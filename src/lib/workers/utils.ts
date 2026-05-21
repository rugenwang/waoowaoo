import sharp from 'sharp'
import { type Job } from 'bullmq'
import { createScopedLogger } from '@/lib/logging/core'
import { withLogContext } from '@/lib/logging/context'
import { generateImage, generateVideo } from '@/lib/generator-api'
import { generateLipSync } from '@/lib/lipsync'
import { pollAsyncTask } from '@/lib/async-poll'
import { getSignedUrl, toFetchableUrl } from '@/lib/storage'
import { initializeFonts, createLabelSVG } from '@/lib/fonts'
import { processMediaResult } from '@/lib/media-process'
import {
  getProjectModelConfig,
  getUserModelConfig,
  resolveProjectModelCapabilityGenerationOptions,
} from '@/lib/config-service'
import { TaskTerminatedError } from '@/lib/task/errors'
import { isTaskActive, trySetTaskExternalId } from '@/lib/task/service'
import { type TaskJobData } from '@/lib/task/types'
import { publishTaskStreamEvent } from '@/lib/task/publisher'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { getProviderConfig } from '@/lib/api-config'
import { reportTaskProgress } from './shared'
import { prisma } from '@/lib/prisma'

const DEFAULT_POLL_TIMEOUT_MS = Number.parseInt(process.env.WORKER_EXTERNAL_TIMEOUT_MS || String(20 * 60 * 1000), 10)
const DEFAULT_POLL_INTERVAL_MS = Number.parseInt(process.env.WORKER_EXTERNAL_POLL_MS || '3000', 10)
const DEFAULT_LOCAL_VIDEO_POLL_TIMEOUT_MS = Number.parseInt(
  process.env.WORKER_LOCAL_VIDEO_TIMEOUT_MS || String(6 * 60 * 60 * 1000),
  10,
)

/**
 * 查询 DB 中任务是否已有 externalId（服务重启后续接轮询用，避免重复提交外部 API）
 */
async function getTaskExistingExternalId(taskId: string): Promise<string | null> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { externalId: true },
    })
    const val = task?.externalId?.trim()
    return val || null
  } catch {
    return null
  }
}

function scopedWorkerUtilLogger(job: Job<TaskJobData>, action: string) {
  return createScopedLogger({
    module: 'worker.utils',
    action,
    requestId: job.data.trace?.requestId || undefined,
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: job.data.userId,
  })
}

function sanitizeGenerationOptionsForConsole(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options)) {
    if (k === 'referenceImages' && Array.isArray(v)) {
      out.referenceImages = { count: v.length, omitted: true }
      continue
    }
    if (k === 'keyframes' && Array.isArray(v)) {
      out.keyframes = { count: v.length, omitted: true }
      continue
    }
    if ((k === 'imageUrl' || k === 'lastFrameImageUrl') && typeof v === 'string') {
      // 可能是 dataURL/base64，控制台里仅显示长度避免污染
      out[k] = { length: v.length, omitted: true }
      continue
    }
    if (typeof v === 'string' && v.length > 500) {
      out[k] = `${v.slice(0, 500)}...(truncated ${v.length})`
      continue
    }
    out[k] = v
  }
  return out
}

export function parseJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function assertTaskActive(job: Job<TaskJobData>, stage: string) {
  const active = await isTaskActive(job.data.taskId)
  if (active) return
  throw new TaskTerminatedError(job.data.taskId, `Task terminated during ${stage}`)
}

async function withTaskAbortSignal<T>(
  job: Job<TaskJobData>,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setInterval(async () => {
    try {
      const active = await isTaskActive(job.data.taskId)
      if (!active) controller.abort()
    } catch {
      // ignore
    }
  }, 750)

  try {
    return await run(controller.signal)
  } finally {
    clearInterval(timer)
  }
}

function normalizeExternalId(result: {
  async?: boolean
  externalId?: string
  requestId?: string
  endpoint?: string
}, mediaType: 'IMAGE' | 'VIDEO') {
  if (!result.async) return null
  const externalId = typeof result.externalId === 'string' ? result.externalId.trim() : ''
  if (externalId) return externalId
  throw new Error(`ASYNC_EXTERNAL_ID_MISSING: async ${mediaType} task returned without standard externalId`)
}

