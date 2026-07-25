import { beforeEach, describe, expect, it, vi } from 'vitest'

const validationMock = vi.hoisted(() => ({
  validateStoryboardArtifact: vi.fn(),
}))

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  agentCreationRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  agentCreationRun: {
    findUnique: vi.fn(),
  },
  $transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/agent-api/storyboard-validation', () => validationMock)

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import type { StoryboardsCommitRequest } from '@/lib/agent-api/contracts/storyboards'
import {
  serializeArtifactHashes,
  serializeAssetMap,
  serializeClipMap,
  serializeEpisodeMap,
  serializeStoryboardMap,
} from '@/lib/agent-api/run-state'
import { commitStoryboardArtifact } from '@/lib/agent-api/services/storyboard-service'

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`
const RULE_HASH = `sha256:${'b'.repeat(64)}`
const EMPTY_SCREENPLAY_HASH = hashArtifact({
  episodeKey: 'episode-001',
  clips: [],
})

function request(): StoryboardsCommitRequest {
  const data = {
    episodeKey: 'episode-001',
    storyboards: [],
  }
  return {
    schemaVersion: 1,
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: RULE_HASH,
    artifactHash: hashArtifact(data),
    dryRun: false,
    data,
  }
}

function snapshots() {
  return {
    episodeMapJson: serializeEpisodeMap({
      'episode-001': {
        episodeKey: 'episode-001',
        episodeId: 'episode-db-1',
        episodeNumber: 1,
        ordinal: 1,
        sourceHash: SOURCE_HASH,
        name: '第一集',
        status: 'screenplay_committed',
      },
    }),
    assetMapJson: serializeAssetMap({
      characters: {},
      locations: {},
      props: {},
    }),
    clipMapJson: serializeClipMap({}),
  }
}

function preflightRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    userId: 'user-1',
    projectId: 'project-1',
    project: { userId: 'user-1' },
    ...snapshots(),
    ...overrides,
  }
}

function lockedRun(overrides: Record<string, unknown> = {}) {
  return {
    ...preflightRun(),
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: RULE_HASH,
    definitionHash: hashArtifact([{
      episodeKey: 'episode-001',
      ordinal: 1,
      sourceHash: SOURCE_HASH,
      name: '第一集',
    }]),
    status: 'screenplay_committed',
    currentStage: 'screenplay_committed',
    storyboardMapJson: serializeStoryboardMap({
      storyboards: {},
      panels: {},
      frames: {},
    }),
    artifactHashesJson: serializeArtifactHashes({
      assets: `sha256:${'c'.repeat(64)}`,
      stories: { 'episode-001': `sha256:${'d'.repeat(64)}` },
      screenplays: { 'episode-001': EMPTY_SCREENPLAY_HASH },
      storyboards: {},
    }),
    createdAt: new Date(0),
    ...overrides,
  }
}

describe('commitStoryboardArtifact preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(preflightRun())
    validationMock.validateStoryboardArtifact.mockReturnValue(undefined)
    txMock.$queryRaw.mockResolvedValue([{ id: 'run-1' }])
    txMock.agentCreationRun.findUnique.mockResolvedValue(lockedRun())
    txMock.agentCreationRun.update.mockResolvedValue({})
    prismaMock.$transaction.mockResolvedValue({
      dryRun: false,
      episodeKey: 'episode-001',
      artifactHash: request().artifactHash,
      storyboards: [],
    })
  })

  it('runs the O(size) pure validator before opening the interactive transaction', async () => {
    await commitStoryboardArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })

    expect(validationMock.validateStoryboardArtifact).toHaveBeenCalledTimes(1)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(
      validationMock.validateStoryboardArtifact.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      prismaMock.$transaction.mock.invocationCallOrder[0],
    )
  })

  it('rejects a changed preflight snapshot inside the run lock with zero writes', async () => {
    const changedAssets = serializeAssetMap({
      characters: {},
      locations: {
        'location.changed': {
          assetKey: 'location.changed',
          entityId: 'location-db-1',
          reused: true,
          imageSlots: {
            0: { entityId: 'location-image-db-1', index: 0 },
          },
        },
      },
      props: {},
    })
    txMock.agentCreationRun.findUnique.mockResolvedValue(lockedRun({
      assetMapJson: changedAssets,
    }))
    prismaMock.$transaction.mockImplementation(
      async (
        callback: (tx: typeof txMock) => Promise<unknown>,
      ) => callback(txMock),
    )

    await expect(commitStoryboardArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({
      code: 'RUN_DEFINITION_CONFLICT',
      retryable: true,
      field: 'preflightSnapshot',
    })
    expect(validationMock.validateStoryboardArtifact).toHaveBeenCalledTimes(1)
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it.each([
    ['missing run', null, 'AGENT_RESOURCE_NOT_FOUND'],
    ['foreign run user', preflightRun({
      userId: 'user-2',
      project: { userId: 'user-2' },
    }), 'AGENT_FORBIDDEN'],
    ['foreign project owner', preflightRun({
      project: { userId: 'user-2' },
    }), 'AGENT_FORBIDDEN'],
  ])('rejects %s during preflight before opening a transaction', async (
    _label,
    run,
    code,
  ) => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValue(run)
    await expect(commitStoryboardArtifact({
      userId: 'user-1',
      runId: 'run-1',
      episodeKey: 'episode-001',
      request: request(),
    })).rejects.toMatchObject({ code })
    expect(validationMock.validateStoryboardArtifact).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
