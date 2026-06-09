import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { getObjectBuffer } from '@/lib/storage'

export const runtime = 'nodejs'

function parseRange(rangeHeader: string | null, size: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return null
  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return null
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}

export const GET = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const panelId = request.nextUrl.searchParams.get('panelId')?.trim() || ''
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
    select: {
      dubbingAudioUrl: true,
      updatedAt: true,
    },
  })
  if (!panel?.dubbingAudioUrl) {
    throw new ApiError('NOT_FOUND')
  }

  const buffer = await getObjectBuffer(panel.dubbingAudioUrl)
  const size = buffer.length
  const range = parseRange(request.headers.get('range'), size)
  if (range) {
    const chunk = buffer.subarray(range.start, range.end + 1)
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(chunk.length),
        'Content-Type': 'audio/wav',
        'Cache-Control': 'no-store',
      },
    })
  }

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
      'Last-Modified': panel.updatedAt.toUTCString(),
    },
  })
})
