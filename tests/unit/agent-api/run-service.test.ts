import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  project: {
    findUnique: vi.fn(),
  },
  novelPromotionProject: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  novelPromotionEpisode: {
    aggregate: vi.fn(),
    create: vi.fn(),
  },
  agentCreationRun: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  project: {
    findUnique: vi.fn(),
  },
  agentCreationRun: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}))

const loadCreatorRuleBundleMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/agent-api/rules/load-rule-bundle', () => ({
  loadCreatorRuleBundle: loadCreatorRuleBundleMock,
}))

import {
  buildRunFingerprint,
  hashArtifact,
} from '@/lib/agent-api/canonical-json'
import type { RunStatus } from '@/lib/agent-api/contracts/common'
import type { CreateRunRequest } from '@/lib/agent-api/contracts/run'
import {
  assertRunAcceptsArtifact,
  parseAssetMap,
  parseArtifactHashes,
  parseClipMap,
  parseEffectiveOptions,
  parseEpisodeMap,
  parseStoryboardMap,
  parseUploadReceipts,
  serializeAssetMap,
  serializeArtifactHashes,
  serializeClipMap,
  serializeEffectiveOptions,
  serializeEpisodeMap,
  serializeStoryboardMap,
  serializeUploadReceipts,
  transitionRunStatus,
} from '@/lib/agent-api/run-state'
import {
  createOrResumeRun,
  getCreatorRun,
} from '@/lib/agent-api/services/run-service'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const HASH_C = `sha256:${'c'.repeat(64)}`
const HASH_D = `sha256:${'d'.repeat(64)}`

function request(overrides: Partial<CreateRunRequest> = {}): CreateRunRequest {
  const episodes = [{
    episodeKey: 'episode-001',
    ordinal: 1,
    sourceHash: HASH_A,
    name: '第一集',
    description: '开场',
  }]
  const base = {
    schemaVersion: 1 as const,
    sourceHash: HASH_A,
    inputKindHint: 'story' as const,
    locale: 'zh' as const,
    effectiveOptions: {
      artStyle: 'realistic',
      videoRatio: '16:9',
      episodeSplitHint: 'auto',
    },
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: HASH_B,
    definitionHash: hashArtifact(episodes),
    episodes,
  }

  return {
    ...base,
    runFingerprint: buildRunFingerprint({
      projectId: 'project-1',
      sourceHash: base.sourceHash,
      inputKindHint: base.inputKindHint,
      locale: base.locale,
      effectiveOptions: base.effectiveOptions,
      ruleSetHash: base.ruleSetHash,
    }),
    ...overrides,
  }
}

function episodeMapJson(status: RunStatus = 'created') {
  return serializeEpisodeMap({
    'episode-001': {
      episodeKey: 'episode-001',
      episodeId: 'episode-db-1',
      episodeNumber: 7,
      ordinal: 1,
      sourceHash: HASH_A,
      name: '第一集',
      description: '开场',
      status,
    },
  })
}

function storedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    projectId: 'project-1',
    sourceHash: HASH_A,
    runFingerprint: request().runFingerprint,
    inputKindHint: 'story',
    locale: 'zh',
    effectiveOptionsJson: JSON.stringify(request().effectiveOptions),
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: HASH_B,
    definitionHash: request().definitionHash,
    status: 'created',
    currentStage: 'created',
    episodeMapJson: episodeMapJson(),
    assetMapJson: null,
    clipMapJson: null,
    storyboardMapJson: null,
    artifactHashesJson: null,
    receiptJson: null,
    project: { userId: 'user-1' },
    ...overrides,
  }
}

function projectOwner() {
  return {
    id: 'project-1',
    userId: 'user-1',
    novelPromotionData: { id: 'novel-project-1' },
  }
}

