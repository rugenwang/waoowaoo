import { BaseImageGenerator, type GenerateResult, type ImageGenerateParams } from '../base'
import { getProviderConfig } from '@/lib/api-config'
import { normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'
import { publishTaskStreamEvent } from '@/lib/task/publisher'

type EeeApiImageOptions = {
  provider?: string
  modelId?: string
  modelKey?: string
  size?: string // e.g. "1024x1024"
  n?: number
  __debugTaskId?: string
  __debugProjectId?: string
  __debugTaskType?: string
  __debugTargetType?: string
  __debugTargetId?: string
  __debugEpisodeId?: string | null
  __debugPublishProviderRequest?: boolean
}

function requireBaseUrl(baseUrl: string | undefined): string {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim().replace(/\/+$/, '') : ''
  return raw || 'https://eeeapi.com'
}

function resolveEndpoint(baseUrl: string): string {
  // Accept:
  // - https://eeeapi.com -> /v1/images/generations
  // - https://eeeapi.com/v1 -> /images/generations
  // - https://eeeapi.com/v1/ -> /images/generations
  // - https://eeeapi.com/v1/images/generations -> use as-is
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/v1/images/generations')) return normalized
  if (normalized.includes('/v1/images/generations')) {
    // If user accidentally pasted a longer path, best-effort keep it
    return normalized
  }
  return normalized.endsWith('/v1')
    ? `${normalized}/images/generations`
    : `${normalized}/v1/images/generations`
}

function mimeFromFormat(format: string | undefined): string {
  const f = (format || '').trim().toLowerCase()
  if (f === 'jpg' || f === 'jpeg') return 'image/jpeg'
  if (f === 'webp') return 'image/webp'
  return 'image/png'
}

function embedReferenceImagesIntoPrompt(prompt: string, referenceImages: string[]): string {
  const cleanPrompt = (prompt || '').trim()
  if (!referenceImages || referenceImages.length === 0) return cleanPrompt

  // eeeApi 约定：把参考图 base64 data url “嵌进 prompt”
  // 形如：data1:image/jpeg;base64,xxxx；data2:image/jpeg;base64,yyyy，<text prompt>
  const chunks: string[] = []
  for (let i = 0; i < referenceImages.length; i += 1) {
    const raw = String(referenceImages[i] || '').trim()
    if (!raw) continue
    if (raw.startsWith('data:')) {
      chunks.push(`data${chunks.length + 1}:${raw.slice('data:'.length)}`)
    } else {
      // 兜底：如果不是 data url，也按原样塞进去（方便排错）
      chunks.push(`data${chunks.length + 1}:${raw}`)
    }
  }
  if (chunks.length === 0) return cleanPrompt
  return `${chunks.join('；')}，${cleanPrompt}`.trim()
}

function redactPromptForLog(prompt: string): string {
  const text = (prompt || '').trim()
  if (!text) return ''
  // 把 dataN:*;base64,<...> 替换为 <omitted>，避免控制台打印超长/敏感数据
  const redacted = text.replace(
    /data(\d+):([^;,\s]+);base64,([A-Za-z0-9+/=_-]+)/g,
    (_match, idx, mime) => `data${idx}:${mime};base64,<omitted>`,
  )
  // 再做一次长度上限保护
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…(truncated)` : redacted
}

export class EeeApiImageGenerator extends BaseImageGenerator {
  private readonly modelId?: string
  private readonly providerId?: string

  constructor(modelId?: string, providerId?: string) {
    super()
    this.modelId = modelId
    this.providerId = providerId
  }

  protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
    const { userId, prompt, referenceImages = [], options = {} } = params
    const providerId = this.providerId || 'eeeapi'
    const providerConfig = await getProviderConfig(userId, providerId)

    const baseUrl = requireBaseUrl(providerConfig.baseUrl)
    const endpoint = resolveEndpoint(baseUrl)
    const token = providerConfig.apiKey
    if (!token) throw new Error(`PROVIDER_API_KEY_MISSING: ${providerId}`)

    const opt = options as EeeApiImageOptions
    const model = (this.modelId || opt.modelId || '').trim() || 'gpt-image-1'

    // 统一把参考图转成 base64 data url，再按 eeeApi 规则嵌进 prompt
    const normalizedRefs = await normalizeReferenceImagesForGeneration(referenceImages)
    const finalPrompt = embedReferenceImagesIntoPrompt(prompt, normalizedRefs)

    const n = typeof opt.n === 'number' && Number.isFinite(opt.n) ? Math.max(1, Math.floor(opt.n)) : 1
    const size = typeof opt.size === 'string' && opt.size.trim() ? opt.size.trim() : '1024x1024'

    const requestBody = {
      model,
      prompt: finalPrompt,
      n,
      size,
    }
    const requestBodyForLog = {
      ...requestBody,
      prompt: redactPromptForLog(requestBody.prompt),
    }
    // 注意：项目默认 LOG_LEVEL=ERROR，logInfo 可能不会输出。
    // 这里用 console.log 强制打印，便于排查请求是否符合 eeeapi 预期。
    console.log('[EEEAPI Image] endpoint:', endpoint)
    console.log('[EEEAPI Image] request json:', JSON.stringify(requestBodyForLog, null, 2))
    console.log('[EEEAPI Image] meta:', JSON.stringify({
      referenceImagesCount: normalizedRefs.length,
      promptLength: finalPrompt.length,
    }, null, 2))

    // 同步把最终请求（脱敏后）写入 task stream，方便你在控制台的 generator_request 附近对照查看
    if (
      opt.__debugPublishProviderRequest === true
      && typeof opt.__debugTaskId === 'string'
      && typeof opt.__debugProjectId === 'string'
      && opt.__debugTaskId
      && opt.__debugProjectId
    ) {
      await publishTaskStreamEvent({
        taskId: opt.__debugTaskId,
        projectId: opt.__debugProjectId,
        userId,
        taskType: typeof opt.__debugTaskType === 'string' ? opt.__debugTaskType : null,
        targetType: typeof opt.__debugTargetType === 'string' ? opt.__debugTargetType : null,
        targetId: typeof opt.__debugTargetId === 'string' ? opt.__debugTargetId : null,
        episodeId: typeof opt.__debugEpisodeId === 'string' ? opt.__debugEpisodeId : null,
        payload: {
          kind: 'provider_request',
          mediaType: 'image',
          provider: 'eeeapi',
          endpoint,
          request: requestBodyForLog,
        },
        persist: true,
      })
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 某些网关/风控会对缺少 UA/Accept 的请求做拦截或降级
        accept: 'application/json',
        'user-agent': 'curl/8.0 (waoowaoo)',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    })

    const rawText = await response.text().catch(() => '')
    let payload: unknown = null
    try { payload = JSON.parse(rawText) } catch { payload = null }

    if (!response.ok) {
      const extra = `endpoint=${endpoint}`
      throw new Error(`EEEAPI_IMAGE_REQUEST_FAILED: ${response.status} ${extra} ${rawText}`.slice(0, 900))
    }

    const data = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
    const first = Array.isArray(data?.data) ? (data?.data as unknown[])[0] : null
    const b64 = first && typeof first === 'object' && !Array.isArray(first)
      ? (first as Record<string, unknown>).b64_json
      : null
    const b64Str = typeof b64 === 'string' ? b64.trim() : ''
    if (!b64Str) {
      throw new Error('EEEAPI_IMAGE_RESPONSE_B64_MISSING')
    }

    const mime = mimeFromFormat(typeof data?.output_format === 'string' ? String(data.output_format) : undefined)
    return {
      success: true,
      imageBase64: `data:${mime};base64,${b64Str}`,
    }
  }
}
