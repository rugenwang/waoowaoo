import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  useQueryClientMock,
  useMutationMock,
  requestJsonWithErrorMock,
} = vi.hoisted(() => ({
  useQueryClientMock: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  useMutationMock: vi.fn((options: unknown) => options),
  requestJsonWithErrorMock: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => useQueryClientMock(),
  useMutation: (options: unknown) => useMutationMock(options),
}))

vi.mock('@/lib/query/mutations/mutation-shared', async () => {
  const actual = await vi.importActual<typeof import('@/lib/query/mutations/mutation-shared')>(
    '@/lib/query/mutations/mutation-shared',
  )
  return {
    ...actual,
    invalidateQueryTemplates: vi.fn(),
    requestJsonWithError: requestJsonWithErrorMock,
  }
})

import {
  useUpdateProjectCharacterVoiceSettings,
  useUploadProjectCharacterVoice,
} from '@/lib/query/mutations/character-voice-mutations'

interface UpdateVoiceMutation {
  mutationFn: (variables: {
    characterId: string
    voiceType: 'qwen-designed' | 'uploaded' | 'custom' | null
    voiceId?: string
    customVoiceUrl?: string
  }) => Promise<unknown>
}

interface UploadVoiceMutation {
  mutationFn: (variables: {
    characterId: string
    file: File
    voicePrompt?: string
  }) => Promise<unknown>
}

describe('project character voice mutations', () => {
  beforeEach(() => {
    useQueryClientMock.mockClear()
    useMutationMock.mockClear()
    requestJsonWithErrorMock.mockReset()
    requestJsonWithErrorMock.mockResolvedValue({ success: true })
  })

  it('routes voice setting updates to the character-voice endpoint after designed voice save', async () => {
    const mutation = useUpdateProjectCharacterVoiceSettings('project-1') as unknown as UpdateVoiceMutation

    await mutation.mutationFn({
      characterId: 'character-1',
      voiceType: 'qwen-designed',
      voiceId: 'voice-1',
      customVoiceUrl: 'https://example.com/audio.wav',
    })

    expect(requestJsonWithErrorMock).toHaveBeenCalledTimes(1)
    expect(requestJsonWithErrorMock).toHaveBeenCalledWith(
      '/api/assets/character-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          kind: 'character',
          projectId: 'project-1',
          voiceType: 'qwen-designed',
          voiceId: 'voice-1',
          customVoiceUrl: 'https://example.com/audio.wav',
        }),
      },
      '更新音色失败',
    )
  })

  it('includes the voice prompt when uploading an extracted voice to a project character', async () => {
    const mutation = useUploadProjectCharacterVoice('project-1') as unknown as UploadVoiceMutation
    const file = new File(['audio'], 'voice.wav', { type: 'audio/wav' })

    await mutation.mutationFn({
      characterId: 'character-1',
      file,
      voicePrompt: '年轻女声，温柔但带一点紧张感',
    })

    expect(requestJsonWithErrorMock).toHaveBeenCalledTimes(1)
    const [url, init] = requestJsonWithErrorMock.mock.calls[0]
    expect(url).toBe('/api/novel-promotion/project-1/character-voice')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    expect(init.body.get('characterId')).toBe('character-1')
    expect(init.body.get('voicePrompt')).toBe('年轻女声，温柔但带一点紧张感')
  })
})
