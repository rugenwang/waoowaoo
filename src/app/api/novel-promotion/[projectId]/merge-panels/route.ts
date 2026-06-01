import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'

type PanelWithFrames = NonNullable<Awaited<ReturnType<typeof getPanelForMerge>>>
type PanelFrameRow = PanelWithFrames['frames'][number]

function roundSeconds(value: number): number {
  return Math.round(Math.max(0.5, value) * 100) / 100
}

function parseNumberArray(raw: string | null | undefined): Array<number | 'FP'> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        if (typeof item === 'string' && item.trim().toUpperCase() === 'FP') return 'FP' as const
        const value = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN
        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
      })
      .filter((item): item is number | 'FP' => item !== null)
  } catch {
    return []
  }
}

function toDependencyText(values: number[]): string | null {
  const unique = Array.from(new Set(values.filter((value) => Number.isFinite(value) && value >= 0)))
  return unique.length > 0 ? JSON.stringify(unique) : null
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function joinText(values: Array<string | null | undefined>, separator = '；'): string | null {
  const parts = values.map(cleanText).filter(Boolean)
  if (parts.length === 0) return null
  return Array.from(new Set(parts)).join(separator)
}

function resolvePanelDuration(panel: PanelWithFrames): number {
  const duration = typeof panel.duration === 'number' && Number.isFinite(panel.duration)
    ? panel.duration
    : typeof panel.groupDurationSec === 'number' && Number.isFinite(panel.groupDurationSec)
      ? panel.groupDurationSec
      : null
  if (duration !== null) return roundSeconds(duration)
  const maxFrameTime = panel.frames.reduce((max, frame) => Math.max(max, frame.frameTimeSec || 0), 0)
  if (maxFrameTime > 0) return roundSeconds(maxFrameTime + 1)
  if (typeof panel.srtStart === 'number' && typeof panel.srtEnd === 'number' && panel.srtEnd > panel.srtStart) {
    return roundSeconds(panel.srtEnd - panel.srtStart)
  }
  return 5
}

function resolveVideoPrompt(panel: PanelWithFrames): string | null {
  return panel.groupVideoPrompt || panel.videoPrompt || null
}

function parseJsonArray(raw: string | null | undefined): unknown[] | null {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function stableStringify(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return JSON.stringify(Object.fromEntries(entries))
  }
  return JSON.stringify(value)
}

function mergeJsonArrayText(left: string | null, right: string | null): string | null {
  const leftArray = parseJsonArray(left)
  const rightArray = parseJsonArray(right)
  if (!leftArray && !rightArray) return left || right || null
  const merged = [...(leftArray || []), ...(rightArray || [])]
  const seen = new Set<string>()
  const unique = merged.filter((item) => {
    const key = stableStringify(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return unique.length > 0 ? JSON.stringify(unique) : null
}

function toFrameFromPanel(panel: PanelWithFrames, frameIndex: number, frameTimeSec: number, dependencyIndexes: number[]) {
  return {
    frameIndex,
    frameTimeSec,
    frameRole: frameIndex === 0 ? 'hero' : 'continuity',
    dependencyFrameIds: toDependencyText(dependencyIndexes),
    imagePrompt: panel.imagePrompt,
    videoPrompt: resolveVideoPrompt(panel),
    promptJson: null,
    referencePolicy: frameIndex === 0
      ? JSON.stringify({ type: 'base', note: '合并分镜组的开场原始状态' })
      : JSON.stringify({ type: 'depends_on_previous', note: '由相邻分镜合并而来，参考前一关键帧保持连续' }),
    imageUrl: panel.imageUrl,
    imageMediaId: panel.imageMediaId,
    generationStatus: null,
    errorMessage: null,
  }
}

function toFrameFromExisting(frame: PanelFrameRow, frameIndex: number, frameTimeSec: number, dependencyIndexes: number[]) {
  return {
    frameIndex,
    frameTimeSec,
    frameRole: frameIndex === 0 ? 'hero' : frame.frameRole,
    dependencyFrameIds: toDependencyText(dependencyIndexes),
    imagePrompt: frame.imagePrompt,
    videoPrompt: frame.videoPrompt,
    promptJson: frame.promptJson,
    referencePolicy: frame.referencePolicy,
    imageUrl: frame.imageUrl,
    imageMediaId: frame.imageMediaId,
    generationStatus: null,
    errorMessage: null,
  }
}

function getSourceFrames(panel: PanelWithFrames) {
  const sortedFrames = [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
  if (sortedFrames.length > 0) return sortedFrames
  return null
}

async function getPanelForMerge(projectId: string, panelId: string) {
  return prisma.novelPromotionPanel.findFirst({
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
}

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

  const firstPanel = await getPanelForMerge(projectId, panelId)
  if (!firstPanel) {
    throw new ApiError('NOT_FOUND')
  }

  const nextPanel = await prisma.novelPromotionPanel.findFirst({
    where: {
      storyboardId: firstPanel.storyboardId,
      panelIndex: { gt: firstPanel.panelIndex },
    },
    orderBy: { panelIndex: 'asc' },
    include: {
      frames: { orderBy: { frameIndex: 'asc' } },
    },
  })

  if (!nextPanel) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'NO_NEXT_PANEL',
      message: '当前分镜后面没有可合并的分镜',
    })
  }

  const firstDuration = resolvePanelDuration(firstPanel)
  const nextDuration = resolvePanelDuration(nextPanel)
  const totalDuration = roundSeconds(firstDuration + nextDuration)
  const firstFrames = getSourceFrames(firstPanel)
  const nextFrames = getSourceFrames(nextPanel)
  const finalFrames: ReturnType<typeof toFrameFromExisting>[] = []

  if (firstFrames) {
    firstFrames.forEach((frame, index) => {
      const dependencies = parseNumberArray(frame.dependencyFrameIds)
        .filter((value): value is number => typeof value === 'number' && value < index)
      finalFrames.push(toFrameFromExisting(
        frame,
        index,
        index === 0 ? 0 : roundSeconds(Math.min(frame.frameTimeSec || 0, totalDuration)),
        dependencies,
      ))
    })
  } else {
    finalFrames.push(toFrameFromPanel(firstPanel, 0, 0, []))
  }

  const firstFrameCount = finalFrames.length
  const bridgeDependencyIndex = Math.max(0, firstFrameCount - 1)
  if (nextFrames) {
    nextFrames.forEach((frame, sourceIndex) => {
      const frameIndex = firstFrameCount + sourceIndex
      const sourceDependencies = parseNumberArray(frame.dependencyFrameIds)
      const dependencies = sourceDependencies
        .map((value) => {
          if (value === 'FP') return bridgeDependencyIndex
          return firstFrameCount + value
        })
        .filter((value) => value >= 0 && value < frameIndex)
      const fallbackDependencies = frameIndex === 0 ? [] : [frameIndex - 1]
      finalFrames.push(toFrameFromExisting(
        frame,
        frameIndex,
        roundSeconds(firstDuration + Math.max(0, frame.frameTimeSec || 0)),
        dependencies.length > 0 ? dependencies : fallbackDependencies,
      ))
    })
  } else {
    const frameIndex = finalFrames.length
    finalFrames.push(toFrameFromPanel(nextPanel, frameIndex, firstDuration, frameIndex === 0 ? [] : [frameIndex - 1]))
  }

  const firstFrame = finalFrames[0]
  const groupPlanJson = JSON.stringify({
    panelMode: 'group',
    complexity: 'manual_merge_adjacent_panels',
    durationSec: totalDuration,
    mergedPanelIds: [firstPanel.id, nextPanel.id],
    frames: finalFrames.map((frame) => ({
      frame_index: frame.frameIndex,
      frame_time_sec: frame.frameTimeSec,
      frame_role: frame.frameRole,
      dependency_frame_ids: parseNumberArray(frame.dependencyFrameIds).filter((value) => typeof value === 'number'),
      image_prompt: frame.imagePrompt,
      video_prompt: frame.videoPrompt,
      reference_policy: frame.referencePolicy,
    })),
  })
  const mergedVideoPrompt = joinText([resolveVideoPrompt(firstPanel), resolveVideoPrompt(nextPanel)], '\n\n') || null

  const result = await prisma.$transaction(async (tx) => {
    await tx.novelPromotionPanelFrame.deleteMany({
      where: { panelId: firstPanel.id },
    })

    if (finalFrames.length > 0) {
      await tx.novelPromotionPanelFrame.createMany({
        data: finalFrames.map((frame) => ({
          panelId: firstPanel.id,
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
      })
    }

    await tx.novelPromotionVoiceLine.updateMany({
      where: { matchedPanelId: nextPanel.id },
      data: {
        matchedPanelId: firstPanel.id,
        matchedPanelIndex: firstPanel.panelIndex,
      },
    })

    await tx.novelPromotionPanel.update({
      where: { id: firstPanel.id },
      data: {
        panelMode: 'group',
        groupDurationSec: totalDuration,
        duration: totalDuration,
        groupVideoPrompt: mergedVideoPrompt,
        videoPrompt: mergedVideoPrompt,
        groupPlanJson,
        shotType: joinText([firstPanel.shotType, nextPanel.shotType], ' → '),
        cameraMove: joinText([firstPanel.cameraMove, nextPanel.cameraMove], ' → '),
        description: joinText([firstPanel.description, nextPanel.description]),
        location: joinText([firstPanel.location, nextPanel.location]),
        characters: mergeJsonArrayText(firstPanel.characters, nextPanel.characters),
        props: mergeJsonArrayText(firstPanel.props, nextPanel.props),
        srtSegment: joinText([firstPanel.srtSegment, nextPanel.srtSegment], '\n'),
        srtStart: firstPanel.srtStart ?? nextPanel.srtStart,
        srtEnd: nextPanel.srtEnd ?? firstPanel.srtEnd,
        imagePrompt: firstFrame?.imagePrompt ?? firstPanel.imagePrompt,
        imageUrl: firstFrame?.imageUrl ?? firstPanel.imageUrl,
        imageMediaId: firstFrame?.imageMediaId ?? firstPanel.imageMediaId,
        videoUrl: null,
        videoMediaId: null,
        lipSyncTaskId: null,
        lipSyncVideoUrl: null,
        lipSyncVideoMediaId: null,
        candidateImages: null,
      },
    })

    await tx.novelPromotionPanel.delete({
      where: { id: nextPanel.id },
    })

    const affectedPanels = await tx.novelPromotionPanel.findMany({
      where: {
        storyboardId: firstPanel.storyboardId,
        panelIndex: { gt: nextPanel.panelIndex },
      },
      select: { id: true, panelIndex: true },
      orderBy: { panelIndex: 'asc' },
    })

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: -(panel.panelIndex - 1), panelNumber: -panel.panelIndex },
      })
    }

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: panel.panelIndex - 1, panelNumber: panel.panelIndex },
      })
    }

    const panelCount = await tx.novelPromotionPanel.count({
      where: { storyboardId: firstPanel.storyboardId },
    })

    await tx.novelPromotionStoryboard.update({
      where: { id: firstPanel.storyboardId },
      data: { panelCount },
    })

    return {
      panelId: firstPanel.id,
      mergedPanelId: nextPanel.id,
      storyboardId: firstPanel.storyboardId,
      panelCount,
      frameCount: finalFrames.length,
    }
  }, {
    maxWait: 15000,
    timeout: 30000,
  })

  return NextResponse.json({
    success: true,
    ...result,
  })
})