export async function waitExternalResult(
  job: Job<TaskJobData>,
  externalId: string,
  userId: string,
  opts?: { timeoutMs?: number; intervalMs?: number; progressStart?: number; progressEnd?: number },
) {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const progressStart = opts?.progressStart ?? 40
  const progressEnd = opts?.progressEnd ?? 90
  const startAt = Date.now()
  const logger = scopedWorkerUtilLogger(job, 'worker.external.poll')

  logger.info({
    message: 'external poll started',
    details: {
      externalId,
      timeoutMs,
      intervalMs,
    },
  })

  await trySetTaskExternalId(job.data.taskId, externalId)

  while (Date.now() - startAt <= timeoutMs) {
    await assertTaskActive(job, 'polling_external')
    const status = await pollAsyncTask(externalId, userId)

    if (status.status === 'completed') {
      const url = status.resultUrl || status.imageUrl || status.videoUrl
      if (!url) {
        throw new Error(`External task completed but no result URL: ${externalId}`)
      }
      logger.info({
        message: 'external poll completed',
        durationMs: Date.now() - startAt,
        details: {
          externalId,
        },
      })
      return {
        url,
        status,
        ...(typeof status.actualVideoTokens === 'number' ? { actualVideoTokens: status.actualVideoTokens } : {}),
        ...(status.downloadHeaders ? { downloadHeaders: status.downloadHeaders } : {}),
      }
    }

    if (status.status === 'failed') {
      logger.error({
        message: status.error || 'external task failed',
        errorCode: 'EXTERNAL_ERROR',
        retryable: true,
        durationMs: Date.now() - startAt,
        details: {
          externalId,
        },
      })
      throw new Error(status.error || `External task failed: ${externalId}`)
    }

    const elapsed = Date.now() - startAt
    const ratio = Math.max(0, Math.min(1, elapsed / timeoutMs))
    const progress = progressStart + Math.floor((progressEnd - progressStart) * ratio)
    await reportTaskProgress(job, progress, { stage: 'polling_external', externalId })
    await assertTaskActive(job, 'polling_external_wait')
    await sleep(intervalMs)
  }

  logger.error({
    message: 'external task polling timeout',
    errorCode: 'GENERATION_TIMEOUT',
    retryable: true,
    durationMs: Date.now() - startAt,
    details: {
      externalId,
      timeoutMs,
    },
  })
  throw new Error(`External task polling timeout (${Math.round(timeoutMs / 1000)}s): ${externalId}`)
}

function resolveExternalPollOptions(
  externalId: string,
  opts?: { start?: number; end?: number },
) {
  return {
    progressStart: opts?.start,
    progressEnd: opts?.end,
    ...(externalId.startsWith('LOCAL:VIDEO:')
      ? { timeoutMs: DEFAULT_LOCAL_VIDEO_POLL_TIMEOUT_MS }
      : {}),
  }
}

