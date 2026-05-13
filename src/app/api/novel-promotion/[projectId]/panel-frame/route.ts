import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'

function parseFrameTimeSec(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_TIME_INVALID',
      field: 'frameTimeSec',
    })
  }
  return Math.round(parsed * 100) / 100
}

function readOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_PROMPT_INVALID',
    })
  }
  const trimmed = value.trim()
  return trimmed || null
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

export const PATCH = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const frameId = typeof body?.frameId === 'string' ? body.frameId.trim() : ''
  if (!frameId) {
    throw new ApiError('INVALID_PARAMS', { field: 'frameId' })
  }

  const hasFrameTimeUpdate = body?.frameTimeSec !== undefined
  const nextFrameTimeSec = hasFrameTimeUpdate ? parseFrameTimeSec(body?.frameTimeSec) : null
  const nextImagePrompt = readOptionalText(body?.imagePrompt)
  const nextVideoPrompt = readOptionalText(body?.videoPrompt)
  if (!hasFrameTimeUpdate && nextImagePrompt === undefined && nextVideoPrompt === undefined) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_UPDATE_EMPTY',
    })
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
  if (hasFrameTimeUpdate && frame.frameIndex === 0) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_TIME_FIRST_FRAME_LOCKED',
      field: 'frameTimeSec',
      message: 'F1 的起始时间固定为 0 秒',
    })
  }
  if (hasFrameTimeUpdate && nextFrameTimeSec !== null && nextFrameTimeSec <= 0) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_TIME_MUST_BE_POSITIVE',
      field: 'frameTimeSec',
      message: 'F1 之后的关键帧时间必须大于 0 秒',
    })
  }

  const panelDuration = typeof frame.panel.groupDurationSec === 'number' && Number.isFinite(frame.panel.groupDurationSec)
    ? frame.panel.groupDurationSec
    : typeof frame.panel.duration === 'number' && Number.isFinite(frame.panel.duration)
      ? frame.panel.duration
      : null
  if (hasFrameTimeUpdate && nextFrameTimeSec !== null && panelDuration !== null && nextFrameTimeSec > panelDuration) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_TIME_EXCEEDS_PANEL_DURATION',
      field: 'frameTimeSec',
      max: panelDuration,
      message: `关键帧时间不能超过分镜时长 ${panelDuration} 秒`,
    })
  }

  const updated = await prisma.novelPromotionPanelFrame.update({
    where: { id: frameId },
    data: {
      ...(nextFrameTimeSec !== null ? { frameTimeSec: nextFrameTimeSec } : {}),
      ...(nextImagePrompt !== undefined ? { imagePrompt: nextImagePrompt } : {}),
      ...(nextVideoPrompt !== undefined ? { videoPrompt: nextVideoPrompt } : {}),
    },
  })

  return NextResponse.json({
    success: true,
    frameId: updated.id,
    panelId: updated.panelId,
    frameIndex: updated.frameIndex,
    frameTimeSec: updated.frameTimeSec,
    imagePrompt: updated.imagePrompt,
    videoPrompt: updated.videoPrompt,
  })
})

export const DELETE = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const frameId = typeof body?.frameId === 'string' ? body.frameId.trim() : ''
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
      code: 'FRAME_DELETE_LAST_FRAME',
      message: '至少需要保留 1 张关键帧',
    })
  }

  const remainingFrames = frame.panel.frames
    .filter((item) => item.id !== frame.id)
    .sort((left, right) => left.frameIndex - right.frameIndex)
  const indexMap = new Map<number, number>()
  remainingFrames.forEach((item, index) => {
    indexMap.set(item.frameIndex, index)
  })

  const updatedRows = await prisma.$transaction(async (tx) => {
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
      await tx.novelPromotionPanelFrame.update({
        where: { id: item.id },
        data: {
          frameIndex: index,
          frameTimeSec: index === 0 ? 0 : item.frameTimeSec,
          frameRole: index === 0 ? 'hero' : item.frameRole,
          dependencyFrameIds: toDependencyFrameIdsText(mappedDependencies.length > 0 ? mappedDependencies : fallbackDependencies),
          generationStatus: item.generationStatus,
        },
      })
    }

    const finalFrames = await tx.novelPromotionPanelFrame.findMany({
      where: { panelId: frame.panelId },
      orderBy: { frameIndex: 'asc' },
    })
    const firstFrame = finalFrames[0] || null
    const isSingle = finalFrames.length <= 1
    await tx.novelPromotionPanel.update({
      where: { id: frame.panelId },
      data: {
        panelMode: isSingle ? 'single' : 'group',
        groupDurationSec: isSingle ? null : frame.panel.groupDurationSec,
        groupVideoPrompt: isSingle ? null : frame.panel.groupVideoPrompt,
        imageUrl: firstFrame?.imageUrl || null,
        imageMediaId: firstFrame?.imageMediaId || null,
        candidateImages: null,
      },
    })
    return finalFrames
  })

  return NextResponse.json({
    success: true,
    deletedFrameId: frame.id,
    panelId: frame.panelId,
    panelMode: updatedRows.length <= 1 ? 'single' : 'group',
    imageUrl: updatedRows[0]?.imageUrl || null,
    groupDurationSec: updatedRows.length <= 1 ? null : frame.panel.groupDurationSec,
    groupVideoPrompt: updatedRows.length <= 1 ? null : frame.panel.groupVideoPrompt,
    groupPlanJson: updatedRows.length <= 1 ? null : frame.panel.groupPlanJson,
    frames: updatedRows,
  })
})
