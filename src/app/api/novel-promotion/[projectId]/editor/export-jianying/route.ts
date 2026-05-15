import archiver from 'archiver'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getObjectBuffer, toFetchableUrl } from '@/lib/storage'
import { resolveStorageKeyFromMediaValue } from '@/lib/media/service'

interface EditorClip {
  id?: string
  src?: string
  durationInFrames?: number
  metadata?: {
    description?: string
    panelId?: string
    storyboardId?: string
    panelIndex?: number
    videoPrompt?: string
  }
}

interface EditorProjectData {
  id?: string
  config?: { fps?: number; width?: number; height?: number }
  timeline?: EditorClip[]
}

async function downloadVideoBuffer(src: string): Promise<Buffer> {
  const storageKey = await resolveStorageKeyFromMediaValue(src)
  if (storageKey) return await getObjectBuffer(storageKey)

  const response = await fetch(toFetchableUrl(src))
  if (!response.ok) {
    throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function safeFilePart(value: string): string {
  return value.slice(0, 48).replace(/[\\/:*?"<>|]/g, '_')
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const body = await request.json()
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId : ''
  const projectData = body?.projectData as EditorProjectData | undefined
  const clips = Array.isArray(projectData?.timeline)
    ? projectData.timeline.filter((clip): clip is EditorClip & { src: string } => typeof clip?.src === 'string' && clip.src.length > 0)
    : []

  if (!episodeId || clips.length === 0) {
    throw new ApiError('INVALID_PARAMS')
  }

  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: { id: episodeId, novelPromotionProject: { projectId } },
    select: { id: true, name: true },
  })
  if (!episode) throw new ApiError('NOT_FOUND')

  const fps = projectData?.config?.fps || 30
  let cursorFrame = 0
  const manifestClips = clips.map((clip, index) => {
    const durationInFrames = Math.max(1, Math.round(clip.durationInFrames || fps * 3))
    const fileName = `${String(index + 1).padStart(3, '0')}_${safeFilePart(clip.metadata?.description || 'clip')}.mp4`
    const item = {
      id: clip.id || `clip_${index + 1}`,
      order: index + 1,
      file: `media/${fileName}`,
      startFrame: cursorFrame,
      durationInFrames,
      startSec: Number((cursorFrame / fps).toFixed(3)),
      durationSec: Number((durationInFrames / fps).toFixed(3)),
      metadata: clip.metadata || {},
    }
    cursorFrame += durationInFrames
    return item
  })

  const draftContent = {
    schema: 'waoo-jianying-draft-v1',
    note: '这是 WAOO 生成的剪映草稿素材包。剪映桌面版的草稿结构不是公开稳定接口，如不能直接导入，可按 waoo_timeline.json 的顺序导入 media 目录素材。',
    fps,
    width: projectData?.config?.width || 1920,
    height: projectData?.config?.height || 1080,
    durationInFrames: cursorFrame,
    clips: manifestClips,
  }

  const archive = archiver('zip', { zlib: { level: 9 } })
  const chunks: Uint8Array[] = []
  const archiveFinished = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve())
    archive.on('error', reject)
  })
  archive.on('data', (chunk) => chunks.push(chunk))

  archive.append(JSON.stringify(draftContent, null, 2), { name: 'waoo_timeline.json' })
  archive.append(JSON.stringify(draftContent, null, 2), { name: 'draft_content.json' })
  archive.append(JSON.stringify({
    draftId: projectData?.id || `waoo_${episodeId}`,
    name: episode.name || 'WAOO 剪辑工程',
    createdBy: 'WAOO',
    exportedAt: new Date().toISOString(),
  }, null, 2), { name: 'draft_meta_info.json' })
  archive.append([
    'WAOO 剪映草稿素材包',
    '',
    '1. media 目录内的视频文件已按当前剪辑时间线排序。',
    '2. waoo_timeline.json 记录每个片段的顺序、秒数和原分镜信息。',
    '3. 剪映桌面版草稿格式不是公开稳定接口，如不能直接识别 draft_content.json，请手动导入 media 文件夹并按文件名前缀排序。',
  ].join('\n'), { name: 'README.txt' })

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]
    const target = manifestClips[index]
    try {
      archive.append(await downloadVideoBuffer(clip.src), { name: target.file })
    } catch (error) {
      archive.append(String(error instanceof Error ? error.message : error), {
        name: `errors/${String(index + 1).padStart(3, '0')}.txt`,
      })
    }
  }

  await archive.finalize()
  await archiveFinished

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  const safeName = safeFilePart(episode.name || 'waoo-jianying')
  return new Response(result, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(`${safeName}_jianying_draft.zip`)}"`,
    },
  })
})
