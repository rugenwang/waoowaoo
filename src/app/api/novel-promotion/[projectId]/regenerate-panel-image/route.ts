import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { hasPanelImageOutput } from '@/lib/task/has-output'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { getProjectModelConfig } from '@/lib/config-service'
import { resolveProjectModelCapabilityGenerationOptions } from '@/lib/config-service'
import { resolveModelSelection } from '@/lib/api-config'
import { prisma } from '@/lib/prisma'
import { loadPreviousPanelTailImageInfo } from '@/lib/novel-promotion/previous-panel-tail'

const DEFAULT_CANDIDATE_COUNT = 1

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json()
  const locale = resolveRequiredTaskLocale(request, body)
  const panelId = body?.panelId
  const count = body?.count
  const candidateCount = Math.max(1, Math.min(4, Number(count ?? DEFAULT_CANDIDATE_COUNT)))

  if (!panelId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: {
      id: panelId,
      storyboard: {
        episode: {
          novelPromotionProject: {
            projectId,
          },
        },
      },
    },
  })
  if (!panel) {
    throw new ApiError('NOT_FOUND')
  }
  let panelUsesPreviousTailAsReference = Boolean(
    (panel as { usePreviousPanelTailAsReference?: boolean }).usePreviousPanelTailAsReference,
  )

  if (panelUsesPreviousTailAsReference) {
    const previousTailInfo = await loadPreviousPanelTailImageInfo({
      storyboardId: panel.storyboardId,
      panelIndex: panel.panelIndex,
    })
    if (!previousTailInfo.previousPanelExists) {
      await prisma.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { usePreviousPanelTailAsReference: false },
      })
      panelUsesPreviousTailAsReference = false
    } else if (!previousTailInfo.imageUrl) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'PREVIOUS_PANEL_TAIL_NOT_READY',
        message: '当前分镜首帧需要参考上一分镜尾帧，但上一分镜还没有可用尾帧图片',
      })
    }
  }

  const projectModelConfig = await getProjectModelConfig(projectId, session.user.id)
  if (!projectModelConfig.storyboardModel) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'STORYBOARD_MODEL_NOT_CONFIGURED'})
  }
  try {
    await resolveModelSelection(session.user.id, projectModelConfig.storyboardModel, 'image')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storyboard image model is invalid'
    throw new ApiError('INVALID_PARAMS', {
      code: 'STORYBOARD_MODEL_INVALID',
      message})
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId,
    userId: session.user.id,
    modelType: 'image',
    modelKey: projectModelConfig.storyboardModel})
  const billingPayload = {
    ...body,
    candidateCount,
    imageModel: projectModelConfig.storyboardModel,
    ...(Object.keys(capabilityOptions).length > 0 ? { generationOptions: capabilityOptions } : {})}

  const hasOutputAtStart = await hasPanelImageOutput(panel.id)

  const result = await submitTask({
    userId: session.user.id,
    locale,
    requestId: getRequestId(request),
    projectId,
    type: TASK_TYPE.IMAGE_PANEL,
    targetType: 'NovelPromotionPanel',
    targetId: panel.id,
    payload: withTaskUiPayload(billingPayload, {
      intent: 'regenerate',
      hasOutputAtStart}),
    dedupeKey: `image_panel:${panel.id}:${candidateCount}`,
    billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, billingPayload)})

  return NextResponse.json(result)
})
