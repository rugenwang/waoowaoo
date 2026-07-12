import { type Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { getArtStylePrompt, prependAnimeStyleLabel } from '@/lib/constants'
import { createScopedLogger } from '@/lib/logging/core'
import { type TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from '../shared'
import {
  assertTaskActive,
  getProjectModels,
  resolveImageSourceFromGeneration,
  toSignedUrlIfCos,
  uploadImageSourceToCos,
} from '../utils'
import { normalizeReferenceImagesForGeneration } from '@/lib/media/outbound-image'
import {
  AnyObj,
  clampCount,
  collectPanelReferenceImageEntries,
  findCharacterByName,
  parsePanelCharacterReferences,
  pickFirstString,
  resolveNovelData,
  selectCharacterAppearance,
} from './image-task-handler-shared'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { clearTaskExternalId } from '@/lib/task/service'
import { buildPanelAiDataJson } from '@/lib/novel-promotion/panel-ai-data-json'
import { parseLocationAvailableSlots } from '@/lib/location-available-slots'
import {
  parsePanelFrameDependencyPlan,
  withPreviousTailDependency,
} from '@/lib/novel-promotion/panel-tail-reference'
import { loadPreviousPanelTailImageInfo } from '@/lib/novel-promotion/previous-panel-tail'
import { isSamePanelLocation } from '@/lib/novel-promotion/panel-character-continuity'
import { extractPanelFramePromptBody } from '@/lib/novel-promotion/panel-frame-reference-prompts'

type PromptRecord = Record<string, unknown>
type PromptCharacter = { name?: unknown; appearance?: unknown; slot?: unknown; reference_description?: unknown }
type PanelFrameForGeneration = {
  id: string
  frameIndex: number
  frameTimeSec: number
  frameRole: string | null
  dependencyFrameIds: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  imageUrl?: string | null
}

type OrderedReferenceImage = {
  url: string
  label: string
  kind: 'previous_tail' | 'dependency_frame' | 'sketch' | 'location' | 'character' | 'prop'
}

async function normalizeOrderedReferenceImages(
  entries: OrderedReferenceImage[],
  context: Record<string, unknown>,
  cache: Map<string, string | null>,
): Promise<OrderedReferenceImage[]> {
  const seen = new Set<string>()
  const normalized: OrderedReferenceImage[] = []
  let lastError: unknown = null

  for (const entry of entries) {
    const url = String(entry.url || '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    try {
      let normalizedUrl = cache.get(url)
      if (normalizedUrl === undefined) {
        const [resolved] = await normalizeReferenceImagesForGeneration([url], { context })
        normalizedUrl = resolved || null
        cache.set(url, normalizedUrl)
      }
      if (normalizedUrl) normalized.push({ ...entry, url: normalizedUrl })
    } catch (error) {
      cache.set(url, null)
      lastError = error
    }
  }

  if (entries.length > 0 && normalized.length === 0 && lastError) throw lastError
  return normalized
}

function parseJsonUnknown(raw: string | null | undefined): unknown | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function parseDescriptionList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

function pickAppearanceDescription(appearance: {
  descriptions?: string | null
  description?: string | null
  selectedIndex?: number | null
} | null | undefined): string {
  if (!appearance) return ''
  const descriptions = parseDescriptionList(appearance.descriptions || null)
  if (descriptions.length > 0) {
    const selectedIndex = typeof appearance.selectedIndex === 'number' ? appearance.selectedIndex : 0
    const selected = descriptions[selectedIndex] || descriptions[0]
    if (selected && selected.trim()) return selected.trim()
  }
  if (typeof appearance.description === 'string' && appearance.description.trim()) {
    return appearance.description.trim()
  }
  return ''
}

function findPanelLocation(projectData: Awaited<ReturnType<typeof resolveNovelData>>, locationName: string | null | undefined) {
  if (!locationName) return null
  return (projectData.locations || []).find(
    (item) => (item.assetKind || 'location') !== 'prop' && item.name.toLowerCase() === locationName.toLowerCase(),
  ) || null
}

function findSelectedLocationImage(location: NonNullable<Awaited<ReturnType<typeof resolveNovelData>>['locations']>[number] | null) {
  if (!location) return null
  const images = location.images || []
  return images.find((image) => image.isSelected) || images[0] || null
}

export function buildPanelPromptContext(params: {
  panel: {
    id: string
    shotType: string | null
    cameraMove: string | null
    description: string | null
    imagePrompt: string | null
    videoPrompt: string | null
    location: string | null
    characters: string | null
    props?: string | null
    srtSegment: string | null
    photographyRules: string | null
    actingNotes: string | null
  }
  projectData: Awaited<ReturnType<typeof resolveNovelData>>
  aspectRatio?: string | null
}) {
  const panelCharacters = parsePanelCharacterReferences(params.panel.characters)
  const characterContexts = panelCharacters.map((reference) => {
    const character = findCharacterByName(params.projectData.characters || [], reference.name)
    const appearances = character?.appearances || []
    const matchedAppearance = selectCharacterAppearance(
      reference.name,
      appearances,
      reference.appearance,
    ) || null

    return {
      name: reference.name,
      appearance: reference.appearance || matchedAppearance?.changeReason || null,
      slot: reference.slot,
      referenceDescription: pickAppearanceDescription(matchedAppearance),
    }
  })
  const selectedLocation = findSelectedLocationImage(findPanelLocation(params.projectData, params.panel.location))
  const panelProps = (() => {
    const raw = parseJsonUnknown(params.panel.props)
    if (!Array.isArray(raw)) return []
    return raw
      .map((item) => {
        const name = typeof item === 'string'
          ? item.trim()
          : item && typeof item === 'object' && typeof (item as PromptRecord).name === 'string'
            ? String((item as PromptRecord).name).trim()
            : ''
        if (!name) return null
        const prop = (params.projectData.locations || []).find(
          (candidate) => (candidate.assetKind || 'location') === 'prop' && candidate.name.toLowerCase() === name.toLowerCase(),
        )
        const selectedPropImage = findSelectedLocationImage(prop || null)
        return {
          name,
          description: selectedPropImage?.description || prop?.summary || '',
        }
      })
      .filter((item): item is { name: string; description: string } => Boolean(item))
  })()

  return buildPanelAiDataJson({
    aspectRatio: params.aspectRatio || params.projectData.videoRatio || '',
    shotType: params.panel.shotType,
    cameraMove: params.panel.cameraMove,
    description: params.panel.description,
    location: params.panel.location,
    locationReference: selectedLocation
      ? {
        description: selectedLocation.description || '',
        availableSlots: parseLocationAvailableSlots(selectedLocation.availableSlots),
      }
      : null,
    characters: characterContexts,
    props: panelProps,
    imagePrompt: params.panel.imagePrompt,
    videoPrompt: params.panel.videoPrompt,
    sourceText: params.panel.srtSegment,
    photographyRules: parseJsonUnknown(params.panel.photographyRules),
    actingNotes: parseJsonUnknown(params.panel.actingNotes),
  })
}

export function buildPanelPrompt(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  sourceText: string
  contextJson: string
}) {
  return buildPrompt({
    promptId: PROMPT_IDS.NP_SINGLE_PANEL_IMAGE,
    locale: params.locale,
    variables: {
      aspect_ratio: params.aspectRatio,
      storyboard_text_json_input: params.contextJson,
      source_text: params.sourceText || '无',
      style: params.styleText,
    },
  })
}

export function buildPanelStructuredPrompt(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  context: ReturnType<typeof buildPanelPromptContext>
  usesPreviousTail?: boolean
}): string {
  const shot = (params.context as { shot?: PromptRecord }).shot || {}
  const shotType = String(shot.shot_type || '').trim()
  const cameraMove = String(shot.camera_move || '').trim()
  const description = String(shot.description || '').trim()
  const imagePrompt = String(shot.image_prompt || '').trim()
  const location = String(shot.location || '').trim()
  const referencePriority = String(shot.reference_priority || '').trim()
  const locationReference = shot.location_reference && typeof shot.location_reference === 'object'
    ? shot.location_reference as PromptRecord
    : null
  const locationReferenceText = [
    locationReference?.description ? String(locationReference.description).trim() : '',
    Array.isArray(locationReference?.available_slots) && locationReference.available_slots.length > 0
      ? `${params.locale === 'en' ? 'available positions' : '可站位置'}：${locationReference.available_slots.map(String).join(params.locale === 'en' ? '; ' : '、')}`
      : '',
  ].filter(Boolean).join(params.locale === 'en' ? '; ' : '；')

  const characterLines = (() => {
    const chars = Array.isArray(shot.characters)
      ? shot.characters as PromptCharacter[]
      : []
    if (chars.length === 0) return ''
    if (params.locale === 'en') {
      return `Characters: ${chars.map((c) => {
        const name = String(c?.name || '').trim()
        const appearance = String(c?.appearance || '').trim()
        const slot = String(c?.slot || '').trim()
        const referenceDescription = String(c?.reference_description || '').trim()
        const extras = [
          appearance ? `appearance: ${appearance}` : '',
          slot ? `fixed position: ${slot}` : '',
          referenceDescription ? `reference outfit/details: ${referenceDescription}` : '',
        ].filter(Boolean).join(', ')
        return extras ? `${name} (${extras})` : name
      }).filter(Boolean).join('; ')}`
    }
    return `角色：${chars.map((c) => {
      const name = String(c?.name || '').trim()
      const appearance = String(c?.appearance || '').trim()
      const slot = String(c?.slot || '').trim()
      const referenceDescription = String(c?.reference_description || '').trim()
      const extras = [
        appearance ? `形象：${appearance}` : '',
        slot ? `固定位置：${slot}` : '',
        referenceDescription ? `参考服装/细节：${referenceDescription}` : '',
      ].filter(Boolean).join('，')
      return extras ? `${name}（${extras}）` : name
    }).filter(Boolean).join('、')}`
  })()

  const propLines = (() => {
    const props = Array.isArray(shot.props)
      ? shot.props as Array<string | PromptRecord>
      : []
    if (props.length === 0) return ''
    const propText = props.map((prop) => {
      if (typeof prop === 'string') return prop
      const name = String(prop.name || '').trim()
      const propDescription = String(prop.description || '').trim()
      if (!name) return ''
      return propDescription ? `${name}（${propDescription}）` : name
    }).filter(Boolean)
    return params.locale === 'en'
      ? `Props: ${propText.join('; ')}`
      : `道具：${propText.join('、')}`
  })()

  const photographyText = (() => {
    const rules = (params.context as { photography_rules?: unknown }).photography_rules as PromptRecord | null
    if (!rules || typeof rules !== 'object') return ''
    const lighting = rules.lighting && typeof rules.lighting === 'object'
      ? rules.lighting as PromptRecord
      : null
    const direction = String(lighting?.direction || '').trim()
    const quality = String(lighting?.quality || '').trim()
    const parts = [
      direction ? (params.locale === 'en' ? `lighting direction: ${direction}` : `光照方向：${direction}`) : '',
      quality ? (params.locale === 'en' ? `lighting quality: ${quality}` : `光照质感：${quality}`) : '',
    ].filter(Boolean)
    if (parts.length === 0) return ''
    return params.locale === 'en'
      ? `Photography rules: ${parts.join(', ')}`
      : `摄影规则：${parts.join('，')}`
  })()

  const actingText = (() => {
    const notes = (params.context as { acting_notes?: unknown }).acting_notes
    if (!notes) return ''
    // 常见结构：[{ name, acting }]
    if (Array.isArray(notes)) {
      const lines = notes.map((row) => {
        const item = row && typeof row === 'object' ? row as PromptRecord : null
        const name = String(item?.name || '').trim()
        const acting = String(item?.acting || '').trim()
        if (!acting) return ''
        return name ? `${name}：${acting}` : acting
      }).filter(Boolean)
      if (lines.length === 0) return ''
      return params.locale === 'en'
        ? `Acting notes: ${lines.join(' | ')}`
        : `演技指导：${lines.join('；')}`
    }
    // 或者对象结构
    try {
      const raw = JSON.stringify(notes)
      return params.locale === 'en' ? `Acting notes: ${raw}` : `演技指导：${raw}`
    } catch {
      return ''
    }
  })()

  if (params.locale === 'en') {
    const parts = [
      `Aspect ratio: ${params.aspectRatio}`,
      shotType || cameraMove ? `Shot: ${[shotType, cameraMove].filter(Boolean).join(', ')}` : '',
      imagePrompt ? `Static image prompt: ${imagePrompt}` : '',
      description ? `Description: ${description}` : '',
      location
        ? (params.usesPreviousTail
          ? `Scene continuity: strictly reuse FP, the first reference image, as the actual environment; current location text "${location}" is story context only and must not override FP.`
          : `Location: ${location}`)
        : '',
      !params.usesPreviousTail && locationReferenceText ? `Location reference: ${locationReferenceText}` : '',
      characterLines,
      propLines,
      referencePriority ? `Reference priority: ${referencePriority}` : '',
      actingText,
      photographyText,
      params.styleText ? `Style: ${params.styleText}` : '',
      'Generate one still image only. Do not depict camera movement, timeline segments, subtitles, dialogue text, music, or multiple action moments.',
    ].filter(Boolean)
    return parts.join('\n')
  }

  const parts = [
    `画面比例：${params.aspectRatio}`,
    shotType || cameraMove ? `镜头：${[shotType, cameraMove].filter(Boolean).join('，')}` : '',
    imagePrompt ? `静态生图提示：${imagePrompt}` : '',
    description ? `画面描述：${description}` : '',
    location ? `场景：${location}` : '',
    locationReferenceText ? `场景参考：${locationReferenceText}` : '',
    characterLines,
    propLines,
    referencePriority ? `参考优先级：${referencePriority}` : '',
    actingText,
    photographyText,
    params.styleText ? `风格：${params.styleText}` : '',
    '只生成一张静态镜头图。不要画运镜、时间轴、字幕、台词文字、背景音乐或多个连续动作瞬间。',
  ].filter(Boolean)
  return parts.join('\n')
}

