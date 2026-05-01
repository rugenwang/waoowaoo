import type { GenerateResult } from '@/lib/generators/base'
import type { OpenAICompatImageRequest } from '../types'
import {
  createOpenAICompatClient,
  readStringOption,
  resolveOpenAICompatClientConfig,
  toUploadFile,
} from './common'
import { publishTaskStreamEvent } from '@/lib/task/publisher'
import { createScopedLogger } from '@/lib/logging/core'

type OpenAIImageResponseFormat = 'url' | 'b64_json'
type OpenAIImageOutputFormat = 'png' | 'jpeg' | 'webp'
type OpenAIImageGenerateQuality = 'standard' | 'hd' | 'low' | 'medium' | 'high' | 'auto'
type OpenAIImageGenerateSize =
  | 'auto'
  | '1024x1024'
  | '1536x1024'
  | '1024x1536'
  | '256x256'
  | '512x512'
  | '1792x1024'
  | '1024x1792'

const OPENAI_IMAGE_OPTION_KEYS = new Set([
  'provider',
  'modelId',
  'modelKey',
  'n',
  'size',
  'resolution',
  'quality',
  'responseFormat',
  'outputFormat',
  // GPT-IMAGE-2 (img.dengche.cc) 扩展字段（OpenAI 兼容客户端可透传）
  'aspectRatio',
  'style',
  'background',
])

function assertAllowedOptions(options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue
    // 内部调试字段（不会透传到外部 API）
    if (key.startsWith('__')) continue
    if (!OPENAI_IMAGE_OPTION_KEYS.has(key)) {
      throw new Error(`OPENAI_COMPAT_IMAGE_OPTION_UNSUPPORTED: ${key}`)
    }
  }
}

type DebugMeta = {
  enabled: boolean
  taskId: string | null
  projectId: string | null
  taskType: string | null
  targetType: string | null
  targetId: string | null
  episodeId: string | null
}

function readDebugMeta(options: Record<string, unknown>): DebugMeta {
  const enabled = options.__debugPublishProviderRequest === true
  if (!enabled) {
    return {
      enabled: false,
      taskId: null,
      projectId: null,
      taskType: null,
      targetType: null,
      targetId: null,
      episodeId: null,
    }
  }
  const read = (key: string) => (typeof options[key] === 'string' ? String(options[key]).trim() : '')
  const taskId = read('__debugTaskId')
  const projectId = read('__debugProjectId')
  return {
    enabled: true,
    taskId: taskId || null,
    projectId: projectId || null,
    taskType: read('__debugTaskType') || null,
    targetType: read('__debugTargetType') || null,
    targetId: read('__debugTargetId') || null,
    episodeId: read('__debugEpisodeId') || null,
  }
}

function summarizeProviderResponse(response: unknown) {
  try {
    if (!response || typeof response !== 'object') return { type: typeof response, value: String(response) }
    const obj = response as Record<string, unknown>
    const data = obj.data
    if (Array.isArray(data)) {
      const first = data[0] as Record<string, unknown> | undefined
      const firstB64 = first && typeof first.b64_json === 'string' ? first.b64_json : null
      const firstUrl = first && typeof first.url === 'string' ? first.url : null
      return {
        created: obj.created,
        model: obj.model,
        dataLength: data.length,
        first: {
          hasB64: !!firstB64,
          b64Length: firstB64 ? firstB64.length : 0,
          hasUrl: !!firstUrl,
          url: firstUrl ? firstUrl.slice(0, 180) : null,
        },
        usage: obj.usage,
      }
    }
    return { keys: Object.keys(obj).slice(0, 30) }
  } catch (e) {
    return { error: `unreadable_response:${String(e)}` }
  }
}

function normalizeResponseFormat(value: unknown): OpenAIImageResponseFormat {
  const normalized = readStringOption(value, 'responseFormat')
  if (!normalized) return 'b64_json'
  if (normalized === 'url' || normalized === 'b64_json') return normalized
  throw new Error(`OPENAI_COMPAT_IMAGE_OPTION_UNSUPPORTED: responseFormat=${normalized}`)
}

function normalizeOutputFormat(value: unknown): OpenAIImageOutputFormat | undefined {
  const normalized = readStringOption(value, 'outputFormat')
  if (!normalized) return undefined
  if (normalized === 'png' || normalized === 'jpeg' || normalized === 'webp') return normalized
  throw new Error(`OPENAI_COMPAT_IMAGE_OPTION_UNSUPPORTED: outputFormat=${normalized}`)
}

