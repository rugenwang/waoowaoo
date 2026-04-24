import { BaseImageGenerator, BaseVideoGenerator, type GenerateResult, type ImageGenerateParams, type VideoGenerateParams } from './base'
import { getProviderConfig } from '@/lib/api-config'
import { normalizeToBase64ForGeneration, normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'

type LocalImageOptions = {
  provider?: string
  modelId?: string
  modelKey?: string
  size?: string // e.g. "1024x1024"
  steps?: number
  guidance?: number
  seed?: number
  random_seed?: boolean
}

type LocalVideoOptions = {
  provider?: string
  modelId?: string
  modelKey?: string
  duration?: number
  fps?: number
  resolution?: string // '480p' | '720p' | '1080p'
  aspectRatio?: string // '16:9' | '9:16'
  seed?: number
  random_seed?: boolean
}

function requireBaseUrl(baseUrl: string | undefined, providerId: string): string {
  const value = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  if (!value) throw new Error(`PROVIDER_BASE_URL_MISSING: ${providerId}`)
  return value
}

function base64UrlEncode(value: string): string {
  return Buffer
    .from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function parseSize(size?: string): { width: number; height: number } | null {
  if (!size) return null
  const raw = String(size).trim()
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(raw)
  if (!match) return null
  return { width: Number(match[1]), height: Number(match[2]) }
}

function resolveVideoDims(options: LocalVideoOptions): { width?: number; height?: number } {
  const ratio = (options.aspectRatio || '').trim()
  const resolution = (options.resolution || '').trim()

  // 默认与 ai-gen_backend 保持一致
  if (!resolution) return { width: 704, height: 480 }

  const isVertical = ratio === '9:16'
  const mapping: Record<string, { w: number; h: number }> = {
    '480p': { w: 704, h: 480 },
    '720p': { w: 1280, h: 720 },
    '1080p': { w: 1920, h: 1080 },
  }
  const preset = mapping[resolution]
  if (!preset) return { width: 704, height: 480 }
  return isVertical ? { width: preset.h, height: preset.w } : { width: preset.w, height: preset.h }
}

export class LocalImageGenerator extends BaseImageGenerator {
  private readonly modelId?: string
  private readonly providerId?: string

  constructor(modelId?: string, providerId?: string) {
    super()
    this.modelId = modelId
    this.providerId = providerId
  }

  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params
    const providerId = this.providerId || 'local'
    const providerConfig = await getProviderConfig(userId, providerId)
    const baseUrl = requireBaseUrl(providerConfig.baseUrl, providerId)
    const token = providerConfig.apiKey

    const normalizedRefs = await normalizeReferenceImagesForGeneration(referenceImages)
    const opt = options as LocalImageOptions
    const size = parseSize(opt.size)

    const response = await fetch(`${baseUrl}/api/integrations/waoowaoo/v1/image`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        prompt,
        reference_images: normalizedRefs,
        ...(size ? { width: size.width, height: size.height } : null),
        ...(typeof opt.steps === 'number' ? { steps: opt.steps } : null),
        ...(typeof opt.guidance === 'number' ? { guidance: opt.guidance } : null),
        // wo -> ltx 生图：每次请求都强制更换随机 seed（文生图/图生图一致）
        random_seed: true,
        // 预留：未来可用 modelId 做后端路由（当前 ai-gen_backend 仅一套本地模型）
        ...(this.modelId ? { model_id: this.modelId } : null),
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LOCAL_IMAGE_REQUEST_FAILED: ${response.status} ${text}`.slice(0, 500))
    }

    const data: unknown = await response.json().catch(() => null)
    const taskId =
      data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).task_id === 'string'
        ? String((data as Record<string, unknown>).task_id)
        : ''
    if (!taskId) throw new Error('LOCAL_IMAGE_TASK_ID_MISSING')

    const providerToken = base64UrlEncode(providerId)
    return {
      success: true,
      async: true,
      requestId: taskId,
      externalId: `LOCAL:IMAGE:${providerToken}:${taskId}`,
    }
  }
}

export class LocalVideoGenerator extends BaseVideoGenerator {
  private readonly providerId?: string

  constructor(providerId?: string) {
    super()
    this.providerId = providerId
  }

  protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
    const { userId, imageUrl, prompt = '', options = {} } = params
    const providerId = this.providerId || 'local'
    const providerConfig = await getProviderConfig(userId, providerId)
    const baseUrl = requireBaseUrl(providerConfig.baseUrl, providerId)
    const token = providerConfig.apiKey

    const cover = await normalizeToBase64ForGeneration(imageUrl)
    const opt = options as LocalVideoOptions
    const dims = resolveVideoDims(opt)

    const response = await fetch(`${baseUrl}/api/integrations/waoowaoo/v1/video`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        prompt: prompt || '',
        keyframes: [{ image: cover, frame_index: 0 }],
        ...(typeof opt.duration === 'number' ? { seconds: opt.duration } : null),
        ...(typeof opt.fps === 'number' ? { fps: opt.fps } : null),
        ...(typeof dims.width === 'number' ? { width: dims.width } : null),
        ...(typeof dims.height === 'number' ? { height: dims.height } : null),
        ...(typeof opt.seed === 'number' ? { seed: opt.seed } : null),
        ...(typeof opt.random_seed === 'boolean' ? { random_seed: opt.random_seed } : null),
      }),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`LOCAL_VIDEO_REQUEST_FAILED: ${response.status} ${text}`.slice(0, 500))
    }

    const data: unknown = await response.json().catch(() => null)
    const taskId =
      data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, unknown>).task_id === 'string'
        ? String((data as Record<string, unknown>).task_id)
        : ''
    if (!taskId) throw new Error('LOCAL_VIDEO_TASK_ID_MISSING')

    const providerToken = base64UrlEncode(providerId)
    return {
      success: true,
      async: true,
      requestId: taskId,
      externalId: `LOCAL:VIDEO:${providerToken}:${taskId}`,
    }
  }
}
