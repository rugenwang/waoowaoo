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
import {
  parseLocationAvailableSlots,
} from '@/lib/location-available-slots'
import { executeAiTextStep } from '@/lib/ai-runtime/client'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { clearTaskExternalId } from '@/lib/task/service'

type PromptRecord = Record<string, unknown>
type PromptCharacter = { name?: unknown; appearance?: unknown; slot?: unknown }
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
}): string {
  const descriptions = parseDescriptionList(appearance.descriptions || null)
  if (descriptions.length > 0) {
    const selectedIndex = typeof appearance.selectedIndex === 'number' ? appearance.selectedIndex : 0
    const selected = descriptions[selectedIndex] || descriptions[0]
    if (selected && selected.trim()) return selected.trim()
  }
  if (typeof appearance.description === 'string' && appearance.description.trim()) {
    return appearance.description.trim()
  }
  return '无描述'
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
    srtSegment: string | null
    photographyRules: string | null
    actingNotes: string | null
  }
  projectData: Awaited<ReturnType<typeof resolveNovelData>>
}) {
  const panelCharacters = parsePanelCharacterReferences(params.panel.characters)
  const characterContexts = panelCharacters.map((reference) => {
    const character = findCharacterByName(params.projectData.characters || [], reference.name)
    if (!character) {
      return {
        name: reference.name,
        appearance: reference.appearance || null,
        description: '无角色外貌数据',
      }
    }

    const appearances = character.appearances || []
    const matchedAppearance =
      (reference.appearance
        ? appearances.find((appearance) => (appearance.changeReason || '').toLowerCase() === reference.appearance!.toLowerCase())
        : null) || appearances[0] || null

    return {
      name: character.name,
      appearance: matchedAppearance?.changeReason || null,
      description: matchedAppearance ? pickAppearanceDescription(matchedAppearance) : '无角色外貌数据',
      slot: reference.slot || null,
    }
  })

  const locationContext = (() => {
    if (!params.panel.location) return null
    const matchedLocation = (params.projectData.locations || []).find(
      (item) => item.name.toLowerCase() === params.panel.location!.toLowerCase(),
    )
    if (!matchedLocation) return null
    const selectedImage = (matchedLocation.images || []).find((item) => item.isSelected) || matchedLocation.images?.[0]
    return {
      name: matchedLocation.name,
      description: selectedImage?.description || null,
      available_slots: parseLocationAvailableSlots(selectedImage?.availableSlots),
    }
  })()

  return {
    panel: {
      panel_id: params.panel.id,
      shot_type: params.panel.shotType || '',
      camera_move: params.panel.cameraMove || '',
      description: params.panel.description || '',
      image_prompt: params.panel.imagePrompt || '',
      video_prompt: params.panel.videoPrompt || '',
      location: params.panel.location || '',
      characters: panelCharacters,
      source_text: params.panel.srtSegment || '',
      photography_rules: parseJsonUnknown(params.panel.photographyRules),
      acting_notes: parseJsonUnknown(params.panel.actingNotes),
    },
    context: {
      character_appearances: characterContexts,
      location_reference: locationContext,
    },
  }
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
}): string {
  const shotType = String(params.context.panel.shot_type || '').trim()
  const cameraMove = String(params.context.panel.camera_move || '').trim()
  const description = String(params.context.panel.description || '').trim()
  const imagePrompt = String(params.context.panel.image_prompt || '').trim()
  const location = String(params.context.panel.location || '').trim()

  const characterLines = (() => {
    const chars = Array.isArray(params.context.panel.characters)
      ? params.context.panel.characters as PromptCharacter[]
      : []
    if (chars.length === 0) return ''
    if (params.locale === 'en') {
      return `Characters: ${chars.map((c) => {
        const name = String(c?.name || '').trim()
        const appearance = String(c?.appearance || '').trim()
        const slot = String(c?.slot || '').trim()
        const extras = [
          appearance ? `appearance: ${appearance}` : '',
          slot ? `fixed position: ${slot}` : '',
        ].filter(Boolean).join(', ')
        return extras ? `${name} (${extras})` : name
      }).filter(Boolean).join('; ')}`
    }
    return `角色：${chars.map((c) => {
      const name = String(c?.name || '').trim()
      const appearance = String(c?.appearance || '').trim()
      const slot = String(c?.slot || '').trim()
      const extras = [
        appearance ? `形象：${appearance}` : '',
        slot ? `固定位置：${slot}` : '',
      ].filter(Boolean).join('，')
      return extras ? `${name}（${extras}）` : name
    }).filter(Boolean).join('、')}`
  })()

  const photographyText = (() => {
    const rules = params.context.panel.photography_rules as PromptRecord | null
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
    const notes = params.context.panel.acting_notes
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
      location ? `Location: ${location}` : '',
      characterLines,
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
    characterLines,
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

function parseDependencyFrameIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        const value = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN
        return Number.isFinite(value) ? Math.floor(value) : null
      })
      .filter((item): item is number => item !== null && item >= 0)
  } catch {
    return []
  }
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

