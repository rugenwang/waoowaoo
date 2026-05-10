import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { getProjectModelConfig, resolveProjectModelCapabilityGenerationOptions } from '@/lib/config-service'
import { resolveModelSelection } from '@/lib/api-config'
import { prisma } from '@/lib/prisma'

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

function hasFrameImage(frame: { imageUrl?: string | null; imageMediaId?: string | null } | null | undefined) {
  return Boolean(
    (typeof frame?.imageUrl === 'string' && frame.imageUrl.trim())
    || (typeof frame?.imageMediaId === 'string' && frame.imageMediaId.trim()),
  )
}

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
  const frameId = typeof body?.frameId === 'string' ? body.frameId.trim() : ''
  const panelIdFromBody = typeof body?.panelId === 'string' ? body.panelId.trim() : ''

  if (!frameId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const frame = await prisma.novelPromotionPanelFrame.findFirst({
    where: {
      id: frameId,
      panel: {
        storyboard: {
          episode: {
            novelPromotionProject: {
              projectId,
            },
          },
        },
      },
    },
    include: {
      panel: {
        include: {
          frames: { orderBy: { frameIndex: 'asc' } },
        },
      },
    },
  })

  if (!frame) {
    throw new ApiError('NOT_FOUND')
  }
  if (panelIdFromBody && panelIdFromBody !== frame.panelId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const frameByIndex = new Map(frame.panel.frames.map((item) => [item.frameIndex, item]))
  const missingDependencyIndexes = parseDependencyFrameIds(frame.dependencyFrameIds)
    .filter((dependencyIndex) => !hasFrameImage(frameByIndex.get(dependencyIndex)))

  if (missingDependencyIndexes.length > 0) {
    const missingLabels = missingDependencyIndexes.map((index) => `F${index + 1}`).join('、')
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_DEPENDENCY_NOT_READY',
      missingFrameIndexes: missingDependencyIndexes,
      message: `请先生成关联帧 ${missingLabels}，再重新生成 F${frame.frameIndex + 1}`,
    })
  }

  const projectModelConfig = await getProjectModelConfig(projectId, session.user.id)
  if (!projectModelConfig.storyboardModel) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'STORYBOARD_MODEL_NOT_CONFIGURED',
    })
  }
  try {
    await resolveModelSelection(session.user.id, projectModelConfig.storyboardModel, 'image')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storyboard image model is invalid'
    throw new ApiError('INVALID_PARAMS', {
      code: 'STORYBOARD_MODEL_INVALID',
      message,
    })
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId,
    userId: session.user.id,
    modelType: 'image',
    modelKey: projectModelConfig.storyboardModel,
  })
  const billingPayload = {
    ...body,
    panelId: frame.panelId,
    targetFrameId: frame.id,
    frameId: frame.id,
    candidateCount: 1,
    imageModel: projectModelConfig.storyboardModel,
    ...(Object.keys(capabilityOptions).length > 0 ? { generationOptions: capabilityOptions } : {}),
  }

  const result = await submitTask({
    userId: session.user.id,
    locale,
    requestId: getRequestId(request),
    projectId,
    type: TASK_TYPE.IMAGE_PANEL,
    targetType: 'NovelPromotionPanel',
    targetId: frame.panelId,
    payload: withTaskUiPayload(billingPayload, {
      intent: 'regenerate',
      hasOutputAtStart: hasFrameImage(frame),
      targetFrameId: frame.id,
      targetFrameIndex: frame.frameIndex,
    }),
    dedupeKey: `image_panel_frame:${frame.id}`,
    billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, billingPayload),
  })

  return NextResponse.json(result)
})
