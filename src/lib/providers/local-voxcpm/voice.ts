export const LOCAL_VOXCPM_TTS_MODEL_ID = 'local/voxcpm-tts'
export const LOCAL_VOXCPM_VOICE_DESIGN_MODEL_ID = 'local/voxcpm-voice-design'
export const LOCAL_VOXCPM_VOICE_ID_PREFIX = 'local-voxcpm:'

export interface LocalVoxCPMVoiceDesignInput {
  voicePrompt: string
  previewText: string
  preferredName?: string
}

export interface LocalVoxCPMVoiceDesignResult {
  success: boolean
  voiceId?: string
  targetModel?: string
  audioBase64?: string
  sampleRate?: number
  responseFormat?: string
  usageCount?: number
  requestId?: string
  error?: string
}

export interface LocalVoxCPMTTSInput {
  text: string
  voiceId: string
}

export interface LocalVoxCPMCloneInput {
  text: string
  promptText: string
  promptAudioBase64: string
  referenceAudioBase64?: string
  preferredName?: string
}

export interface LocalVoxCPMTTSResult {
  success: boolean
  audioData?: Buffer
  audioDuration?: number
  audioUrl?: string
  error?: string
}

type LocalVoiceResponse = {
  success?: boolean
  voice_id?: string
  voiceId?: string
  audio_base64?: string
  audioBase64?: string
  audio_url?: string
  audioUrl?: string
  duration_ms?: number
  durationMs?: number
  error?: string
}

function normalizeBaseUrl(baseUrl?: string | null): string {
  const value = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  return (value || 'http://127.0.0.1:5566').replace(/\/+$/, '')
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function normalizeLocalVoxCPMError(message: string): string {
  const value = message.trim()
  const lower = value.toLowerCase()
  if (value.includes('VoxCPM failed') && (
    value.includes('未登录') ||
    lower.includes('not login') ||
    lower.includes('not logged')
  )) {
    return 'VoxCPM CLI 未登录，请先在终端完成 VoxCPM 登录或授权后重试'
  }
  return value
}

async function postLocalVoice(
  baseUrl: string | undefined,
  apiKey: string | undefined,
  pathname: string,
  body: Record<string, unknown>,
): Promise<LocalVoiceResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = readString(apiKey)
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  let data: LocalVoiceResponse = {}
  if (raw) {
    try {
      data = JSON.parse(raw) as LocalVoiceResponse
    } catch {
      throw new Error(`LOCAL_VOXCPM_INVALID_JSON: ${raw.slice(0, 120)}`)
    }
  }
  if (!response.ok || data.success === false) {
    const message = readString(data.error) || `LOCAL_VOXCPM_REQUEST_FAILED(${response.status})`
    throw new Error(normalizeLocalVoxCPMError(message))
  }
  return data
}

export function isLocalVoxCPMVoiceId(voiceId?: string | null): boolean {
  return readString(voiceId).startsWith(LOCAL_VOXCPM_VOICE_ID_PREFIX)
}

export async function createLocalVoxCPMVoiceDesign(
  input: LocalVoxCPMVoiceDesignInput,
  baseUrl?: string,
  apiKey?: string,
): Promise<LocalVoxCPMVoiceDesignResult> {
  const voicePrompt = readString(input.voicePrompt)
  const previewText = readString(input.previewText)
  if (!voicePrompt) return { success: false, error: '声音提示词不能为空' }
  if (!previewText) return { success: false, error: '预览文本不能为空' }

  try {
    const data = await postLocalVoice(baseUrl, apiKey, '/api/integrations/waoowaoo/v1/voice/design', {
      text: previewText,
      control: voicePrompt,
      preferred_name: input.preferredName || 'custom_voice',
    })
    const audioBase64 = readString(data.audio_base64) || readString(data.audioBase64)
    const voiceId = readString(data.voice_id) || readString(data.voiceId)
    return {
      success: true,
      voiceId,
      targetModel: 'local-voxcpm',
      audioBase64,
      responseFormat: 'wav',
    }
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'LOCAL_VOXCPM_VOICE_DESIGN_FAILED',
    }
  }
}

export async function synthesizeWithLocalVoxCPM(
  input: LocalVoxCPMTTSInput,
  baseUrl?: string,
  apiKey?: string,
): Promise<LocalVoxCPMTTSResult> {
  const text = readString(input.text)
  const voiceId = readString(input.voiceId)
  if (!text) return { success: false, error: 'LOCAL_VOXCPM_TTS_TEXT_REQUIRED' }
  if (!voiceId) return { success: false, error: 'LOCAL_VOXCPM_TTS_VOICE_ID_REQUIRED' }

  try {
    const data = await postLocalVoice(baseUrl, apiKey, '/api/integrations/waoowaoo/v1/voice/synthesize', {
      text,
      voice_id: voiceId,
    })
    const audioBase64 = readString(data.audio_base64) || readString(data.audioBase64)
    if (!audioBase64) {
      throw new Error('LOCAL_VOXCPM_AUDIO_MISSING')
    }
    return {
      success: true,
      audioData: Buffer.from(audioBase64, 'base64'),
      audioDuration: readDuration(data.duration_ms) ?? readDuration(data.durationMs),
      audioUrl: readString(data.audio_url) || readString(data.audioUrl) || undefined,
    }
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'LOCAL_VOXCPM_TTS_FAILED',
    }
  }
}

export async function cloneWithLocalVoxCPM(
  input: LocalVoxCPMCloneInput,
  baseUrl?: string,
  apiKey?: string,
): Promise<LocalVoxCPMTTSResult> {
  const text = readString(input.text)
  const promptText = readString(input.promptText)
  const promptAudioBase64 = readString(input.promptAudioBase64)
  const referenceAudioBase64 = readString(input.referenceAudioBase64) || promptAudioBase64
  if (!text) return { success: false, error: 'LOCAL_VOXCPM_CLONE_TEXT_REQUIRED' }
  if (!promptText) return { success: false, error: 'LOCAL_VOXCPM_CLONE_PROMPT_TEXT_REQUIRED' }
  if (!promptAudioBase64) return { success: false, error: 'LOCAL_VOXCPM_CLONE_PROMPT_AUDIO_REQUIRED' }

  try {
    const data = await postLocalVoice(baseUrl, apiKey, '/api/integrations/waoowaoo/v1/voice/clone', {
      text,
      prompt_text: promptText,
      prompt_audio_base64: promptAudioBase64,
      reference_audio_base64: referenceAudioBase64,
      preferred_name: input.preferredName || 'panel_dubbing',
    })
    const audioBase64 = readString(data.audio_base64) || readString(data.audioBase64)
    if (!audioBase64) {
      throw new Error('LOCAL_VOXCPM_AUDIO_MISSING')
    }
    return {
      success: true,
      audioData: Buffer.from(audioBase64, 'base64'),
      audioDuration: readDuration(data.duration_ms) ?? readDuration(data.durationMs),
      audioUrl: readString(data.audio_url) || readString(data.audioUrl) || undefined,
    }
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'LOCAL_VOXCPM_CLONE_FAILED',
    }
  }
}
