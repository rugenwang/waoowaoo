import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const panelId = typeof body?.panelId === 'string' ? body.panelId.trim() : ''
  if (!panelId) {
    throw new ApiError('INVALID_PARAMS', { field: 'panelId' })
  }

  const sourcePanel = await prisma.novelPromotionPanel.findFirst({
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
    include: {
      frames: { orderBy: { frameIndex: 'asc' } },
    },
  })

  if (!sourcePanel) {
    throw new ApiError('NOT_FOUND')
  }

  const createdPanel = await prisma.$transaction(async (tx) => {
    const affectedPanels = await tx.novelPromotionPanel.findMany({
      where: {
        storyboardId: sourcePanel.storyboardId,
        panelIndex: { gt: sourcePanel.panelIndex },
      },
      select: { id: true, panelIndex: true },
      orderBy: { panelIndex: 'asc' },
    })

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: -(panel.panelIndex + 1) },
      })
    }

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: panel.panelIndex + 1 },
      })
    }

    const duplicated = await tx.novelPromotionPanel.create({
      data: {
        storyboardId: sourcePanel.storyboardId,
        panelIndex: sourcePanel.panelIndex + 1,
        panelNumber: sourcePanel.panelIndex + 2,
        shotType: sourcePanel.shotType,
        cameraMove: sourcePanel.cameraMove,
        description: sourcePanel.description,
        location: sourcePanel.location,
        characters: sourcePanel.characters,
        props: sourcePanel.props,
        srtSegment: sourcePanel.srtSegment,
        srtStart: sourcePanel.srtStart,
        srtEnd: sourcePanel.srtEnd,
        duration: sourcePanel.duration,
        panelMode: sourcePanel.panelMode,
        groupDurationSec: sourcePanel.groupDurationSec,
        groupVideoPrompt: sourcePanel.groupVideoPrompt,
        groupPlanJson: sourcePanel.groupPlanJson,
        imagePrompt: sourcePanel.imagePrompt,
        imageUrl: sourcePanel.imageUrl,
        imageMediaId: sourcePanel.imageMediaId,
        imageHistory: sourcePanel.imageHistory,
        videoPrompt: sourcePanel.videoPrompt,
        firstLastFramePrompt: sourcePanel.firstLastFramePrompt,
        videoUrl: sourcePanel.videoUrl,
        videoGenerationMode: sourcePanel.videoGenerationMode,
        videoMediaId: sourcePanel.videoMediaId,
        sceneType: sourcePanel.sceneType,
        candidateImages: sourcePanel.candidateImages,
        linkedToNextPanel: sourcePanel.linkedToNextPanel,
        lipSyncTaskId: sourcePanel.lipSyncTaskId,
        lipSyncVideoUrl: sourcePanel.lipSyncVideoUrl,
        lipSyncVideoMediaId: sourcePanel.lipSyncVideoMediaId,
        sketchImageUrl: sourcePanel.sketchImageUrl,
        sketchImageMediaId: sourcePanel.sketchImageMediaId,
        photographyRules: sourcePanel.photographyRules,
        actingNotes: sourcePanel.actingNotes,
        previousImageUrl: sourcePanel.previousImageUrl,
        previousImageMediaId: sourcePanel.previousImageMediaId,
        frames: {
          create: sourcePanel.frames.map((frame) => ({
            frameIndex: frame.frameIndex,
            frameTimeSec: frame.frameTimeSec,
            frameRole: frame.frameRole,
            dependencyFrameIds: frame.dependencyFrameIds,
            imagePrompt: frame.imagePrompt,
            videoPrompt: frame.videoPrompt,
            promptJson: frame.promptJson,
            referencePolicy: frame.referencePolicy,
            imageUrl: frame.imageUrl,
            imageMediaId: frame.imageMediaId,
            generationStatus: frame.generationStatus,
            errorMessage: frame.errorMessage,
          })),
        },
      },
      include: {
        frames: { orderBy: { frameIndex: 'asc' } },
      },
    })

    const panelCount = await tx.novelPromotionPanel.count({
      where: { storyboardId: sourcePanel.storyboardId },
    })

    await tx.novelPromotionStoryboard.update({
      where: { id: sourcePanel.storyboardId },
      data: { panelCount },
    })

    return duplicated
  })

  return NextResponse.json({
    success: true,
    panel: createdPanel,
  })
})