function readBooleanOption(value: unknown, optionName: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
  }
  throw new Error(`OPENAI_COMPAT_OPTION_INVALID: ${optionName}`)
}

function normalizeGenerateQuality(value: unknown): OpenAIImageGenerateQuality | undefined {
  const normalized = readStringOption(value, 'quality')
  if (!normalized) return undefined
  if (
    normalized === 'standard'
    || normalized === 'hd'
    || normalized === 'low'
    || normalized === 'medium'
    || normalized === 'high'
    || normalized === 'auto'
  ) {
    return normalized
  }
  throw new Error(`OPENAI_COMPAT_IMAGE_OPTION_UNSUPPORTED: quality=${normalized}`)
}

function normalizeN(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(n)) {
    throw new Error('OPENAI_COMPAT_IMAGE_OPTION_INVALID: n')
  }
  const normalized = Math.floor(n)
  if (normalized < 1 || normalized > 10) {
    throw new Error('OPENAI_COMPAT_IMAGE_OPTION_INVALID: n must be between 1 and 10')
  }
  return normalized
}

function normalizeOpenAIImageSize(value: string | undefined): OpenAIImageGenerateSize | undefined {
  if (!value) return undefined
  if (
    value === 'auto'
    || value === '1024x1024'
    || value === '1536x1024'
    || value === '1024x1536'
    || value === '256x256'
    || value === '512x512'
    || value === '1792x1024'
    || value === '1024x1792'
  ) {
    return value
  }
  throw new Error(`OPENAI_COMPAT_IMAGE_OPTION_UNSUPPORTED: size=${value}`)
}

function isEeeApiProvider(providerId: string): boolean {
  const normalized = (providerId || '').toLowerCase()
  return normalized === 'eeeapi' || normalized.startsWith('eeeapi:')
}

function aspectRatioToEeeApiSize(aspectRatio: string): string | undefined {
  const ratio = aspectRatio.trim()
  const mapping: Record<string, string> = {
    '1:1': '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
  }
  return mapping[ratio]
}

function buildExtraBody(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const aspectRatio = readStringOption(options.aspectRatio, 'aspectRatio')
  const style = readStringOption(options.style, 'style')
  const background = readBooleanOption(options.background, 'background')
  const extra: Record<string, unknown> = {}
  if (aspectRatio) extra.aspect_ratio = aspectRatio
  if (style) extra.style = style
  if (background !== undefined) extra.background = background
  return Object.keys(extra).length > 0 ? extra : undefined
}

function resolveRawSize(options: Record<string, unknown>): string | undefined {
  const size = readStringOption(options.size, 'size')
  const resolution = readStringOption(options.resolution, 'resolution')
  if (size && resolution && size !== resolution) {
    throw new Error('OPENAI_COMPAT_IMAGE_OPTION_CONFLICT: size and resolution must match')
  }
  return size || resolution
}

function resolveModelId(modelId: string | undefined, options: Record<string, unknown>): string {
  const optionModelId = readStringOption(options.modelId, 'modelId')
  const selected = (modelId || optionModelId || '').trim()
  if (selected) return selected
  return 'gpt-image-1'
}

function toMimeFromOutputFormat(outputFormat: string | undefined): string {
  if (outputFormat === 'jpeg' || outputFormat === 'jpg') return 'image/jpeg'
  if (outputFormat === 'webp') return 'image/webp'
  return 'image/png'
}

interface ImagePayloads {
  /** 第一张图的 base64（向后兼容） */
  b64Json: string | null
  /** 第一张图的 URL（向后兼容） */
  url: string | null
  /** 所有图的 URL 列表（接口返回多张时有值） */
  urls: string[]
}

function readAllImagePayloads(response: unknown): ImagePayloads {
  if (typeof response !== 'object' || response === null) {
    return { b64Json: null, url: null, urls: [] }
  }
  const data = (response as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    return { b64Json: null, url: null, urls: [] }
  }

  const urls: string[] = []
  let firstB64: string | null = null

  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const rawUrl = (item as { url?: unknown }).url
    const rawB64 = (item as { b64_json?: unknown }).b64_json
    if (typeof rawUrl === 'string' && rawUrl.trim()) {
      urls.push(rawUrl.trim())
    }
    if (firstB64 === null && typeof rawB64 === 'string' && rawB64.trim()) {
      firstB64 = rawB64.trim()
    }
  }

  return {
    b64Json: firstB64,
    url: urls[0] ?? null,
    urls,
  }
}