function buildPanelDescriptionPrompt(params: {
  description: string
  styleText: string
  locale: TaskJobData['locale']
}): string {
  const clean = String(params.description || '').trim()
  if (!clean) return ''
  // 直接用画面描述作为 prompt，风格放末尾（与其他生图链路保持一致）
  return params.styleText ? `${clean}，${params.styleText}` : clean
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const clean = value.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
  }
  return result
}

function uniqueNumbers(values: number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const value of values) {
    if (!Number.isFinite(value) || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

async function markPanelFrameGenerationFailed(frameId: string | null | undefined, message: string) {
  if (!frameId) return
  try {
    await prisma.novelPromotionPanelFrame.update({
      where: { id: frameId },
      data: {
        generationStatus: 'failed',
        errorMessage: message,
      },
    })
  } catch {
    // Best-effort cleanup so a worker-side validation error does not leave the card spinning.
  }
}

function buildFrameReferencePlan(params: {
  frame: PanelFrameForGeneration
  generatedByFrameIndex: Map<number, string>
  previousTailImageUrl?: string | null
  dependencyFrameIds?: string | null
}) {
  const dependencyPlan = parsePanelFrameDependencyPlan(params.dependencyFrameIds ?? params.frame.dependencyFrameIds)
  const dependencyIndexes = uniqueNumbers(dependencyPlan.frameIndexes)
  const frameReferenceIndexes = params.frame.frameIndex > 0
    ? (dependencyIndexes.length > 0 ? dependencyIndexes : [Math.max(0, params.frame.frameIndex - 1)])
    : dependencyIndexes
  const urls = frameReferenceIndexes
    .map((frameIndex) => params.generatedByFrameIndex.get(frameIndex))
    .filter((value): value is string => Boolean(value))
  if (dependencyPlan.previousTail && params.previousTailImageUrl) {
    urls.unshift(params.previousTailImageUrl)
  }
  return {
    frameReferenceIndexes,
    usesPreviousTail: dependencyPlan.previousTail,
    urls: uniqueStrings(urls),
  }
}

function buildPanelFramePrompt(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  frame: PanelFrameForGeneration
  panelDescription: string | null
  panelContext: ReturnType<typeof buildPanelPromptContext>
  frameReferenceIndexes: number[]
  usesPreviousTail: boolean
  frameReferenceImageCount: number
  hardConstraints: string
}) {
  const shot = (params.panelContext as { shot?: PromptRecord }).shot || {}
  const shotType = String(shot.shot_type || '').trim()
  const framePrompt = extractPanelFramePromptBody(params.frame.imagePrompt || params.panelDescription)
  const referenceLabels = [
    params.usesPreviousTail ? '上一分镜尾帧' : '',
    ...params.frameReferenceIndexes.map((index) => `分镜组第 ${index + 1} 关键帧`),
  ].filter(Boolean).join(', ')
  const hasLinkedFrameReference = params.frameReferenceImageCount > 0 || params.usesPreviousTail
  const lines = params.locale === 'en'
    ? [
      `Aspect ratio: ${params.aspectRatio}`,
      shotType ? `Shot type: ${shotType}` : '',
      `Frame time: ${params.frame.frameTimeSec}s`,
      params.frame.frameRole ? `Frame role: ${params.frame.frameRole}` : '',
      hasLinkedFrameReference ? `Inherited state (${referenceLabels || 'linked frame'}): preserve identity, outfit, screen side, facing direction, spatial order, prop state, lighting, and scene layout.` : '',
      framePrompt ? `This-frame change: ${framePrompt}` : '',
      'Unchanged state: anything not explicitly changed above must remain consistent with the linked frame and asset references.',
      params.frame.frameIndex === 0 ? 'Opening state only: do not show the result of a later action or transition.' : '',
      'Generate one still frame. Show one moment only; no camera-motion trail, timeline, dialogue text, music, collage, or multiple action stages.',
      params.hardConstraints,
    ]
    : [
      `画面比例：${params.aspectRatio}`,
      shotType ? `景别：${shotType}` : '',
      `所在秒点：${params.frame.frameTimeSec}s`,
      params.frame.frameRole ? `关键帧角色：${params.frame.frameRole}` : '',
      hasLinkedFrameReference ? `继承状态（${referenceLabels || '关联帧'}）：锁定人物身份与服装、画面左右位置、朝向、人物顺序与间距、道具状态、光线和空间布局。` : '',
      framePrompt ? `本帧变化：${framePrompt}` : '',
      '保持不变：本帧没有明确要求改变的内容，全部沿用关联帧和资产参考图。',
      params.frame.frameIndex === 0 ? '只表现开场原始状态，不提前画出后续动作或转场结果。' : '',
      '只生成一个静态瞬间；不要画运镜轨迹、时间轴、字幕、台词文字、背景音乐、拼图或多个动作阶段。',
      params.hardConstraints,
    ]
  return lines.filter(Boolean).join('\n')
}

export function buildStoryboardHardConstraints(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  referenceImagesCount: number
  referenceKinds?: OrderedReferenceImage['kind'][]
}): string {
  const ratio = String(params.aspectRatio || '').trim()
  const style = String(params.styleText || '').trim()
  const hasRefs = params.referenceImagesCount > 0
  const kinds = new Set(params.referenceKinds || [])
  const hasRuntimeKinds = Array.isArray(params.referenceKinds)
  const authorityZh = [
    kinds.has('previous_tail') || kinds.has('dependency_frame') ? '关联帧锁定画面连续性与空间关系' : '',
    kinds.has('location') ? '场景图锁定空间结构、光线和可站位置' : '',
    kinds.has('character') ? '角色图锁定身份、服装和发型' : '',
    kinds.has('prop') ? '道具图锁定道具外观' : '',
    kinds.has('sketch') ? '草图锁定主要构图意图' : '',
  ].filter(Boolean).join('；')
  const authorityEn = [
    kinds.has('previous_tail') || kinds.has('dependency_frame') ? 'linked frames lock continuity and spatial relationships' : '',
    kinds.has('location') ? 'location images lock scene structure, lighting, and placement areas' : '',
    kinds.has('character') ? 'character images lock identity, outfit, and hair' : '',
    kinds.has('prop') ? 'prop images lock prop appearance' : '',
    kinds.has('sketch') ? 'the sketch locks the main composition intent' : '',
  ].filter(Boolean).join('; ')

  if (params.locale === 'en') {
    return [
      'ABSOLUTE CONSTRAINTS (must follow):',
      '- No text in image (no subtitles/labels/numbers/watermarks/symbols).',
      '- Output exactly ONE frame (no collage / no multi-panel).',
      '- In multi-person or crowd scenes, every visible person must have a distinct face. Do NOT generate multiple people with the same face, cloned facial features, or repeated identity in the same shot.',
      '- Character identity, hairstyle, makeup, outfit style, clothing color, fabric layers, accessories that belong to the outfit, and body silhouette must strictly match the corresponding character reference image. Do not redesign clothing or change outfits.',
      '- Characters must be fully and properly clothed, exactly consistent with their reference outfit; no shirtless, semi-nude, exposed torso, revealing outfit, missing clothing, or torn-clothing exposure.',
      '- Do NOT generate tilted heads, twisted heads, strongly turned heads, strange expressions, exaggerated expressions, or distorted facial expressions. Keep head and neck posture natural and upright; keep expressions realistic, restrained, and story-appropriate.',
      ratio ? `- Aspect ratio must be EXACT: ${ratio}.` : null,
      hasRefs
        ? `- Match only the provided reference types strictly: ${hasRuntimeKinds ? authorityEn : 'linked frames control continuity; location, character, and prop images control their corresponding visual attributes'}. Do NOT copy pose/composition exactly, and do NOT draw any text from references.`
        : null,
      style ? `- Keep visual style consistent: ${style}.` : null,
    ].filter(Boolean).join('\n')
  }

  return [
    '【强制规则 - 必须遵守】',
    '- 画面中绝对禁止出现任何文字（字幕/标签/编号/水印/符号）。',
    '- 只生成一张镜头画面（禁止拼图/多镜头/多格）。',
    '- 多人或一群人的场景里，每个可见人物必须是不同的脸；禁止在同一个镜头中出现同一张脸、重复五官模板、克隆脸或看起来像同一个人的多个个体。',
    '- 人物身份、发型、妆容、服装款式、服装颜色、面料层次、属于服装的一切配饰、身体轮廓必须严格匹配对应角色参考图；禁止重新设计衣服、换衣服、改颜色或自由发挥服装。',
    '- 人物必须衣着完整、服饰得体，并与角色参考图服装完全一致；禁止半裸、裸露上身、暴露服装、缺少衣服、衣物破损导致裸露。',
    '- 禁止生成歪头、扭头、头部大幅偏转、怪异表情、夸张表情或五官扭曲表情；人物头颈姿态必须自然端正，表情真实克制并符合剧情。',
    ratio ? `- 画面比例必须严格为：${ratio}` : null,
    hasRefs
      ? `- 只严格匹配本次实际传入的参考类型：${hasRuntimeKinds ? authorityZh : '关联帧控制连续性，场景图、角色图和道具图分别控制对应视觉属性'}。禁止原样复制参考图姿势/构图；参考图文字禁止画入。`
      : null,
    style ? `- 风格必须与参考一致：${style}` : null,
  ].filter(Boolean).join('\n')
}