async function downloadToDataUrl(sourceUrl: string, downloadHeaders?: Record<string, string>): Promise<string> {
  const response = await fetch(sourceUrl, {
    method: 'GET',
    headers: downloadHeaders,
  })
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`)
  }
  const contentType = response.headers.get('content-type') || 'image/png'
  const buffer = Buffer.from(await response.arrayBuffer())
  return `data:${contentType};base64,${buffer.toString('base64')}`
}

export async function resolveImageSourceFromGeneration(
  job: Job<TaskJobData>,
  params: {
    userId: string
    modelId: string
    prompt: string
    options?: {
      referenceImages?: string[]
      aspectRatio?: string
      resolution?: string
      size?: string
      provider?: string
    }
    allowTaskExternalIdResume?: boolean
    pollProgress?: { start?: number; end?: number }
  },
): Promise<string> {
  const logger = scopedWorkerUtilLogger(job, 'worker.image.generate_source')
  const startedAt = Date.now()
  const allowTaskExternalIdResume = params.allowTaskExternalIdResume !== false

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询，不重新提交外部 API
  if (allowTaskExternalIdResume) {
    const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
    if (resumeExternalId) {
      logger.info({
        message: 'image source generation resumed from existing external id',
        details: { externalId: resumeExternalId },
      })
      const polled = await waitExternalResult(
        job,
        resumeExternalId,
        params.userId,
        resolveExternalPollOptions(resumeExternalId, {
          start: params.pollProgress?.start ?? 40,
          end: params.pollProgress?.end ?? 92,
        }),
      )
      return polled.downloadHeaders
        ? await downloadToDataUrl(polled.url, polled.downloadHeaders)
        : polled.url
    }
  }

  logger.info({
    message: 'image source generation started',
    provider: params.options?.provider || undefined,
    details: {
      model: params.modelId,
    },
  })

  const runtimeSelections: Record<string, string | number | boolean> = {}
  if (typeof params.options?.resolution === 'string') {
    runtimeSelections.resolution = params.options.resolution
  }
  const imageMode: 't2i' | 'i2i' =
    (params.options?.referenceImages?.length || 0) > 0 ? 'i2i' : 't2i'

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId: job.data.projectId,
    userId: params.userId,
    modelType: 'image',
    modelKey: params.modelId,
    runtimeSelections,
    imageMode,
  })

  logger.info({
    message: 'image source generation calling generateImage',
    details: {
      model: params.modelId,
      referenceImageCount: params.options?.referenceImages?.length ?? 0,
      capabilityOptions,
      optionKeys: Object.keys(params.options || {}),
    },
  })

  // 控制台可视化：记录请求参数/提示词（脱敏）
  const parsedModel = parseModelKeyStrict(params.modelId)
  const truncateText = (value: unknown, max = 3000) => {
    const text = typeof value === 'string' ? value : String(value ?? '')
    if (text.length <= max) return text
    return `${text.slice(0, max)}…(truncated)`
  }
  const providerKey = (parsedModel?.provider || '').trim()

  // GPT Image 2（api.img.dengche.cc / eeeapi）质量策略：
  // 为了稳定与速度，固定透传 quality=medium（不允许被上层覆盖）。
  // 说明：该服务端把 gpt-image-1 / gpt-image-2 / dall-e-2 / dall-e-3 都路由到 gpt-image-2。
  const shouldForceMediumQuality = providerKey === 'eeeapi' && (() => {
    const modelRef = (parsedModel?.modelId || '').trim()
    return modelRef === 'gpt-image-1'
      || modelRef === 'gpt-image-2'
      || modelRef === 'dall-e-2'
      || modelRef === 'dall-e-3'
  })()
  if (shouldForceMediumQuality) {
    ;(capabilityOptions as Record<string, unknown>).quality = 'medium'
  }

  const eeeapiRequest = providerKey === 'eeeapi'
    ? await (async () => {
        try {
          const providerConfig = await getProviderConfig(params.userId, parsedModel?.provider || 'eeeapi')
          const baseUrlRaw = typeof providerConfig.baseUrl === 'string'
            ? providerConfig.baseUrl.trim().replace(/\/+$/, '')
            : ''
          const endpoint = baseUrlRaw
            ? (baseUrlRaw.endsWith('/v1') ? `${baseUrlRaw}/images/generations` : `${baseUrlRaw}/v1/images/generations`)
            : 'https://api.img.dengche.cc/v1/images/generations'
          const optAny = (params.options || {}) as Record<string, unknown>
          const normalizeEeeApiSizeAlias = (value: string) => {
            const normalized = value.trim().toLowerCase()
            if (normalized === '2k') return '2720x1536'
            if (normalized === '4k') return '3840x2160'
            return value.trim()
          }
          const configuredSize = (typeof optAny.size === 'string' && optAny.size.trim())
            ? optAny.size.trim()
            : (typeof (capabilityOptions as Record<string, unknown>)?.size === 'string'
              ? String((capabilityOptions as Record<string, unknown>).size)
              : (typeof (capabilityOptions as Record<string, unknown>)?.resolution === 'string'
                ? String((capabilityOptions as Record<string, unknown>).resolution)
                : '1024x1024'))
          const size = normalizeEeeApiSizeAlias(configuredSize)
          const n = (typeof optAny.n === 'number' && Number.isFinite(optAny.n)) ? Math.max(1, Math.floor(optAny.n)) : 1
          return {
            endpoint,
            body: {
              model: parsedModel?.modelId || 'gpt-image-1',
              prompt: truncateText(params.prompt, 3000),
              n,
              size,
            },
            promptLength: typeof params.prompt === 'string' ? params.prompt.length : 0,
            referenceImagesCount: params.options?.referenceImages?.length ?? 0,
          }
        } catch {
          return null
        }
      })()
    : null
  await publishTaskStreamEvent({
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: params.userId,
    taskType: job.data.type,
    targetType: job.data.targetType,
    targetId: job.data.targetId,
    episodeId: job.data.episodeId || null,
    payload: {
      kind: 'generator_request',
      mediaType: 'image',
      provider: parsedModel?.provider || null,
      modelId: params.modelId,
      prompt: params.prompt,
      options: sanitizeGenerationOptionsForConsole({
        ...(params.options || {}),
        ...capabilityOptions,
      }),
      ...(eeeapiRequest ? { eeeapiRequest } : null),
    },
    persist: true,
  })

  const result = await withLogContext(
    { projectId: job.data.projectId, taskId: job.data.taskId, userId: params.userId },
    () => generateImage(params.userId, params.modelId, params.prompt, {
      ...params.options,
      ...capabilityOptions,
      // 仅用于调试：让具体 provider 实现可以把最终请求记录到 task stream（不会透传到外部 API）
      __debugTaskId: job.data.taskId,
      __debugProjectId: job.data.projectId,
      __debugTaskType: job.data.type,
      __debugTargetType: job.data.targetType,
      __debugTargetId: job.data.targetId,
      __debugEpisodeId: job.data.episodeId || null,
      __debugPublishProviderRequest: true,
    }),
  )
  if (!result.success) {
    await publishTaskStreamEvent({
      taskId: job.data.taskId,
      projectId: job.data.projectId,
      userId: params.userId,
      taskType: job.data.type,
      targetType: job.data.targetType,
      targetId: job.data.targetId,
      episodeId: job.data.episodeId || null,
      payload: {
        kind: 'generator_response',
        mediaType: 'image',
        ok: false,
        error: result.error || 'Image generation failed',
      },
      persist: true,
    })
    throw new Error(result.error || 'Image generation failed')
  }

  if (result.imageUrl) {
    logger.info({
      message: 'image source generation completed',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    await publishTaskStreamEvent({
      taskId: job.data.taskId,
      projectId: job.data.projectId,
      userId: params.userId,
      taskType: job.data.type,
      targetType: job.data.targetType,
      targetId: job.data.targetId,
      episodeId: job.data.episodeId || null,
      payload: {
        kind: 'generator_response',
        mediaType: 'image',
        ok: true,
        mode: 'direct_url',
      },
      persist: true,
    })
    return result.imageUrl
  }
  if (result.imageBase64) {
    logger.info({
      message: 'image source generation completed (base64)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    await publishTaskStreamEvent({
      taskId: job.data.taskId,
      projectId: job.data.projectId,
      userId: params.userId,
      taskType: job.data.type,
      targetType: job.data.targetType,
      targetId: job.data.targetId,
      episodeId: job.data.episodeId || null,
      payload: {
        kind: 'generator_response',
        mediaType: 'image',
        ok: true,
        mode: 'base64',
        base64Length: result.imageBase64.length,
      },
      persist: true,
    })
    return `data:image/png;base64,${result.imageBase64}`
  }

  const externalId = normalizeExternalId(result, 'IMAGE')
  if (!externalId) {
    throw new Error('Image generation returned no image and no external id')
  }

  await publishTaskStreamEvent({
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: params.userId,
    taskType: job.data.type,
    targetType: job.data.targetType,
    targetId: job.data.targetId,
    episodeId: job.data.episodeId || null,
    payload: {
      kind: 'generator_async_submitted',
      mediaType: 'image',
      externalId,
    },
    persist: true,
  })

  const polled = await waitExternalResult(
    job,
    externalId,
    params.userId,
    resolveExternalPollOptions(externalId, {
      start: params.pollProgress?.start ?? 40,
      end: params.pollProgress?.end ?? 92,
    }),
  )
  logger.info({
    message: 'image source generation completed (async)',
    provider: params.options?.provider || undefined,
    durationMs: Date.now() - startedAt,
    details: {
      externalId,
    },
  })
  await publishTaskStreamEvent({
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: params.userId,
    taskType: job.data.type,
    targetType: job.data.targetType,
    targetId: job.data.targetId,
    episodeId: job.data.episodeId || null,
    payload: {
      kind: 'generator_async_completed',
      mediaType: 'image',
      externalId,
    },
    persist: true,
  })
  return polled.downloadHeaders
    ? await downloadToDataUrl(polled.url, polled.downloadHeaders)
    : polled.url
}

/**
 * 多图版本：一次生成调用返回所有图片 URL 数组。
 *
 * - 接口返回多张（result.imageUrls）→ 返回完整列表
 * - 接口只返回单张（result.imageUrl / result.imageBase64）→ 封装成 [url] 保持接口一致
 * - 异步任务：轮询结果只有一个 URL，封装成 [url]
 *
 * 现有代码请继续使用 resolveImageSourceFromGeneration（取第一张），
 * 只有需要利用多图结果时才调用此函数。
 */
export async function resolveImageSourcesFromGeneration(
  job: Job<TaskJobData>,
  params: {
    userId: string
    modelId: string
    prompt: string
    options?: {
      referenceImages?: string[]
      aspectRatio?: string
      resolution?: string
      size?: string
      provider?: string
    }
    allowTaskExternalIdResume?: boolean
    pollProgress?: { start?: number; end?: number }
  },
): Promise<string[]> {
  const logger = scopedWorkerUtilLogger(job, 'worker.image.generate_sources')
  const startedAt = Date.now()
  const allowTaskExternalIdResume = params.allowTaskExternalIdResume !== false

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询（异步只有一张）
  if (allowTaskExternalIdResume) {
    const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
    if (resumeExternalId) {
      logger.info({
        message: 'image sources generation resumed from existing external id',
        details: { externalId: resumeExternalId },
      })
      const polled = await waitExternalResult(
        job,
        resumeExternalId,
        params.userId,
        resolveExternalPollOptions(resumeExternalId, {
          start: params.pollProgress?.start ?? 40,
          end: params.pollProgress?.end ?? 92,
        }),
      )
      if (polled.downloadHeaders) {
        return [await downloadToDataUrl(polled.url, polled.downloadHeaders)]
      }
      return [polled.url]
    }
  }

  logger.info({
    message: 'image sources generation started',
    provider: params.options?.provider || undefined,
    details: { model: params.modelId },
  })

  const runtimeSelections: Record<string, string | number | boolean> = {}
  if (typeof params.options?.resolution === 'string') {
    runtimeSelections.resolution = params.options.resolution
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId: job.data.projectId,
    userId: params.userId,
    modelType: 'image',
    modelKey: params.modelId,
    runtimeSelections,
  })

  const result = await withLogContext(
    { projectId: job.data.projectId, taskId: job.data.taskId, userId: params.userId },
    () => generateImage(params.userId, params.modelId, params.prompt, {
      ...params.options,
      ...capabilityOptions,
    }),
  )
  if (!result.success) {
    throw new Error(result.error || 'Image generation failed')
  }

  // 优先使用多图列表
  if (result.imageUrls && result.imageUrls.length > 0) {
    logger.info({
      message: 'image sources generation completed (multi-image)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
      details: { count: result.imageUrls.length },
    })
    return result.imageUrls
  }

  if (result.imageUrl) {
    logger.info({
      message: 'image sources generation completed (single url)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    return [result.imageUrl]
  }

  if (result.imageBase64) {
    logger.info({
      message: 'image sources generation completed (base64)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    return [`data:image/png;base64,${result.imageBase64}`]
  }

  const externalId = normalizeExternalId(result, 'IMAGE')
  if (!externalId) {
    throw new Error('Image generation returned no image and no external id')
  }

  const polled = await waitExternalResult(
    job,
    externalId,
    params.userId,
    resolveExternalPollOptions(externalId, {
      start: params.pollProgress?.start ?? 40,
      end: params.pollProgress?.end ?? 92,
    }),
  )
  logger.info({
    message: 'image sources generation completed (async)',
    provider: params.options?.provider || undefined,
    durationMs: Date.now() - startedAt,
    details: { externalId },
  })
  if (polled.downloadHeaders) {
    return [await downloadToDataUrl(polled.url, polled.downloadHeaders)]
  }
  return [polled.url]
}

export async function resolveVideoSourceFromGeneration(
  job: Job<TaskJobData>,
  params: {
    userId: string
    modelId: string
    imageUrl: string
    options?: {
      prompt?: string
      duration?: number
      fps?: number
      resolution?: string
      aspectRatio?: string
      generateAudio?: boolean
      lastFrameImageUrl?: string
      generationMode?: 'normal' | 'firstlastframe' | 'keyframes'
      keyframes?: Array<{ imageUrl: string; frameTimeSec?: number; frameIndex?: number }>
      [key: string]: unknown
    }
    pollProgress?: { start?: number; end?: number }
  },
): Promise<{ url: string; actualVideoTokens?: number; downloadHeaders?: Record<string, string> }> {
  const logger = scopedWorkerUtilLogger(job, 'worker.video.generate_source')
  const startedAt = Date.now()

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询，不重新提交外部 API（避免重复扣费）
  const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
  if (resumeExternalId) {
    logger.info({
      message: 'video source generation resumed from existing external id',
      details: { externalId: resumeExternalId, model: params.modelId },
    })
    const polled = await waitExternalResult(
      job,
      resumeExternalId,
      params.userId,
      resolveExternalPollOptions(resumeExternalId, {
        start: params.pollProgress?.start ?? 45,
        end: params.pollProgress?.end ?? 94,
      }),
    )
    logger.info({
      message: 'video source generation completed (resumed)',
      durationMs: Date.now() - startedAt,
      details: { externalId: resumeExternalId },
    })
    return {
      url: polled.url,
      ...(typeof polled.actualVideoTokens === 'number' ? { actualVideoTokens: polled.actualVideoTokens } : {}),
      ...(polled.downloadHeaders ? { downloadHeaders: polled.downloadHeaders } : {}),
    }
  }

  logger.info({
    message: 'video source generation started',
    details: {
      model: params.modelId,
    },
  })

  const runtimeSelections: Record<string, string | number | boolean> = {}
  if (typeof params.options?.duration === 'number') {
    runtimeSelections.duration = params.options.duration
  }
  if (typeof params.options?.resolution === 'string') {
    runtimeSelections.resolution = params.options.resolution
  }
  if (
    params.options?.generationMode === 'normal'
    || params.options?.generationMode === 'firstlastframe'
    || params.options?.generationMode === 'keyframes'
  ) {
    // keyframes is an internal local-generator mode. Capability/pricing catalogs
    // only expose provider-level modes, so validate it as normal I2V.
    runtimeSelections.generationMode = params.options.generationMode === 'keyframes'
      ? 'normal'
      : params.options.generationMode
  }
  if (typeof params.options?.generateAudio === 'boolean') {
    runtimeSelections.generateAudio = params.options.generateAudio
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId: job.data.projectId,
    userId: params.userId,
    modelType: 'video',
    modelKey: params.modelId,
    runtimeSelections,
  })

  const providerCapabilityOptions: Record<string, unknown> = { ...capabilityOptions }
  delete providerCapabilityOptions.generationMode
  const providerRequestOptions: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params.options || {})) {
    if (key === 'generationMode' || value === undefined) continue
    providerRequestOptions[key] = value
  }

  // 控制台可视化：记录请求参数/提示词（脱敏）
  const parsedModel = parseModelKeyStrict(params.modelId)
  await publishTaskStreamEvent({
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: params.userId,
    taskType: job.data.type,
    targetType: job.data.targetType,
    targetId: job.data.targetId,
    episodeId: job.data.episodeId || null,
    payload: {
      kind: 'generator_request',
      mediaType: 'video',
      provider: parsedModel?.provider || null,
      modelId: params.modelId,
      prompt: params.options?.prompt || '',
      options: sanitizeGenerationOptionsForConsole({
        ...(providerRequestOptions || {}),
        ...(providerCapabilityOptions || {}),
      }),
    },
    persist: true,
  })

  const result = await withLogContext(
    { projectId: job.data.projectId, taskId: job.data.taskId, userId: params.userId },
    () => generateVideo(params.userId, params.modelId, params.imageUrl, {
      ...providerRequestOptions,
      ...providerCapabilityOptions,
    }),
  )
  if (!result.success) {
    await publishTaskStreamEvent({
      taskId: job.data.taskId,
      projectId: job.data.projectId,
      userId: params.userId,
      taskType: job.data.type,
      targetType: job.data.targetType,
      targetId: job.data.targetId,
      episodeId: job.data.episodeId || null,
      payload: {
        kind: 'generator_response',
        mediaType: 'video',
        ok: false,
        error: result.error || 'Video generation failed',
      },
      persist: true,
    })
    throw new Error(result.error || 'Video generation failed')
  }

  if (result.videoUrl) {
    logger.info({
      message: 'video source generation completed',
      durationMs: Date.now() - startedAt,
    })
    await publishTaskStreamEvent({
      taskId: job.data.taskId,
      projectId: job.data.projectId,
      userId: params.userId,
      taskType: job.data.type,
      targetType: job.data.targetType,
      targetId: job.data.targetId,
      episodeId: job.data.episodeId || null,
      payload: {
        kind: 'generator_response',
        mediaType: 'video',
        ok: true,
        mode: 'direct_url',
      },
      persist: true,
    })
    return { url: result.videoUrl }
  }

  const externalId = normalizeExternalId(result, 'VIDEO')
  if (!externalId) {
    throw new Error('Video generation returned no video and no external id')
  }

  // 控制台可视化：记录请求参数/提示词（脱敏）
  await publishTaskStreamEvent({
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: params.userId,
    taskType: job.data.type,
    targetType: job.data.targetType,
    targetId: job.data.targetId,
    episodeId: job.data.episodeId || null,
    payload: {
      kind: 'generator_async_submitted',
      mediaType: 'video',
      provider: parsedModel?.provider || null,
      modelId: params.modelId,
      prompt: params.options?.prompt || '',
      options: sanitizeGenerationOptionsForConsole({
        ...(providerRequestOptions || {}),
        ...(providerCapabilityOptions || {}),
      }),
      externalId,
    },
    persist: true,
  })

  const polled = await waitExternalResult(
    job,
    externalId,
    params.userId,
    resolveExternalPollOptions(externalId, {
      start: params.pollProgress?.start ?? 45,
      end: params.pollProgress?.end ?? 94,
    }),
  )
  logger.info({
    message: 'video source generation completed (async)',
    durationMs: Date.now() - startedAt,
    details: {
      externalId,
    },
  })
  await publishTaskStreamEvent({
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: params.userId,
    taskType: job.data.type,
    targetType: job.data.targetType,
    targetId: job.data.targetId,
    episodeId: job.data.episodeId || null,
    payload: {
      kind: 'generator_async_completed',
      mediaType: 'video',
      externalId,
      ...(typeof polled.actualVideoTokens === 'number' ? { actualVideoTokens: polled.actualVideoTokens } : {}),
    },
    persist: true,
  })
  return {
    url: polled.url,
    ...(typeof polled.actualVideoTokens === 'number' ? { actualVideoTokens: polled.actualVideoTokens } : {}),
    ...(polled.downloadHeaders ? { downloadHeaders: polled.downloadHeaders } : {}),
  }
}

export async function resolveLipSyncVideoSource(
  job: Job<TaskJobData>,
  params: {
    userId: string
    videoUrl: string
    audioUrl: string
    audioDurationMs?: number | null
    videoDurationMs?: number | null
    modelKey?: string
    pollProgress?: { start?: number; end?: number }
  },
): Promise<string> {
  const logger = scopedWorkerUtilLogger(job, 'worker.video.lip_sync')
  const startedAt = Date.now()

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询，不重新提交（避免重复扣费）
  const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
  if (resumeExternalId) {
    logger.info({
      message: 'lip sync generation resumed from existing external id',
      details: { externalId: resumeExternalId },
    })
    const polled = await waitExternalResult(
      job,
      resumeExternalId,
      params.userId,
      resolveExternalPollOptions(resumeExternalId, {
        start: params.pollProgress?.start ?? 45,
        end: params.pollProgress?.end ?? 94,
      }),
    )
    logger.info({
      message: 'lip sync generation completed (resumed)',
      durationMs: Date.now() - startedAt,
      details: { externalId: resumeExternalId },
    })
    return polled.url
  }

  logger.info({
    message: 'lip sync generation started',
  })

  const result = await generateLipSync(
    {
      videoUrl: params.videoUrl,
      audioUrl: params.audioUrl,
      audioDurationMs: params.audioDurationMs,
      videoDurationMs: params.videoDurationMs,
    },
    params.userId,
    params.modelKey,
  )

  if (!result.requestId) {
    throw new Error('Lip sync request id missing')
  }

  const externalId = typeof result.externalId === 'string'
    ? result.externalId.trim()
    : ''
  if (!externalId) {
    throw new Error('Lip sync external id missing')
  }

  const polled = await waitExternalResult(
    job,
    externalId,
    params.userId,
    resolveExternalPollOptions(externalId, {
      start: params.pollProgress?.start ?? 45,
      end: params.pollProgress?.end ?? 94,
    }),
  )

  logger.info({
    message: 'lip sync generation completed',
    durationMs: Date.now() - startedAt,
    details: {
      externalId,
    },
  })

  return polled.url
}

/**
 * 裁掉图片顶部的黑边标签区域，返回纯净内容的 base64 data URL
 * 用于改图前去除旧黑边，避免 AI 参考图携带黑边导致叠加
 */
export async function stripLabelBar(imageSource: string): Promise<string> {
  const response = await fetch(toFetchableUrl(imageSource))
  if (!response.ok) {
    throw new Error(`Failed to download image for strip: ${response.status}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(raw).metadata()
  const w = meta.width || 2160
  const h = meta.height || 2160
  const fontSize = Math.floor(h * 0.04)
  const pad = Math.floor(fontSize * 0.5)
  const barH = fontSize + pad * 2

  const cropped = await sharp(raw)
    .extract({ left: 0, top: barH, width: w, height: h - barH })
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer()

  return `data:image/jpeg;base64,${cropped.toString('base64')}`
}

