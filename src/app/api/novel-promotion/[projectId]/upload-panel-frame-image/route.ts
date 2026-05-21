import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import { prisma } from '@/lib/prisma'
import { uploadObject, generateUniqueKey, getObjectBuffer, toFetchableUrl } from '@/lib/storage'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { ensureMediaObjectFromStorageKey, resolveStorageKeyFromMediaValue } from '@/lib/media/service'

async function readSourceImageBuffer(file: File | null, sourceImageUrl: string | null) {
  if (file) {
    return Buffer.from(await file.arrayBuffer())
  }
  if (!sourceImageUrl) return null

  const storageKey = await resolveStorageKeyFromMediaValue(sourceImageUrl)
  if (storageKey) {
    return getObjectBuffer(storageKey)
  }

  const response = await fetch(toFetchableUrl(sourceImageUrl))
  if (!response.ok) {
    throw new ApiError('INVALID_PARAMS', {
      message: `读取来源图片失败：${response.status}`,
    })
  }
  return Buffer.from(await response.arrayBuffer())
}

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

  const contentType = request.headers.get('content-type') || ''
  let file: File | null = null
  let frameId = ''
  let sourceImageUrl: string | null = null

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    frameId = typeof body?.frameId === 'string' ? body.frameId.trim() : ''
    sourceImageUrl = typeof body?.sourceImageUrl === 'string' ? body.sourceImageUrl.trim() : null
  } else {
    const formData = await request.formData()
    file = formData.get('file') as File | null
    frameId = String(formData.get('frameId') || '')
  }

  if ((!file && !sourceImageUrl) || !frameId) {
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

  const buffer = await readSourceImageBuffer(file, sourceImageUrl)
  if (!buffer) {
    throw new ApiError('INVALID_PARAMS')
  }
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