function buildPreviousTailReferenceHardRule(locale: TaskJobData['locale'], sameScene: boolean): string {
  if (locale === 'en') {
    return [
      'PREVIOUS-PANEL TAIL REFERENCE (must follow):',
      '- The FIRST reference image is FP, the previous panel tail frame.',
      sameScene
        ? '- This is the same scene: FP controls inherited scene layout, character positions/order, screen side, facing direction, lighting, and prop state.'
        : '- This is a scene transition: FP controls the starting state; the current location image controls the destination environment. Show only the transition state explicitly requested by the current frame.',
      '- Character asset references control identity, face, hair, and outfit; current frame text controls only explicitly requested changes.',
      '- Do not add, remove, rearrange, or redesign inherited scene elements unless the current frame explicitly changes them.',
      '- Continue coherently from FP without copying its pose or composition exactly.',
    ].join('\n')
  }
  return [
    '【上一分镜尾帧 FP 参考规则 - 必须遵守】',
    '- 第 1 张参考图是 FP，即上一分镜的尾帧。',
    sameScene
      ? '- 当前为同场景连续镜头：FP 锁定场景布局、人物位置与顺序、画面左右侧、朝向、光线和道具状态。'
      : '- 当前为跨场景转场：FP 控制转场起点，当前场景图控制目标环境；只表现当前帧明确要求的转场阶段。',
    '- 角色资产图锁定身份、脸、发型和服装；当前帧文字只控制明确写出的变化。',
    '- 当前帧未明确改变的场景元素不得增删、重排或重新设计。',
    '- 自然承接 FP，但不要原样复制姿势和构图。',
  ].join('\n')
}

