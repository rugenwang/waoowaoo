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
  resolution?: string // '480p' | '1024x576' | '1280x704' | '720p' | '1080p'
  aspectRatio?: string // '16:9' | '9:16'
  seed?: number
  random_seed?: boolean
  generationMode?: 'normal' | 'firstlastframe'
  lastFrameImageUrl?: string
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
    '1024x576': { w: 1024, h: 576 },
    '1280x704': { w: 1280, h: 704 },
    '720p': { w: 1280, h: 720 },
    '1080p': { w: 1920, h: 1080 },
  }
  const preset = mapping[resolution]
  if (!preset) return { width: 704, height: 480 }
  return isVertical ? { width: preset.h, height: preset.w } : { width: preset.w, height: preset.h }
}

function calcFrames(seconds: number, fps: number): number {
  // 与 ltx-2-mlx/ai-gen_backend/utils.py::calc_frames 保持一致：
  // frames = round(seconds * fps) + 1，最小 9，且满足 8k+1。
  let raw = Math.round(seconds * fps) + 1
  if (raw < 9) raw = 9
  if ((raw - 1) % 8 === 0) return raw
  const k = Math.floor((raw - 1 + 7) / 8)
  return 8 * k + 1
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

    const duration = typeof opt.duration === 'number' ? opt.duration : undefined
    const fps = typeof opt.fps === 'number' ? opt.fps : undefined

    // 注意：worker/utils.ts 在调用 generateVideo 前会过滤掉 generationMode 字段（仅用于 capability 校验），
    // 因此这里不能依赖 opt.generationMode 来判断 first/last-frame。
    // 只要存在 lastFrameImageUrl，就视为首尾帧模式。
    const isFirstLastFrame = typeof opt.lastFrameImageUrl === 'string' && opt.lastFrameImageUrl.trim().length > 0
    const keyframes = await (async () => {
      if (!isFirstLastFrame) {
        return [{ image: cover, frame_index: 0 }]
      }

      const lastFrame = await normalizeToBase64ForGeneration(opt.lastFrameImageUrl as string)
      const seconds = typeof duration === 'number' ? duration : 4
      const f = typeof fps === 'number' ? fps : 24
      const frames = calcFrames(seconds, f)
      const lastIdx = Math.max(0, frames - 1)
      return [
        { image: cover, frame_index: 0 },
        { image: lastFrame, frame_index: lastIdx },
      ]
    })()

    const response = await fetch(`${baseUrl}/api/integrations/waoowaoo/v1/video`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        prompt: prompt || '',
        keyframes,
        ...(typeof duration === 'number' ? { seconds: duration } : null),
        ...(typeof fps === 'number' ? { fps } : null),
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
