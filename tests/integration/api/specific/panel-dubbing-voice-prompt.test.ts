import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => ({
  requireProjectAuthLight: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
  })),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
}))

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock)),
  novelPromotionProject: {
    findFirst: vi.fn(async () => ({ id: 'project-db-1', audioModel: 'local/voxcpm-tts' })),
  },
  novelPromotionPanel: {
    findFirst: vi.fn(async () => ({ id: 'panel-1', panelIndex: 0, videoUrl: 'video.mp4' })),
    update: vi.fn(async () => ({ id: 'panel-1' })),
  },
  novelPromotionCharacter: {
    findFirst: vi.fn(async () => ({
      id: 'character-1',
      name: '林晚',
      customVoiceUrl: 'voice/reference.wav',
      voicePrompt: '旧声音文案',
    })),
    update: vi.fn(async () => ({ id: 'character-1' })),
  },
}))

const storageMock = vi.hoisted(() => ({
  extractStorageKey: vi.fn((value: string) => value),
  generateUniqueKey: vi.fn(() => 'voice/panel-dubbing/project-1/panel-1/dubbing.wav'),
  getObjectBuffer: vi.fn(async () => Buffer.from('reference-audio')),
  getSignedUrl: vi.fn((key: string) => `signed://${key}`),
  toFetchableUrl: vi.fn((value: string) => value),
  uploadObject: vi.fn(async () => 'voice/panel-dubbing/project-1/panel-1/dubbing.wav'),
}))

const mediaServiceMock = vi.hoisted(() => ({
  ensureMediaObjectFromStorageKey: vi.fn(async () => ({ id: 'media-1' })),
}))

const apiConfigMock = vi.hoisted(() => ({
  getProviderConfig: vi.fn(async () => ({ baseUrl: 'http://localhost:5566', apiKey: '' })),
  getProviderKey: vi.fn(() => 'local'),
  resolveModelSelectionOrSingle: vi.fn(async () => ({ provider: 'local' })),
}))

const localVoxMock = vi.hoisted(() => ({
  cloneWithLocalVoxCPM: vi.fn(async () => ({
    success: true,
    audioData: Buffer.from('generated-audio'),
    audioDuration: 1200,
  })),
}))

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/storage', () => storageMock)
vi.mock('@/lib/media/service', () => mediaServiceMock)
vi.mock('@/lib/api-config', () => apiConfigMock)
vi.mock('@/lib/providers/local-voxcpm/voice', () => localVoxMock)

describe('api specific - panel dubbing voice prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('syncs the submitted voice prompt to the selected character after character dubbing succeeds', async () => {
    const mod = await import('@/app/api/novel-promotion/[projectId]/panel-dubbing/clone/route')
    const req = buildMockRequest({
      path: '/api/novel-promotion/project-1/panel-dubbing/clone',
      method: 'POST',
      body: {
        panelId: 'panel-1',
        mode: 'character-voice',
        text: '好的，我马上去。',
        promptText: '年轻女声，声音清亮，略带紧张',
        characterId: 'character-1',
        syncPromptToCharacter: true,
      },
    })

    const res = await mod.POST(req, { params: Promise.resolve({ projectId: 'project-1' }) })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.meta.promptText).toBe('年轻女声，声音清亮，略带紧张')
    expect(localVoxMock.cloneWithLocalVoxCPM).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '好的，我马上去。',
        promptText: '年轻女声，声音清亮，略带紧张',
      }),
      'http://localhost:5566',
      '',
    )
    expect(prismaMock.novelPromotionCharacter.update).toHaveBeenCalledWith({
      where: { id: 'character-1' },
      data: { voicePrompt: '年轻女声，声音清亮，略带紧张' },
    })
  })
})
