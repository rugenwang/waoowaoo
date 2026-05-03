import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { prisma } from '@/lib/prisma'
import { uploadObject, generateUniqueKey } from '@/lib/storage'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

/**
 * POST /api/novel-promotion/[projectId]/upload-panel-image
 * 上传用户自定义图片作为分镜图，直接写入 panel.imageUrl
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
  const processed = await sharp(buffer)
    .rotate()
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()

  const key = generateUniqueKey(`panel-${panelId}-upload`, 'jpg')
  await uploadObject(processed, key)
  const media = await ensureMediaObjectFromStorageKey(key, {
    mimeType: 'image/jpeg',
    sizeBytes: processed.length,
  })

  await prisma.novelPromotionPanel.update({
    where: { id: panelId },
    data: {
      previousImageUrl: panel.imageUrl || panel.previousImageUrl || null,
      previousImageMediaId: panel.imageMediaId || panel.previousImageMediaId || null,
      imageUrl: key,
      imageMediaId: media.id,
      candidateImages: null,
    },
  })

  return NextResponse.json({
    success: true,
    imageKey: key,
    imageUrl: media.url,
  })
})
