import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { resolveMediaRef } from '@/lib/media/service'
import { parsePanelFrameDependencyPlan, serializePanelFrameDependencyPlan } from '@/lib/novel-promotion/panel-tail-reference'

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

function parseVirtualFramePanelId(frameId: string): string | null {
  const suffix = ':virtual-frame-0'
  return frameId.endsWith(suffix) ? frameId.slice(0, -suffix.length) : null
}

function roundFrameTime(value: number): number {
  return Math.round(value * 100) / 100
}

function shiftDependencyIndexes(raw: string | null | undefined, insertIndex: number): string | null {
  const plan = parsePanelFrameDependencyPlan(raw)
  return serializePanelFrameDependencyPlan({
    previousTail: plan.previousTail,
    frameIndexes: plan.frameIndexes.map((index) => index >= insertIndex ? index + 1 : index),
  })
}

function normalizeInsertedFrameDependencyIndexes(raw: string | null | undefined): string | null {
  const plan = parsePanelFrameDependencyPlan(raw)
  return serializePanelFrameDependencyPlan({
    previousTail: plan.previousTail,
    frameIndexes: plan.frameIndexes
      .filter((index) => index >= 0),
  })
}

function resolveInsertedFrameTime(input: {
  insertIndex: number
  frames: Array<{ frameIndex: number; frameTimeSec: number }>
  panelDuration: number | null
}) {
  const { insertIndex, frames, panelDuration } = input
  const previousFrame = frames[insertIndex - 1] || null
  const nextFrame = frames[insertIndex] || null
  if (!previousFrame) return 0
  if (nextFrame && nextFrame.frameTimeSec > previousFrame.frameTimeSec) {
    return roundFrameTime((previousFrame.frameTimeSec + nextFrame.frameTimeSec) / 2)
  }
  if (panelDuration !== null && panelDuration > previousFrame.frameTimeSec) {
    return roundFrameTime((previousFrame.frameTimeSec + panelDuration) / 2)
  }
  return roundFrameTime(previousFrame.frameTimeSec + 1)
}

function buildInsertedFramePrompt(input: {
  placement: 'before' | 'after'
  anchorLabel: string
  prompt: string | null | undefined
}) {
  const base = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const prefix = input.placement === 'before'
    ? `插入在${input.anchorLabel}之前的新关键帧，保持人物、服饰、场景和光影连续。`
    : `插入在${input.anchorLabel}之后的新关键帧，承接上一关键帧，保持人物、服饰、场景和光影连续。`
  return base ? `${prefix}\n${base}` : prefix
}

