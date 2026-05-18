import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getObjectBuffer, toFetchableUrl } from '@/lib/storage'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'

interface EditorClip {
  id?: string
  src?: string
  durationInFrames?: number
  trim?: {
    from?: number
    to?: number
  }
  playback?: {
    reverse?: boolean
    muted?: boolean
  }
}

interface EditorProjectData {
  config?: { fps?: number }
  timeline?: EditorClip[]
}

async function downloadVideoBuffer(src: string): Promise<Buffer> {
  const storageKey = await resolveStorageKeyFromMediaValue(src)
  if (storageKey) return await getObjectBuffer(storageKey)

  const response = await fetch(toFetchableUrl(src))
  if (!response.ok) {
    throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr: Buffer[] = []
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8') || `ffmpeg exited with ${code}`))
    })
  })
}

function frameToSeconds(frame: number, fps: number): string {
  return Math.max(0, frame / Math.max(1, fps)).toFixed(3)
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId : ''
  const projectData = body?.projectData as EditorProjectData | undefined
  const clips = Array.isArray(projectData?.timeline)
    ? projectData.timeline.filter((clip): clip is EditorClip & { src: string } => typeof clip?.src === 'string' && clip.src.length > 0)
    : []

  if (!episodeId || clips.length === 0) {
    throw new ApiError('INVALID_PARAMS')
  }

  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: { id: episodeId, novelPromotionProject: { projectId } },
    select: { id: true, name: true },
  })
  if (!episode) throw new ApiError('NOT_FOUND')

  const fps = projectData?.config?.fps || 30
  const workDir = path.join(os.tmpdir(), `waoo-editor-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })

  try {
    const inputLines: string[] = []
    for (let index = 0; index < clips.length; index += 1) {
      const sourceName = `${String(index + 1).padStart(4, '0')}_source.mp4`
      const sourcePath = path.join(workDir, sourceName)
      const outputName = `${String(index + 1).padStart(4, '0')}.mp4`
      const outputPath = path.join(workDir, outputName)
      const clip = clips[index]
      const buffer = await downloadVideoBuffer(clip.src)
      await writeFile(sourcePath, buffer)

      const trimFrom = typeof clip.trim?.from === 'number' ? Math.max(0, Math.round(clip.trim.from)) : 0
      const trimTo = typeof clip.trim?.to === 'number' ? Math.max(trimFrom + 1, Math.round(clip.trim.to)) : 0
      const durationFrames = trimTo > trimFrom
        ? trimTo - trimFrom
        : Math.max(1, Math.round(clip.durationInFrames || fps * 3))

      if (trimFrom > 0 || trimTo > 0 || clip.playback?.reverse || clip.playback?.muted) {
        const filterArgs: string[] = []
        if (clip.playback?.reverse) {
          filterArgs.push('-vf', 'reverse')
          if (!clip.playback?.muted) {
            filterArgs.push('-af', 'areverse')
          }
        }
        await runFfmpeg([
          '-y',
          '-ss', frameToSeconds(trimFrom, fps),
          '-i', sourcePath,
          '-t', frameToSeconds(durationFrames, fps),
          ...filterArgs,
          '-c:v', 'libx264',
          ...(clip.playback?.muted ? ['-an'] : ['-c:a', 'aac']),
          '-movflags', '+faststart',
          outputPath,
        ], workDir)
      } else {
        await writeFile(outputPath, buffer)
      }
      inputLines.push(`file '${outputName.replace(/'/g, "'\\''")}'`)
    }

    const listPath = path.join(workDir, 'concat.txt')
    const outputPath = path.join(workDir, 'output.mp4')
    await writeFile(listPath, inputLines.join('\n'), 'utf8')

    try {
      await runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        outputPath,
      ], workDir)
    } catch {
      await runFfmpeg([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath,
      ], workDir)
    }

    const output = await readFile(outputPath)
    const safeName = (episode.name || 'waoo-editor').replace(/[\\/:*?"<>|]/g, '_')
    const body = new ArrayBuffer(output.byteLength)
    new Uint8Array(body).set(output)
    return new Response(body, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeName}_merged.mp4`)}"`,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({
      error: 'EXPORT_VIDEO_FAILED',
      message: message.includes('ENOENT')
        ? '当前运行环境找不到 ffmpeg，无法在服务端直接拼接视频。请先安装 ffmpeg 后重试。'
        : message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})
