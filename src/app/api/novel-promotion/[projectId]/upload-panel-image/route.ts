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

  const contentType = request.headers.get('content-type') || ''
  let file: File | null = null
  let panelId = ''
  let sourceImageUrl: string | null = null

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({}))
    panelId = typeof body?.panelId === 'string' ? body.panelId.trim() : ''
    sourceImageUrl = typeof body?.sourceImageUrl === 'string' ? body.sourceImageUrl.trim() : null
  } else {
    const formData = await request.formData()
    file = formData.get('file') as File | null
    panelId = String(formData.get('panelId') || '')
  }

  if ((!file && !sourceImageUrl) || !panelId) {
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
    include: {
      frames: { orderBy: { frameIndex: 'asc' }, take: 1 },
    },
  })

  if (!panel) {
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

  const key = generateUniqueKey(`panel-${panelId}-upload`, 'jpg')
  await uploadObject(processed, key)
  const media = await ensureMediaObjectFromStorageKey(key, {
    mimeType: 'image/jpeg',
    sizeBytes: processed.length,
  })

  const firstFrame = panel.frames[0]
  await prisma.$transaction([
    prisma.novelPromotionPanel.update({
      where: { id: panelId },
      data: {
        previousImageUrl: panel.imageUrl || panel.previousImageUrl || null,
        previousImageMediaId: panel.imageMediaId || panel.previousImageMediaId || null,
        imageUrl: key,
        imageMediaId: media.id,
        candidateImages: null,
      },
    }),
    ...(firstFrame
      ? [
        prisma.novelPromotionPanelFrame.update({
          where: { id: firstFrame.id },
          data: {
            imageUrl: key,
            imageMediaId: media.id,
            generationStatus: 'completed',
            errorMessage: null,
          },
        }),
      ]
      : []),
  ])

  return NextResponse.json({
    success: true,
    imageKey: key,
    imageUrl: media.url,
    frameId: firstFrame?.id || null,
    frameImageUpdated: Boolean(firstFrame),
  })
})
