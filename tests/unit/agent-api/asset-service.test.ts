import { beforeEach, describe, expect, it, vi } from 'vitest'

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  agentCreationRun: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  novelPromotionProject: {
    findUnique: vi.fn(),
  },
  novelPromotionCharacter: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  characterAppearance: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  novelPromotionLocation: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
  locationImage: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import type { AssetsCommitRequest } from '@/lib/agent-api/contracts/assets'
import { buildProjectedEntityId } from '@/lib/agent-api/entity-id'
import {
  parseAssetMap,
  serializeArtifactHashes,
  serializeAssetMap,
  serializeEpisodeMap,
} from '@/lib/agent-api/run-state'
import { commitAssetsArtifact } from '@/lib/agent-api/services/asset-service'

const RULE_SET_HASH = `sha256:${'b'.repeat(64)}`
const OTHER_HASH = `sha256:${'c'.repeat(64)}`
const DEFINITION_HASH = hashArtifact([{
  episodeKey: 'episode-001',
  ordinal: 1,
  sourceHash: `sha256:${'a'.repeat(64)}`,
  name: '第一集',
}])

function request(overrides: {
  envelope?: Partial<Omit<AssetsCommitRequest, 'data'>>
  data?: Partial<AssetsCommitRequest['data']>
} = {}): AssetsCommitRequest {
  const data = {
    characters: [{
      characterKey: 'character.lin',
      name: '林晓',
      aliases: ['小林'],
      introduction: '记者',
      gender: 'female' as const,
      ageRange: '25-30',
      roleLevel: 'S' as const,
      archetype: '调查者',
      personalityTags: ['坚毅'],
      eraPeriod: '现代',
      socialClass: '中产',
      occupation: '记者',
      costumeTier: 3,
      suggestedColors: ['蓝色'],
      primaryIdentifier: '银色发夹',
      visualKeywords: ['短发'],
      appearances: [{
        appearanceKey: 'appearance.lin.default',
        appearanceOrdinal: 1,
        changeReason: '默认',
        visualDescription: '短发蓝衣',
      }],
    }],
    locations: [{
      locationKey: 'location.newsroom',
      name: '新闻编辑室',
      summary: '夜班工作地点',
      availableSlots: ['窗边'],
      descriptions: ['深夜编辑室全景', '窗边工位'],
    }],
    props: [{
      propKey: 'prop.hairpin',
      name: '银色发夹',
      summary: '关键线索',
      visualDescription: '磨损的银色发夹',
    }],
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
    definitionHash: DEFINITION_HASH,
    status: 'story_committed',
    currentStage: 'story_committed',
    episodeMapJson: serializeEpisodeMap({
      'episode-001': {
        episodeKey: 'episode-001',
        episodeId: 'episode-db-1',
        episodeNumber: 1,
        ordinal: 1,
        sourceHash: `sha256:${'a'.repeat(64)}`,
        name: '第一集',
        status: 'story_committed',
      },
    }),
    assetMapJson: serializeAssetMap({
      characters: {},
      locations: {},
      props: {},
    }),
    artifactHashesJson: serializeArtifactHashes({
      stories: { 'episode-001': `sha256:${'d'.repeat(64)}` },
      screenplays: {},
      storyboards: {},
    }),
    project: { userId: 'user-1' },
    ...overrides,
  }
}

