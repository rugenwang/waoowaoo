import type { Job } from 'bullmq'
import {
  createVoiceDesign,
  validatePreviewText,
  validateVoicePrompt,
  type VoiceDesignInput,
} from '@/lib/providers/bailian/voice-design'
import { getProviderConfig, getProviderKey, resolveModelSelectionOrSingle } from '@/lib/api-config'
import { createLocalVoxCPMVoiceDesign } from '@/lib/providers/local-voxcpm/voice'
import { prisma } from '@/lib/prisma'
import { logInfo as _ulogInfo } from '@/lib/logging/core'
import { reportTaskProgress } from '@/lib/workers/shared'
import { assertTaskActive } from '@/lib/workers/utils'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

function readLanguage(value: unknown): 'zh' | 'en' {
  return value === 'en' ? 'en' : 'zh'
}

export async function handleVoiceDesignTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as Record<string, unknown>
  const voicePrompt = readRequiredString(payload.voicePrompt, 'voicePrompt')
  const previewText = readRequiredString(payload.previewText, 'previewText')
  const preferredName = typeof payload.preferredName === 'string' && payload.preferredName.trim()
    ? payload.preferredName.trim()
    : 'custom_voice'
  const language = readLanguage(payload.language)

  const promptValidation = validateVoicePrompt(voicePrompt)
  if (!promptValidation.valid) {
    throw new Error(promptValidation.error || 'invalid voicePrompt')
  }
  const textValidation = validatePreviewText(previewText)
  if (!textValidation.valid) {
    throw new Error(textValidation.error || 'invalid previewText')
  }

  await reportTaskProgress(job, 25, {
    stage: 'voice_design_submit',
    stageLabel: '提交声音设计任务',
    displayMode: 'detail',
  })
  await assertTaskActive(job, 'voice_design_submit')

  const input: VoiceDesignInput = {
    voicePrompt,
    previewText,
    preferredName,
    language,
  }
  const pref = await prisma.userPreference.findUnique({
    where: { userId: job.data.userId },
    select: { voiceDesignModel: true },
  })
  const selectedVoiceDesignModel = typeof pref?.voiceDesignModel === 'string' && pref.voiceDesignModel.trim()
    ? pref.voiceDesignModel.trim()
    : ''
  const modelSelection = selectedVoiceDesignModel
    ? await resolveModelSelectionOrSingle(job.data.userId, selectedVoiceDesignModel, 'audio')
    : null
  const providerId = modelSelection?.provider || 'bailian'
  const providerKey = getProviderKey(providerId).toLowerCase()
  const providerConfig = await getProviderConfig(job.data.userId, providerId)
  _ulogInfo('[VoiceDesign] resolved provider:', {
    taskId: job.id,
    providerId,
    providerKey,
    modelKey: modelSelection?.modelKey || null,
    baseUrl: providerConfig.baseUrl || null,
  })
  const designed = providerKey === 'local'
    ? await createLocalVoxCPMVoiceDesign(input, providerConfig.baseUrl, providerConfig.apiKey)
    : await createVoiceDesign(input, providerConfig.apiKey)
  if (!designed.success) {
    throw new Error(designed.error || '声音设计失败')
  }

  await reportTaskProgress(job, 96, {
    stage: 'voice_design_done',
    stageLabel: '声音设计完成',
    displayMode: 'detail',
  })

  return {
    success: true,
    voiceId: designed.voiceId,
    targetModel: designed.targetModel,
    audioBase64: designed.audioBase64,
    sampleRate: designed.sampleRate,
    responseFormat: designed.responseFormat,
    usageCount: designed.usageCount,
    requestId: designed.requestId,
    taskType: job.data.type === TASK_TYPE.ASSET_HUB_VOICE_DESIGN ? TASK_TYPE.ASSET_HUB_VOICE_DESIGN : TASK_TYPE.VOICE_DESIGN,
  }
}