export async function withLabelBar(imageSource: string, labelText: string): Promise<Buffer> {
  await initializeFonts()

  const response = await fetch(toFetchableUrl(imageSource))
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`)
  }

  const raw = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(raw).metadata()
  const width = meta.width || 2160
  const height = meta.height || 2160
  const fontSize = Math.floor(height * 0.04)
  const pad = Math.floor(fontSize * 0.5)
  const barHeight = fontSize + pad * 2
  const svg = await createLabelSVG(width, barHeight, fontSize, pad, labelText)

  return await sharp(raw)
    .extend({ top: barHeight, bottom: 0, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()
}

export async function uploadImageSourceToCos(
  source: string | Buffer,
  keyPrefix: string,
  targetId: string,
  job?: Job<TaskJobData>,
) {
  if (job) {
    return await withTaskAbortSignal(job, async (signal) => await processMediaResult({
      source,
      type: 'image',
      keyPrefix,
      targetId,
      signal,
    }))
  }
  return await processMediaResult({ source, type: 'image', keyPrefix, targetId })
}

export async function uploadVideoSourceToCos(
  source: string | Buffer,
  keyPrefix: string,
  targetId: string,
  downloadHeaders?: Record<string, string>,
  job?: Job<TaskJobData>,
) {
  if (job) {
    return await withTaskAbortSignal(job, async (signal) => await processMediaResult({
      source,
      type: 'video',
      keyPrefix,
      targetId,
      downloadHeaders,
      signal,
    }))
  }
  return await processMediaResult({ source, type: 'video', keyPrefix, targetId, downloadHeaders })
}

export async function uploadAudioSourceToCos(
  source: string | Buffer,
  keyPrefix: string,
  targetId: string,
  job?: Job<TaskJobData>,
) {
  if (job) {
    return await withTaskAbortSignal(job, async (signal) => await processMediaResult({
      source,
      type: 'audio',
      keyPrefix,
      targetId,
      signal,
    }))
  }
  return await processMediaResult({ source, type: 'audio', keyPrefix, targetId })
}

export function toSignedUrlIfCos(keyOrUrl: string | null | undefined, ttlSeconds = 3600) {
  if (!keyOrUrl) return null
  return keyOrUrl.startsWith('images/') || keyOrUrl.startsWith('voice/') || keyOrUrl.startsWith('video/')
    ? getSignedUrl(keyOrUrl, ttlSeconds)
    : keyOrUrl
}

export async function getProjectModels(projectId: string, userId: string) {
  return await getProjectModelConfig(projectId, userId)
}

export async function getUserModels(userId: string) {
  return await getUserModelConfig(userId)
}
