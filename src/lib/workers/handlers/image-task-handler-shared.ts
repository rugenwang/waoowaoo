import { type Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { type TaskJobData } from '@/lib/task/types'
import { decodeImageUrlsFromDb } from '@/lib/contracts/image-urls-contract'
import {
  assertTaskActive,
  resolveImageSourceFromGeneration,
  toSignedUrlIfCos,
  uploadImageSourceToCos,
  withLabelBar,
} from '../utils'

export type AnyObj = Record<string, unknown>

interface CharacterAppearanceLike {
  appearanceIndex?: number
  changeReason: string | null
  description?: string | null
  descriptions?: string | null
  imageUrls: string | null
  imageUrl: string | null
  selectedIndex: number | null
}

interface CharacterLike {
  name: string
  appearances?: CharacterAppearanceLike[]
}

const DEFAULT_APPEARANCE_NAMES = new Set(['初始形象', '默认形象', 'default', 'initial'])

export function selectCharacterAppearance<T extends { changeReason?: string | null }>(
  characterName: string,
  appearances: T[],
  requestedAppearance?: string | null,
): T | undefined {
  const requested = String(requestedAppearance || '').trim()
  if (!requested || DEFAULT_APPEARANCE_NAMES.has(requested.toLowerCase())) return appearances[0]

  const matched = appearances.find(
    (appearance) => String(appearance.changeReason || '').trim().toLowerCase() === requested.toLowerCase(),
  )
  if (matched) return matched

  const available = appearances
    .map((appearance) => String(appearance.changeReason || '').trim())
    .filter(Boolean)
  throw new Error(
    `角色“${characterName}”没有形象“${requested}”${available.length > 0 ? `，可用形象：${available.join('、')}` : ''}`,
  )
}

interface LocationImageLike {
  description?: string | null
  availableSlots?: string | null
  imageIndex?: number
  isSelected: boolean
  imageUrl: string | null
}

interface LocationLike {
  name: string
  summary?: string | null
  assetKind?: string | null
  images?: LocationImageLike[]
}

interface NovelProjectData {
  videoRatio?: string | null
  characters?: CharacterLike[]
  locations?: LocationLike[]
}

interface PanelLike {
  sketchImageUrl?: string | null
  characters?: string | null
  props?: string | null
  location?: string | null
}

export interface PanelCharacterReference {
  name: string
  appearance?: string
  slot?: string
}

interface NovelDataDb {
  novelPromotionProject: {
    findUnique(args: Record<string, unknown>): Promise<NovelProjectData | null>
  }
}

export function parseJsonStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

export function parseImageUrls(value: string | null | undefined, fieldName: string): string[] {
  return decodeImageUrlsFromDb(value, fieldName)
}

export function clampCount(value: unknown, min: number, max: number, fallback: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

export function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

async function generateImageToStorage(params: {
  job: Job<TaskJobData>
  userId: string
  modelId: string
  prompt: string
  targetId: string
  keyPrefix: string
  options?: {
    referenceImages?: string[]
    aspectRatio?: string
    size?: string
  }
  label?: string
  allowTaskExternalIdResume?: boolean
}) {
  const source = await resolveImageSourceFromGeneration(params.job, {
    userId: params.userId,
    modelId: params.modelId,
    prompt: params.prompt,
    options: params.options,
    allowTaskExternalIdResume: params.allowTaskExternalIdResume,
  })

  const uploadSource = params.label
    ? await withLabelBar(source, params.label)
    : source
  await assertTaskActive(params.job, 'upload_generated_image')
  const cosKey = await uploadImageSourceToCos(uploadSource, params.keyPrefix, params.targetId, params.job)
  return cosKey
}

export async function generateCleanImageToStorage(params: {
  job: Job<TaskJobData>
  userId: string
  modelId: string
  prompt: string
  targetId: string
  keyPrefix: string
  options?: {
    referenceImages?: string[]
    aspectRatio?: string
    size?: string
  }
  allowTaskExternalIdResume?: boolean
}) {
  return await generateImageToStorage(params)
}

export async function generateProjectLabeledImageToStorage(params: {
  job: Job<TaskJobData>
  userId: string
  modelId: string
  prompt: string
  label: string
  targetId: string
  keyPrefix: string
  options?: {
    referenceImages?: string[]
    aspectRatio?: string
    size?: string
  }
  allowTaskExternalIdResume?: boolean
}) {
  return await generateImageToStorage(params)
}

export async function resolveNovelData(projectId: string) {
  const db = prisma as unknown as NovelDataDb
  const data = await db.novelPromotionProject.findUnique({
    where: { projectId },
    include: {
      characters: { include: { appearances: { orderBy: { appearanceIndex: 'asc' } } } },
      locations: { include: { images: { orderBy: { imageIndex: 'asc' } } } },
    },
  })

  if (!data) {
    throw new Error(`NovelPromotionProject not found: ${projectId}`)
  }

  return data
}

export function parsePanelCharacterReferences(value: string | null | undefined): PanelCharacterReference[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item: unknown) => {
        if (typeof item === 'string') return { name: item }
        if (!item || typeof item !== 'object') return null
        const candidate = item as { name?: unknown; appearance?: unknown; slot?: unknown }
        if (typeof candidate.name === 'string') {
          return {
            name: candidate.name,
            appearance: typeof candidate.appearance === 'string' ? candidate.appearance : undefined,
            slot: typeof candidate.slot === 'string' ? candidate.slot : undefined,
          }
        }
        return null
      })
      .filter(Boolean) as PanelCharacterReference[]
  } catch {
    return []
  }
}

