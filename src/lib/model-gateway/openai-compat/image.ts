import type { GenerateResult } from '@/lib/generators/base'
import type { OpenAICompatImageRequest } from '../types'
import {
  createOpenAICompatClient,
  readStringOption,
  resolveOpenAICompatClientConfig,
  toUploadFile,
} from './common'

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

export async function generateImageViaOpenAICompat(request: OpenAICompatImageRequest): Promise<GenerateResult> {
  const {
    userId,
    providerId,
    modelId,
    prompt,
    referenceImages = [],
    options = {},
  } = request

  assertAllowedOptions(options)
  const config = await resolveOpenAICompatClientConfig(userId, providerId)
  const client = createOpenAICompatClient(config)

  const normalizedModelId = resolveModelId(modelId, options)
  const responseFormat = normalizeResponseFormat(options.responseFormat)
  const outputFormat = normalizeOutputFormat(options.outputFormat)
  const quality = normalizeGenerateQuality(options.quality)
  const rawSize = resolveRawSize(options)
  const size = normalizeOpenAIImageSize(rawSize)
  const n = normalizeN(options.n)
  const extraBody = buildExtraBody(options)

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
    throw new Error('OPENAI_COMPAT_IMAGE_EMPTY_RESPONSE: no image data returned')
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
  throw new Error('OPENAI_COMPAT_IMAGE_EMPTY_RESPONSE: no image data returned')
}
