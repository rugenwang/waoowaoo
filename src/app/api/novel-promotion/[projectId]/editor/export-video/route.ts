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
}

interface EditorProjectData {
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

  const workDir = path.join(os.tmpdir(), `waoo-editor-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })

  try {
    const inputLines: string[] = []
    for (let index = 0; index < clips.length; index += 1) {
      const fileName = `${String(index + 1).padStart(4, '0')}.mp4`
      const filePath = path.join(workDir, fileName)
      const buffer = await downloadVideoBuffer(clips[index].src)
      await writeFile(filePath, buffer)
      inputLines.push(`file '${fileName.replace(/'/g, "'\\''")}'`)
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