function buildFrameReferencePlan(params: {
  frame: PanelFrameForGeneration
  generatedByFrameIndex: Map<number, string>
}) {
  const dependencyIndexes = uniqueNumbers(parseDependencyFrameIds(params.frame.dependencyFrameIds))
  const frameReferenceIndexes = params.frame.frameIndex > 0
    ? (dependencyIndexes.length > 0 ? dependencyIndexes : [Math.max(0, params.frame.frameIndex - 1)])
    : dependencyIndexes
  const urls = frameReferenceIndexes
    .map((frameIndex) => params.generatedByFrameIndex.get(frameIndex))
    .filter((value): value is string => Boolean(value))
  return {
    frameReferenceIndexes,
    urls: uniqueStrings(urls),
  }
}

function buildPanelFramePrompt(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  frame: PanelFrameForGeneration
  panelDescription: string | null
  groupVideoPrompt: string | null
  frameReferenceIndexes: number[]
  frameReferenceImageCount: number
  hardConstraints: string
}) {
  const framePrompt = String(params.frame.imagePrompt || params.panelDescription || '').trim()
  const motionPrompt = String(params.frame.videoPrompt || '').trim()
  const referenceLabels = params.frameReferenceIndexes.map((index) => `F${index + 1}`).join(', ')
  const zhReferenceRule = params.frame.frameIndex > 0
    ? [
      params.frameReferenceImageCount > 0
        ? `参考帧规则：参考图前 ${params.frameReferenceImageCount} 张是本分镜组已生成的直接关联关键帧${referenceLabels ? `（${referenceLabels}）` : ''}。`
        : '参考帧规则：这是基础帧之后的关键帧，必须承接直接相邻剧情的角色、服饰、场景、光线和构图逻辑。',
      '请根据直接关联帧和本帧剧本描述，生成顺滑过渡到当前秒点的画面；保留身份和服装一致，但不要原样复制参考帧姿势、表情、站位或构图。',
      '本帧只表现当前秒点的关键状态，要有明确变化，例如动作进展、人物位置、手部/道具状态、视线、表情或场景转化。'
    ].join('\n')
    : ''
  const enReferenceRule = params.frame.frameIndex > 0
    ? [
      params.frameReferenceImageCount > 0
        ? `Reference-frame rule: the first ${params.frameReferenceImageCount} reference image(s) are directly linked generated keyframes from this storyboard group${referenceLabels ? ` (${referenceLabels})` : ''}.`
        : 'Reference-frame rule: this is after the base frame; preserve continuity from the directly adjacent story beat.',
      'Use the directly linked frame(s) and this frame script description to create a smooth current-frame image. Keep identity/outfit consistent, but do not copy the reference-frame pose, expression, position, or composition exactly.',
      'Show only the current second state with a clear change: action progress, body position, hand/prop state, gaze, expression, or scene transition.'
    ].join('\n')
    : ''
  const lines = params.locale === 'en'
    ? [
      `Aspect ratio: ${params.aspectRatio}`,
      framePrompt ? `Key frame image prompt: ${framePrompt}` : '',
      `Frame time: ${params.frame.frameTimeSec}s`,
      params.frame.frameRole ? `Frame role: ${params.frame.frameRole}` : '',
      params.frame.frameIndex === 0 ? 'This is the opening keyframe: show the original state before any later action, movement, emotional change, fight result, or transition result.' : '',
      enReferenceRule,
      motionPrompt ? `Continuity note for this still frame only: ${motionPrompt}` : '',
      params.styleText ? `Style: ${params.styleText}` : '',
      'Generate exactly one still image for this key frame. Keep visual continuity with reference images. Do not depict camera movement, timeline segments, dialogue text, music, or multiple action moments.',
      params.hardConstraints,
    ]
    : [
      `画面比例：${params.aspectRatio}`,
      framePrompt ? `关键帧生图提示：${framePrompt}` : '',
      `所在秒点：${params.frame.frameTimeSec}s`,
      params.frame.frameRole ? `关键帧角色：${params.frame.frameRole}` : '',
      params.frame.frameIndex === 0 ? '这是开头关键帧：必须表现后续动作发生前的原始状态，人物尚未完成移动、转身、打斗、情绪变化或事件结果。' : '',
      zhReferenceRule,
      motionPrompt ? `本帧静态衔接提示：${motionPrompt}` : '',
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
      '- Characters must be fully and properly clothed, consistent with their reference outfit; no shirtless, semi-nude, exposed torso, revealing outfit, missing clothing, or torn-clothing exposure.',
      ratio ? `- Aspect ratio must be EXACT: ${ratio}.` : null,
      hasRefs ? '- Match reference images for identity, outfit, style, and scene continuity; do NOT copy pose/composition exactly, and do NOT draw any text from references.' : null,
      style ? `- Keep visual style consistent: ${style}.` : null,
    ].filter(Boolean).join('\n')
  }

  return [
    '【强制规则 - 必须遵守】',
    '- 画面中绝对禁止出现任何文字（字幕/标签/编号/水印/符号）。',
    '- 只生成一张镜头画面（禁止拼图/多镜头/多格）。',
    '- 多人或一群人的场景里，每个可见人物必须是不同的脸；禁止在同一个镜头中出现同一张脸、重复五官模板、克隆脸或看起来像同一个人的多个个体。',
    '- 人物必须衣着完整、服饰得体，并与角色参考图/设定服装一致；禁止半裸、裸露上身、暴露服装、缺少衣服、衣物破损导致裸露。',
    ratio ? `- 画面比例必须严格为：${ratio}` : null,
    hasRefs ? '- 有参考图时：外貌、服饰、画风、场景连续性需与参考图一致；禁止原样复制参考图姿势/构图；参考图上的文字标签仅供识别，禁止画入图中。' : null,
    style ? `- 风格必须与参考一致：${style}` : null,
  ].filter(Boolean).join('\n')
}