function parsePanelPropReferences(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item: unknown) => {
        if (typeof item === 'string') return item.trim()
        if (!item || typeof item !== 'object') return ''
        const name = (item as { name?: unknown }).name
        return typeof name === 'string' ? name.trim() : ''
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 按角色名查找角色（支持别名匹配）
 * 优先级：1. 精确全名匹配  2. 按 '/' 拆分后别名精确匹配
 * 例：引用名 "顾娘子" 可匹配角色 "顾娘子/顾盼之"
 */
export function findCharacterByName<T extends { name: string }>(characters: T[], referenceName: string): T | undefined {
  const refLower = referenceName.toLowerCase().trim()
  if (!refLower) return undefined

  // 优先级 1：精确全名匹配
  const exact = characters.find((c) => c.name.toLowerCase().trim() === refLower)
  if (exact) return exact

  // 优先级 2：别名匹配 — 按 '/' 拆分后任一别名精确匹配
  const refAliases = refLower.split('/').map((s) => s.trim()).filter(Boolean)
  for (const character of characters) {
    const charAliases = character.name.toLowerCase().split('/').map((s) => s.trim()).filter(Boolean)
    const hasOverlap = refAliases.some((refAlias) => charAliases.includes(refAlias))
    if (hasOverlap) return character
  }

  return undefined
}

interface CollectPanelReferenceImagesOptions {
  includeLocationReference?: boolean
}

export type PanelReferenceImageEntry = {
  url: string
  label: string
  kind: 'sketch' | 'location' | 'character' | 'prop'
}

function collectSelectedLocationImages(location: LocationLike | undefined | null) {
  const images = location?.images || []
  const selectedImages = images.filter((image) => image.isSelected)
  return selectedImages.length > 0 ? selectedImages : images.slice(0, 1)
}

export async function collectPanelReferenceImageEntries(
  projectData: NovelProjectData,
  panel: PanelLike,
  options: CollectPanelReferenceImagesOptions = {},
) {
  const includeLocationReference = options.includeLocationReference !== false
  const refs: PanelReferenceImageEntry[] = []

  const sketch = toSignedUrlIfCos(panel.sketchImageUrl, 3600)
  if (sketch) {
    refs.push({
      url: sketch,
      label: '当前分镜手工参考图/草图',
      kind: 'sketch',
    })
  }

  if (includeLocationReference && panel.location) {
    const location = (projectData.locations || []).find((loc) => (loc.assetKind || 'location') !== 'prop' && loc.name.toLowerCase() === panel.location!.toLowerCase())
    const locationImages = collectSelectedLocationImages(location)
    locationImages.forEach((image, index) => {
      const signed = toSignedUrlIfCos(image?.imageUrl, 3600)
      if (!signed) return
      refs.push({
        url: signed,
        label: locationImages.length > 1
          ? `当前分镜场景图：${location?.name || panel.location} · 第 ${index + 1} 张`
          : `当前分镜场景图：${location?.name || panel.location}`,
        kind: 'location',
      })
    })
  }

  const panelCharacters = parsePanelCharacterReferences(panel.characters)
  for (const item of panelCharacters) {
    const character = findCharacterByName(projectData.characters || [], item.name)
    if (!character) continue

    const appearances = character.appearances || []
    const appearance = selectCharacterAppearance(item.name, appearances, item.appearance)

    if (!appearance) continue

    const imageUrls = parseImageUrls(appearance.imageUrls, 'characterAppearance.imageUrls')
    const selectedIndex = appearance.selectedIndex
    const selectedUrl = selectedIndex !== null && selectedIndex !== undefined ? imageUrls[selectedIndex] : null
    const key = selectedUrl || imageUrls[0] || appearance.imageUrl
    const signed = toSignedUrlIfCos(key, 3600)
    if (signed) {
      refs.push({
        url: signed,
        label: item.appearance
          ? `角色图：${item.name} · ${item.appearance}`
          : `角色图：${item.name}`,
        kind: 'character',
      })
    }
  }

  for (const propName of parsePanelPropReferences(panel.props)) {
    const prop = (projectData.locations || []).find(
      (item) => (item.assetKind || 'location') === 'prop' && item.name.toLowerCase() === propName.toLowerCase(),
    )
    if (!prop) continue
    const propImages = collectSelectedLocationImages(prop)
    propImages.forEach((image, index) => {
      const signed = toSignedUrlIfCos(image?.imageUrl, 3600)
      if (!signed) return
      refs.push({
        url: signed,
        label: propImages.length > 1
          ? `道具图：${propName} · 第 ${index + 1} 张`
          : `道具图：${propName}`,
        kind: 'prop',
      })
    })
  }

  return refs
}

export async function collectPanelReferenceImages(
  projectData: NovelProjectData,
  panel: PanelLike,
  options: CollectPanelReferenceImagesOptions = {},
) {
  const entries = await collectPanelReferenceImageEntries(projectData, panel, options)
  return entries.map((entry) => entry.url)
}