function buildReferenceImageOrderInstruction(params: {
  locale: TaskJobData['locale']
  references: OrderedReferenceImage[]
}): string {
  const references = params.references.filter((reference) => reference.url && reference.label)
  if (references.length === 0) return ''
  const first = references[0]
  const firstIsContinuity = first.kind === 'previous_tail' || first.kind === 'dependency_frame'
  const referenceLinesEn = references.map((reference, index) => `- F${index + 1}: ${reference.label}.`).join('\n')
  const supportingReferenceLinesEn = references.slice(1).map((reference, index) => `- F${index + 2}: ${reference.label}.`).join('\n')
  const referenceLinesZh = references.map((reference, index) => `- F${index + 1}：${reference.label}。`).join('\n')
  const supportingReferenceLinesZh = references.slice(1).map((reference, index) => `- F${index + 2}：${reference.label}。`).join('\n')
  if (params.locale === 'en') {
    return [
      'REFERENCE IMAGE ORDER (must follow):',
      `- ${references.length} reference image(s) are provided in the actual input order; F numbers refer only to that order.`,
      firstIsContinuity ? `- F1 is ${first.label}; use it as the continuity anchor.` : '',
      firstIsContinuity && references.length > 1
        ? '- F2-Fn are supporting references in the actual input order; apply each by its asset type and do not let it override F1 continuity unless a location image explicitly defines a transition destination.'
        : referenceLinesEn,
      firstIsContinuity && references.length > 1 ? supportingReferenceLinesEn : '',
      '- Authority: FP/dependency frames control inherited or starting spatial state; a location image included after FP controls an explicit destination scene; character images control identity/outfit/hair; prop images control prop appearance; current text controls explicit changes.',
      '- In the generated still image, combine the current script/frame description with the ordered references. Do not copy any reference image exactly.',
    ].join('\n')
  }
  return [
    '【参考图顺序说明 - 必须遵守】',
    `- 实际共传入 ${references.length} 张参考图，F 编号只表示本次接口的真实传入顺序。`,
    firstIsContinuity ? `- F1 是${first.label}，作为画面连续性锚点。` : '',
    firstIsContinuity && references.length > 1
      ? '- F2-Fn 是按真实顺序传入的辅助参考图，按各自资产类型生效；除非场景图明确表示转场目标，否则不得覆盖 F1 的连续性。'
      : referenceLinesZh,
    firstIsContinuity && references.length > 1 ? supportingReferenceLinesZh : '',
    '- 权限顺序：FP/依赖帧控制继承状态或转场起点；若 FP 后仍传入场景图，该场景图控制明确的目标环境；角色图控制身份/服装/发型；道具图控制道具外观；当前文字只控制明确变化。',
    '- 生成当前静态图时，把当前剧本/关键帧描述与这些参考图融合；禁止原样复制任意参考图构图或姿势。',
  ].join('\n')
}