export function cleanupRefinedPrompt(raw: string): string {
  const text = String(raw || '').trim()
  if (!text) return ''
  // 去掉可能的 code fence 或多余引号
  const noFence = text.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim()
  const unquoted = noFence.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim()
  // 防止输出过长影响本地模型（保守截断）
  return unquoted.length > 1200 ? unquoted.slice(0, 1200) : unquoted
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

  const projectData = await resolveNovelData(job.data.projectId)
  const modelConfig = await getProjectModels(job.data.projectId, job.data.userId)
  const modelKey = modelConfig.storyboardModel
  if (!modelKey) throw new Error('Storyboard model not configured')
  const parsedStoryboardModel = parseModelKeyStrict(modelKey)

  const candidateCount = clampCount(payload.candidateCount ?? payload.count, 1, 4, 1)
  const refs = await collectPanelReferenceImages(projectData, panel)
  const normalizedRefs = await normalizeReferenceImagesForGeneration(refs)

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
      referenceImagesRawCount: refs.length,
      referenceImagesNormalizedCount: normalizedRefs.length,
      rawUrls: refs.map((u) => u.substring(0, 100)),
      normalizedUrls: normalizedRefs.map((u) => u.substring(0, 100)),
      panelCharacters: panel.characters,
      panelLocation: panel.location,
      artStyle: modelConfig.artStyle,
    },
  })

  const artStyle = getArtStylePrompt(modelConfig.artStyle, job.data.locale)
  if (!projectData.videoRatio) throw new Error('Project videoRatio not configured')
  const aspectRatio = projectData.videoRatio

  const usePanelDescriptionEnabled = modelConfig.localStoryboardUsePanelDescriptionEnabled === true
  const panelDescriptionText = String(panel.description || '').trim()

  // 默认走 JSON 模板；只有在开启“启用画面描述”且 panel.description 有内容时，才用画面描述直出。
  let contextJson = ''
  let prompt = ''
  let promptContext: ReturnType<typeof buildPanelPromptContext> | null = null
  if (usePanelDescriptionEnabled && panelDescriptionText) {
    prompt = buildPanelDescriptionPrompt({
      description: panelDescriptionText,
      styleText: artStyle || '',
      locale: job.data.locale,
    })
  } else {
    promptContext = buildPanelPromptContext({
      panel: {
        id: panel.id,
        shotType: panel.shotType,
        cameraMove: panel.cameraMove,
        description: panel.description,
        imagePrompt: panel.imagePrompt,
        videoPrompt: panel.videoPrompt,
        location: panel.location,
        characters: panel.characters,
        srtSegment: panel.srtSegment,
        photographyRules: panel.photographyRules,
        actingNotes: panel.actingNotes,
      },
      projectData,
    })
    contextJson = JSON.stringify(promptContext, null, 2)

    // 对本地模型（ltx/MLX），不把 JSON 串当作最终 prompt；而是把结构化数据整理成“整洁的自然语言 prompt”
    // （与项目里其它生图链路一致：最终 prompt 是一段可读文本，而不是大段 JSON）。
    if (parsedStoryboardModel?.provider === 'local') {
      prompt = buildPanelStructuredPrompt({
        locale: job.data.locale,
        aspectRatio,
        styleText: artStyle || '',
        context: promptContext,
      })
    } else {
      // 非本地模型仍沿用模板（模板内部会引用 storyboard_text_json_input）
      prompt = buildPanelPrompt({
        locale: job.data.locale,
        aspectRatio,
        styleText: artStyle || '与参考图风格一致',
        sourceText: panel.srtSegment || panel.description || '',
        contextJson,
      })
    }
  }

  // 可选：本地模型前先用文本模型精炼 prompt（把 JSON/规则压成一条更适合本地模型的提示词）
  const shouldRefinePrompt =
    modelConfig.localStoryboardPromptRefineEnabled === true
    && !!modelConfig.analysisModel

  const refinedOrRawPrompt = shouldRefinePrompt ? await (async () => {
    try {
      const strength = modelConfig.localStoryboardPromptRefineLevel || 'medium'
      // 本地模型精炼：
      // - 勾选“使用画面描述”：精炼画面描述（纯文本）
      // - 否则：用完整分镜 JSON 做精炼（你在 lib/prompts/novel-promotion/storyboard_prompt_refine.zh.txt 里配置的那个）
      const refineUserPrompt = (usePanelDescriptionEnabled && panelDescriptionText)
        ? buildPrompt({
          promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE_DESCRIPTION,
          locale: job.data.locale,
          variables: {
            panel_description: panelDescriptionText,
            aspect_ratio: aspectRatio,
            style: artStyle || '与参考图风格一致',
            strength,
            reference_images_count: String(normalizedRefs.length),
          },
        })
        : buildPrompt({
          promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE,
          locale: job.data.locale,
          variables: {
            storyboard_text_json_input: contextJson,
            source_text: panel.srtSegment || panel.description || '',
            aspect_ratio: aspectRatio,
            style: artStyle || '与参考图风格一致',
            strength,
            reference_images_count: String(normalizedRefs.length),
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
      return refined || prompt
    } catch (err) {
      logger.warn({
        message: 'storyboard prompt refine failed, fallback to original prompt',
        details: { error: String(err) },
      })
      return prompt
    }
  })() : prompt

  const withAnimeStyle = prependAnimeStyleLabel({
    prompt: refinedOrRawPrompt,
    artStyle: modelConfig.artStyle,
    locale: job.data.locale === 'en' ? 'en' : 'zh',
  })

  const hardConstraints = buildStoryboardHardConstraints({
    locale: job.data.locale,
    aspectRatio,
    styleText: artStyle || '',
    referenceImagesCount: normalizedRefs.length,
  })

  const sortedFrames = Array.isArray(panel.frames)
    ? [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
    : []
  const isPanelGroup = panel.panelMode === 'group' || sortedFrames.length > 1
  if (isPanelGroup && sortedFrames.length > 1) {
    const generatedByFrameIndex = new Map<number, string>()
    const generatedUrls: string[] = []
    const targetFrame = targetFrameId
      ? sortedFrames.find((frame) => frame.id === targetFrameId)
      : null
    if (targetFrameId && !targetFrame) {
      throw new Error('Target frame not found')
    }
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
      for (const dependencyIndex of parseDependencyFrameIds(frame.dependencyFrameIds)) {
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

      const frameReferencePlan = buildFrameReferencePlan({ frame, generatedByFrameIndex })
      const dependencyUrls = frameReferencePlan.urls
        .map((value) => toSignedUrlIfCos(value, 3600))
        .filter((value): value is string => Boolean(value))
      const normalizedFrameReferenceRefs = dependencyUrls.length > 0
        ? await normalizeReferenceImagesForGeneration(dependencyUrls)
        : []
      const normalizedFrameRefs = uniqueStrings([
        ...normalizedFrameReferenceRefs,
        ...normalizedRefs,
      ])
      const framePrompt = prependAnimeStyleLabel({
        prompt: buildPanelFramePrompt({
          locale: job.data.locale,
          aspectRatio,
          styleText: artStyle || '',
          frame,
          panelDescription: panel.description,
          groupVideoPrompt: panel.groupVideoPrompt || panel.videoPrompt,
          frameReferenceIndexes: frameReferencePlan.frameReferenceIndexes,
          frameReferenceImageCount: normalizedFrameReferenceRefs.length,
          hardConstraints: buildStoryboardHardConstraints({
            locale: job.data.locale,
            aspectRatio,
            styleText: artStyle || '',
            referenceImagesCount: normalizedFrameRefs.length,
          }),
        }),
        artStyle: modelConfig.artStyle,
        locale: job.data.locale === 'en' ? 'en' : 'zh',
      })

      try {
        await clearTaskExternalId(job.data.taskId)
        const source = await resolveImageSourceFromGeneration(job, {
          userId: job.data.userId,
          modelId: modelKey,
          prompt: framePrompt,
          options: {
            referenceImages: normalizedFrameRefs,
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

  const finalPrompt = hardConstraints
    ? `${withAnimeStyle}\n\n${hardConstraints}`
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
