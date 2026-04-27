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

function buildPanelPromptContext(params: {
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

function buildPanelPrompt(params: {
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

function buildPanelStructuredPrompt(params: {
  locale: TaskJobData['locale']
  aspectRatio: string
  styleText: string
  context: ReturnType<typeof buildPanelPromptContext>
}): string {
  const shotType = String(params.context.panel.shot_type || '').trim()
  const cameraMove = String(params.context.panel.camera_move || '').trim()
  const description = String(params.context.panel.description || '').trim()
  const location = String(params.context.panel.location || '').trim()
  const videoPrompt = String(params.context.panel.video_prompt || '').trim()

  const characterLines = (() => {
    const chars = Array.isArray(params.context.panel.characters) ? params.context.panel.characters : []
    if (chars.length === 0) return ''
    if (params.locale === 'en') {
      return `Characters: ${chars.map((c: any) => {
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
    return `角色：${chars.map((c: any) => {
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
    const rules = params.context.panel.photography_rules as any
    if (!rules || typeof rules !== 'object') return ''
    const lighting = rules.lighting || null
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
    const notes = params.context.panel.acting_notes as any
    if (!notes) return ''
    // 常见结构：[{ name, acting }]
    if (Array.isArray(notes)) {
      const lines = notes.map((row) => {
        const name = String(row?.name || '').trim()
        const acting = String(row?.acting || '').trim()
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
      description ? `Description: ${description}` : '',
      location ? `Location: ${location}` : '',
      characterLines,
      actingText,
      photographyText,
      videoPrompt ? `Additional prompt: ${videoPrompt}` : '',
      params.styleText ? `Style: ${params.styleText}` : '',
    ].filter(Boolean)
    return parts.join('\n')
  }

  const parts = [
    `画面比例：${params.aspectRatio}`,
    shotType || cameraMove ? `镜头：${[shotType, cameraMove].filter(Boolean).join('，')}` : '',
    description ? `画面描述：${description}` : '',
    location ? `场景：${location}` : '',
    characterLines,
    actingText,
    photographyText,
    videoPrompt ? `补充提示：${videoPrompt}` : '',
    params.styleText ? `风格：${params.styleText}` : '',
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

function buildStoryboardHardConstraints(params: {
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
      '- Do NOT include duplicated identical characters (no clones of the same person with identical appearance in the same frame).',
      ratio ? `- Aspect ratio must be EXACT: ${ratio}.` : null,
      hasRefs ? '- Match the reference images for identity/style/composition; do NOT draw any text from references.' : null,
      style ? `- Keep visual style consistent: ${style}.` : null,
    ].filter(Boolean).join('\n')
  }

  return [
    '【强制规则 - 必须遵守】',
    '- 画面中绝对禁止出现任何文字（字幕/标签/编号/水印/符号）。',
    '- 只生成一张镜头画面（禁止拼图/多镜头/多格）。',
    '- 禁止在同一个镜头中出现“形象完全一样的人”（禁止克隆同一人物外貌/服装/发型完全一致的多个个体）。',
    ratio ? `- 画面比例必须严格为：${ratio}` : null,
    hasRefs ? '- 有参考图时：外貌/风格/构图需与参考图一致；参考图上的文字标签仅供识别，禁止画入图中。' : null,
    style ? `- 风格必须与参考一致：${style}` : null,
  ].filter(Boolean).join('\n')
}

function cleanupRefinedPrompt(raw: string): string {
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
  if (!panelId) throw new Error('panelId missing')

  const panel = await prisma.novelPromotionPanel.findUnique({
    where: { id: panelId },
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
    parsedStoryboardModel?.provider === 'local'
    && modelConfig.localStoryboardPromptRefineEnabled === true
    && !!modelConfig.analysisModel

  const refinedOrRawPrompt = shouldRefinePrompt ? await (async () => {
    try {
      const strength = modelConfig.localStoryboardPromptRefineLevel || 'medium'
      // 本地模型精炼：优先精炼“最终会用于生图的那段整洁 prompt”
      // - 勾选画面描述：精炼画面描述
      // - 未勾选画面描述：精炼 buildPanelStructuredPrompt 生成的整洁 prompt
      // 复用 NP_STORYBOARD_PROMPT_REFINE_DESCRIPTION 模板即可（其输入本质是一段待精炼文本）。
      const refineUserPrompt = buildPrompt({
        promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE_DESCRIPTION,
        locale: job.data.locale,
        variables: {
          panel_description: usePanelDescriptionEnabled && panelDescriptionText ? panelDescriptionText : prompt,
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

  // 本地模型（ltx/MLX）在启用“精炼/画面描述”后最终 prompt 可能过于“自由”，
  // 这里把关键的限制性规则重新加回 prompt，防止模型乱加文字/拼图/比例跑偏。
  const hardConstraints = buildStoryboardHardConstraints({
    locale: job.data.locale,
    aspectRatio,
    styleText: artStyle || '',
    referenceImagesCount: normalizedRefs.length,
  })

  const finalPrompt = hardConstraints
    ? `${hardConstraints}\n\n${withAnimeStyle}`
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

    const cosKey = await uploadImageSourceToCos(source, 'panel-candidate', `${panel.id}-${i}`)
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

  return {
    panelId: panel.id,
    candidateCount: candidates.length,
    imageUrl: isFirstGeneration ? candidates[0] || null : null,
  }
}
