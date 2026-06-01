import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'
import { getObjectBuffer, toFetchableUrl } from '@/lib/storage'

type FrameMode = 'first' | 'first-last'

interface ClipFramesRequest {
  src?: string
  fps?: number
  durationInFrames?: number
  frameMode?: FrameMode
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

function toFrameDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json() as ClipFramesRequest
  const src = typeof body.src === 'string' ? body.src.trim() : ''
  if (!src) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'EDITOR_CLIP_FRAMES_SRC_REQUIRED',
      field: 'src',
    })
  }

  const fps = typeof body.fps === 'number' && Number.isFinite(body.fps) && body.fps > 0 ? body.fps : 30
  const trimFrom = typeof body.trim?.from === 'number' ? Math.max(0, Math.round(body.trim.from)) : 0
  const trimTo = typeof body.trim?.to === 'number' ? Math.max(trimFrom + 1, Math.round(body.trim.to)) : 0
  const durationFrames = trimTo > trimFrom
    ? trimTo - trimFrom
    : Math.max(1, Math.round(body.durationInFrames || fps * 3))
  const firstFrame = trimFrom
  const lastFrame = Math.max(trimFrom, trimFrom + durationFrames - 1)
  const frameMode: FrameMode = body.frameMode === 'first' ? 'first' : 'first-last'

  const workDir = path.join(os.tmpdir(), `waoo-editor-clip-frames-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })

  try {
    const inputPath = path.join(workDir, 'input.mp4')
    const firstFramePath = path.join(workDir, 'first.png')
    const lastFramePath = path.join(workDir, 'last.png')
    await writeFile(inputPath, await downloadVideoBuffer(src))

    await runFfmpeg([
      '-y',
      '-ss', frameToSeconds(firstFrame, fps),
      '-i', inputPath,
      '-frames:v', '1',
      firstFramePath,
    ], workDir)

    if (frameMode === 'first-last') {
      await runFfmpeg([
        '-y',
        '-ss', frameToSeconds(lastFrame, fps),
        '-i', inputPath,
        '-frames:v', '1',
        lastFramePath,
      ], workDir)
    }

    return Response.json({
      success: true,
      firstFrameUrl: toFrameDataUrl(await readFile(firstFramePath)),
      lastFrameUrl: frameMode === 'first-last'
        ? toFrameDataUrl(await readFile(lastFramePath))
        : null,
      firstFrame,
      lastFrame,
      fps,
      frameMode,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({
      error: 'EDITOR_CLIP_FRAMES_FAILED',
      message: message.includes('ENOENT')
        ? '当前运行环境找不到 ffmpeg，无法预览首尾帧。请先安装 ffmpeg 后重试。'
        : message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})
