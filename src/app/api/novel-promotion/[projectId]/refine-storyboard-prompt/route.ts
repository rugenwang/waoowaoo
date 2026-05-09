import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { prisma } from '@/lib/prisma'
import { getProjectModelConfig } from '@/lib/config-service'
import { getArtStylePrompt, prependAnimeStyleLabel } from '@/lib/constants'
import { buildPrompt, PROMPT_IDS } from '@/lib/prompt-i18n'
import { executeAiTextStep } from '@/lib/ai-runtime/client'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import {
  buildPanelPrompt,
  buildPanelPromptContext,
  buildPanelStructuredPrompt,
  buildStoryboardHardConstraints,
  cleanupRefinedPrompt,
} from '@/lib/workers/handlers/panel-image-task-handler'
import {
  collectPanelReferenceImages,
  resolveNovelData,
} from '@/lib/workers/handlers/image-task-handler-shared'

type DraftRecord = Record<string, unknown>

function isRecord(value: unknown): value is DraftRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function pickDraftString(draft: DraftRecord | null, key: string, fallback: string | null): string | null {
  if (!draft || !(key in draft)) return fallback
  const value = draft[key]
  if (value === null) return null
  return typeof value === 'string' ? value : fallback
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json().catch(() => ({}))
  const panelId = typeof body?.panelId === 'string' ? body.panelId.trim() : ''
  const locale = body?.locale === 'en' ? 'en' : 'zh'
  const draft = isRecord(body?.draft) ? body.draft : null
  if (!panelId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const panel = await prisma.novelPromotionPanel.findUnique({
    where: { id: panelId },
    include: {
      storyboard: {
        include: {
          episode: {
            include: {
              novelPromotionProject: {
                select: { projectId: true },
              },
            },
          },
        },
      },
    },
  })
  if (!panel || panel.storyboard.episode.novelPromotionProject.projectId !== projectId) {
    throw new ApiError('NOT_FOUND')
  }

  const [projectData, modelConfig] = await Promise.all([
    resolveNovelData(projectId),
    getProjectModelConfig(projectId, session.user.id),
  ])
  if (!modelConfig.analysisModel) {
    throw new Error('请先在项目设置中配置分析模型')
  }

  const aspectRatio = modelConfig.videoRatio || projectData.videoRatio || '16:9'
  const artStyle = getArtStylePrompt(modelConfig.artStyle, locale)
  const draftCharacters = draft && Array.isArray(draft.characters)
    ? JSON.stringify(draft.characters)
    : panel.characters
  const effectivePanel = {
    id: panel.id,
    shotType: pickDraftString(draft, 'shotType', panel.shotType),
    cameraMove: pickDraftString(draft, 'cameraMove', panel.cameraMove),
    description: pickDraftString(draft, 'description', panel.description),
    imagePrompt: panel.imagePrompt,
    videoPrompt: pickDraftString(draft, 'videoPrompt', panel.videoPrompt),
    location: pickDraftString(draft, 'location', panel.location),
    characters: draftCharacters,
    srtSegment: panel.srtSegment,
    photographyRules: panel.photographyRules,
    actingNotes: panel.actingNotes,
    sketchImageUrl: panel.sketchImageUrl,
  }
  const promptContext = buildPanelPromptContext({
    panel: effectivePanel,
    projectData,
  })
  const contextJson = JSON.stringify(promptContext, null, 2)
  const parsedStoryboardModel = parseModelKeyStrict(modelConfig.storyboardModel)
  const fallbackPrompt = parsedStoryboardModel?.provider === 'local'
    ? buildPanelStructuredPrompt({
      locale,
      aspectRatio,
      styleText: artStyle || '',
      context: promptContext,
    })
    : buildPanelPrompt({
      locale,
      aspectRatio,
      styleText: artStyle || '与参考图风格一致',
      sourceText: effectivePanel.srtSegment || effectivePanel.description || '',
      contextJson,
    })

  const panelDescription = (effectivePanel.description || '').trim()
  const usePanelDescription =
    modelConfig.localStoryboardUsePanelDescriptionEnabled === true && !!panelDescription
  const strength = modelConfig.localStoryboardPromptRefineLevel || 'medium'
  const referenceImages = await collectPanelReferenceImages(projectData, effectivePanel)
  const refineUserPrompt = usePanelDescription
    ? buildPrompt({
      promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE_DESCRIPTION,
      locale,
      variables: {
        panel_description: panelDescription,
        aspect_ratio: aspectRatio,
        style: artStyle || '与参考图风格一致',
        strength,
        reference_images_count: String(referenceImages.length),
      },
    })
    : buildPrompt({
      promptId: PROMPT_IDS.NP_STORYBOARD_PROMPT_REFINE,
      locale,
      variables: {
        storyboard_text_json_input: contextJson,
        source_text: effectivePanel.srtSegment || effectivePanel.description || '',
        aspect_ratio: aspectRatio,
        style: artStyle || '与参考图风格一致',
        strength,
        reference_images_count: String(referenceImages.length),
      },
    })

  const res = await executeAiTextStep({
    userId: session.user.id,
    projectId,
    model: modelConfig.analysisModel,
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

  const refinedPrompt = cleanupRefinedPrompt(res.text) || fallbackPrompt
  const withAnimeStyle = prependAnimeStyleLabel({
    prompt: refinedPrompt,
    artStyle: modelConfig.artStyle,
    locale,
  })
  const hardConstraints = buildStoryboardHardConstraints({
    locale,
    aspectRatio,
    styleText: artStyle || '',
    referenceImagesCount: referenceImages.length,
  })
  const finalPrompt = hardConstraints
    ? `${withAnimeStyle}\n\n${hardConstraints}`
    : withAnimeStyle

  return NextResponse.json({
    prompt: finalPrompt,
    refinedPrompt,
    source: usePanelDescription ? 'description' : 'storyboard',
    strength,
  })
})
