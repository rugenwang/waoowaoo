import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getProjectModelConfig } from '@/lib/config-service'
import { generateVideo } from '@/lib/generator-api'
import { processMediaResult } from '@/lib/media-process'
import { ensureMediaObjectFromStorageKey, resolveStorageKeyFromMediaValue } from '@/lib/media/service'
import { getObjectBuffer, toFetchableUrl } from '@/lib/storage'

type FrameMode = 'first' | 'first-last'

interface RegenerateClipRequest {
  src?: string
  prompt?: string
  videoModel?: string
  fps?: number
  durationInFrames?: number
  frameMode?: FrameMode
  trim?: {
    from?: number
    to?: number
  }
  generationOptions?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

function normalizeGenerationOptions(raw: unknown): Record<string, string | number | boolean> {
  if (!isRecord(raw)) return {}
  const next: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'aspectRatio') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[key] = value
    }
  }
  return next
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json() as RegenerateClipRequest
  const src = typeof body.src === 'string' ? body.src.trim() : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!src || !prompt) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'EDITOR_REGENERATE_CLIP_PARAMS_REQUIRED',
      fields: ['src', 'prompt'],
    })
  }

  const modelConfig = await getProjectModelConfig(projectId, session.user.id)
  const videoModel = typeof body.videoModel === 'string' && body.videoModel.trim()
    ? body.videoModel.trim()
    : modelConfig.videoModel
  if (!videoModel) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'VIDEO_MODEL_REQUIRED',
      field: 'videoModel',
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
  const durationSeconds = Math.max(0.1, durationFrames / fps)

  const workDir = path.join(os.tmpdir(), `waoo-editor-regenerate-${randomUUID()}`)
  await mkdir(workDir, { recursive: true })

  try {
    const inputPath = path.join(workDir, 'input.mp4')
    const firstFramePath = path.join(workDir, 'first.jpg')
    const lastFramePath = path.join(workDir, 'last.jpg')
    await writeFile(inputPath, await downloadVideoBuffer(src))

    await runFfmpeg([
      '-y',
      '-ss', frameToSeconds(firstFrame, fps),
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '2',
      firstFramePath,
    ], workDir)

    if (frameMode === 'first-last') {
      await runFfmpeg([
        '-y',
        '-ss', frameToSeconds(lastFrame, fps),
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', '2',
        lastFramePath,
      ], workDir)
    }

    const firstFrameDataUrl = toFrameDataUrl(await readFile(firstFramePath))
    const lastFrameDataUrl = frameMode === 'first-last'
      ? toFrameDataUrl(await readFile(lastFramePath))
      : null
    const generationOptions = normalizeGenerationOptions(body.generationOptions)
    if (generationOptions.duration === undefined) {
      generationOptions.duration = Math.max(1, Math.round(durationSeconds))
    }
    if (generationOptions.fps === undefined) {
      generationOptions.fps = fps
    }

    const result = await generateVideo(session.user.id, videoModel, firstFrameDataUrl, {
      ...generationOptions,
      prompt,
      ...(modelConfig.videoRatio ? { aspectRatio: modelConfig.videoRatio } : {}),
      ...(lastFrameDataUrl
        ? { generationMode: 'firstlastframe', lastFrameImageUrl: lastFrameDataUrl }
        : { generationMode: 'normal' }),
    })

    if (!result.success || !result.videoUrl) {
      throw new Error(result.error || '视频生成失败')
    }

    const storageKey = await processMediaResult({
      source: result.videoUrl,
      type: 'video',
      keyPrefix: 'editor-regenerate-clip',
      targetId: projectId,
    })
    const mediaRef = await ensureMediaObjectFromStorageKey(storageKey, {
      mimeType: 'video/mp4',
      durationMs: Math.round(durationSeconds * 1000),
    })

    return Response.json({
      success: true,
      videoUrl: mediaRef.url,
      storageKey,
      durationInFrames: durationFrames,
      durationSeconds,
      frameMode,
      prompt,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({
      error: 'EDITOR_REGENERATE_CLIP_FAILED',
      message: message.includes('ENOENT')
        ? '当前运行环境找不到 ffmpeg，无法截取首尾帧。请先安装 ffmpeg 后重试。'
        : message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
})
