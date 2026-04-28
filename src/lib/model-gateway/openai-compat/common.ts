import OpenAI, { toFile } from 'openai'
import { getProviderConfig } from '@/lib/api-config'
import { getInternalBaseUrl } from '@/lib/env'
import { getImageBase64Cached } from '@/lib/image-cache'
import type { OpenAICompatClientConfig } from '../types'

function toAbsoluteUrlIfNeeded(value: string): string {
  if (!value.startsWith('/')) return value
  const baseUrl = getInternalBaseUrl()
  return `${baseUrl}${value}`
}

export function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const marker = ';base64,'
  const markerIndex = value.indexOf(marker)
  if (!value.startsWith('data:') || markerIndex === -1) return null
  const mimeType = value.slice(5, markerIndex)
  const base64 = value.slice(markerIndex + marker.length)
  if (!mimeType || !base64) return null
  return { mimeType, base64 }
}

export function readStringOption(value: unknown, optionName: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`OPENAI_COMPAT_OPTION_INVALID: ${optionName}`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`OPENAI_COMPAT_OPTION_INVALID: ${optionName}`)
  }
  return trimmed
}

export async function resolveOpenAICompatClientConfig(userId: string, providerId: string): Promise<OpenAICompatClientConfig> {
  const config = await getProviderConfig(userId, providerId)
  if (!config.baseUrl) {
    throw new Error(`PROVIDER_BASE_URL_MISSING: ${config.id}`)
  }
  const rawBaseUrl = String(config.baseUrl || '').trim()
  const normalizedBaseUrl = (() => {
    const trimmed = rawBaseUrl.replace(/\/+$/, '')
    // GPT Image 2（eeeapi）要求 SDK 直连 api.img.dengche.cc/v1，避免 CDN/前端页面导致的 HTML 响应。
    if (providerId === 'eeeapi' || config.id === 'eeeapi') {
      // 用户可能填了浏览器入口 img.dengche.cc，或漏掉 /v1
      if (/^https?:\/\/img\.dengche\.cc(\/.*)?$/i.test(trimmed)) {
        return 'https://api.img.dengche.cc/v1'
      }
      if (/^https?:\/\/api\.img\.dengche\.cc$/i.test(trimmed)) {
        return 'https://api.img.dengche.cc/v1'
      }
      if (/^https?:\/\/api\.img\.dengche\.cc\/v1\/?$/i.test(trimmed)) {
        return 'https://api.img.dengche.cc/v1'
      }
      // api.img.dengche.cc 但路径不是 /v1，补齐
      if (/^https?:\/\/api\.img\.dengche\.cc(\/.*)?$/i.test(trimmed) && !/\/v1(\/|$)/i.test(trimmed)) {
        return `${trimmed}/v1`
      }
    }
    return trimmed
  })()
  return {
    providerId: config.id,
    baseUrl: normalizedBaseUrl,
    apiKey: config.apiKey,
  }
}

export function createOpenAICompatClient(config: OpenAICompatClientConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  })
}

export async function toUploadFile(imageSource: string, index: number): Promise<File> {
  const parsedDataUrl = parseDataUrl(imageSource)
  if (parsedDataUrl) {
    const bytes = Buffer.from(parsedDataUrl.base64, 'base64')
    return await toFile(bytes, `reference-${index}.png`, { type: parsedDataUrl.mimeType })
  }

  if (imageSource.startsWith('http://') || imageSource.startsWith('https://') || imageSource.startsWith('/')) {
    const cachedDataUrl = await getImageBase64Cached(toAbsoluteUrlIfNeeded(imageSource))
    const parsedCached = parseDataUrl(cachedDataUrl)
    if (!parsedCached) {
      throw new Error(`OPENAI_COMPAT_REFERENCE_INVALID: failed to parse image source ${index}`)
    }
    const bytes = Buffer.from(parsedCached.base64, 'base64')
    return await toFile(bytes, `reference-${index}.png`, { type: parsedCached.mimeType })
  }

  const bytes = Buffer.from(imageSource, 'base64')
  return await toFile(bytes, `reference-${index}.png`, { type: 'image/png' })
}
