import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'

type SplitPlacement = 'before' | 'after'

function parsePlacement(value: unknown): SplitPlacement {
  if (value === 'before' || value === 'after') return value
  throw new ApiError('INVALID_PARAMS', {
    field: 'placement',
    message: 'placement must be before or after',
  })
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

function toDependencyFrameIdsText(values: number[]): string | null {
  const unique = Array.from(new Set(values.filter((value) => Number.isFinite(value) && value >= 0)))
  return unique.length > 0 ? JSON.stringify(unique) : null
}

function roundDuration(value: number): number {
  return Math.round(Math.max(0.5, value) * 100) / 100
}

function resolveSourceVideoPrompt(panel: {
  videoPrompt: string | null
  groupVideoPrompt: string | null
}): string | null {
  return panel.groupVideoPrompt ?? panel.videoPrompt ?? null
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const frameId = typeof body?.frameId === 'string' ? body.frameId.trim() : ''
  const placement = parsePlacement(body?.placement)
  if (!frameId) {
    throw new ApiError('INVALID_PARAMS', { field: 'frameId' })
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
  if (frame.panel.frames.length <= 1) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_SPLIT_NEEDS_GROUP',
      message: '只有多帧分镜组可以拆出单帧',
    })
  }

  const sourcePanel = frame.panel
  const sortedFrames = [...sourcePanel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
  const framePosition = sortedFrames.findIndex((item) => item.id === frame.id)
  const panelDuration = roundDuration(
    typeof sourcePanel.groupDurationSec === 'number' && Number.isFinite(sourcePanel.groupDurationSec)
      ? sourcePanel.groupDurationSec
      : typeof sourcePanel.duration === 'number' && Number.isFinite(sourcePanel.duration)
        ? sourcePanel.duration
        : Math.max(...sortedFrames.map((item) => item.frameTimeSec), 0) + 1,
  )
  const splitStartSec = Math.max(0, frame.frameTimeSec || 0)
  const nextFrame = sortedFrames[framePosition + 1] || null
  const splitEndSec = nextFrame ? Math.max(nextFrame.frameTimeSec, splitStartSec + 0.5) : panelDuration
  const splitDuration = roundDuration(splitEndSec - splitStartSec)
  const remainingDuration = roundDuration(panelDuration - splitDuration)

  const remainingFrames = sortedFrames.filter((item) => item.id !== frame.id)
  const sourceVideoPrompt = resolveSourceVideoPrompt(sourcePanel)
  const indexMap = new Map<number, number>()
  remainingFrames.forEach((item, index) => {
    indexMap.set(item.frameIndex, index)
  })

  const createdPanel = await prisma.$transaction(async (tx) => {
    const insertIndex = placement === 'before' ? sourcePanel.panelIndex : sourcePanel.panelIndex + 1
    const affectedPanels = await tx.novelPromotionPanel.findMany({
      where: {
        storyboardId: sourcePanel.storyboardId,
        panelIndex: { gte: insertIndex },
      },
      select: { id: true, panelIndex: true },
      orderBy: { panelIndex: 'desc' },
    })

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: -(panel.panelIndex + 1), panelNumber: -(panel.panelIndex + 2) },
      })
    }

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: panel.panelIndex + 1, panelNumber: panel.panelIndex + 2 },
      })
    }

    const splitPanel = await tx.novelPromotionPanel.create({
      data: {
        storyboardId: sourcePanel.storyboardId,
        panelIndex: insertIndex,
        panelNumber: insertIndex + 1,
        shotType: sourcePanel.shotType,
        cameraMove: sourcePanel.cameraMove,
        description: sourcePanel.description,
        location: sourcePanel.location,
        characters: sourcePanel.characters,
        props: sourcePanel.props,
        srtSegment: sourcePanel.srtSegment,
        srtStart: typeof sourcePanel.srtStart === 'number' ? sourcePanel.srtStart + splitStartSec : sourcePanel.srtStart,
        srtEnd: typeof sourcePanel.srtStart === 'number' ? sourcePanel.srtStart + splitStartSec + splitDuration : sourcePanel.srtEnd,
        duration: splitDuration,
        panelMode: 'single',
        groupDurationSec: null,
        groupVideoPrompt: null,
        groupPlanJson: null,
        imagePrompt: frame.imagePrompt || sourcePanel.imagePrompt,
        imageUrl: frame.imageUrl,
        imageMediaId: frame.imageMediaId,
        imageHistory: null,
        videoPrompt: sourceVideoPrompt,
        firstLastFramePrompt: sourcePanel.firstLastFramePrompt,
        videoUrl: null,
        videoGenerationMode: sourcePanel.videoGenerationMode,
        videoMediaId: null,
        sceneType: sourcePanel.sceneType,
        candidateImages: null,
        linkedToNextPanel: false,
        lipSyncTaskId: null,
        lipSyncVideoUrl: null,
        lipSyncVideoMediaId: null,
        sketchImageUrl: sourcePanel.sketchImageUrl,
        sketchImageMediaId: sourcePanel.sketchImageMediaId,
        photographyRules: sourcePanel.photographyRules,
        actingNotes: sourcePanel.actingNotes,
        previousImageUrl: sourcePanel.previousImageUrl,
        previousImageMediaId: sourcePanel.previousImageMediaId,
      },
    })

    await tx.novelPromotionPanelFrame.delete({ where: { id: frame.id } })

    for (let index = 0; index < remainingFrames.length; index += 1) {
      await tx.novelPromotionPanelFrame.update({
        where: { id: remainingFrames[index].id },
        data: { frameIndex: -1000 - index },
      })
    }

    for (let index = 0; index < remainingFrames.length; index += 1) {
      const item = remainingFrames[index]
      const mappedDependencies = parseDependencyFrameIds(item.dependencyFrameIds)
        .filter((dependencyIndex) => dependencyIndex !== frame.frameIndex)
        .map((dependencyIndex) => indexMap.get(dependencyIndex))
        .filter((dependencyIndex): dependencyIndex is number => typeof dependencyIndex === 'number')
        .filter((dependencyIndex) => dependencyIndex < index)
      const fallbackDependencies = index === 0 ? [] : [index - 1]
      const rawFrameTime = item.frameTimeSec >= splitEndSec
        ? item.frameTimeSec - splitDuration
        : item.frameTimeSec

      await tx.novelPromotionPanelFrame.update({
        where: { id: item.id },
        data: {
          frameIndex: index,
          frameTimeSec: index === 0 ? 0 : roundDuration(rawFrameTime),
          frameRole: index === 0 ? 'hero' : item.frameRole,
          dependencyFrameIds: toDependencyFrameIdsText(mappedDependencies.length > 0 ? mappedDependencies : fallbackDependencies),
          generationStatus: item.generationStatus,
        },
      })
    }

    const finalFrames = await tx.novelPromotionPanelFrame.findMany({
      where: { panelId: sourcePanel.id },
      orderBy: { frameIndex: 'asc' },
    })
    const firstFrame = finalFrames[0] || null
    const isSingle = finalFrames.length <= 1
    await tx.novelPromotionPanel.update({
      where: { id: sourcePanel.id },
      data: {
        panelMode: isSingle ? 'single' : 'group',
        duration: remainingDuration,
        groupDurationSec: isSingle ? null : remainingDuration,
        groupVideoPrompt: isSingle ? null : sourcePanel.groupVideoPrompt,
        groupPlanJson: isSingle ? null : sourcePanel.groupPlanJson,
        imagePrompt: isSingle ? firstFrame?.imagePrompt || sourcePanel.imagePrompt : sourcePanel.imagePrompt,
        imageUrl: firstFrame?.imageUrl || null,
        imageMediaId: firstFrame?.imageMediaId || null,
        videoPrompt: isSingle ? firstFrame?.videoPrompt || sourcePanel.videoPrompt : sourcePanel.videoPrompt,
        candidateImages: null,
      },
    })

    const panelCount = await tx.novelPromotionPanel.count({
      where: { storyboardId: sourcePanel.storyboardId },
    })
    await tx.novelPromotionStoryboard.update({
      where: { id: sourcePanel.storyboardId },
      data: { panelCount },
    })

    return splitPanel
  })

  return NextResponse.json({
    success: true,
    panelId: createdPanel.id,
    sourcePanelId: sourcePanel.id,
    placement,
  })
})
