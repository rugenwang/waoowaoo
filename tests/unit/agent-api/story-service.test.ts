import { beforeEach, describe, expect, it, vi } from 'vitest'

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  agentCreationRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  novelPromotionEpisode: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import type { StoryCommitRequest } from '@/lib/agent-api/contracts/story'
import {
  parseArtifactHashes,
  parseEpisodeMap,
  serializeArtifactHashes,
  serializeEpisodeMap,
} from '@/lib/agent-api/run-state'
import { commitStoryArtifact } from '@/lib/agent-api/services/story-service'

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`
const RULE_SET_HASH = `sha256:${'b'.repeat(64)}`
const OTHER_HASH = `sha256:${'c'.repeat(64)}`

function request(overrides: {
  envelope?: Partial<Omit<StoryCommitRequest, 'data'>>
  data?: Partial<StoryCommitRequest['data']>
} = {}): StoryCommitRequest {
  const data = {
    episodeKey: 'episode-001',
    sourceHash: SOURCE_HASH,
    inputKind: 'story' as const,
    name: '第一集',
    description: '新的简介',
    novelText: '新的正文',
    ...overrides.data,
  }
  return {
    schemaVersion: 1,
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: RULE_SET_HASH,
    artifactHash: hashArtifact(data),
    dryRun: false,
    data,
    ...overrides.envelope,
  }
}

function storedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    projectId: 'project-1',
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: RULE_SET_HASH,
    definitionHash: hashArtifact([{
      episodeKey: 'episode-001',
      ordinal: 1,
      sourceHash: SOURCE_HASH,
      name: '第一集',
      description: '旧简介',
    }]),
    status: 'created',
    currentStage: 'created',
    episodeMapJson: serializeEpisodeMap({
      'episode-001': {
        episodeKey: 'episode-001',
        episodeId: 'episode-db-1',
        episodeNumber: 7,
        ordinal: 1,
        sourceHash: SOURCE_HASH,
        name: '第一集',
        description: '旧简介',
        status: 'created',
      },
    }),
    artifactHashesJson: serializeArtifactHashes({
      stories: {},
      screenplays: {},
      storyboards: {},
    }),
    project: { userId: 'user-1' },
    ...overrides,
  }
}

describe('commitStoryArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'run-1' }])
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun())
    txMock.agentCreationRun.update.mockResolvedValue({})
    txMock.novelPromotionEpisode.findUnique.mockResolvedValue({
      id: 'episode-db-1',
      episodeNumber: 7,
      name: '第一集',
      novelPromotionProject: {
        projectId: 'project-1',
      },
    })
    txMock.novelPromotionEpisode.update.mockResolvedValue({})
  })

  it('locks the run and commits only the mapped episode story fields', async () => {
    const result = await commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })

    expect(result).toEqual({
      dryRun: false,
      episodeKey: 'episode-001',
      episodeId: 'episode-db-1',
      episodeNumber: 7,
      artifactHash: request().artifactHash,
    })
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(txMock.novelPromotionEpisode.update).toHaveBeenCalledWith({
      where: { id: 'episode-db-1' },
      data: {
        description: '新的简介',
        novelText: '新的正文',
      },
    })
    const lockQuery = txMock.$queryRaw.mock.calls[0]?.[0] as {
      sql?: string
      values?: unknown[]
    }
    expect(lockQuery.sql?.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id FROM agent_creation_runs WHERE id = ? FOR UPDATE',
    )
    expect(lockQuery.values).toEqual(['run-1'])
  })

  it.each([
    ['ruleSetVersion', request({
      envelope: { ruleSetVersion: 'other-rules' },
    }), 'RULESET_MISMATCH'],
    ['ruleSetHash', request({
      envelope: { ruleSetHash: OTHER_HASH },
    }), 'RULESET_MISMATCH'],
    ['artifactHash', request({
      envelope: { artifactHash: OTHER_HASH },
    }), 'ARTIFACT_HASH_MISMATCH'],
    ['path episodeKey', request(), 'REFERENCE_INVALID', 'episode-002'],
    ['data episodeKey', request({
      data: { episodeKey: 'episode-002' },
    }), 'REFERENCE_INVALID'],
    ['sourceHash', request({
      data: { sourceHash: OTHER_HASH },
    }), 'REFERENCE_INVALID'],
    ['name', request({
      data: { name: '篡改集名' },
    }), 'REFERENCE_INVALID'],
  ])('rejects mismatched %s before writes', async (
    _label,
    commitRequest,
    code,
    episodeKey = 'episode-001',
  ) => {
    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey,
      request: commitRequest,
    })).rejects.toMatchObject({ code })
    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('performs every dry-run validation and writes nothing', async () => {
    const dryRunRequest = request({ envelope: { dryRun: true } })
    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: dryRunRequest,
    })).resolves.toEqual(expect.objectContaining({
      dryRun: true,
      artifactHash: dryRunRequest.artifactHash,
    }))

    expect(txMock.novelPromotionEpisode.findUnique).toHaveBeenCalledTimes(1)
    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('returns the same receipt without writes for a repeated artifact hash', async () => {
    const commitRequest = request()
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      episodeMapJson: serializeEpisodeMap({
        'episode-001': {
          ...parseEpisodeMap(storedRun().episodeMapJson)['episode-001'],
          status: 'story_committed',
        },
      }),
      artifactHashesJson: serializeArtifactHashes({
        stories: { 'episode-001': commitRequest.artifactHash },
        screenplays: {},
        storyboards: {},
      }),
      status: 'story_committed',
      currentStage: 'story_committed',
    }))

    const first = await commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: commitRequest,
    })
    const second = await commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: commitRequest,
    })

    expect(second).toEqual(first)
    expect(txMock.novelPromotionEpisode.findUnique).toHaveBeenCalledTimes(2)
    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('rejects replacing a committed story with a different artifact hash', async () => {
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      artifactHashesJson: serializeArtifactHashes({
        stories: { 'episode-001': OTHER_HASH },
        screenplays: {},
        storyboards: {},
      }),
    }))

    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({ code: 'RUN_DEFINITION_CONFLICT' })
    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
  })

  it('records partial progress without claiming story completion', async () => {
    const secondEpisode = {
      episodeKey: 'episode-002',
      episodeId: 'episode-db-2',
      episodeNumber: 8,
      ordinal: 2,
      sourceHash: OTHER_HASH,
      name: '第二集',
      status: 'created' as const,
    }
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      episodeMapJson: serializeEpisodeMap({
        ...parseEpisodeMap(storedRun().episodeMapJson),
        'episode-002': secondEpisode,
      }),
      definitionHash: hashArtifact([{
        episodeKey: 'episode-001',
        ordinal: 1,
        sourceHash: SOURCE_HASH,
        name: '第一集',
        description: '旧简介',
      }, {
        episodeKey: 'episode-002',
        ordinal: 2,
        sourceHash: OTHER_HASH,
        name: '第二集',
      }]),
    }))

    await commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })

    const update = txMock.agentCreationRun.update.mock.calls[0]?.[0]
    expect(update.data).toMatchObject({
      status: 'created',
      currentStage: 'story_committing:1/2',
    })
    expect(parseEpisodeMap(update.data.episodeMapJson)).toMatchObject({
      'episode-001': { status: 'story_committed' },
      'episode-002': { status: 'created' },
    })
    expect(parseArtifactHashes(update.data.artifactHashesJson).stories)
      .toEqual({ 'episode-001': request().artifactHash })
  })

  it('advances the run only after every story is committed', async () => {
    await commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })
    expect(txMock.agentCreationRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'story_committed',
        currentStage: 'story_committed',
      }),
    })
  })

  it('rejects completed runs and malformed persisted JSON without writes', async () => {
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      status: 'completed',
    }))
    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({ code: 'RUN_INCOMPLETE' })

    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      episodeMapJson: '{broken',
    }))
    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })

    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      artifactHashesJson: '{broken',
    }))
    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })

    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('rejects an externally inconsistent episode mapping', async () => {
    txMock.novelPromotionEpisode.findUnique.mockResolvedValue({
      id: 'episode-db-1',
      episodeNumber: 7,
      name: '第一集',
      novelPromotionProject: { projectId: 'other-project' },
    })

    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({ code: 'REFERENCE_INVALID' })
    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
  })

  it('does not trust a schema-valid episode map that conflicts with the fixed definition hash', async () => {
    const tamperedSourceHash = `sha256:${'d'.repeat(64)}`
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      episodeMapJson: serializeEpisodeMap({
        'episode-001': {
          ...parseEpisodeMap(storedRun().episodeMapJson)['episode-001'],
          sourceHash: tamperedSourceHash,
        },
      }),
    }))
    const tamperedRequest = request({
      data: { sourceHash: tamperedSourceHash },
    })

    await expect(commitStoryArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: tamperedRequest,
    })).rejects.toMatchObject({ code: 'AGENT_INTERNAL_ERROR' })
    expect(txMock.novelPromotionEpisode.update).not.toHaveBeenCalled()
  })
})
