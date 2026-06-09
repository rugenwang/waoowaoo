import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prisma } from '@/lib/prisma'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { extractStorageKey, generateUniqueKey, getObjectBuffer, getSignedUrl, toFetchableUrl, uploadObject } from '@/lib/storage'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

export const runtime = 'nodejs'

const DIALOGUE_SERVICE_BASE_URL = (process.env.WAOO_DIALOGUE_SERVICE_BASE_URL || 'http://127.0.0.1:5555').replace(/\/+$/, '')
const POLL_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 1500

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readFiniteNumber(value: unknown): number | null {
  const next = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(next) ? next : null
}

async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${code}): ${stderr.slice(-1000)}`))
    })
  })
}

async function readPanelVideoBuffer(videoUrl: string): Promise<Buffer> {
  const key = extractStorageKey(videoUrl) || (!videoUrl.startsWith('http') && !videoUrl.startsWith('/') ? videoUrl : '')
  if (key) {
    return await getObjectBuffer(key)
  }
  const response = await fetch(toFetchableUrl(videoUrl))
  if (!response.ok) {
    throw new Error(`下载视频失败: ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function separateVocals(clipBuffer: Buffer) {
  const form = new FormData()
  form.append('video', new Blob([new Uint8Array(clipBuffer)], { type: 'video/mp4' }), 'clip.mp4')
  const startResponse = await fetch(`${DIALOGUE_SERVICE_BASE_URL}/api/dialogue/separate-vocals`, {
    method: 'POST',
    body: form,
  })
  const startData = await startResponse.json().catch(() => ({})) as { task_id?: string; error?: string }
  if (!startResponse.ok || !startData.task_id) {
    throw new Error(startData.error || `人声提取服务启动失败(${startResponse.status})`)
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const taskResponse = await fetch(`${DIALOGUE_SERVICE_BASE_URL}/api/dialogue/tasks/${encodeURIComponent(startData.task_id)}`)
    const taskData = await taskResponse.json().catch(() => ({})) as {
      status?: string
      error?: string
      result?: {
        vocals_url?: string
        audio_url?: string
      }
    }
    if (!taskResponse.ok) {
      throw new Error(taskData.error || `人声提取任务查询失败(${taskResponse.status})`)
    }
    if (taskData.status === 'failed') {
      throw new Error(taskData.error || '人声提取失败')
    }
    if (taskData.status === 'completed') {
      const vocalsUrl = taskData.result?.vocals_url || taskData.result?.audio_url || ''
      if (!vocalsUrl) throw new Error('人声提取完成但没有返回音频')
      const absoluteVocalsUrl = vocalsUrl.startsWith('http') ? vocalsUrl : `${DIALOGUE_SERVICE_BASE_URL}${vocalsUrl}`
      const audioResponse = await fetch(absoluteVocalsUrl)
      if (!audioResponse.ok) throw new Error(`下载提取人声失败(${audioResponse.status})`)
      return {
        audioBuffer: Buffer.from(await audioResponse.arrayBuffer()),
        taskId: startData.task_id,
      }
    }
  }
  throw new Error('人声提取超时')
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json().catch(() => null)
  const panelId = readString(body?.panelId)
  const startSec = readFiniteNumber(body?.startSec)
  const endSec = readFiniteNumber(body?.endSec)
  if (!panelId || startSec === null || endSec === null || startSec < 0 || endSec <= startSec) {
    throw new ApiError('INVALID_PARAMS')
  }

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: {
      id: panelId,
      storyboard: {
        episode: {
          novelPromotionProject: {
            projectId,
          },
        },
      },
    },
    select: {
      id: true,
      panelIndex: true,
      videoUrl: true,
    },
  })
  if (!panel?.videoUrl) {
    throw new ApiError('INVALID_PARAMS', { message: '当前成片还没有可提取的视频' })
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `waoo-panel-dubbing-${randomUUID()}-`))
  const sourcePath = path.join(tempDir, 'source.mp4')
  const clipPath = path.join(tempDir, 'clip.mp4')
  try {
    const sourceBuffer = await readPanelVideoBuffer(panel.videoUrl)
    await fs.writeFile(sourcePath, sourceBuffer)
    await runCommand('ffmpeg', [
      '-y',
      '-ss',
      String(startSec),
      '-i',
      sourcePath,
      '-t',
      String(endSec - startSec),
      '-c',
      'copy',
      clipPath,
    ])
    const clipBuffer = await fs.readFile(clipPath)
    const extracted = await separateVocals(clipBuffer)
    const key = generateUniqueKey(`voice/panel-dubbing/${projectId}/${panel.id}/vocals`, 'wav')
    await uploadObject(extracted.audioBuffer, key, 1, 'audio/wav')
    const media = await ensureMediaObjectFromStorageKey(key, {
      mimeType: 'audio/wav',
      sizeBytes: extracted.audioBuffer.length,
    })

    return NextResponse.json({
      success: true,
      audioKey: key,
      audioUrl: getSignedUrl(key, 7200),
      mediaId: media.id,
      dialogueTaskId: extracted.taskId,
      startSec,
      endSec,
    })
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
})
