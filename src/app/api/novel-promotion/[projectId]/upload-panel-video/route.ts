import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { uploadObject, generateUniqueKey } from '@/lib/storage'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

/**
 * POST /api/novel-promotion/[projectId]/upload-panel-video
 * 上传用户自定义视频作为分镜视频，直接写入 panel.videoUrl
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const panelId = String(formData.get('panelId') || '')

  if (!file || !panelId) {
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

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  const key = generateUniqueKey(`panel-${panelId}-upload`, 'mp4')
  await uploadObject(buffer, key, 1, 'video/mp4')
  const media = await ensureMediaObjectFromStorageKey(key, {
    mimeType: 'video/mp4',
    sizeBytes: buffer.length,
  })

  await prisma.novelPromotionPanel.update({
    where: { id: panelId },
    data: {
      videoUrl: key,
      videoMediaId: media.id,
    },
  })

  return NextResponse.json({
    success: true,
    videoKey: key,
    videoUrl: media.url,
  })
})
