export type ImageGenerationCountScope =
  | 'character'
  | 'location'
  | 'storyboard-candidates'
  | 'reference-to-character'

interface ImageGenerationCountConfig {
  defaultValue: number
  min: number
  max: number
  storageKey: string
}

const IMAGE_GENERATION_COUNT_CONFIG: Record<ImageGenerationCountScope, ImageGenerationCountConfig> = {
  character: {
    // 资产库默认生成 1 张即可；需要更多可手动调整
    defaultValue: 1,
    min: 1,
    max: 6,
    // bump key to reset previous default (3) for existing users
    storageKey: 'image-count:v2:character',
  },
  location: {
    // 资产库默认生成 1 张即可；需要更多可手动调整
    defaultValue: 1,
    min: 1,
    max: 6,
    storageKey: 'image-count:v2:location',
  },
  'storyboard-candidates': {
    defaultValue: 1,
    min: 1,
    max: 4,
    storageKey: 'image-count:storyboard-candidates',
  },
  'reference-to-character': {
    defaultValue: 1,
    min: 1,
    max: 6,
    storageKey: 'image-count:v2:reference-to-character',
  },
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

export function getImageGenerationCountConfig(scope: ImageGenerationCountScope): ImageGenerationCountConfig {
  return IMAGE_GENERATION_COUNT_CONFIG[scope]
}

export function normalizeImageGenerationCount(
  scope: ImageGenerationCountScope,
  value: unknown,
  fallback = getImageGenerationCountConfig(scope).defaultValue,
): number {
  const config = getImageGenerationCountConfig(scope)
  const numericValue = toFiniteNumber(value)
  const baseValue = numericValue === null ? fallback : Math.trunc(numericValue)
  if (baseValue < config.min) return config.min
  if (baseValue > config.max) return config.max
  return baseValue
}

export function getImageGenerationCountOptions(scope: ImageGenerationCountScope): number[] {
  const config = getImageGenerationCountConfig(scope)
  return Array.from(
    { length: config.max - config.min + 1 },
    (_value, index) => config.min + index,
  )
}

export function getImageGenerationCountStorageKey(scope: ImageGenerationCountScope): string {
  return getImageGenerationCountConfig(scope).storageKey
}
