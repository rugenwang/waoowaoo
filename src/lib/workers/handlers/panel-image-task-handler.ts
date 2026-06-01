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
  collectPanelReferenceImages,
  findCharacterByName,
  parsePanelCharacterReferences,
  pickFirstString,
  resolveNovelData,
} from './image-task-handler-shared'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { executeAiTextStep } from '@/lib/ai-runtime/client'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { clearTaskExternalId } from '@/lib/task/service'
import { buildPanelAiDataJson } from '@/lib/novel-promotion/panel-ai-data-json'
import { parseLocationAvailableSlots } from '@/lib/location-available-slots'
import {
  parsePanelFrameDependencyPlan,
  withPreviousTailDependency,
} from '@/lib/novel-promotion/panel-tail-reference'
import { loadPreviousPanelTailImageInfo } from '@/lib/novel-promotion/previous-panel-tail'

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
    const matchedAppearance =
      (reference.appearance
        ? appearances.find((appearance) => (appearance.changeReason || '').toLowerCase() === reference.appearance!.toLowerCase())
        : null) || appearances[0] || null

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

function buildPanelFrameRefineContext(params: {
  panelContext: ReturnType<typeof buildPanelPromptContext>
  frame: PanelFrameForGeneration
  frameReferenceIndexes: number[]
  usesPreviousTail: boolean
  referenceImageCount: number
}) {
  return {
    ...params.panelContext,
    current_frame: {
      frame_index: params.frame.frameIndex,
      frame_label: `F${params.frame.frameIndex + 1}`,
      frame_time_sec: params.frame.frameTimeSec,
      frame_role: params.frame.frameRole || '',
      image_prompt: params.frame.imagePrompt || '',
      dependency_frame_indexes: params.frameReferenceIndexes,
      uses_previous_panel_tail_frame: params.usesPreviousTail,
      reference_image_count: params.referenceImageCount,
    },
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
  const cameraMove = String(shot.camera_move || '').trim()
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
  const characters = Array.isArray(shot.characters)
    ? (shot.characters as PromptCharacter[])
      .map((character) => {
        const name = String(character?.name || '').trim()
        const appearance = String(character?.appearance || '').trim()
        const slot = String(character?.slot || '').trim()
        const referenceDescription = String(character?.reference_description || '').trim()
        const extras = [
          appearance,
          slot ? `${params.locale === 'en' ? 'fixed position' : '固定位置'}：${slot}` : '',
          referenceDescription ? `${params.locale === 'en' ? 'reference outfit/details' : '参考服装/细节'}：${referenceDescription}` : '',
        ].filter(Boolean).join(params.locale === 'en' ? ', ' : '，')
        return name ? (extras ? `${name}（${extras}）` : name) : ''
      })
      .filter(Boolean)
      .join(params.locale === 'en' ? '; ' : '、')
    : ''
  const props = Array.isArray(shot.props)
    ? (shot.props as Array<string | PromptRecord>).map((prop) => {
      if (typeof prop === 'string') return prop
      const name = String(prop.name || '').trim()
      const propDescription = String(prop.description || '').trim()
      if (!name) return ''
      return propDescription ? `${name}（${propDescription}）` : name
    }).filter(Boolean).join(params.locale === 'en' ? '; ' : '、')
    : ''
  const framePrompt = String(params.frame.imagePrompt || params.panelDescription || '').trim()
  const referenceLabels = [
    params.usesPreviousTail ? 'FP（上一分镜尾帧）' : '',
    ...params.frameReferenceIndexes.map((index) => `F${index + 1}`),
  ].filter(Boolean).join(', ')
  const hasReferenceRule = params.frame.frameIndex > 0 || params.usesPreviousTail
  const zhReferenceRule = hasReferenceRule
    ? [
      params.frameReferenceImageCount > 0
        ? `参考帧规则：参考图前 ${params.frameReferenceImageCount} 张是直接关联关键帧${referenceLabels ? `（${referenceLabels}）` : ''}。`
        : '参考帧规则：必须承接直接相邻剧情的角色、服饰、场景、光线和构图逻辑。',
      params.usesPreviousTail ? 'FP 表示本帧需要参考上一分镜的尾帧；请把上一分镜结尾状态自然承接为当前分镜开场状态，但不要原样复制上一帧构图。' : '',
      '请根据直接关联帧和本帧剧本描述，生成顺滑过渡到当前秒点的画面；保留身份和服装一致，但不要原样复制参考帧姿势、表情、站位或构图。',
      '本帧只表现当前秒点的关键状态，要有明确变化，例如动作进展、人物位置、手部/道具状态、视线、表情或场景转化。'
    ].join('\n')
    : ''
  const enReferenceRule = hasReferenceRule
    ? [
      params.frameReferenceImageCount > 0
        ? `Reference-frame rule: the first ${params.frameReferenceImageCount} reference image(s) are directly linked keyframes${referenceLabels ? ` (${referenceLabels})` : ''}.`
        : 'Reference-frame rule: preserve continuity from the directly adjacent story beat.',
      params.usesPreviousTail ? 'FP means this frame references the previous panel tail frame; continue naturally from the previous ending state into this panel opening state without copying the previous composition exactly.' : '',
      'Use the directly linked frame(s) and this frame script description to create a smooth current-frame image. Keep identity/outfit consistent, but do not copy the reference-frame pose, expression, position, or composition exactly.',
      'Show only the current second state with a clear change: action progress, body position, hand/prop state, gaze, expression, or scene transition.'
    ].join('\n')
    : ''
  const lines = params.locale === 'en'
    ? [
      `Aspect ratio: ${params.aspectRatio}`,
      shotType || cameraMove ? `Shot: ${[shotType, cameraMove].filter(Boolean).join(', ')}` : '',
      location ? `Location: ${location}` : '',
      locationReferenceText ? `Location reference: ${locationReferenceText}` : '',
      characters ? `Characters: ${characters}` : '',
      props ? `Props: ${props}` : '',
      referencePriority ? `Reference priority: ${referencePriority}` : '',
      params.panelDescription ? `Panel description: ${params.panelDescription}` : '',
      framePrompt ? `Key frame image prompt: ${framePrompt}` : '',
      `Frame time: ${params.frame.frameTimeSec}s`,
      params.frame.frameRole ? `Frame role: ${params.frame.frameRole}` : '',
      params.frame.frameIndex === 0 ? 'This is the opening keyframe: show the original state before any later action, movement, emotional change, fight result, or transition result.' : '',
      enReferenceRule,
      params.styleText ? `Style: ${params.styleText}` : '',
      'Generate exactly one still image for this key frame. Keep visual continuity with reference images. Do not depict camera movement, timeline segments, dialogue text, music, or multiple action moments.',
      params.hardConstraints,
    ]
    : [
      `画面比例：${params.aspectRatio}`,
      shotType || cameraMove ? `镜头：${[shotType, cameraMove].filter(Boolean).join('，')}` : '',
      location
        ? (params.usesPreviousTail
          ? `场景连续性：实际环境必须严格沿用第一张参考图 FP；当前地点文字“${location}”只作为剧情上下文，不能覆盖 FP 场景。`
          : `场景：${location}`)
        : '',
      !params.usesPreviousTail && locationReferenceText ? `场景参考：${locationReferenceText}` : '',
      characters ? `角色：${characters}` : '',
      props ? `道具：${props}` : '',
      referencePriority ? `参考优先级：${referencePriority}` : '',
      params.panelDescription ? `分镜描述：${params.panelDescription}` : '',
      framePrompt ? `关键帧生图提示：${framePrompt}` : '',
      `所在秒点：${params.frame.frameTimeSec}s`,
      params.frame.frameRole ? `关键帧角色：${params.frame.frameRole}` : '',
      params.frame.frameIndex === 0 ? '这是开头关键帧：必须表现后续动作发生前的原始状态，人物尚未完成移动、转身、打斗、情绪变化或事件结果。' : '',
      zhReferenceRule,
      params.styleText ? `风格：${params.styleText}` : '',
      '只生成这一秒点的一张静态关键帧图，必须与参考图保持人物、服饰、场景、光线和画风连贯。不要画运镜、时间轴、字幕、台词文字、背景音乐或多个连续动作瞬间。',
      params.hardConstraints,
    ]
  return lines.filter(Boolean).join('\n')
}

export function buildStoryboardHardConstraints(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  referenceImagesCount: number
}): string {
  const ratio = String(params.aspectRatio || '').trim()
  const style = String(params.styleText || '').trim()
  const hasRefs = params.referenceImagesCount > 0

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
      hasRefs ? '- Match reference images strictly: character asset images control identity/outfit/hairstyle; prior-frame references control continuity; location asset images control space/lighting/allowed positions; prop asset images control prop appearance. Do NOT copy pose/composition exactly, and do NOT draw any text from references.' : null,
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
    hasRefs ? '- 有参考图时必须严格匹配：角色资产图锁定身份/服装/发型；上一帧参考图锁定连续性；场景资产图锁定空间结构/光线/可站位置；道具资产图锁定道具外观。禁止原样复制参考图姿势/构图；参考图上的文字标签仅供识别，禁止画入图中。' : null,
    style ? `- 风格必须与参考一致：${style}` : null,
  ].filter(Boolean).join('\n')
}

