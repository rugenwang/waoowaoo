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

  const nextFrameTimeSec = parseFrameTimeSec(body?.frameTimeSec)
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
  if (frame.frameIndex === 0) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_TIME_FIRST_FRAME_LOCKED',
      field: 'frameTimeSec',
      message: 'F1 的起始时间固定为 0 秒',
    })
  }
  if (nextFrameTimeSec <= 0) {
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
  if (panelDuration !== null && nextFrameTimeSec > panelDuration) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'FRAME_TIME_EXCEEDS_PANEL_DURATION',
      field: 'frameTimeSec',
      max: panelDuration,
      message: `关键帧时间不能超过分镜时长 ${panelDuration} 秒`,
    })
  }

  const updated = await prisma.novelPromotionPanelFrame.update({
    where: { id: frameId },
    data: { frameTimeSec: nextFrameTimeSec },
  })

  return NextResponse.json({
    success: true,
    frameId: updated.id,
    panelId: updated.panelId,
    frameIndex: updated.frameIndex,
    frameTimeSec: updated.frameTimeSec,
  })
})