async function resolveFramesWithMedia(rows: Array<{
  id: string
  panelId: string
  frameIndex: number
  frameTimeSec: number
  frameRole: string | null
  dependencyFrameIds: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  promptJson: string | null
  referencePolicy: string | null
  imageUrl: string | null
  imageMediaId: string | null
  generationStatus: string | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}>) {
  return Promise.all(rows.map(async (row) => {
    const imageMedia = await resolveMediaRef(row.imageMediaId, row.imageUrl)
    return {
      ...row,
      media: imageMedia,
      imageMedia,
      imageUrl: imageMedia?.url || row.imageUrl || null,
    }
  }))
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
  const panelId = typeof body?.panelId === 'string' ? body.panelId.trim() : ''
  const placement = body?.placement === 'before' ? 'before' : 'after'
  const customPrompt = readOptionalText(body?.imagePrompt)
  if (!frameId && !panelId) {
    throw new ApiError('INVALID_PARAMS', { field: 'frameId' })
  }

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: {
      ...(panelId ? { id: panelId } : {}),
      ...(frameId ? { frames: { some: { id: frameId } } } : {}),
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

  const currentFrames = [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
  const anchorFrame = frameId ? currentFrames.find((item) => item.id === frameId) : null
  if (frameId && !anchorFrame) {
    throw new ApiError('NOT_FOUND')
  }

  const updatedRows = await prisma.$transaction(async (tx) => {
    let frames = currentFrames
    if (frames.length === 0) {
      const baseFrame = await tx.novelPromotionPanelFrame.create({
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
      frames = [baseFrame]
    }

    const sortedFrames = [...frames].sort((left, right) => left.frameIndex - right.frameIndex)
    const anchor = frameId
      ? sortedFrames.find((item) => item.id === frameId)
      : sortedFrames[sortedFrames.length - 1]
    if (!anchor) {
      throw new ApiError('NOT_FOUND')
    }

    const anchorIndex = sortedFrames.findIndex((item) => item.id === anchor.id)
    const insertIndex = placement === 'before' ? anchorIndex : anchorIndex + 1
    const panelDuration = typeof panel.duration === 'number' && Number.isFinite(panel.duration)
      ? panel.duration
      : typeof panel.groupDurationSec === 'number' && Number.isFinite(panel.groupDurationSec)
        ? panel.groupDurationSec
        : null
    const frameTimeSec = resolveInsertedFrameTime({ insertIndex, frames: sortedFrames, panelDuration })
    const imagePrompt = customPrompt !== undefined
      ? customPrompt
      : buildInsertedFramePrompt({
        placement,
        anchorLabel: `F${anchor.frameIndex + 1}`,
        prompt: anchor.imagePrompt || panel.imagePrompt || panel.description,
      })

    const temporaryFrameIndex = -100000 - sortedFrames.length
    const insertedFrame = await tx.novelPromotionPanelFrame.create({
      data: {
        panelId: panel.id,
        frameIndex: temporaryFrameIndex,
        frameTimeSec,
        frameRole: 'transition',
        dependencyFrameIds: serializePanelFrameDependencyPlan({
          previousTail: false,
          frameIndexes: insertIndex === 0 ? [] : [insertIndex - 1],
        }),
        imagePrompt,
        videoPrompt: anchor.videoPrompt || panel.groupVideoPrompt || panel.videoPrompt || null,
        promptJson: anchor.promptJson || null,
        referencePolicy: anchor.referencePolicy || null,
        generationStatus: null,
      },
    })

    const shiftedRows = sortedFrames.map((item) => ({
      row: item,
      nextIndex: item.frameIndex >= insertIndex ? item.frameIndex + 1 : item.frameIndex,
      inserted: false,
    }))
    shiftedRows.push({
      row: insertedFrame,
      nextIndex: insertIndex,
      inserted: true,
    })

    for (let index = 0; index < shiftedRows.length; index += 1) {
      await tx.novelPromotionPanelFrame.update({
        where: { id: shiftedRows[index].row.id },
        data: { frameIndex: -1000 - index },
      })
    }

    for (const item of shiftedRows) {
      await tx.novelPromotionPanelFrame.update({
        where: { id: item.row.id },
        data: {
          frameIndex: item.nextIndex,
          frameRole: item.nextIndex === 0 ? 'hero' : (item.row.frameRole === 'hero' ? 'transition' : item.row.frameRole),
          dependencyFrameIds: item.inserted
            ? normalizeInsertedFrameDependencyIndexes(item.row.dependencyFrameIds)
            : shiftDependencyIndexes(item.row.dependencyFrameIds, insertIndex),
        },
      })
    }

    const finalFrames = await tx.novelPromotionPanelFrame.findMany({
      where: { panelId: panel.id },
      orderBy: { frameIndex: 'asc' },
    })
    const firstFrameWithImage = finalFrames.find((item) => item.imageUrl || item.imageMediaId) || finalFrames[0] || null
    await tx.novelPromotionPanel.update({
      where: { id: panel.id },
      data: {
        panelMode: finalFrames.length > 1 ? 'group' : 'single',
        groupDurationSec: finalFrames.length > 1 ? (panel.groupDurationSec ?? panel.duration ?? null) : null,
        groupVideoPrompt: finalFrames.length > 1 ? (panel.groupVideoPrompt ?? panel.videoPrompt ?? null) : null,
        imageUrl: firstFrameWithImage?.imageUrl || null,
        imageMediaId: firstFrameWithImage?.imageMediaId || null,
        candidateImages: null,
      },
    })
    return finalFrames
  })

  const framesWithMedia = await resolveFramesWithMedia(updatedRows)
  const firstFrameWithImage = framesWithMedia.find((item) => item.imageUrl || item.imageMedia?.url) || framesWithMedia[0] || null
  const nextPanelImageUrl = firstFrameWithImage?.imageUrl || null

  return NextResponse.json({
    success: true,
    panelId: panel.id,
    panelMode: framesWithMedia.length > 1 ? 'group' : 'single',
    imageUrl: nextPanelImageUrl,
    groupDurationSec: framesWithMedia.length > 1 ? (panel.groupDurationSec ?? panel.duration ?? null) : null,
    groupVideoPrompt: framesWithMedia.length > 1 ? (panel.groupVideoPrompt ?? panel.videoPrompt ?? null) : null,
    groupPlanJson: panel.groupPlanJson,
    frames: framesWithMedia,
  })
})

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
      if (hasFrameTimeUpdate) {
        throw new ApiError('INVALID_PARAMS', {
          code: 'FRAME_TIME_FIRST_FRAME_LOCKED',
          field: 'frameTimeSec',
          message: 'F1 的起始时间固定为 0 秒',
        })
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
      const updated = await prisma.novelPromotionPanelFrame.update({
        where: { id: firstFrame.id },
        data: {
          ...(nextImagePrompt !== undefined ? { imagePrompt: nextImagePrompt } : {}),
          ...(nextVideoPrompt !== undefined ? { videoPrompt: nextVideoPrompt } : {}),
        },
      })
      if (nextImagePrompt !== undefined) {
        await prisma.novelPromotionPanel.update({
          where: { id: panel.id },
          data: { imagePrompt: nextImagePrompt },
        })
      }
      return NextResponse.json({
        success: true,
        frameId: updated.id,
        panelId: updated.panelId,
        frameIndex: updated.frameIndex,
        frameTimeSec: updated.frameTimeSec,
        imagePrompt: updated.imagePrompt,
        videoPrompt: updated.videoPrompt,
      })
    }
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

  const panelDuration = typeof frame.panel.duration === 'number' && Number.isFinite(frame.panel.duration)
    ? frame.panel.duration
    : typeof frame.panel.groupDurationSec === 'number' && Number.isFinite(frame.panel.groupDurationSec)
      ? frame.panel.groupDurationSec
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

  if (nextImagePrompt !== undefined && frame.frameIndex === 0 && frame.panel.frames.length <= 1) {
    await prisma.novelPromotionPanel.update({
      where: { id: frame.panelId },
      data: { imagePrompt: nextImagePrompt },
    })
  }

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
      const dependencyPlan = parsePanelFrameDependencyPlan(item.dependencyFrameIds)
      const mappedDependencies = dependencyPlan.frameIndexes
        .filter((dependencyIndex) => dependencyIndex !== frame.frameIndex)
        .map((dependencyIndex) => indexMap.get(dependencyIndex))
        .filter((dependencyIndex): dependencyIndex is number => typeof dependencyIndex === 'number')
        .filter((dependencyIndex) => dependencyIndex < index)
      const fallbackDependencies = index === 0 ? [] : [index - 1]
      const nextDependencyPlan = {
        previousTail: dependencyPlan.previousTail,
        frameIndexes: mappedDependencies.length > 0 ? mappedDependencies : fallbackDependencies,
      }
      await tx.novelPromotionPanelFrame.update({
        where: { id: item.id },
        data: {
          frameIndex: index,
          frameTimeSec: index === 0 ? 0 : item.frameTimeSec,
          frameRole: index === 0 ? 'hero' : item.frameRole,
          dependencyFrameIds: serializePanelFrameDependencyPlan(nextDependencyPlan),
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
  const framesWithMedia = await Promise.all(updatedRows.map(async (row) => {
    const imageMedia = await resolveMediaRef(row.imageMediaId, row.imageUrl)
    return {
      ...row,
      media: imageMedia,
      imageMedia,
      imageUrl: imageMedia?.url || row.imageUrl || null,
    }
  }))
  const nextPanelImageMedia = updatedRows[0]
    ? await resolveMediaRef(updatedRows[0].imageMediaId, updatedRows[0].imageUrl)
    : null
  const nextPanelImageUrl = nextPanelImageMedia?.url || updatedRows[0]?.imageUrl || null

  return NextResponse.json({
    success: true,
    deletedFrameId: frame.id,
    panelId: frame.panelId,
    panelMode: updatedRows.length <= 1 ? 'single' : 'group',
    imageUrl: nextPanelImageUrl,
    groupDurationSec: updatedRows.length <= 1 ? null : frame.panel.groupDurationSec,
    groupVideoPrompt: updatedRows.length <= 1 ? null : frame.panel.groupVideoPrompt,
    groupPlanJson: updatedRows.length <= 1 ? null : frame.panel.groupPlanJson,
    frames: framesWithMedia,
  })
})