function buildPreviousTailReferenceHardRule(locale: TaskJobData['locale']): string {
  if (locale === 'en') {
    return [
      'PREVIOUS-PANEL TAIL REFERENCE (must follow):',
      '- The FIRST reference image is FP, the previous panel tail frame.',
      '- The current image must naturally continue from FP as the opening state of this panel.',
      '- Character appearance MUST strictly follow FP and character asset references: same identity, face, hairstyle, makeup, outfit style, clothing color, fabric layers, accessories, body silhouette, and relative position continuity.',
      '- The scene/background MUST strictly follow FP: keep the same environment, spatial layout, architecture/background structures, furniture, furnishings, interior decor, wall/floor materials, doors/windows, tables/chairs/cabinets, lamps, key objects, light direction, color mood, weather/time-of-day, depth relationship, and overall atmosphere from the first reference image.',
      '- Do not replace, add, remove, rearrange, or redesign furniture and set dressing from FP unless the current panel explicitly says a specific object moved.',
      '- If the current panel location/scene text conflicts with FP, FP wins. Treat current location text only as story context, never as permission to change the FP environment.',
      '- Do not redesign, replace, or freely reinterpret the FP scene. Only adjust the camera framing slightly when the current panel description requires it.',
      '- Preserve FP continuity for character identity, outfit, hairstyle, prop state, spatial relationship, lighting direction, color mood, and story state.',
      '- Do not ignore FP, but also do not copy FP exactly; create the next coherent still frame based on the current panel description.',
    ].join('\n')
  }
  return [
    '【上一分镜尾帧 FP 参考规则 - 必须遵守】',
    '- 第 1 张参考图是 FP，即上一分镜的尾帧。',
    '- 当前图片必须自然承接 FP，作为当前分镜的开场状态。',
    '- 人物必须严格按照 FP 和角色资产参考图：保持同一身份、脸型五官、发型、妆容、服装款式、服装颜色、面料层次、配饰、体型轮廓和相对位置连续性。',
    '- 场景/背景必须严格按照 FP：保持第 1 张参考图里的同一环境、空间布局、建筑/背景结构、家具、陈设、室内装饰、墙面/地面材质、门窗、桌椅柜、灯具、关键物体、光线方向、色调、天气/时间、前后景关系和整体氛围。',
    '- 禁止替换、增删、重排或重新设计 FP 中的家具和场景陈设；除非当前分镜明确写了某个物体发生移动。',
    '- 如果当前分镜的场景/地点文字与 FP 不一致，必须以 FP 为准；当前场景文字只能作为剧情上下文，不能作为改变 FP 环境的依据。',
    '- 禁止重新设计、替换或自由发挥 FP 的场景；除非当前分镜描述明确要求，只允许轻微调整取景范围和构图。',
    '- 必须延续 FP 中的人物身份、服装发型、道具状态、空间关系、光线方向、色调氛围和剧情状态。',
    '- 不能忽略 FP，也不能原样复制 FP；要结合当前分镜描述生成顺滑衔接后的当前静态画面。',
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

function buildShotPromptPrefix(params: {
  locale: TaskJobData['locale']
  context: ReturnType<typeof buildPanelPromptContext>
}): string {
  const shot = (params.context as { shot?: PromptRecord }).shot || {}
  const shotType = String(shot.shot_type || '').trim()
  const cameraMove = String(shot.camera_move || '').trim()
  if (!shotType && !cameraMove) return ''
  if (params.locale === 'en') {
    return [
      shotType ? `Shot type: ${shotType}` : '',
      cameraMove ? `camera framing/movement hint: ${cameraMove}` : '',
    ].filter(Boolean).join('; ')
  }
  return [
    shotType ? `镜头类型：${shotType}` : '',
    cameraMove ? `镜头方式：${cameraMove}` : '',
  ].filter(Boolean).join('；')
}

export async function handlePanelImageTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const panelId = pickFirstString(payload.panelId, job.data.targetId)
  const targetFrameId = pickFirstString(payload.targetFrameId, payload.frameId)
  if (!panelId) throw new Error('panelId missing')

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
      ? framesNeedingGenerationForPreviousTailCheck.some((frame) => parsePanelFrameDependencyPlan(
        withPreviousTailDependency(
          frame.dependencyFrameIds,
          panelUsesPreviousTailAsReference,
          frame.frameIndex,
        ),
      ).previousTail)
      : panelUsesPreviousTailAsReference

  const candidateCount = clampCount(payload.candidateCount ?? payload.count, 1, 4, 1)
  const panelReferenceImages = await collectPanelReferenceImages(projectData, panel)
  const panelReferenceImagesWithoutLocation = needsPreviousTailReference
    ? await collectPanelReferenceImages(projectData, panel, { includeLocationReference: false })
    : panelReferenceImages
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
  const panelReferenceImagesForSinglePanel = !isMultiFrameGroup && previousTailImageUrl
    ? panelReferenceImagesWithoutLocation
    : panelReferenceImages
  const singlePanelRefs = uniqueStrings([
    ...(!isMultiFrameGroup && previousTailImageUrl
      ? [toSignedUrlIfCos(previousTailImageUrl, 3600) || previousTailImageUrl]
      : []),
    ...panelReferenceImagesForSinglePanel,
  ])
  const normalizedRefs = await normalizeReferenceImagesForGeneration(singlePanelRefs)
  const normalizedPanelRefs = isMultiFrameGroup
    ? await normalizeReferenceImagesForGeneration(uniqueStrings(panelReferenceImages))
    : normalizedRefs
  const normalizedPanelRefsWithoutLocation = isMultiFrameGroup
    ? await normalizeReferenceImagesForGeneration(uniqueStrings(panelReferenceImagesWithoutLocation))
    : normalizedRefs

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
      referenceImagesRawCount: panelReferenceImages.length,
      referenceImagesEffectiveRawCount: singlePanelRefs.length,
      referenceImagesNormalizedCount: normalizedRefs.length,
      referenceImageLabels: [
        ...(!isMultiFrameGroup && previousTailImageUrl ? ['FP(previous-panel-tail)'] : []),
        ...panelReferenceImagesForSinglePanel.map((_, index) => `asset-${index + 1}`),
      ],
      rawUrls: singlePanelRefs.map((u) => u.substring(0, 100)),
      normalizedUrls: normalizedRefs.map((u) => u.substring(0, 100)),
      panelCharacters: panel.characters,
      panelLocation: panel.location,
      artStyle: modelConfig.artStyle,
      usePreviousPanelTailAsReference: panelUsesPreviousTailAsReference,
    },
  })

  const artStyle = getArtStylePrompt(modelConfig.artStyle, job.data.locale)
  if (!projectData.videoRatio) throw new Error('Project videoRatio not configured')
  const aspectRatio = projectData.videoRatio

  const usePanelDescriptionEnabled = modelConfig.localStoryboardUsePanelDescriptionEnabled === true
  const panelDescriptionText = String(panel.description || '').trim()

  const promptContext = buildPanelPromptContext({
    panel: {
      id: panel.id,
      shotType: panel.shotType,
      cameraMove: panel.cameraMove,
      description: panel.description,
      imagePrompt: null,
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

  // 默认走当前“查看数据 JSON”；只有在开启“启用画面描述”且 panel.description 有内容时，才用画面描述直出。
  let prompt = ''
  if (usePanelDescriptionEnabled && panelDescriptionText) {
    prompt = buildPanelDescriptionPrompt({
      description: panelDescriptionText,
      styleText: artStyle || '',
      locale: job.data.locale,
    })
  } else {
    // 对本地模型（ltx/MLX），不把 JSON 串当作最终 prompt；而是把结构化数据整理成“整洁的自然语言 prompt”
    // （与项目里其它生图链路一致：最终 prompt 是一段可读文本，而不是大段 JSON）。
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

  // 可选：本地模型前先用文本模型精炼 prompt（把 JSON/规则压成一条更适合本地模型的提示词）
  const shouldRefinePrompt =
    modelConfig.localStoryboardPromptRefineEnabled === true
    && !!modelConfig.analysisModel

  const refinedOrRawPrompt = !isMultiFrameGroup && shouldRefinePrompt ? await (async () => {
    try {
      const strength = modelConfig.localStoryboardPromptRefineLevel || 'medium'
      const refineUserPrompt = buildPrompt({
        promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE,
        locale: job.data.locale,
        variables: {
          storyboard_text_json_input: contextJson,
          source_text: panel.description || '',
          aspect_ratio: aspectRatio,
          style: artStyle || '与参考图风格一致',
          strength,
          reference_images_count: String(normalizedRefs.length),
        },
      })

      logger.info({
        message: 'storyboard prompt refine request payload',
        details: {
          panelId: panel.id,
          locale: job.data.locale,
          model: modelConfig.analysisModel,
          usePanelDescription: usePanelDescriptionEnabled && !!panelDescriptionText,
          aspectRatio,
          strength,
          referenceImagesCount: normalizedRefs.length,
          data: promptContext,
          contextJson,
          refineUserPrompt,
        },
      })

      const res = await executeAiTextStep({
        userId: job.data.userId,
        projectId: job.data.projectId,
        model: modelConfig.analysisModel!,
        action: 'NP_STORYBOARD_PROMPT_REFINE',
        meta: {
          stepId: 'np_storyboard_prompt_refine',
          stepTitle: 'storyboard_prompt_refine',
          stepIndex: 1,
          stepTotal: 1,
          stepAttempt: 1,
        },
        reasoning: false,
        temperature: 0.2,
        messages: [
          { role: 'user', content: refineUserPrompt },
        ],
      })

      const refined = cleanupRefinedPrompt(res.text)
      logger.info({
        message: 'storyboard prompt refine response payload',
        details: {
          panelId: panel.id,
          rawResponseText: res.text,
          cleanedPrompt: refined,
        },
      })
      return refined || prompt
    } catch (err) {
      logger.warn({
        message: 'storyboard prompt refine failed, fallback to original prompt',
        details: { error: String(err) },
      })
      return prompt
    }
  })() : prompt
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
  })

  if (isMultiFrameGroup) {
    const generatedByFrameIndex = new Map<number, string>()
    const generatedUrls: string[] = []
    const existingGeneratedFrames = sortedFrames.filter((frame) => {
      if (targetFrameId && frame.id === targetFrameId) return false
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
      : sortedFrames.filter((frame) => !(shouldResumePartialGroup && frame.imageUrl))

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
      const dependencyUrls = frameReferencePlan.urls
        .map((value) => toSignedUrlIfCos(value, 3600))
        .filter((value): value is string => Boolean(value))
      const normalizedFrameReferenceRefs = dependencyUrls.length > 0
        ? await normalizeReferenceImagesForGeneration(dependencyUrls)
        : []
      const panelAssetRefs = frameReferencePlan.usesPreviousTail
        ? normalizedPanelRefsWithoutLocation
        : normalizedPanelRefs
      const normalizedFrameRefs = uniqueStrings([
        ...normalizedFrameReferenceRefs,
        ...panelAssetRefs,
      ])
      const frameHardConstraints = [
        frameReferencePlan.usesPreviousTail ? buildPreviousTailReferenceHardRule(job.data.locale) : '',
        buildStoryboardHardConstraints({
          locale: job.data.locale,
          aspectRatio,
          styleText: artStyle || '',
          referenceImagesCount: normalizedFrameRefs.length,
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
        frameReferenceImageCount: normalizedFrameReferenceRefs.length,
        hardConstraints: frameHardConstraints,
      })
      const framePromptInput = buildPanelFrameRefineContext({
        panelContext: promptContext,
        frame,
        frameReferenceIndexes: frameReferencePlan.frameReferenceIndexes,
        usesPreviousTail: frameReferencePlan.usesPreviousTail,
        referenceImageCount: normalizedFrameRefs.length,
      })
      const frameContextJson = JSON.stringify(framePromptInput, null, 2)
      const frameResolvedPrompt = shouldRefinePrompt ? await (async () => {
        try {
          const strength = modelConfig.localStoryboardPromptRefineLevel || 'medium'
          const refineUserPrompt = buildPrompt({
            promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE,
            locale: job.data.locale,
            variables: {
              storyboard_text_json_input: frameContextJson,
              source_text: frame.imagePrompt || panel.description || '',
              aspect_ratio: aspectRatio,
              style: artStyle || '与参考图风格一致',
              strength,
              reference_images_count: String(normalizedFrameRefs.length),
            },
          })

          logger.info({
            message: 'storyboard frame prompt refine request payload',
            details: {
              panelId: panel.id,
              frameId: frame.id,
              frameIndex: frame.frameIndex,
              locale: job.data.locale,
              model: modelConfig.analysisModel,
              aspectRatio,
              strength,
              referenceImagesCount: normalizedFrameRefs.length,
              data: framePromptInput,
              contextJson: frameContextJson,
              refineUserPrompt,
            },
          })

          const res = await executeAiTextStep({
            userId: job.data.userId,
            projectId: job.data.projectId,
            model: modelConfig.analysisModel!,
            action: 'NP_STORYBOARD_PROMPT_REFINE',
            meta: {
              stepId: 'np_storyboard_frame_prompt_refine',
              stepTitle: 'storyboard_frame_prompt_refine',
              stepIndex: 1,
              stepTotal: 1,
              stepAttempt: 1,
            },
            reasoning: false,
            temperature: 0.2,
            messages: [
              { role: 'user', content: refineUserPrompt },
            ],
          })

          const refined = cleanupRefinedPrompt(res.text)
          const refinedWithConstraints = refined
            ? [refined, frameHardConstraints].filter(Boolean).join('\n\n')
            : ''
          logger.info({
            message: 'storyboard frame prompt refine response payload',
            details: {
              panelId: panel.id,
              frameId: frame.id,
              frameIndex: frame.frameIndex,
              rawResponseText: res.text,
              cleanedPrompt: refinedWithConstraints || refined,
            },
          })
          return refinedWithConstraints || frameBasePrompt
        } catch (err) {
          logger.warn({
            message: 'storyboard frame prompt refine failed, fallback to frame base prompt',
            details: {
              panelId: panel.id,
              frameId: frame.id,
              frameIndex: frame.frameIndex,
              error: String(err),
            },
          })
          return frameBasePrompt
        }
      })() : frameBasePrompt
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
            referenceImageLabels: [
              ...(frameReferencePlan.usesPreviousTail ? ['FP(previous-panel-tail)'] : []),
              ...frameReferencePlan.frameReferenceIndexes.map((index) => `F${index + 1}`),
              ...panelAssetRefs.map((_, index) => `asset-${index + 1}`),
            ],
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
    !isMultiFrameGroup && previousTailImageUrl ? buildPreviousTailReferenceHardRule(job.data.locale) : '',
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
        referenceImageLabels: [
          ...(!isMultiFrameGroup && previousTailImageUrl ? ['FP(previous-panel-tail)'] : []),
          ...panelReferenceImagesForSinglePanel.map((_, index) => `asset-${index + 1}`),
        ],
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
