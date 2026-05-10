import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { prisma } from '@/lib/prisma'
import { uploadObject, generateUniqueKey } from '@/lib/storage'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'

/**
 * POST /api/novel-promotion/[projectId]/upload-panel-frame-image
 * 上传用户自定义图片替换分镜组中的单个关键帧。
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const frameId = String(formData.get('frameId') || '')

  if (!file || !frameId) {
    throw new ApiError('INVALID_PARAMS')
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
      panel: true,
    },
  })

  if (!frame) {
    throw new ApiError('NOT_FOUND')
  }

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const processed = await sharp(buffer)
    .rotate()
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()

  const key = generateUniqueKey(`panel-frame-${frameId}-upload`, 'jpg')
  await uploadObject(processed, key)
  const media = await ensureMediaObjectFromStorageKey(key, {
    mimeType: 'image/jpeg',
    sizeBytes: processed.length,
  })

  const shouldUpdatePanelImage = frame.frameIndex === 0 || !frame.panel.imageUrl

  await prisma.$transaction([
    prisma.novelPromotionPanelFrame.update({
      where: { id: frameId },
      data: {
        imageUrl: key,
        imageMediaId: media.id,
        generationStatus: 'completed',
        errorMessage: null,
      },
    }),
    ...(shouldUpdatePanelImage
      ? [
        prisma.novelPromotionPanel.update({
          where: { id: frame.panelId },
          data: {
            previousImageUrl: frame.panel.imageUrl || frame.panel.previousImageUrl || null,
            previousImageMediaId: frame.panel.imageMediaId || frame.panel.previousImageMediaId || null,
            imageUrl: key,
            imageMediaId: media.id,
            candidateImages: null,
          },
        }),
      ]
      : []),
  ])

  return NextResponse.json({
    success: true,
    frameId,
    panelId: frame.panelId,
    frameIndex: frame.frameIndex,
    imageKey: key,
    imageUrl: media.url,
    panelImageUpdated: shouldUpdatePanelImage,
  })
})