function summarizeEmptyImageResponse(response: unknown): string {
  try {
    if (!response || typeof response !== 'object') return String(response)
    const obj = response as Record<string, unknown>
    const detail = typeof obj.detail === 'string' ? obj.detail : null
    if (detail) return `detail=${detail}`
    const data = obj.data
    if (!Array.isArray(data)) {
      return `keys=[${Object.keys(obj).slice(0, 20).join(',')}], dataType=${typeof data}`
    }
    const first = data[0]
    const firstKeys = first && typeof first === 'object' && !Array.isArray(first)
      ? Object.keys(first as Record<string, unknown>).slice(0, 20).join(',')
      : typeof first
    return `keys=[${Object.keys(obj).slice(0, 20).join(',')}], data.length=${data.length}, firstKeys=${firstKeys}`
  } catch (e) {
    return `unreadable_response:${String(e)}`
  }
}

export async function generateImageViaOpenAICompat(request: OpenAICompatImageRequest): Promise<GenerateResult> {
  const {
    userId,
    providerId,
    modelId,
    prompt,
    referenceImages = [],
    options = {},
  } = request

  const debug = readDebugMeta(options)
  // 对 GPT-IMAGE-2（eeeapi）做兼容：
  // - 允许任意 WxH 尺寸（服务端会校验边长/比例/像素范围）
  // - 对常见比例（1:1 / 3:2 等）优先用 size 落地，避免 extra_body.aspect_ratio 兼容性差导致“点了没反应/直接失败”
  const effectiveOptions: Record<string, unknown> = { ...options }
  if (isEeeApiProvider(providerId)) {
    const rawAspectRatio = readStringOption(effectiveOptions.aspectRatio, 'aspectRatio')
    const rawSize = resolveRawSize(effectiveOptions)
    if (rawAspectRatio) {
      const mapped = aspectRatioToEeeApiSize(rawAspectRatio)
      if (mapped) {
        effectiveOptions.size = mapped
        // 关键：避免出现 aspectRatio=1:1 但 resolution=1024x1536 这类冲突组合
        // eeeapi 对 /v1/images/generations 的 size 有固定枚举，直接用映射后的 size 最稳定
        delete effectiveOptions.aspectRatio
        delete effectiveOptions.resolution
      }
    }
  }

  assertAllowedOptions(effectiveOptions)
  const config = await resolveOpenAICompatClientConfig(userId, providerId)
  const client = createOpenAICompatClient(config)
  const logger = createScopedLogger({
    module: 'openai-compat-image',
    action: 'provider.call',
    projectId: debug.projectId || undefined,
    taskId: debug.taskId || undefined,
    userId,
  })

  const normalizedModelId = resolveModelId(modelId, effectiveOptions)
  const responseFormat = normalizeResponseFormat(effectiveOptions.responseFormat)
  const outputFormat = normalizeOutputFormat(effectiveOptions.outputFormat)
  const quality = normalizeGenerateQuality(effectiveOptions.quality)
  const rawSize = resolveRawSize(effectiveOptions)
  const size = isEeeApiProvider(providerId)
    ? (rawSize
      ? (rawSize === 'auto' || /^\d{2,5}x\d{2,5}$/.test(rawSize)
        ? rawSize
        : (() => { throw new Error(`OPENAI_COMPAT_IMAGE_OPTION_UNSUPPORTED: size=${rawSize}`) })())
      : undefined)
    : normalizeOpenAIImageSize(rawSize)
  const n = normalizeN(effectiveOptions.n)
  const extraBody = buildExtraBody(effectiveOptions)
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${referenceImages.length > 0 ? '/images/edits' : '/images/generations'}`

  const publishDebug = async (payload: Record<string, unknown>) => {
    if (!debug.enabled || !debug.taskId || !debug.projectId) return
    await publishTaskStreamEvent({
      taskId: debug.taskId,
      projectId: debug.projectId,
      userId,
      taskType: debug.taskType,
      targetType: debug.targetType,
      targetId: debug.targetId,
      episodeId: debug.episodeId,
      payload,
      persist: true,
    })
  }

  await publishDebug({
    kind: 'provider_request',
    provider: providerId,
    endpoint,
    method: 'POST',
    body: {
      model: normalizedModelId,
      promptLength: typeof prompt === 'string' ? prompt.length : 0,
      response_format: responseFormat,
      ...(typeof n === 'number' ? { n } : {}),
      ...(quality ? { quality } : {}),
      ...(size ? { size } : {}),
      ...(outputFormat ? { output_format: outputFormat } : {}),
      ...(extraBody ? { extra_body: extraBody } : {}),
      ...(referenceImages.length > 0 ? { imageCount: referenceImages.length } : null),
    },
  })

  // ✅ 兜底：有些环境会禁用 STREAM（STREAM_EPHEMERAL_ENABLED=false），导致看不到 task.stream。
  // 这里在 debug 模式下同步打印到服务端启动命令行，方便直接排查 provider/baseUrl/入参。
  if (debug.enabled) {
    logger.info({
      message: 'provider_request',
      details: {
        provider: providerId,
        endpoint,
        body: {
          model: normalizedModelId,
          prompt: typeof prompt === 'string' ? (prompt.length > 600 ? `${prompt.slice(0, 600)}…(truncated)` : prompt) : null,
          response_format: responseFormat,
          ...(typeof n === 'number' ? { n } : {}),
          ...(quality ? { quality } : {}),
          ...(size ? { size } : {}),
          ...(outputFormat ? { output_format: outputFormat } : {}),
          ...(extraBody ? { extra_body: extraBody } : {}),
          ...(referenceImages.length > 0 ? { imageCount: referenceImages.length } : null),
        },
      },
    })
  }

  try {
    if (referenceImages.length > 0) {
      const response = await client.images.edit({
        model: normalizedModelId,
        prompt,
        image: await Promise.all(referenceImages.map((image, index) => toUploadFile(image, index))),
        response_format: responseFormat,
        ...(typeof n === 'number' ? { n } : {}),
        ...(outputFormat ? { output_format: outputFormat } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(extraBody ? { extra_body: extraBody } : {}),
      } as unknown as Parameters<typeof client.images.edit>[0])

      await publishDebug({
        kind: 'provider_response',
        provider: providerId,
        endpoint,
        ok: true,
        response: summarizeProviderResponse(response),
      })
      if (debug.enabled) {
        logger.info({
          message: 'provider_response',
          details: {
            provider: providerId,
            endpoint,
            ok: true,
            response: summarizeProviderResponse(response),
          },
        })
      }

      const imagePayload = readAllImagePayloads(response)
      const imageBase64 = imagePayload.b64Json
      if (typeof imageBase64 === 'string' && imageBase64.trim().length > 0) {
        const mimeType = toMimeFromOutputFormat(outputFormat)
        return {
          success: true,
          imageBase64,
          imageUrl: `data:${mimeType};base64,${imageBase64}`,
        }
      }
      const imageUrl = imagePayload.url
      if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
        return {
          success: true,
          imageUrl,
          ...(imagePayload.urls.length > 1 ? { imageUrls: imagePayload.urls } : {}),
        }
      }
      throw new Error(`OPENAI_COMPAT_IMAGE_EMPTY_RESPONSE: no image data returned (${summarizeEmptyImageResponse(response)})`)
    }

    const response = await client.images.generate({
      model: normalizedModelId,
      prompt,
      response_format: responseFormat,
      ...(typeof n === 'number' ? { n } : {}),
      ...(outputFormat ? { output_format: outputFormat } : {}),
      ...(quality ? { quality } : {}),
      ...(size ? { size } : {}),
      ...(extraBody ? { extra_body: extraBody } : {}),
    } as unknown as Parameters<typeof client.images.generate>[0])

    await publishDebug({
      kind: 'provider_response',
      provider: providerId,
      endpoint,
      ok: true,
      response: summarizeProviderResponse(response),
    })
    if (debug.enabled) {
      logger.info({
        message: 'provider_response',
        details: {
          provider: providerId,
          endpoint,
          ok: true,
          response: summarizeProviderResponse(response),
        },
      })
    }

    const imagePayload = readAllImagePayloads(response)
    const imageBase64 = imagePayload.b64Json
    if (typeof imageBase64 === 'string' && imageBase64.trim().length > 0) {
      const mimeType = toMimeFromOutputFormat(outputFormat)
      return {
        success: true,
        imageBase64,
        imageUrl: `data:${mimeType};base64,${imageBase64}`,
      }
    }
    const imageUrl = imagePayload.url
    if (typeof imageUrl === 'string' && imageUrl.trim().length > 0) {
      return {
        success: true,
        imageUrl,
        ...(imagePayload.urls.length > 1 ? { imageUrls: imagePayload.urls } : {}),
      }
    }
    throw new Error(`OPENAI_COMPAT_IMAGE_EMPTY_RESPONSE: no image data returned (${summarizeEmptyImageResponse(response)})`)
  } catch (error) {
    await publishDebug({
      kind: 'provider_response',
      provider: providerId,
      endpoint,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
    if (debug.enabled) {
      logger.error({
        message: 'provider_response',
        details: {
          provider: providerId,
          endpoint,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
    throw error
  }
}
