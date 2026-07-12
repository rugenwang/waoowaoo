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
import {
  parsePanelFrameDependencyPlan,
  serializePanelFrameDependencyPlan,
  withPreviousTailDependency,
} from '@/lib/novel-promotion/panel-tail-reference'
import { loadPreviousPanelTailImageInfo } from '@/lib/novel-promotion/previous-panel-tail'
import { rebuildPanelFrameReferencePrompts } from '@/lib/novel-promotion/panel-frame-reference-prompts'

function hasFrameImage(frame: { imageUrl?: string | null; imageMediaId?: string | null } | null | undefined) {
  return Boolean(
    (typeof frame?.imageUrl === 'string' && frame.imageUrl.trim())
    || (typeof frame?.imageMediaId === 'string' && frame.imageMediaId.trim()),
  )
}

function parseOptionalBooleanField(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return undefined
}

function parseVirtualFramePanelId(frameId: string): string | null {
  const suffix = ':virtual-frame-0'
  return frameId.endsWith(suffix) ? frameId.slice(0, -suffix.length) : null
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
  const requestedUsePreviousTail = parseOptionalBooleanField(body?.usePreviousPanelTailAsReference)

  if (!frameId) {
    throw new ApiError('INVALID_PARAMS')
  }

  let frame = await prisma.novelPromotionPanelFrame.findFirst({
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
    const virtualPanelId = parseVirtualFramePanelId(frameId)
    if (virtualPanelId) {
      const panel = await prisma.novelPromotionPanel.findFirst({
        where: {
          id: virtualPanelId,
          storyboard: {
            episode: {
              novelPromotionProject: {
                projectId,
              },
            },
          },
        },
        include: {
          frames: { orderBy: { frameIndex: 'asc' } },
        },
      })
      if (!panel) {
        throw new ApiError('NOT_FOUND')
      }
      const firstFrame = panel.frames[0] || await prisma.novelPromotionPanelFrame.create({
        data: {
          panelId: panel.id,
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'hero',
          dependencyFrameIds: serializePanelFrameDependencyPlan({
            previousTail: panel.usePreviousPanelTailAsReference,
            frameIndexes: [],
          }),
          imagePrompt: panel.imagePrompt || panel.description || null,
          videoPrompt: panel.videoPrompt || panel.groupVideoPrompt || null,
          imageUrl: panel.imageUrl || null,
          imageMediaId: panel.imageMediaId || null,
          generationStatus: panel.imageUrl || panel.imageMediaId ? 'completed' : null,
        },
      })
      frame = await prisma.novelPromotionPanelFrame.findFirst({
        where: {
          id: firstFrame.id,
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
    }
    if (!frame) {
      throw new ApiError('NOT_FOUND')
    }
  }
  if (panelIdFromBody && panelIdFromBody !== frame.panelId) {
    throw new ApiError('INVALID_PARAMS')
  }
  if (
    typeof requestedUsePreviousTail === 'boolean' &&
    requestedUsePreviousTail !== (frame.panel as { usePreviousPanelTailAsReference?: boolean }).usePreviousPanelTailAsReference
  ) {
    await prisma.novelPromotionPanel.update({
      where: { id: frame.panelId },
      data: { usePreviousPanelTailAsReference: requestedUsePreviousTail },
    })
    ;(frame.panel as { usePreviousPanelTailAsReference?: boolean }).usePreviousPanelTailAsReference = requestedUsePreviousTail
    await rebuildPanelFrameReferencePrompts(frame.panelId)
  }

  const panelUsesPreviousTailAsReference = Boolean(
    (frame.panel as { usePreviousPanelTailAsReference?: boolean }).usePreviousPanelTailAsReference,
  )

  const frameByIndex = new Map(frame.panel.frames.map((item) => [item.frameIndex, item]))
  let runtimeDependencyFrameIds = withPreviousTailDependency(
    frame.dependencyFrameIds,
    panelUsesPreviousTailAsReference,
    frame.frameIndex,
  )
  let dependencyPlan = parsePanelFrameDependencyPlan(runtimeDependencyFrameIds)
  const missingDependencyIndexes = dependencyPlan.frameIndexes
    .filter((dependencyIndex) => !hasFrameImage(frameByIndex.get(dependencyIndex)))

  if (missingDependencyIndexes.length > 0) {
    const missingLabels = missingDependencyIndexes.map((index) => `F${index + 1}`).join('、')
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_DEPENDENCY_NOT_READY',
      missingFrameIndexes: missingDependencyIndexes,
      message: `请先生成关联帧 ${missingLabels}，再重新生成 F${frame.frameIndex + 1}`,
    })
  }

  if (dependencyPlan.previousTail) {
    const previousTailInfo = await loadPreviousPanelTailImageInfo({
      storyboardId: frame.panel.storyboardId,
      panelIndex: frame.panel.panelIndex,
    })
    if (!previousTailInfo.previousPanelExists) {
      dependencyPlan = {
        ...dependencyPlan,
        previousTail: false,
      }
      runtimeDependencyFrameIds = serializePanelFrameDependencyPlan(dependencyPlan)
      await prisma.novelPromotionPanelFrame.update({
        where: { id: frame.id },
        data: { dependencyFrameIds: runtimeDependencyFrameIds },
      })
      if (frame.frameIndex === 0 && panelUsesPreviousTailAsReference) {
        await prisma.novelPromotionPanel.update({
          where: { id: frame.panelId },
          data: { usePreviousPanelTailAsReference: false },
        })
        await rebuildPanelFrameReferencePrompts(frame.panelId)
      }
    } else if (!previousTailInfo.imageUrl) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'PREVIOUS_PANEL_TAIL_NOT_READY',
        message: `F${frame.frameIndex + 1} 需要参考上一分镜尾帧 FP，但上一分镜还没有可用尾帧图片`,
      })
    }
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

  await prisma.novelPromotionPanelFrame.update({
    where: { id: frame.id },
    data: {
      generationStatus: 'processing',
      errorMessage: null,
    },
  })

  let result: Awaited<ReturnType<typeof submitTask>>
  try {
    result = await submitTask({
      userId: session.user.id,
      locale,
      requestId: getRequestId(request),
      projectId,
      type: TASK_TYPE.IMAGE_PANEL,
      targetType: 'NovelPromotionPanelFrame',
      targetId: frame.id,
      payload: withTaskUiPayload(billingPayload, {
        intent: 'regenerate',
        hasOutputAtStart: hasFrameImage(frame),
        targetFrameId: frame.id,
        targetFrameIndex: frame.frameIndex,
      }),
      dedupeKey: `image_panel_frame:${frame.id}`,
      billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, billingPayload),
    })
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

  return NextResponse.json(result)
})
