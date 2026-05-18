import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getObjectBuffer, toFetchableUrl, uploadObject } from '@/lib/storage'
import { ensureMediaObjectFromStorageKey, resolveStorageKeyFromMediaValue } from '@/lib/media/service'

interface ReversePreviewRequest {
  src?: string
  fps?: number
  durationInFrames?: number
  trim?: {
    from?: number
    to?: number
  }
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

  const body = await request.json() as ReversePreviewRequest
  const src = typeof body.src === 'string' ? body.src : ''
  if (!src) throw new ApiError('INVALID_PARAMS')

  const fps = typeof body.fps === 'number' && Number.isFinite(body.fps) ? body.fps : 30
  const trimFrom = typeof body.trim?.from === 'number' ? Math.max(0, Math.round(body.trim.from)) : 0
  const trimTo = typeof body.trim?.to === 'number' ? Math.max(trimFrom + 1, Math.round(body.trim.to)) : 0
  const durationFrames = trimTo > trimFrom
    ? trimTo - trimFrom
    : Math.max(1, Math.round(body.durationInFrames || fps * 3))

  const workDir = path.join(os.tmpdir(), `waoo-reverse-preview-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })

  try {
    const inputPath = path.join(workDir, 'input.mp4')
    const outputPath = path.join(workDir, 'reverse-preview.mp4')
    await writeFile(inputPath, await downloadVideoBuffer(src))

    await runFfmpeg([
      '-y',
      '-ss', frameToSeconds(trimFrom, fps),
      '-i', inputPath,
      '-t', frameToSeconds(durationFrames, fps),
      '-vf', 'reverse,scale=-2:720',
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '30',
      '-movflags', '+faststart',
      outputPath,
    ], workDir)

    const output = await readFile(outputPath)
    const storageKey = `novel-promotion/${projectId}/editor/reverse-preview/${randomUUID()}.mp4`
    await uploadObject(output, storageKey, 1, 'video/mp4')
    const mediaRef = await ensureMediaObjectFromStorageKey(storageKey, {
      mimeType: 'video/mp4',
      sizeBytes: output.byteLength,
      durationMs: Math.round((durationFrames / fps) * 1000),
    })

    return Response.json({
      url: mediaRef.url,
      storageKey,
      durationInFrames: durationFrames,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({
      error: 'REVERSE_PREVIEW_FAILED',
      message: message.includes('ENOENT')
        ? '当前运行环境找不到 ffmpeg，无法生成倒放预览。请先安装 ffmpeg 后重试。'
        : message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})