export function cleanupRefinedPrompt(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  // 去掉可能的 code fence 或多余引号
  const noFence = text.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim()
  const unquoted = noFence.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim()
  const stillOnly = sanitizeStillImagePrompt(unquoted)
  // 防止输出过长影响本地模型（保守截断）
  return stillOnly.length > 1200 ? stillOnly.slice(0, 1200) : stillOnly
}

function sanitizeStillImagePrompt(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  const bannedLinePattern = /(?:\b\d{1,2}:\d{2}(?::\d{2})?\s*[-–—至~]\s*\d{1,2}:\d{2}(?::\d{2})?\b|^【?(?:对话|台词|旁白|背景音乐|背景音|运镜|镜头切换|时间轴|音乐|sound|dialogue|voiceover|timeline|camera movement|background music)】?[:：])/i
  const cleanedLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !bannedLinePattern.test(line))

  const joined = (cleanedLines.length > 0 ? cleanedLines.join('，') : text)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*[-–—至~]\s*\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
    .replace(/【?(?:对话|台词|旁白|背景音乐|背景音|运镜|镜头切换|时间轴|音乐)】?[:：][^。；\n]*(?:[。；]|$)/g, '')
    .replace(/\b(?:dialogue|voiceover|timeline|camera movement|background music)\s*:[^.;\n]*(?:[.;]|$)/gi, '')
    .replace(/[，,；;]\s*[，,；;]+/g, '，')
    .replace(/^[，,；;\s]+|[，,；;\s]+$/g, '')
    .trim()

  return joined || text
}

export function buildShotPromptPrefix(params: {
  locale: TaskJobData['locale']
  context: ReturnType<typeof buildPanelPromptContext>
}): string {
  const shot = (params.context as { shot?: PromptRecord }).shot || {}
  const shotType = String(shot.shot_type || '').trim()
  const cameraMove = String(shot.camera_move || '').trim()
  const location = String(shot.location || '').trim()
  if (!shotType && !cameraMove && !location) return ''
  if (params.locale === 'en') {
    const framing = cameraMove ? describeStaticFramingResult(cameraMove, 'en') : ''
    return [
      location ? `Current scene: ${location}` : '',
      shotType ? `Shot type: ${shotType}` : '',
      framing ? `Static framing result: ${framing}` : '',
    ].filter(Boolean).join('; ')
  }
  const framing = cameraMove ? describeStaticFramingResult(cameraMove, 'zh') : ''
  return [
    location ? `当前场景：${location}` : '',
    shotType ? `镜头类型：${shotType}` : '',
    framing ? `静态构图结果：${framing}` : '',
  ].filter(Boolean).join('；')
}

function describeStaticFramingResult(cameraMove: string, locale: 'zh' | 'en'): string {
  const value = cameraMove.trim().toLowerCase()
  const is = (pattern: RegExp) => pattern.test(value)
  if (is(/push|dolly.?in|推进|推镜/)) return locale === 'en' ? 'closer framing with the subject occupying more of the frame' : '更近景别，主体占画面比例增大'
  if (is(/pull|dolly.?out|拉远|拉镜/)) return locale === 'en' ? 'wider framing revealing more of the environment' : '更宽景别，展示更多环境关系'
  if (is(/pan|摇镜|横摇/)) return locale === 'en' ? 'the composed endpoint after revealing the target subject' : '呈现揭示目标主体后的终点构图'
  if (is(/track|follow|truck|跟拍|跟随|横移/)) return locale === 'en' ? 'a stable current moment that preserves movement direction and screen side' : '稳定呈现当前瞬间，保持移动方向与画面左右关系'
  if (is(/jib|crane|升降|上升|下降/)) return locale === 'en' ? 'the final high or low spatial relationship implied by the shot' : '呈现升降结束后的高低空间关系'
  if (is(/orbit|环绕/)) return locale === 'en' ? 'the final angle around the subject while preserving spatial continuity' : '呈现环绕结束后的观察角度并保持空间连续'
  if (is(/zoom|变焦/)) return locale === 'en' ? 'the final field of view implied by the zoom' : '呈现变焦结束后的最终视野范围'
  if (is(/static|固定|静止/)) return locale === 'en' ? 'locked-off composition' : '固定机位构图'
  return locale === 'en'
    ? `the single still-frame endpoint implied by ${cameraMove}, with no motion trail`
    : `${cameraMove}对应的单一终点构图，不表现运动轨迹`
}

