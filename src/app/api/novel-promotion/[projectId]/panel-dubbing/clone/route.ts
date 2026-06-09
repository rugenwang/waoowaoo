import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { extractStorageKey, generateUniqueKey, getObjectBuffer, getSignedUrl, toFetchableUrl, uploadObject } from '@/lib/storage'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { getProviderConfig, getProviderKey, resolveModelSelectionOrSingle } from '@/lib/api-config'
import { cloneWithLocalVoxCPM } from '@/lib/providers/local-voxcpm/voice'

export const runtime = 'nodejs'

type DubbingMode = 'video-vocal' | 'character-voice'

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readMode(value: unknown): DubbingMode {
  return value === 'video-vocal' ? 'video-vocal' : 'character-voice'
}

async function readAudioBuffer(audioRef: string): Promise<Buffer> {
  const key = extractStorageKey(audioRef) || (!audioRef.startsWith('http') && !audioRef.startsWith('/') ? audioRef : '')
  if (key) {
    return await getObjectBuffer(key)
  }
  const response = await fetch(toFetchableUrl(audioRef))
  if (!response.ok) {
    throw new Error(`下载参考音频失败: ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

async function resolveLocalVoiceProvider(userId: string, projectAudioModel: string | null) {
  try {
    if (projectAudioModel) {
      const selection = await resolveModelSelectionOrSingle(userId, projectAudioModel, 'audio')
      if (getProviderKey(selection.provider).toLowerCase() === 'local') {
        return await getProviderConfig(userId, selection.provider)
      }
    }
  } catch {
    // Fall back to the default local provider below.
  }
  return await getProviderConfig(userId, 'local')
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json().catch(() => null)
  const panelId = readString(body?.panelId)
  const mode = readMode(body?.mode)
  const text = readString(body?.text)
  const sourceAudioKey = readString(body?.sourceAudioKey)
  const characterId = readString(body?.characterId)
  const userPromptText = readString(body?.promptText)
  if (!panelId || !text) {
    throw new ApiError('INVALID_PARAMS')
  }

  const project = await prisma.novelPromotionProject.findFirst({
    where: { projectId },
    select: {
      id: true,
      audioModel: true,
    },
  })
  if (!project) throw new ApiError('NOT_FOUND')

  const panel = await prisma.novelPromotionPanel.findFirst({
    where: {
      id: panelId,
      storyboard: {
        episode: {
          novelPromotionProjectId: project.id,
        },
      },
    },
    select: {
      id: true,
      panelIndex: true,
      videoUrl: true,
    },
  })
  if (!panel) throw new ApiError('NOT_FOUND')

  let referenceAudio: Buffer
  let promptText = userPromptText || text
  let sourceLabel = '视频人声'
  let sourceCharacterId: string | null = null

  if (mode === 'video-vocal') {
    if (!sourceAudioKey) {
      throw new ApiError('INVALID_PARAMS', { message: '请先提取可用的人声音频' })
    }
    referenceAudio = await readAudioBuffer(sourceAudioKey)
  } else {
    if (!characterId) {
      throw new ApiError('INVALID_PARAMS', { message: '请选择角色音色' })
    }
    const character = await prisma.novelPromotionCharacter.findFirst({
      where: {
        id: characterId,
        novelPromotionProjectId: project.id,
      },
      select: {
        id: true,
        name: true,
        customVoiceUrl: true,
        voicePrompt: true,
      },
    })
    if (!character?.customVoiceUrl) {
      throw new ApiError('INVALID_PARAMS', { message: '该角色还没有可用音色' })
    }
    referenceAudio = await readAudioBuffer(character.customVoiceUrl)
    promptText = userPromptText || character.voicePrompt || `${character.name}的角色音色`
    sourceLabel = character.name
    sourceCharacterId = character.id
  }

  const providerConfig = await resolveLocalVoiceProvider(session.user.id, project.audioModel)
  const generated = await cloneWithLocalVoxCPM(
    {
      text,
      promptText,
      promptAudioBase64: referenceAudio.toString('base64'),
      referenceAudioBase64: referenceAudio.toString('base64'),
      preferredName: `panel_${panel.panelIndex + 1}_dubbing`,
    },
    providerConfig.baseUrl,
    providerConfig.apiKey,
  )
  if (!generated.success || !generated.audioData) {
    throw new ApiError('INVALID_PARAMS', {
      message: generated.error || '视频配音生成失败',
    })
  }

  const key = generateUniqueKey(`voice/panel-dubbing/${projectId}/${panel.id}/dubbing`, 'wav')
  await uploadObject(generated.audioData, key, 1, 'audio/wav')
  const media = await ensureMediaObjectFromStorageKey(key, {
    mimeType: 'audio/wav',
    sizeBytes: generated.audioData.length,
    durationMs: generated.audioDuration,
  })
  const meta = {
    mode,
    text,
    promptText,
    sourceLabel,
    sourceCharacterId,
    sourceAudioKey: mode === 'video-vocal' ? sourceAudioKey : undefined,
    generatedAt: new Date().toISOString(),
    model: 'local-voxcpm-clone',
  }

  await prisma.novelPromotionPanel.update({
    where: { id: panel.id },
    data: {
      dubbingAudioUrl: key,
      dubbingAudioMediaId: media.id,
      dubbingSourceType: mode,
      dubbingMetaJson: JSON.stringify(meta),
    },
  })

  return NextResponse.json({
    success: true,
    audioKey: key,
    audioUrl: getSignedUrl(key, 7200),
    mediaId: media.id,
    sourceType: mode,
    meta,
  })
})
