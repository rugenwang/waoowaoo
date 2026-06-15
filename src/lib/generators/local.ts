import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BaseImageGenerator, BaseVideoGenerator, type GenerateResult, type ImageGenerateParams, type VideoGenerateParams } from './base'
import { getProviderConfig } from '@/lib/api-config'
import { normalizeToBase64ForGeneration, normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'

type LocalImageOptions = {
  provider?: string
  modelId?: string
  modelKey?: string
  size?: string // e.g. "1024x1024"
  resolution?: string
  aspectRatio?: string
  n?: number
  image2apiModel?: string
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
  generationMode?: 'normal' | 'firstlastframe' | 'keyframes'
  lastFrameImageUrl?: string
  keyframes?: Array<{
    imageUrl?: string
    image?: string
    frameTimeSec?: number
    frameIndex?: number
  }>
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

function isAspectRatio(value?: string): boolean {
  return !!value && /^\d{1,2}:\d{1,2}$/.test(value.trim())
}

function inferKnownAspectRatio(value?: string): string | null {
  if (!value) return null
  const parsed = parseSize(value)
  if (!parsed) return null
  const ratio = parsed.width / parsed.height
  const candidates: Array<[string, number]> = [
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['4:3', 4 / 3],
    ['3:4', 3 / 4],
    ['3:2', 3 / 2],
    ['2:3', 2 / 3],
  ]
  const best = candidates
    .map(([label, target]) => ({ label, diff: Math.abs(target - ratio) }))
    .sort((left, right) => left.diff - right.diff)[0]
  return best && best.diff <= 0.04 ? best.label : null
}

function resolveImage2ApiCurlSize(options: LocalImageOptions): string {
  if (isAspectRatio(options.aspectRatio)) return options.aspectRatio!.trim()
  if (isAspectRatio(options.size)) return options.size!.trim()
  const fromSize = inferKnownAspectRatio(options.size)
  if (fromSize) return fromSize
  const fromResolution = inferKnownAspectRatio(options.resolution)
  if (fromResolution) return fromResolution
  return '16:9'
}

function dataUrlToImageBytes(dataUrl: string, index: number): { bytes: Buffer; mimeType: string; ext: string } {
  const marker = ';base64,'
  const markerIndex = dataUrl.indexOf(marker)
  if (!dataUrl.startsWith('data:') || markerIndex === -1) {
    throw new Error(`LOCAL_IMAGE2API_REFERENCE_INVALID: reference-${index}`)
  }
  const mimeType = dataUrl.slice(5, markerIndex) || 'image/png'
  const bytes = Buffer.from(dataUrl.slice(markerIndex + marker.length), 'base64')
  const ext = mimeType === 'image/jpeg' || mimeType === 'image/jpg'
    ? 'jpg'
    : mimeType === 'image/webp'
      ? 'webp'
      : mimeType === 'image/gif'
        ? 'gif'
        : 'png'
  return { bytes, mimeType, ext }
}

async function saveImage2ApiCurlReferencePaths(dataUrls: string[]): Promise<Array<{
  index: number
  path: string
  size: number
  sha256: string
  mimeType: string
}>> {
  if (dataUrls.length === 0) return []

  const requestDir = path.join(
    os.tmpdir(),
    'waoowaoo-image2api-curl-refs',
    `${Date.now()}-${crypto.randomUUID()}`,
  )
  await fs.mkdir(requestDir, { recursive: true })

  return await Promise.all(dataUrls.map(async (dataUrl, index) => {
    const part = dataUrlToImageBytes(dataUrl, index + 1)
    const sha256 = crypto.createHash('sha256').update(part.bytes).digest('hex')
    const filePath = path.join(requestDir, `${String(index + 1).padStart(2, '0')}_${sha256.slice(0, 12)}.${part.ext}`)
    await fs.writeFile(filePath, part.bytes)
    return {
      index: index + 1,
      path: filePath,
      size: part.bytes.length,
      sha256,
      mimeType: part.mimeType,
    }
  }))
}

function isImage2ApiCurlModel(modelId?: string): boolean {
  const normalized = (modelId || '').trim().toLowerCase()
  return normalized === 'local/image2api-curl' || normalized === 'image2api-curl'
}

function resolveVideoDims(options: LocalVideoOptions): { width?: number; height?: number } {
  const ratio = (options.aspectRatio || '').trim()
  const resolution = (options.resolution || '').trim()

  // 默认与 ai-gen_backend 保持一致
  if (!resolution) return { width: 704, height: 480 }

  const explicitSize = parseSize(resolution)
  if (explicitSize) return explicitSize

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

    if (isImage2ApiCurlModel(this.modelId)) {
      const referenceFiles = await saveImage2ApiCurlReferencePaths(normalizedRefs)
      const body = {
        model: opt.image2apiModel || 'gpt-image-2',
        prompt,
        n: typeof opt.n === 'number' && Number.isFinite(opt.n) ? Math.max(1, Math.min(4, Math.floor(opt.n))) : 1,
        size: resolveImage2ApiCurlSize(opt),
        response_format: 'url',
        reference_image_paths: referenceFiles.map((item) => item.path),
        reference_image_debug: referenceFiles,
      }

      const response = await fetch(`${baseUrl}/api/integrations/waoowaoo/v1/image2api/edits`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })

      const rawText = await response.text().catch(() => '')
      let data: unknown = null
      try {
        data = rawText ? JSON.parse(rawText) : null
      } catch {
        data = null
      }
      if (!response.ok) {
        const message = data && typeof data === 'object' && typeof (data as Record<string, unknown>).error === 'string'
          ? String((data as Record<string, unknown>).error)
          : rawText
        throw new Error(`LOCAL_IMAGE2API_CURL_REQUEST_FAILED: ${response.status} ${message}`.slice(0, 800))
      }

      const responseObject = data && typeof data === 'object'
        ? data as Record<string, unknown>
        : null
      const rows = responseObject && Array.isArray(responseObject.data)
        ? (responseObject.data as unknown[])
        : []
      const dataUrls = rows
        .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).url : null))
        .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
        .map((url) => url.trim())
      const directUrls = responseObject && Array.isArray(responseObject.urls)
        ? responseObject.urls
            .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
            .map((url) => url.trim())
        : []
      const imageUrls = dataUrls.length > 0 ? dataUrls : directUrls
      if (imageUrls.length === 0) {
        throw new Error(`LOCAL_IMAGE2API_CURL_EMPTY_RESPONSE: ${rawText.slice(0, 500)}`)
      }
      return {
        success: true,
        imageUrl: imageUrls[0],
        ...(imageUrls.length > 1 ? { imageUrls } : {}),
      }
    }

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
      const seconds = typeof duration === 'number' ? duration : 4
      const f = typeof fps === 'number' ? fps : 24
      const frameCount = calcFrames(seconds, f)
      const lastIdx = Math.max(0, frameCount - 1)

      if (Array.isArray(opt.keyframes) && opt.keyframes.length > 0) {
        const rows = opt.keyframes
          .map((item, index) => {
            const image = typeof item?.imageUrl === 'string' && item.imageUrl.trim()
              ? item.imageUrl.trim()
              : typeof item?.image === 'string' && item.image.trim()
                ? item.image.trim()
                : ''
            if (!image) return null
            const rawFrameIndex = typeof item.frameIndex === 'number' && Number.isFinite(item.frameIndex)
              ? item.frameIndex
              : typeof item.frameTimeSec === 'number' && Number.isFinite(item.frameTimeSec)
                ? Math.round(item.frameTimeSec * f)
                : index === 0
                  ? 0
                  : Math.round((index / Math.max(1, opt.keyframes!.length - 1)) * lastIdx)
            return {
              image,
              frame_index: Math.max(0, Math.min(lastIdx, Math.round(rawFrameIndex))),
            }
          })
          .filter((item): item is { image: string; frame_index: number } => item !== null)
          .sort((left, right) => left.frame_index - right.frame_index)

        if (rows.length > 0) {
          return await Promise.all(rows.map(async (row, index) => ({
            image: await normalizeToBase64ForGeneration(row.image),
            frame_index: index === 0 ? 0 : row.frame_index,
          })))
        }
      }

      if (!isFirstLastFrame) {
        return [{ image: cover, frame_index: 0 }]
      }

      const lastFrame = await normalizeToBase64ForGeneration(opt.lastFrameImageUrl as string)
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