export async function handlePanelImageTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const panelId = pickFirstString(payload.panelId, job.data.targetId)
  const targetFrameId = pickFirstString(payload.targetFrameId, payload.frameId)
  if (!panelId) throw new Error('panelId missing')
  const referenceNormalizationCache = new Map<string, string | null>()

  const panel = await prisma.novelPromotionPanel.findUnique({
    where: { id: panelId },
    include: {
      frames: { orderBy: { frameIndex: 'asc' } },
    },
  })

  if (!panel) throw new Error('Panel not found')
  let panelUsesPreviousTailAsReference = Boolean(
    (panel as { usePreviousPanelTailAsReference?: boolean }).usePreviousPanelTailAsReference,
  )

  const projectData = await resolveNovelData(job.data.projectId)
  const modelConfig = await getProjectModels(job.data.projectId, job.data.userId)
  const modelKey = modelConfig.storyboardModel
  if (!modelKey) throw new Error('Storyboard model not configured')
  const parsedStoryboardModel = parseModelKeyStrict(modelKey)
  const sortedFrames = Array.isArray(panel.frames)
    ? [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
    : []
  const isPanelGroup = panel.panelMode === 'group' || sortedFrames.length > 1
  const isMultiFrameGroup = isPanelGroup && sortedFrames.length > 1
  const targetFrame = isMultiFrameGroup && targetFrameId
    ? sortedFrames.find((frame) => frame.id === targetFrameId)
    : null
  if (isMultiFrameGroup && targetFrameId && !targetFrame) {
    throw new Error('Target frame not found')
  }
  const framesNeedingGenerationForPreviousTailCheck = isMultiFrameGroup
    ? (targetFrame ? [targetFrame] : sortedFrames.filter((frame) => !(typeof frame.imageUrl === 'string' && frame.imageUrl.trim())))
    : []
  const needsPreviousTailReference =
    isMultiFrameGroup
      ? (!targetFrame && panelUsesPreviousTailAsReference) || framesNeedingGenerationForPreviousTailCheck.some((frame) => parsePanelFrameDependencyPlan(
        withPreviousTailDependency(
          frame.dependencyFrameIds,
          panelUsesPreviousTailAsReference,
          frame.frameIndex,
        ),
      ).previousTail)
      : panelUsesPreviousTailAsReference

  const candidateCount = clampCount(payload.candidateCount ?? payload.count, 1, 4, 1)
  const previousTailInfo = needsPreviousTailReference
    ? await loadPreviousPanelTailImageInfo({
      storyboardId: panel.storyboardId,
      panelIndex: panel.panelIndex,
    })
    : null
  let previousTailImageUrl = previousTailInfo?.imageUrl || null
  if (needsPreviousTailReference && previousTailInfo && !previousTailInfo.previousPanelExists) {
    if (panelUsesPreviousTailAsReference) {
      await prisma.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { usePreviousPanelTailAsReference: false },
      })
      panelUsesPreviousTailAsReference = false
    }
    previousTailImageUrl = null
  } else if (needsPreviousTailReference && !previousTailImageUrl) {
    const message = '当前分镜首帧需要参考上一分镜尾帧，但上一分镜还没有可用尾帧图片'
    await markPanelFrameGenerationFailed(targetFrame?.id, message)
    throw new Error(message)
  }
  const previousTailIsSameScene = Boolean(
    previousTailImageUrl &&
    previousTailInfo &&
    (previousTailInfo.previousPanelLocation === undefined
      ? true
      : isSamePanelLocation(previousTailInfo.previousPanelLocation, panel.location)),
  )
  const panelReferenceEntries = await collectPanelReferenceImageEntries(
    projectData,
    panel,
    { includeLocationReference: !previousTailIsSameScene },
  )
  const panelOrderedReferences: OrderedReferenceImage[] = panelReferenceEntries.map((entry) => ({
    url: entry.url,
    label: entry.label,
    kind: entry.kind,
  }))
  const singlePanelOrderedReferences = await normalizeOrderedReferenceImages([
    ...(!isMultiFrameGroup && previousTailImageUrl
      ? [{
        url: toSignedUrlIfCos(previousTailImageUrl, 3600) || previousTailImageUrl,
        label: 'FP：上一个连续分镜的尾帧，作为当前分镜的参考图',
        kind: 'previous_tail' as const,
      }]
      : []),
    ...panelOrderedReferences,
  ], { panelId, scope: 'single_panel' }, referenceNormalizationCache)
  const normalizedRefs = singlePanelOrderedReferences.map((entry) => entry.url)
  const singlePanelReferenceLabels = singlePanelOrderedReferences.map((entry) => entry.label)
  const panelReferenceEntriesWithoutLocation = panelReferenceEntries.filter((entry) => entry.kind !== 'location')

  const logger = createScopedLogger({
    module: 'worker.panel-image',
    action: 'panel_image_generate',
    requestId: job.data.trace?.requestId || undefined,
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: job.data.userId,
  })
  logger.info({
    message: 'panel image generation started',
    details: {
      panelId,
      modelKey,
      candidateCount,
      referenceImagesRawCount: panelReferenceEntries.length,
      referenceImagesEffectiveRawCount: singlePanelOrderedReferences.length,
      referenceImagesNormalizedCount: normalizedRefs.length,
      orderedReferences: singlePanelOrderedReferences.map((entry, index) => ({
        frameLabel: `F${index + 1}`,
        kind: entry.kind,
        label: entry.label,
        normalizedUrl: entry.url.substring(0, 100),
      })),
      panelCharacters: panel.characters,
      panelLocation: panel.location,
      artStyle: modelConfig.artStyle,
      usePreviousPanelTailAsReference: panelUsesPreviousTailAsReference,
      previousTailIsSameScene,
    },
  })

  const artStyle = getArtStylePrompt(modelConfig.artStyle, job.data.locale)
  if (!projectData.videoRatio) throw new Error('Project videoRatio not configured')
  const aspectRatio = projectData.videoRatio

  const firstFramePromptText = !isMultiFrameGroup
    ? String(sortedFrames[0]?.imagePrompt || '').trim()
    : ''
  const panelDirectPromptText = String(firstFramePromptText || panel.imagePrompt || panel.description || '').trim()
  const promptContext = buildPanelPromptContext({
    panel: {
      id: panel.id,
      shotType: panel.shotType,
      cameraMove: panel.cameraMove,
      description: panel.description,
      imagePrompt: panel.imagePrompt,
      videoPrompt: panel.panelMode === 'group'
        ? panel.groupVideoPrompt || panel.videoPrompt
        : panel.videoPrompt,
      location: panel.location,
      characters: panel.characters,
      props: panel.props,
      srtSegment: null,
      photographyRules: null,
      actingNotes: null,
    },
    projectData,
    aspectRatio,
  })
  const contextJson = JSON.stringify(promptContext, null, 2)

  // 生图主体 prompt 优先直接透传当前分镜的生图提示/画面描述，避免自动重写带回旧 JSON 字段。
  let prompt = ''
  if (panelDirectPromptText) {
    prompt = buildPanelDescriptionPrompt({
      description: panelDirectPromptText,
      styleText: artStyle || '',
      locale: job.data.locale,
    })
  } else {
    // 兜底：老数据没有 imagePrompt/description 时，仍使用结构化信息生成可读 prompt。
    if (parsedStoryboardModel?.provider === 'local') {
      prompt = buildPanelStructuredPrompt({
        locale: job.data.locale,
        aspectRatio,
        styleText: artStyle || '',
        context: promptContext,
        usesPreviousTail: !isMultiFrameGroup && !!previousTailImageUrl,
      })
    } else {
      // 非本地模型仍沿用模板（模板内部会引用 storyboard_text_json_input）
      prompt = buildPanelPrompt({
        locale: job.data.locale,
        aspectRatio,
        styleText: artStyle || '与参考图风格一致',
        sourceText: panel.description || '',
        contextJson,
      })
    }
  }

  // 生图阶段不再自动调用大模型“美化/精炼”提示词，直接透传当前分镜/关键帧描述。
  // 参考图顺序、FP 连贯性、画面安全等硬约束仍在最终 prompt 中追加。
  const shouldRefinePrompt = false
  const refinedOrRawPrompt = prompt
  const shotPromptPrefix = buildShotPromptPrefix({
    locale: job.data.locale,
    context: promptContext,
  })
  const imagePromptWithShotType = [shotPromptPrefix, refinedOrRawPrompt].filter(Boolean).join('\n')

  const withAnimeStyle = prependAnimeStyleLabel({
    prompt: imagePromptWithShotType,
    artStyle: modelConfig.artStyle,
    locale: job.data.locale === 'en' ? 'en' : 'zh',
  })

  const hardConstraints = buildStoryboardHardConstraints({
    locale: job.data.locale,
    aspectRatio,
    styleText: artStyle || '',
    referenceImagesCount: normalizedRefs.length,
    referenceKinds: singlePanelOrderedReferences.map((entry) => entry.kind),
  })

  if (isMultiFrameGroup) {
    const generatedByFrameIndex = new Map<number, string>()
    const generatedUrls: string[] = []
    const shouldRegenerateFirstFrameForPreviousTail =
      !targetFrame &&
      panelUsesPreviousTailAsReference &&
      Boolean(previousTailImageUrl) &&
      sortedFrames[0]?.frameIndex === 0
    const existingGeneratedFrames = sortedFrames.filter((frame) => {
      if (targetFrameId && frame.id === targetFrameId) return false
      if (shouldRegenerateFirstFrameForPreviousTail) return false
      return typeof frame.imageUrl === 'string' && frame.imageUrl.trim()
    })
    const shouldResumePartialGroup =
      !targetFrameId &&
      existingGeneratedFrames.length > 0 &&
      existingGeneratedFrames.length < sortedFrames.length

    for (const frame of existingGeneratedFrames) {
      generatedByFrameIndex.set(frame.frameIndex, frame.imageUrl!)
      if (!targetFrameId) generatedUrls.push(frame.imageUrl!)
    }

    if (shouldResumePartialGroup) {
      const existingRepresentativeImageUrl = sortedFrames[0]?.imageUrl || existingGeneratedFrames[0]?.imageUrl || null
      if (existingRepresentativeImageUrl && panel.imageUrl !== existingRepresentativeImageUrl) {
        await prisma.novelPromotionPanel.update({
          where: { id: panel.id },
          data: {
            imageUrl: existingRepresentativeImageUrl,
            candidateImages: null,
          },
        })
      }
    }

    const framesToGenerate = targetFrame
      ? [targetFrame]
      : sortedFrames.filter((frame) => {
        if (shouldRegenerateFirstFrameForPreviousTail) return true
        return !(shouldResumePartialGroup && frame.imageUrl)
      })
    logger.info({
      message: 'panel group image generation frame plan',
      details: {
        panelId: panel.id,
        usePreviousPanelTailAsReference: panelUsesPreviousTailAsReference,
        previousTailImageLoaded: Boolean(previousTailImageUrl),
        shouldRegenerateFirstFrameForPreviousTail,
        targetFrameId: targetFrame?.id || null,
        existingFrameIndexes: existingGeneratedFrames.map((frame) => frame.frameIndex),
        frameIndexesToGenerate: framesToGenerate.map((frame) => frame.frameIndex),
      },
    })

    for (const frame of targetFrame ? framesToGenerate : []) {
      const dependencyPlan = parsePanelFrameDependencyPlan(
        withPreviousTailDependency(
          frame.dependencyFrameIds,
          panelUsesPreviousTailAsReference,
          frame.frameIndex,
        ),
      )
      if (dependencyPlan.previousTail && !previousTailImageUrl) {
        const message = `F${frame.frameIndex + 1} 需要参考上一分镜尾帧 FP，但上一分镜还没有可用尾帧图片`
        await markPanelFrameGenerationFailed(frame.id, message)
        throw new Error(message)
      }
      for (const dependencyIndex of dependencyPlan.frameIndexes) {
        if (!generatedByFrameIndex.get(dependencyIndex)) {
          throw new Error(`请先生成关联帧 F${dependencyIndex + 1}，再重新生成 F${frame.frameIndex + 1}`)
        }
      }
    }

    for (let i = 0; i < framesToGenerate.length; i += 1) {
      const frame = framesToGenerate[i] as PanelFrameForGeneration
      await reportTaskProgress(job, 12 + Math.floor((i / Math.max(sortedFrames.length, 1)) * 74), {
        stage: 'generate_panel_candidate',
        candidateIndex: i,
        frameIndex: frame.frameIndex,
      })
      await prisma.novelPromotionPanelFrame.update({
        where: { id: frame.id },
        data: {
          generationStatus: 'processing',
          errorMessage: null,
        },
      })

      try {
      const runtimeDependencyFrameIds = withPreviousTailDependency(
        frame.dependencyFrameIds,
        panelUsesPreviousTailAsReference,
        frame.frameIndex,
      )
      const frameReferencePlan = buildFrameReferencePlan({
        frame,
        generatedByFrameIndex,
        previousTailImageUrl,
        dependencyFrameIds: runtimeDependencyFrameIds,
      })
      const dependencyLabels = [
        ...(frameReferencePlan.usesPreviousTail ? ['FP：上一个连续分镜的尾帧，作为当前分镜的参考图'] : []),
        ...frameReferencePlan.frameReferenceIndexes.map((index) => `分镜组第 ${index + 1} 关键帧`),
      ]
      const dependencyOrderedReferences = frameReferencePlan.urls
        .reduce<OrderedReferenceImage[]>((entries, value, index) => {
          const url = toSignedUrlIfCos(value, 3600)
          if (!url) return entries
          entries.push({
            url,
            label: dependencyLabels[index] || `关联关键帧 ${index + 1}`,
            kind: index === 0 && frameReferencePlan.usesPreviousTail
              ? 'previous_tail' as const
              : 'dependency_frame' as const,
          })
          return entries
        }, [])
      const hasDependencyFrameReference = dependencyOrderedReferences.length > 0
      const panelAssetEntries = (hasDependencyFrameReference
        ? panelReferenceEntriesWithoutLocation
        : panelReferenceEntries).map((entry): OrderedReferenceImage => ({
          url: entry.url,
          label: entry.label,
          kind: entry.kind,
        }))
      const normalizedOrderedFrameReferences = await normalizeOrderedReferenceImages(
        [...dependencyOrderedReferences, ...panelAssetEntries],
        { panelId, frameId: frame.id, frameIndex: frame.frameIndex },
        referenceNormalizationCache,
      )
      const normalizedFrameRefs = normalizedOrderedFrameReferences.map((entry) => entry.url)
      const frameReferenceLabels = normalizedOrderedFrameReferences.map((entry) => entry.label)
      const normalizedDependencyReferenceCount = normalizedOrderedFrameReferences.filter(
        (entry) => entry.kind === 'previous_tail' || entry.kind === 'dependency_frame',
      ).length
      const frameHardConstraints = [
        buildReferenceImageOrderInstruction({
          locale: job.data.locale,
          references: normalizedOrderedFrameReferences,
        }),
        frameReferencePlan.usesPreviousTail
          ? buildPreviousTailReferenceHardRule(job.data.locale, previousTailIsSameScene)
          : '',
        buildStoryboardHardConstraints({
          locale: job.data.locale,
          aspectRatio,
          styleText: artStyle || '',
          referenceImagesCount: normalizedFrameRefs.length,
          referenceKinds: normalizedOrderedFrameReferences.map((entry) => entry.kind),
        }),
      ].filter(Boolean).join('\n\n')
      const frameBasePrompt = buildPanelFramePrompt({
        locale: job.data.locale,
        aspectRatio,
        styleText: artStyle || '',
        frame,
        panelDescription: panel.description,
        panelContext: promptContext,
        frameReferenceIndexes: frameReferencePlan.frameReferenceIndexes,
        usesPreviousTail: frameReferencePlan.usesPreviousTail,
        frameReferenceImageCount: normalizedDependencyReferenceCount,
        hardConstraints: frameHardConstraints,
      })
      const frameResolvedPrompt = frameBasePrompt
      const framePromptWithShotType = [
        buildShotPromptPrefix({ locale: job.data.locale, context: promptContext }),
        frameResolvedPrompt,
      ].filter(Boolean).join('\n')
      const framePrompt = prependAnimeStyleLabel({
        prompt: framePromptWithShotType,
        artStyle: modelConfig.artStyle,
        locale: job.data.locale === 'en' ? 'en' : 'zh',
      })
      logger.info({
        message: 'panel frame image prompt resolved',
        details: {
          panelId: panel.id,
          frameId: frame.id,
          frameIndex: frame.frameIndex,
          promptRefineEnabled: shouldRefinePrompt,
          analysisModel: modelConfig.analysisModel || null,
          promptLength: framePrompt.length,
          prompt: framePrompt,
        },
      })

      try {
        await clearTaskExternalId(job.data.taskId)
        const source = await resolveImageSourceFromGeneration(job, {
          userId: job.data.userId,
          modelId: modelKey,
          prompt: framePrompt,
          options: {
            referenceImages: normalizedFrameRefs,
            referenceImageLabels: frameReferenceLabels,
            aspectRatio,
          },
          allowTaskExternalIdResume: false,
          pollProgress: {
            start: 18 + Math.floor((i / Math.max(framesToGenerate.length, 1)) * 64),
            end: 18 + Math.floor(((i + 1) / Math.max(framesToGenerate.length, 1)) * 64),
          },
        })
        await assertTaskActive(job, 'upload_panel_candidate')
        const cosKey = await uploadImageSourceToCos(source, 'panel-frame', `${panel.id}-${frame.frameIndex}`, job)
        generatedByFrameIndex.set(frame.frameIndex, cosKey)
        generatedUrls.push(cosKey)
        await prisma.novelPromotionPanelFrame.update({
          where: { id: frame.id },
          data: {
            imageUrl: cosKey,
            generationStatus: 'completed',
            errorMessage: null,
          },
        })
        if (frame.frameIndex === 0 || !panel.imageUrl) {
          await prisma.novelPromotionPanel.update({
            where: { id: panel.id },
            data: {
              imageUrl: cosKey,
              candidateImages: null,
            },
          })
          panel.imageUrl = cosKey
        }
      } catch (error) {
        await prisma.novelPromotionPanelFrame.update({
          where: { id: frame.id },
          data: {
            generationStatus: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      }
      } catch (error) {
        await prisma.novelPromotionPanelFrame.update({
          where: { id: frame.id },
          data: {
            generationStatus: 'failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        })
        throw error
      }
    }

    const representativeImageUrl = generatedByFrameIndex.get(0) || generatedUrls[0] || null
    const targetFrameImageUrl = targetFrame ? (generatedByFrameIndex.get(targetFrame.frameIndex) || null) : null
    await assertTaskActive(job, 'persist_panel_image')
    await prisma.novelPromotionPanel.update({
      where: { id: panel.id },
      data: {
        imageUrl: representativeImageUrl,
        candidateImages: null,
      },
    })

    return {
      panelId: panel.id,
      candidateCount: generatedUrls.length,
      imageUrl: targetFrameImageUrl || representativeImageUrl,
      panelImageUrl: representativeImageUrl,
      ...(targetFrame ? { frameId: targetFrame.id, frameIndex: targetFrame.frameIndex } : {}),
    }
  }

  const finalConstraints = [
    buildReferenceImageOrderInstruction({
      locale: job.data.locale,
      references: singlePanelOrderedReferences,
    }),
    !isMultiFrameGroup && previousTailImageUrl
      ? buildPreviousTailReferenceHardRule(job.data.locale, previousTailIsSameScene)
      : '',
    hardConstraints,
  ].filter(Boolean).join('\n\n')
  const finalPrompt = finalConstraints
    ? `${withAnimeStyle}\n\n${finalConstraints}`
    : withAnimeStyle

  logger.info({
    message: 'panel image prompt resolved',
    details: {
      promptLength: finalPrompt.length,
      promptRefined: shouldRefinePrompt,
      promptRefineLevel: modelConfig.localStoryboardPromptRefineLevel || null,
    },
  })

  const candidates: string[] = []

  for (let i = 0; i < candidateCount; i++) {
    await reportTaskProgress(job, 18 + Math.floor((i / Math.max(candidateCount, 1)) * 58), {
      stage: 'generate_panel_candidate',
      candidateIndex: i,
    })

    const source = await resolveImageSourceFromGeneration(job, {
      userId: job.data.userId,
      modelId: modelKey,
      prompt: finalPrompt,
      options: {
        referenceImages: normalizedRefs,
        referenceImageLabels: singlePanelReferenceLabels,
        aspectRatio,
      },
      // 单个任务内会串行生成多候选，若允许按 task.externalId 续接会复用上一候选外部任务结果。
      allowTaskExternalIdResume: candidateCount === 1,
      pollProgress: { start: 30, end: 90 },
    })

    await assertTaskActive(job, 'upload_panel_candidate')
    const cosKey = await uploadImageSourceToCos(source, 'panel-candidate', `${panel.id}-${i}`, job)
    candidates.push(cosKey)
  }

  const isFirstGeneration = !panel.imageUrl

  await assertTaskActive(job, 'persist_panel_image')
  if (isFirstGeneration) {
    await prisma.novelPromotionPanel.update({
      where: { id: panel.id },
      data: {
        imageUrl: candidates[0] || null,
        candidateImages: candidateCount > 1 ? JSON.stringify(candidates) : null,
      },
    })
  } else {
    await prisma.novelPromotionPanel.update({
      where: { id: panel.id },
      data: {
        previousImageUrl: panel.imageUrl,
        candidateImages: JSON.stringify(candidates),
      },
    })
  }
  if (sortedFrames.length > 0 && candidates[0]) {
    await prisma.novelPromotionPanelFrame.update({
      where: { id: sortedFrames[0].id },
      data: {
        imageUrl: candidates[0],
        generationStatus: 'completed',
        errorMessage: null,
      },
    })
  }

  return {
    panelId: panel.id,
    candidateCount: candidates.length,
    imageUrl: isFirstGeneration ? candidates[0] || null : null,
  }
}