describe('typed Agent run state', () => {
  it('strictly round-trips episode maps and rejects a mismatched record key', () => {
    const json = episodeMapJson()
    expect(parseEpisodeMap(json)).toEqual({
      'episode-001': expect.objectContaining({
        episodeId: 'episode-db-1',
        ordinal: 1,
        status: 'created',
      }),
    })
    expect(() => serializeEpisodeMap({
      'episode-002': {
        ...parseEpisodeMap(json)['episode-001'],
        episodeKey: 'episode-001',
      },
    })).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
  })

  it.each([
    ['invalid JSON', '{'],
    ['unknown episode field', JSON.stringify({
      'episode-001': {
        ...parseEpisodeMap(episodeMapJson())['episode-001'],
        unexpected: true,
      },
    })],
  ])('turns %s into AGENT_INTERNAL_ERROR', (_label, json) => {
    expect(() => parseEpisodeMap(json)).toThrowError(
      expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }),
    )
  })

  it('rejects a purely blank persisted episode description', () => {
    expect(() => parseEpisodeMap(JSON.stringify({
      'episode-001': {
        ...parseEpisodeMap(episodeMapJson())['episode-001'],
        description: '   ',
      },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => parseEpisodeMap(JSON.stringify({
      'episode-001': {
        ...parseEpisodeMap(episodeMapJson())['episode-001'],
        description: 'x'.repeat(2_001),
      },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
  })

  it('round-trips strict artifact hashes and upload receipts', () => {
    const hashes = {
      assets: HASH_A,
      stories: { 'episode-001': HASH_B },
      screenplays: {},
      storyboards: { 'episode-001': HASH_C },
    }
    const completedReceipt = {
      targetType: 'panel-frame' as const,
      targetKey: 'frame-001',
      variantIndex: 0,
      contentSha256: HASH_D,
      mediaId: 'media-1',
      storageKey: 'agent/run-1/frame.png',
      url: '/api/media/media-1',
    }
    const receipts = [
      completedReceipt,
      {
        targetType: 'location-image' as const,
        targetKey: 'location-001',
        variantIndex: 0,
        contentSha256: HASH_C,
        status: 'pending' as const,
        storageKey: 'agent/run-1/location.png',
      },
    ]
    expect(parseArtifactHashes(serializeArtifactHashes(hashes))).toEqual(hashes)
    expect(parseUploadReceipts(serializeUploadReceipts(receipts))).toEqual(receipts)
    expect(() => parseUploadReceipts(JSON.stringify([{
      ...completedReceipt,
      provider: 'must-not-be-persisted',
    }]))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => parseUploadReceipts(JSON.stringify([
      completedReceipt,
      completedReceipt,
    ]))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
  })

  it('strictly round-trips asset, clip, and storyboard association maps', () => {
    const assets = {
      characters: {
        'character-001': {
          characterKey: 'character-001',
          characterId: 'character-db-1',
          reused: false,
          appearances: {
            'appearance-001': {
              appearanceKey: 'appearance-001',
              appearanceId: 'appearance-db-1',
              appearanceIndex: 4,
              reused: true,
              variantSlots: {
                '0': { entityId: 'appearance-db-1', index: 3 },
              },
            },
          },
        },
      },
      locations: {
        'location-001': {
          assetKey: 'location-001',
          entityId: 'location-db-1',
          reused: true,
          imageSlots: {
            '0': { entityId: 'location-image-db-1', index: 2 },
          },
        },
      },
      props: {},
    }
    const clips = {
      'clip-001': {
        clipKey: 'clip-001',
        clipId: 'clip-db-1',
        episodeKey: 'episode-001',
        ordinal: 1,
      },
    }
    const storyboards = {
      storyboards: {
        'storyboard-001': {
          storyboardKey: 'storyboard-001',
          storyboardId: 'storyboard-db-1',
          episodeKey: 'episode-001',
          clipKey: 'clip-001',
        },
      },
      panels: {
        'panel-001': {
          panelKey: 'panel-001',
          panelId: 'panel-db-1',
          storyboardKey: 'storyboard-001',
          panelIndex: 0,
        },
      },
      frames: {
        'frame-001': {
          frameKey: 'frame-001',
          frameId: 'frame-db-1',
          panelKey: 'panel-001',
          frameIndex: 0,
        },
      },
    }
    expect(parseAssetMap(serializeAssetMap(assets))).toEqual(assets)
    expect(parseClipMap(serializeClipMap(clips))).toEqual(clips)
    expect(parseStoryboardMap(serializeStoryboardMap(storyboards)))
      .toEqual(storyboards)

    expect(() => parseAssetMap(JSON.stringify({
      ...assets,
      characters: {
        wrong: assets.characters['character-001'],
      },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => parseClipMap(JSON.stringify({
      ...clips,
      'clip-001': { ...clips['clip-001'], unknown: true },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => parseStoryboardMap(JSON.stringify({
      ...storyboards,
      frames: {
        wrong: storyboards.frames['frame-001'],
      },
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
  })

  it('strictly round-trips effective options and rejects corrupt persisted options', () => {
    const options = request().effectiveOptions
    expect(parseEffectiveOptions(serializeEffectiveOptions(options)))
      .toEqual(options)
    expect(() => parseEffectiveOptions(JSON.stringify({
      ...options,
      provider: 'forbidden',
    }))).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
  })

  it('only advances normally, requires recovery-stage evidence, and seals completed runs', () => {
    expect(transitionRunStatus('created', 'created', 'story_committed'))
      .toBe('story_committed')
    expect(transitionRunStatus('failed', 'assets_committed', 'assets_committed'))
      .toBe('assets_committed')
    expect(transitionRunStatus(
      'incomplete',
      'storyboards_committed',
      'storyboards_committed',
    ))
      .toBe('storyboards_committed')
    expect(() => transitionRunStatus(
      'failed',
      'story_committed',
      'assets_committed',
    )).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => transitionRunStatus(
      'assets_committed',
      'assets_committed',
      'story_committed',
    ))
      .toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => transitionRunStatus(
      'created',
      'created',
      'assets_committed',
    )).toThrowError(expect.objectContaining({ code: 'AGENT_INTERNAL_ERROR' }))
    expect(() => assertRunAcceptsArtifact('completed'))
      .toThrowError(expect.objectContaining({ code: 'RUN_INCOMPLETE' }))
  })
})

describe('createOrResumeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.project.findUnique.mockResolvedValue(projectOwner())
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(null)
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'novel-project-1' }])
    txMock.project.findUnique.mockResolvedValue(projectOwner())
    txMock.novelPromotionProject.findUnique.mockResolvedValue({
      id: 'novel-project-1',
      projectId: 'project-1',
    })
    txMock.agentCreationRun.findUnique.mockResolvedValue(null)
    txMock.novelPromotionEpisode.aggregate.mockResolvedValue({
      _max: { episodeNumber: 6 },
    })
    txMock.novelPromotionEpisode.create.mockResolvedValue({
      id: 'episode-db-1',
      episodeNumber: 7,
      name: '第一集',
    })
    txMock.agentCreationRun.create.mockImplementation(async ({ data }) => ({
      ...storedRun(),
      ...data,
      id: 'run-created',
    }))
    txMock.novelPromotionProject.update.mockResolvedValue({})
    loadCreatorRuleBundleMock.mockResolvedValue({
      ruleSetVersion: 'waoo-creator-v1',
      contentHash: HASH_B,
    })
  })

  it.each([
    ['definitionHash', HASH_C],
    ['runFingerprint', HASH_D],
  ] as const)('rejects a client %s that differs from the server recomputation', async (field, value) => {
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request({ [field]: value }),
    })).rejects.toMatchObject({
      code: 'ARTIFACT_HASH_MISMATCH',
      field,
    })
    expect(loadCreatorRuleBundleMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('validates service-layer project and novel-project ownership', async () => {
    prismaMock.project.findUnique.mockResolvedValue({
      ...projectOwner(),
      userId: 'other-user',
    })
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'AGENT_FORBIDDEN' })

    prismaMock.project.findUnique.mockResolvedValue({
      ...projectOwner(),
      novelPromotionData: null,
    })
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
  })

  it('restores before loading current rules and validates the fixed run definition/rules', async () => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun())

    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).resolves.toMatchObject({
      runId: 'run-1',
      resumed: true,
      episodes: [{
        episodeKey: 'episode-001',
        episodeId: 'episode-db-1',
        episodeNumber: 7,
      }],
    })
    expect(loadCreatorRuleBundleMock).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()

    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      definitionHash: HASH_C,
    }))
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'RUN_DEFINITION_CONFLICT' })

    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      ruleSetHash: HASH_C,
    }))
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'RULESET_MISMATCH' })
  })

  it('locks, rechecks ownership/fingerprint/rules, then appends and stores the typed map', async () => {
    const result = await createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })

    expect(result).toMatchObject({
      runId: 'run-created',
      resumed: false,
      status: 'created',
      episodes: [{
        episodeKey: 'episode-001',
        episodeId: 'episode-db-1',
        episodeNumber: 7,
        name: '第一集',
      }],
    })
    expect(loadCreatorRuleBundleMock).toHaveBeenCalledTimes(2)
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    const lockQuery = txMock.$queryRaw.mock.calls[0]?.[0] as {
      sql?: string
      values?: unknown[]
    }
    expect(lockQuery.sql?.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM novel_promotion_projects WHERE projectId = ? FOR UPDATE',
    )
    expect(lockQuery.values).toEqual(['project-1'])
    expect(txMock.novelPromotionEpisode.aggregate).toHaveBeenCalledWith({
      where: { novelPromotionProjectId: 'novel-project-1' },
      _max: { episodeNumber: true },
    })
    expect(txMock.novelPromotionEpisode.create).toHaveBeenCalledWith({
      data: {
        novelPromotionProjectId: 'novel-project-1',
        episodeNumber: 7,
        name: '第一集',
        description: '开场',
        novelText: null,
      },
      select: {
        id: true,
        episodeNumber: true,
        name: true,
      },
    })
    const createData = txMock.agentCreationRun.create.mock.calls[0]?.[0].data
    expect(parseEpisodeMap(createData.episodeMapJson)).toEqual({
      'episode-001': expect.objectContaining({
        episodeId: 'episode-db-1',
        episodeNumber: 7,
        ordinal: 1,
        sourceHash: HASH_A,
        status: 'created',
      }),
    })
    expect(txMock.novelPromotionProject.update).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      data: { lastEpisodeId: 'episode-db-1' },
    })
  })

  it('uses the post-lock existing run without allocating again', async () => {
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun())
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).resolves.toMatchObject({ runId: 'run-1', resumed: true })
    expect(loadCreatorRuleBundleMock).toHaveBeenCalledTimes(1)
    expect(txMock.novelPromotionEpisode.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.create).not.toHaveBeenCalled()
  })

  it('rejects a creator rule change observed after acquiring the lock', async () => {
    loadCreatorRuleBundleMock
      .mockResolvedValueOnce({
        ruleSetVersion: 'waoo-creator-v1',
        contentHash: HASH_B,
      })
      .mockResolvedValueOnce({
        ruleSetVersion: 'waoo-creator-v1',
        contentHash: HASH_C,
      })

    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'RULESET_MISMATCH' })
    expect(txMock.novelPromotionEpisode.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.create).not.toHaveBeenCalled()
  })

  it('retries only one target Episode P2002 and makes the second conflict retryable', async () => {
    const targetConflict = {
      code: 'P2002',
      meta: {
        modelName: 'NovelPromotionEpisode',
        target:
          'novel_promotion_episodes_novelPromotionProjectId_episodeNumber_key',
      },
    }
    prismaMock.$transaction
      .mockRejectedValueOnce(targetConflict)
      .mockRejectedValueOnce(targetConflict)

    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({
      code: 'EPISODE_NUMBER_CONFLICT',
      retryable: true,
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)

    prismaMock.$transaction.mockReset()
    prismaMock.$transaction.mockRejectedValue({
      code: 'P2002',
      meta: {
        modelName: 'AgentCreationRun',
        target: ['userId', 'projectId', 'runFingerprint'],
      },
    })
    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'P2002' })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('retries a MySQL-truncated Episode number unique target', async () => {
    const targetConflict = {
      code: 'P2002',
      meta: {
        modelName: 'NovelPromotionEpisode',
        target:
          'novel_promotion_episodes_novelPromotionProjectId_episodeNumb_key',
      },
    }
    prismaMock.$transaction
      .mockRejectedValueOnce(targetConflict)
      .mockRejectedValueOnce(targetConflict)

    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).rejects.toMatchObject({
      code: 'EPISODE_NUMBER_CONFLICT',
      retryable: true,
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('retries once after a target Episode P2002 and can then succeed', async () => {
    const targetConflict = {
      code: 'P2002',
      meta: {
        modelName: 'NovelPromotionEpisode',
        target: [
          'novelPromotionProjectId',
          'episodeNumber',
        ],
      },
    }
    prismaMock.$transaction
      .mockRejectedValueOnce(targetConflict)
      .mockImplementationOnce(
        async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
      )

    await expect(createOrResumeRun({
      userId: 'user-1',
      projectId: 'project-1',
      request: request(),
    })).resolves.toMatchObject({
      runId: 'run-created',
      resumed: false,
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })
})

describe('getCreatorRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun())
  })

  it('returns a strict user-owned projection and rejects corrupted JSON', async () => {
    await expect(getCreatorRun({
      userId: 'user-1',
      runId: 'run-1',
    })).resolves.toEqual({
      runId: 'run-1',
      projectId: 'project-1',
      status: 'created',
      currentStage: 'created',
      sourceHash: HASH_A,
      runFingerprint: request().runFingerprint,
      ruleSetVersion: 'waoo-creator-v1',
      ruleSetHash: HASH_B,
      episodes: [{
        episodeKey: 'episode-001',
        episodeId: 'episode-db-1',
        episodeNumber: 7,
        status: 'created',
      }],
    })

    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      episodeMapJson: '{corrupt',
    }))
    await expect(getCreatorRun({
      userId: 'user-1',
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })

    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      effectiveOptionsJson: JSON.stringify({
        ...request().effectiveOptions,
        unknown: true,
      }),
    }))
    await expect(getCreatorRun({
      userId: 'user-1',
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })

    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      locale: 'en',
    }))
    await expect(getCreatorRun({
      userId: 'user-1',
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })

    prismaMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      currentStage: '   ',
    }))
    await expect(getCreatorRun({
      userId: 'user-1',
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })
  })

  it('forbids a different user without mutating the run', async () => {
    await expect(getCreatorRun({
      userId: 'other-user',
      runId: 'run-1',
    })).rejects.toMatchObject({ code: 'AGENT_FORBIDDEN' })
  })
})