describe('commitAssetsArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$transaction.mockImplementation(
      async (
        callback: (tx: typeof txMock) => Promise<unknown>,
      ) => callback(txMock),
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'locked' }])
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun())
    txMock.agentCreationRun.update.mockResolvedValue({})
    txMock.novelPromotionProject.findUnique.mockResolvedValue({
      id: 'novel-project-1',
      projectId: 'project-1',
    })
    txMock.novelPromotionCharacter.findMany.mockResolvedValue([])
    txMock.novelPromotionCharacter.findUnique.mockResolvedValue(null)
    txMock.novelPromotionCharacter.create.mockResolvedValue({ id: 'character-db-1' })
    txMock.novelPromotionCharacter.update.mockResolvedValue({})
    txMock.characterAppearance.findMany.mockResolvedValue([])
    txMock.characterAppearance.findUnique.mockResolvedValue(null)
    txMock.characterAppearance.create.mockResolvedValue({
      id: 'appearance-db-1',
      appearanceIndex: 0,
      imageUrls: JSON.stringify(['']),
    })
    txMock.characterAppearance.update.mockResolvedValue({})
    txMock.novelPromotionLocation.findMany.mockResolvedValue([])
    txMock.novelPromotionLocation.findUnique.mockResolvedValue(null)
    txMock.novelPromotionLocation.create.mockImplementation(async ({ data }) => ({
      id: data.assetKind === 'location' ? 'location-db-1' : 'prop-db-1',
      name: data.name,
      summary: data.summary,
      assetKind: data.assetKind,
      selectedImageId: null,
    }))
    txMock.locationImage.findMany.mockResolvedValue([])
    txMock.locationImage.findUnique.mockResolvedValue(null)
    txMock.locationImage.create.mockImplementation(async ({ data }) => ({
      id: data.locationId === 'prop-db-1'
        ? 'prop-image-1'
        : `location-image-${data.imageIndex + 1}`,
      imageIndex: data.imageIndex,
    }))
  })

  it('rejects malformed external key, ordinal, and request-wide key duplication before transaction', async () => {
    const malformed = request()
    malformed.data.characters[0].characterKey = 'Bad Key'
    malformed.data.characters[0].appearances[0].appearanceOrdinal = 2
    malformed.data.locations[0].locationKey = malformed.data.props[0].propKey
    malformed.artifactHash = hashArtifact(malformed.data)

    await expect(commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: malformed,
    })).rejects.toMatchObject({ code: 'CONTRACT_INVALID' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('dry-runs with stable projected IDs and writes no database state', async () => {
    const dryRun = request({ envelope: { dryRun: true } })
    const first = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: dryRun,
    })
    const second = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: dryRun,
    })

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      dryRun: true,
      artifactHash: dryRun.artifactHash,
      characters: [{
        characterId: buildProjectedEntityId('run-1', 'Character', 'character.lin'),
        appearances: [{
          appearanceId: buildProjectedEntityId(
            'run-1',
            'Appearance',
            'appearance.lin.default',
          ),
          appearanceIndex: 0,
        }],
      }],
      locations: [{
        locationId: buildProjectedEntityId('run-1', 'Location', 'location.newsroom'),
        imageSlotIds: [
          buildProjectedEntityId('run-1', 'LocationImage', 'location.newsroom:0'),
          buildProjectedEntityId('run-1', 'LocationImage', 'location.newsroom:1'),
        ],
      }],
      props: [{
        propId: buildProjectedEntityId('run-1', 'Prop', 'prop.hairpin'),
        imageSlotIds: [
          buildProjectedEntityId('run-1', 'LocationImage', 'prop.hairpin:0'),
        ],
      }],
    })
    expect(txMock.novelPromotionCharacter.create).not.toHaveBeenCalled()
    expect(txMock.characterAppearance.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionLocation.create).not.toHaveBeenCalled()
    expect(txMock.locationImage.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('uses the exact dry-run projected IDs when the same artifact is committed', async () => {
    txMock.novelPromotionCharacter.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      name: data.name,
      aliases: data.aliases,
      profileData: data.profileData,
      profileConfirmed: data.profileConfirmed,
      introduction: data.introduction,
    }))
    txMock.characterAppearance.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      characterId: data.characterId,
      appearanceIndex: data.appearanceIndex,
      changeReason: data.changeReason,
      description: data.description,
      descriptions: data.descriptions,
      imageUrl: null,
      imageUrls: data.imageUrls,
      selectedIndex: null,
    }))
    txMock.novelPromotionLocation.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      name: data.name,
      summary: data.summary,
      assetKind: data.assetKind,
      selectedImageId: null,
    }))
    txMock.locationImage.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      imageIndex: data.imageIndex,
    }))
    const commitRequest = request()
    const dryRunResult = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: { ...commitRequest, dryRun: true },
    })
    const committed = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: commitRequest,
    })

    expect({
      ...committed,
      dryRun: true,
    }).toEqual(dryRunResult)
    expect(txMock.novelPromotionCharacter.create.mock.calls[0][0].data.id)
      .toBe(dryRunResult.characters[0].characterId)
    expect(txMock.characterAppearance.create.mock.calls[0][0].data.id)
      .toBe(dryRunResult.characters[0].appearances[0].appearanceId)
    expect(txMock.novelPromotionLocation.create.mock.calls.map(
      (call) => call[0].data.id,
    )).toEqual([
      dryRunResult.locations[0].locationId,
      dryRunResult.props[0].propId,
    ])
    expect(txMock.locationImage.create.mock.calls.map(
      (call) => call[0].data.id,
    )).toEqual([
      ...dryRunResult.locations[0].imageSlotIds,
      ...dryRunResult.props[0].imageSlotIds,
    ])
  })

  it('creates every new-character appearance independently when change reasons repeat', async () => {
    const first = request().data.characters[0]
    const commitRequest = request({
      data: {
        locations: [],
        props: [],
        characters: [{
          ...first,
          appearances: [{
            ...first.appearances[0],
            appearanceKey: 'appearance.lin.one',
            appearanceOrdinal: 1,
          }, {
            ...first.appearances[0],
            appearanceKey: 'appearance.lin.two',
            appearanceOrdinal: 2,
          }],
        }],
      },
    })
    txMock.novelPromotionCharacter.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      name: data.name,
      aliases: data.aliases,
      profileData: data.profileData,
      profileConfirmed: data.profileConfirmed,
      introduction: data.introduction,
    }))
    txMock.characterAppearance.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      characterId: data.characterId,
      appearanceIndex: data.appearanceIndex,
      changeReason: data.changeReason,
      description: data.description,
      descriptions: data.descriptions,
      imageUrl: null,
      imageUrls: data.imageUrls,
      selectedIndex: null,
    }))

    const result = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: commitRequest,
    })
    expect(txMock.characterAppearance.create).toHaveBeenCalledTimes(2)
    expect(txMock.characterAppearance.update).not.toHaveBeenCalled()
    expect(result.characters[0].appearances).toEqual([
      expect.objectContaining({
        appearanceKey: 'appearance.lin.one',
        appearanceId: buildProjectedEntityId(
          'run-1',
          'Appearance',
          'appearance.lin.one',
        ),
        appearanceIndex: 0,
        reused: false,
      }),
      expect.objectContaining({
        appearanceKey: 'appearance.lin.two',
        appearanceId: buildProjectedEntityId(
          'run-1',
          'Appearance',
          'appearance.lin.two',
        ),
        appearanceIndex: 1,
        reused: false,
      }),
    ])
  })

  it('creates complete character/profile/appearances and run-owned location/prop slots', async () => {
    const commitRequest = request()
    const result = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: commitRequest,
    })

    expect(result).toMatchObject({
      dryRun: false,
      characters: [{
        characterKey: 'character.lin',
        characterId: 'character-db-1',
        reused: false,
        appearances: [{
          appearanceId: 'appearance-db-1',
          appearanceIndex: 0,
          reused: false,
        }],
      }],
      locations: [{
        locationId: 'location-db-1',
        imageSlotIds: ['location-image-1', 'location-image-2'],
      }],
      props: [{
        propId: 'prop-db-1',
        imageSlotIds: ['prop-image-1'],
      }],
    })
    expect(result.characters[0].appearances[0]).not.toHaveProperty('variantIndex')

    const characterData = txMock.novelPromotionCharacter.create.mock.calls[0][0].data
    expect(characterData).toMatchObject({
      novelPromotionProjectId: 'novel-project-1',
      name: '林晓',
      aliases: JSON.stringify(['小林']),
      introduction: '记者',
      profileConfirmed: true,
    })
    expect(JSON.parse(characterData.profileData)).toEqual({
      gender: 'female',
      ageRange: '25-30',
      roleLevel: 'S',
      archetype: '调查者',
      personalityTags: ['坚毅'],
      eraPeriod: '现代',
      socialClass: '中产',
      occupation: '记者',
      costumeTier: 3,
      suggestedColors: ['蓝色'],
      primaryIdentifier: '银色发夹',
      visualKeywords: ['短发'],
    })
    expect(txMock.characterAppearance.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        characterId: 'character-db-1',
        appearanceIndex: 0,
        changeReason: '默认',
        description: '短发蓝衣',
        descriptions: JSON.stringify(['短发蓝衣']),
        imageUrls: JSON.stringify(['']),
      }),
    }))
    expect(txMock.locationImage.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        locationId: 'location-db-1',
        imageIndex: 0,
        description: '深夜编辑室全景',
        availableSlots: JSON.stringify(['窗边']),
      }),
    }))
    expect(txMock.locationImage.create).toHaveBeenNthCalledWith(3, expect.objectContaining({
      data: expect.objectContaining({
        locationId: 'prop-db-1',
        imageIndex: 0,
        description: '磨损的银色发夹',
      }),
    }))

    const runUpdate = txMock.agentCreationRun.update.mock.calls[0][0]
    expect(runUpdate.data).toMatchObject({
      status: 'assets_committed',
      currentStage: 'assets_committed',
    })
    expect(parseAssetMap(runUpdate.data.assetMapJson)).toMatchObject({
      characters: {
        'character.lin': {
          appearances: {
            'appearance.lin.default': {
              variantSlots: {
                0: { entityId: 'appearance-db-1', index: 0 },
              },
            },
          },
        },
      },
    })
  })

  it('reuses an exact character without overwriting preserved fields and appends one run-owned candidate', async () => {
    txMock.novelPromotionCharacter.findMany.mockResolvedValue([{
      id: 'existing-character',
      name: '历史名称',
      aliases: JSON.stringify(['林晓']),
      profileData: JSON.stringify({ gender: 'female', custom: 'keep' }),
      profileConfirmed: false,
      introduction: '历史介绍',
    }])
    txMock.characterAppearance.findMany.mockResolvedValue([{
      id: 'existing-appearance',
      characterId: 'existing-character',
      appearanceIndex: 4,
      changeReason: ' 默认 ',
      description: '历史描述',
      descriptions: JSON.stringify(['历史描述']),
      imageUrl: 'old-main.jpg',
      imageUrls: JSON.stringify(['old-a.jpg', 'old-b.jpg']),
      selectedIndex: 1,
    }])
    txMock.characterAppearance.update.mockResolvedValue({
      id: 'existing-appearance',
      imageUrls: JSON.stringify(['old-a.jpg', 'old-b.jpg', '']),
    })

    const result = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request({
        data: { locations: [], props: [] },
      }),
    })

    expect(result.characters[0]).toMatchObject({
      characterId: 'existing-character',
      reused: true,
      appearances: [{
        appearanceId: 'existing-appearance',
        appearanceIndex: 4,
        reused: true,
      }],
    })
    expect(txMock.novelPromotionCharacter.create).not.toHaveBeenCalled()
    expect(txMock.characterAppearance.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionCharacter.update).toHaveBeenCalledWith({
      where: { id: 'existing-character' },
      data: { aliases: JSON.stringify(['林晓', '小林']) },
    })
    expect(txMock.characterAppearance.update).toHaveBeenCalledWith({
      where: { id: 'existing-appearance' },
      data: { imageUrls: JSON.stringify(['old-a.jpg', 'old-b.jpg', '']) },
    })
    expect(result.warnings).toEqual(expect.arrayContaining([
      {
        code: 'EXISTING_ASSET_PRESERVED',
        targetKey: 'character.lin',
        field: 'name',
      },
      {
        code: 'EXISTING_ASSET_PRESERVED',
        targetKey: 'appearance.lin.default',
        field: 'imageUrls',
      },
    ]))
    const map = parseAssetMap(
      txMock.agentCreationRun.update.mock.calls[0][0].data.assetMapJson,
    )
    expect(
      map.characters['character.lin'].appearances['appearance.lin.default']
        .variantSlots['0'],
    ).toEqual({ entityId: 'existing-appearance', index: 2 })
  })

  it.each([
    ['malformed JSON', '{broken'],
    ['non-array JSON', JSON.stringify({ old: 'history.jpg' })],
    ['mixed/non-string array', JSON.stringify(['history.jpg', 42])],
  ])('rejects %s stored imageUrls without overwriting history', async (
    _label,
    imageUrls,
  ) => {
    txMock.novelPromotionCharacter.findMany.mockResolvedValue([{
      id: 'existing-character',
      name: '林晓',
      aliases: JSON.stringify(['小林']),
      profileData: JSON.stringify({ gender: 'female' }),
      profileConfirmed: true,
      introduction: '历史介绍',
    }])
    txMock.characterAppearance.findMany.mockResolvedValue([{
      id: 'existing-appearance',
      characterId: 'existing-character',
      appearanceIndex: 4,
      changeReason: '默认',
      description: '历史描述',
      descriptions: JSON.stringify(['历史描述']),
      imageUrl: 'history-main.jpg',
      imageUrls,
      selectedIndex: 0,
    }])

    await expect(commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request({ data: { locations: [], props: [] } }),
    })).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: {
        field: 'imageUrls',
        targetKey: 'appearance.lin.default',
      },
    })
    expect(txMock.novelPromotionCharacter.update).not.toHaveBeenCalled()
    expect(txMock.characterAppearance.update).not.toHaveBeenCalled()
    expect(txMock.characterAppearance.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionLocation.create).not.toHaveBeenCalled()
    expect(txMock.locationImage.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('allocates max appearanceIndex + 1 under a character lock for a different change reason', async () => {
    txMock.novelPromotionCharacter.findMany.mockResolvedValue([{
      id: 'existing-character',
      name: '林晓',
      aliases: '[]',
      profileData: JSON.stringify({ gender: 'female' }),
      profileConfirmed: true,
      introduction: '记者',
    }])
    txMock.characterAppearance.findMany.mockResolvedValue([{
      id: 'old-appearance',
      characterId: 'existing-character',
      appearanceIndex: 7,
      changeReason: '雨夜',
      description: null,
      descriptions: null,
      imageUrl: null,
      imageUrls: null,
      selectedIndex: null,
    }])
    txMock.characterAppearance.create.mockResolvedValue({
      id: 'new-appearance',
      appearanceIndex: 8,
      imageUrls: JSON.stringify(['']),
    })

    const result = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request({ data: { locations: [], props: [] } }),
    })
    expect(result.characters[0].appearances[0]).toMatchObject({
      appearanceId: 'new-appearance',
      appearanceIndex: 8,
      reused: false,
    })
    expect(txMock.$queryRaw.mock.calls.some((call) => (
      (call[0] as { sql?: string }).sql?.includes('novel_promotion_characters')
    ))).toBe(true)
  })

  it('returns the persisted mapping without allocating slots for a same-hash retry', async () => {
    const commitRequest = request()
    const persistedMap = {
      characters: {
        'character.lin': {
          characterKey: 'character.lin',
          characterId: 'persisted-character',
          reused: true,
          appearances: {
            'appearance.lin.default': {
              appearanceKey: 'appearance.lin.default',
              appearanceId: 'persisted-appearance',
              appearanceIndex: 9,
              reused: true,
              variantSlots: {
                0: { entityId: 'persisted-appearance', index: 3 },
              },
            },
          },
        },
      },
      locations: {
        'location.newsroom': {
          assetKey: 'location.newsroom',
          entityId: 'persisted-location',
          reused: true,
          imageSlots: {
            0: { entityId: 'persisted-location-image', index: 5 },
            1: { entityId: 'persisted-location-image-2', index: 6 },
          },
        },
      },
      props: {
        'prop.hairpin': {
          assetKey: 'prop.hairpin',
          entityId: 'persisted-prop',
          reused: true,
          imageSlots: {
            0: { entityId: 'persisted-prop-image', index: 2 },
          },
        },
      },
    }
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      status: 'assets_committed',
      currentStage: 'assets_committed',
      assetMapJson: serializeAssetMap(persistedMap),
      artifactHashesJson: serializeArtifactHashes({
        assets: commitRequest.artifactHash,
        stories: { 'episode-001': `sha256:${'d'.repeat(64)}` },
        screenplays: {},
        storyboards: {},
      }),
    }))

    const result = await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: commitRequest,
    })
    expect(result).toMatchObject({
      characters: [{
        characterId: 'persisted-character',
        appearances: [{ appearanceIndex: 9 }],
      }],
      locations: [{
        imageSlotIds: ['persisted-location-image', 'persisted-location-image-2'],
      }],
      props: [{ imageSlotIds: ['persisted-prop-image'] }],
    })
    expect(txMock.novelPromotionCharacter.findMany).not.toHaveBeenCalled()
    expect(txMock.characterAppearance.update).not.toHaveBeenCalled()
    expect(txMock.locationImage.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it.each([
    ['rules version', request({
      envelope: { ruleSetVersion: 'other' },
    }), 'RULESET_MISMATCH'],
    ['rules hash', request({
      envelope: { ruleSetHash: OTHER_HASH },
    }), 'RULESET_MISMATCH'],
    ['artifact hash', request({
      envelope: { artifactHash: OTHER_HASH },
    }), 'ARTIFACT_HASH_MISMATCH'],
  ])('rejects mismatched %s without asset writes', async (
    _label,
    commitRequest,
    code,
  ) => {
    await expect(commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: commitRequest,
    })).rejects.toMatchObject({ code })
    expect(txMock.novelPromotionCharacter.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionLocation.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('rejects a different hash after assets were committed', async () => {
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      status: 'assets_committed',
      currentStage: 'assets_committed',
      artifactHashesJson: serializeArtifactHashes({
        assets: OTHER_HASH,
        stories: { 'episode-001': `sha256:${'d'.repeat(64)}` },
        screenplays: {},
        storyboards: {},
      }),
    }))
    await expect(commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request(),
    })).rejects.toMatchObject({ code: 'RUN_DEFINITION_CONFLICT' })
  })

  it('rejects corrupted persisted asset mapping instead of overwriting it', async () => {
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      assetMapJson: '{broken',
    }))
    await expect(commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request(),
    })).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'assetMapJson' },
    })
    expect(txMock.novelPromotionCharacter.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('rejects a valid nonempty asset mapping when the assets hash is missing', async () => {
    txMock.agentCreationRun.findUnique.mockResolvedValue(storedRun({
      assetMapJson: serializeAssetMap({
        characters: {
          'character.lin': {
            characterKey: 'character.lin',
            characterId: 'existing-character',
            reused: false,
            appearances: {},
          },
        },
        locations: {},
        props: {},
      }),
    }))
    await expect(commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request(),
    })).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'assetMapJson' },
    })
    expect(txMock.novelPromotionCharacter.findMany).not.toHaveBeenCalled()
    expect(txMock.novelPromotionCharacter.create).not.toHaveBeenCalled()
    expect(txMock.characterAppearance.create).not.toHaveBeenCalled()
    expect(txMock.locationImage.create).not.toHaveBeenCalled()
    expect(txMock.agentCreationRun.update).not.toHaveBeenCalled()
  })

  it('uses an explicit long interactive transaction timeout for 500-asset batches', async () => {
    await commitAssetsArtifact({
      userId: 'user-1',
      runId: 'run-1',
      request: request(),
    })
    expect(prismaMock.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxWait: expect.any(Number),
        timeout: expect.any(Number),
      }),
    )
    const options = prismaMock.$transaction.mock.calls[0][1]
    expect(options.maxWait).toBeGreaterThanOrEqual(10_000)
    expect(options.timeout).toBeGreaterThanOrEqual(30_000)
  })
})