describe('run route output validation', () => {
  const originalEnv = {
    WAOO_AGENT_API_ENABLED: process.env.WAOO_AGENT_API_ENABLED,
    WAOO_AGENT_TOKEN: process.env.WAOO_AGENT_TOKEN,
    WAOO_AGENT_USER_ID: process.env.WAOO_AGENT_USER_ID,
  }

  afterAll(() => {
    vi.doUnmock('@/lib/agent-api/auth')
    vi.doUnmock('@/lib/agent-api/services/run-service')
    vi.resetModules()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('turns invalid or extra service response fields into unified 500 envelopes', async () => {
    vi.resetModules()
    vi.doMock('@/lib/agent-api/auth', () => ({
      requireAgentProject: vi.fn().mockResolvedValue({
        userId: 'user-1',
        projectId: 'project-1',
      }),
      requireAgentRun: vi.fn().mockResolvedValue({
        userId: 'user-1',
        projectId: 'project-1',
        runId: 'run-1',
      }),
    }))
    vi.doMock('@/lib/agent-api/services/run-service', () => ({
      createOrResumeRun: vi.fn().mockResolvedValue({
        runId: 'run-1',
        resumed: false,
        status: 'created',
        projectId: 'project-1',
        sourceHash: HASH_A,
        runFingerprint: request().runFingerprint,
        episodes: [],
        leakedProvider: 'must-not-leak',
      }),
      getCreatorRun: vi.fn().mockResolvedValue({
        runId: 'run-1',
        projectId: 'project-1',
        status: 'created',
        currentStage: 'created',
        sourceHash: HASH_A,
        runFingerprint: request().runFingerprint,
        ruleSetVersion: 'waoo-creator-v1',
        ruleSetHash: HASH_B,
        episodes: [],
        leakedToken: 'must-not-leak',
      }),
    }))
    const [{ POST }, { GET }] = await Promise.all([
      import('@/app/api/agent/v1/projects/[projectId]/runs/route'),
      import('@/app/api/agent/v1/runs/[runId]/route'),
    ])

    const post = await POST(new Request(
      'http://localhost/api/agent/v1/projects/project-1/runs',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': request().runFingerprint,
          'X-Request-Id': 'req-invalid-create-output',
        },
        body: JSON.stringify(request()),
      },
    ), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })
    const get = await GET(new Request(
      'http://localhost/api/agent/v1/runs/run-1',
      {
        headers: {
          'X-Request-Id': 'req-invalid-get-output',
        },
      },
    ), {
      params: Promise.resolve({ runId: 'run-1' }),
    })

    expect(post.status).toBe(500)
    expect(await post.json()).toMatchObject({
      success: false,
      requestId: 'req-invalid-create-output',
      error: { code: 'AGENT_INTERNAL_ERROR' },
    })
    expect(get.status).toBe(500)
    expect(await get.json()).toMatchObject({
      success: false,
      requestId: 'req-invalid-get-output',
      error: { code: 'AGENT_INTERNAL_ERROR' },
    })
  })
})
