import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PUT as COMMIT_ASSETS } from '@/app/api/agent/v1/runs/[runId]/assets/route'
import { hashArtifact } from '@/lib/agent-api/canonical-json'
import {
  AssetsCommitResponseSchema,
  type AssetsCommitRequest,
} from '@/lib/agent-api/contracts/assets'
import {
  parseArtifactHashes,
  parseAssetMap,
  serializeArtifactHashes,
  serializeAssetMap,
  serializeEpisodeMap,
} from '@/lib/agent-api/run-state'
import { resetSystemState } from '../../helpers/db-reset'
import {
  createFixtureEpisode,
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

const ORIGINAL_ENV = {
  WAOO_AGENT_API_ENABLED: process.env.WAOO_AGENT_API_ENABLED,
  WAOO_AGENT_TOKEN: process.env.WAOO_AGENT_TOKEN,
  WAOO_AGENT_USER_ID: process.env.WAOO_AGENT_USER_ID,
}
const SOURCE_HASH = `sha256:${'a'.repeat(64)}`
const RULE_SET_HASH = `sha256:${'b'.repeat(64)}`
const STORY_HASH = `sha256:${'c'.repeat(64)}`
const definitions = [{
  episodeKey: 'episode-001',
  ordinal: 1,
  sourceHash: SOURCE_HASH,
  name: '第一集',
}]

let userId: string
let projectId: string
let novelProjectId: string
let episodeId: string

function assetsRequest(overrides: {
  envelope?: Partial<Omit<AssetsCommitRequest, 'data'>>
  data?: Partial<AssetsCommitRequest['data']>
} = {}): AssetsCommitRequest {
  const data = {
    characters: [{
      characterKey: 'character.lin',
      name: '林晓',
      aliases: ['小林'],
      introduction: '调查记者',
      gender: 'female' as const,
      ageRange: '25-30',
      roleLevel: 'S' as const,
      personalityTags: ['坚毅'],
      suggestedColors: ['蓝色'],
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
      availableSlots: ['窗边', '门口'],
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

async function createReadyRun(fingerprint = `run-${crypto.randomUUID()}`) {
  return await prisma.agentCreationRun.create({
    data: {
      userId,
      projectId,
      sourceHash: SOURCE_HASH,
      runFingerprint: fingerprint,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: JSON.stringify({}),
      ruleSetVersion: 'waoo-creator-v1',
      ruleSetHash: RULE_SET_HASH,
      definitionHash: hashArtifact(definitions),
      status: 'story_committed',
      currentStage: 'story_committed',
      episodeMapJson: serializeEpisodeMap({
        'episode-001': {
          ...definitions[0],
          episodeId,
          episodeNumber: 1,
          status: 'story_committed',
        },
      }),
      assetMapJson: serializeAssetMap({
        characters: {},
        locations: {},
        props: {},
      }),
      artifactHashesJson: serializeArtifactHashes({
        stories: { 'episode-001': STORY_HASH },
        screenplays: {},
        storyboards: {},
      }),
    },
  })
}

function headers(idempotencyKey: string) {
  return {
    Authorization: 'Bearer integration-agent-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Waoo-User-Id': userId,
    'X-Request-Id': `req-assets-${crypto.randomUUID()}`,
  }
}

async function commit(
  runId: string,
  body: AssetsCommitRequest | Record<string, unknown>,
  idempotencyKey = body.artifactHash as string,
) {
  const response = await COMMIT_ASSETS(new Request(
    `http://localhost/api/agent/v1/runs/${runId}/assets`,
    {
      method: 'PUT',
      headers: headers(idempotencyKey),
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ runId }),
  })
  return { response, payload: await response.json() }
}

describe('Agent assets artifact commit with MySQL', () => {
  beforeEach(async () => {
    await resetSystemState()
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const episode = await createFixtureEpisode(novelProject.id, 1)
    userId = user.id
    projectId = project.id
    novelProjectId = novelProject.id
    episodeId = episode.id
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'integration-agent-token'
    process.env.WAOO_AGENT_USER_ID = user.id
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('dry-runs deterministically without writing assets, slots, mapping, or status', async () => {
    const run = await createReadyRun()
    const body = assetsRequest({ envelope: { dryRun: true } })
    const beforeRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })

    const first = await commit(run.id, body)
    const second = await commit(run.id, body)
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    expect(first.payload.data).toEqual(second.payload.data)
    expect(AssetsCommitResponseSchema.safeParse(first.payload).success).toBe(true)
    expect(first.payload.data).toMatchObject({
      dryRun: true,
      artifactHash: body.artifactHash,
    })
    await expect(Promise.all([
      prisma.novelPromotionCharacter.count(),
      prisma.characterAppearance.count(),
      prisma.novelPromotionLocation.count(),
      prisma.locationImage.count(),
    ])).resolves.toEqual([0, 0, 0, 0])
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })).resolves.toEqual(beforeRun)

    const committed = await commit(run.id, { ...body, dryRun: false })
    expect(committed.response.status).toBe(200)
    expect({
      ...committed.payload.data,
      dryRun: true,
    }).toEqual(first.payload.data)
    const persisted = await Promise.all([
      prisma.novelPromotionCharacter.findFirstOrThrow({
        where: { novelPromotionProjectId: novelProjectId },
      }),
      prisma.characterAppearance.findFirstOrThrow(),
      prisma.novelPromotionLocation.findMany({
        where: { novelPromotionProjectId: novelProjectId },
        orderBy: { assetKind: 'asc' },
      }),
      prisma.locationImage.findMany({ orderBy: { id: 'asc' } }),
    ])
    expect(persisted[0].id).toBe(first.payload.data.characters[0].characterId)
    expect(persisted[1].id)
      .toBe(first.payload.data.characters[0].appearances[0].appearanceId)
    expect(persisted[2].map((asset) => asset.id).sort()).toEqual([
      first.payload.data.locations[0].locationId,
      first.payload.data.props[0].propId,
    ].sort())
    expect(persisted[3].map((image) => image.id).sort()).toEqual([
      ...first.payload.data.locations[0].imageSlotIds,
      ...first.payload.data.props[0].imageSlotIds,
    ].sort())
  })

  it('creates complete deterministic assets and run-owned slots without queue/model records', async () => {
    const run = await createReadyRun()
    const body = assetsRequest()
    const result = await commit(run.id, body)
    expect(result.response.status).toBe(200)
    expect(AssetsCommitResponseSchema.safeParse(result.payload).success).toBe(true)
    expect(result.payload.data).toMatchObject({
      dryRun: false,
      artifactHash: body.artifactHash,
      characters: [{
        characterKey: 'character.lin',
        reused: false,
        appearances: [{
          appearanceKey: 'appearance.lin.default',
          appearanceIndex: 0,
          reused: false,
        }],
      }],
      locations: [{
        locationKey: 'location.newsroom',
        reused: false,
      }],
      props: [{
        propKey: 'prop.hairpin',
        reused: false,
      }],
    })
    expect(result.payload.data.characters[0].appearances[0])
      .not.toHaveProperty('variantIndex')

    const character = await prisma.novelPromotionCharacter.findFirstOrThrow({
      where: { novelPromotionProjectId: novelProjectId },
      include: { appearances: true },
    })
    expect(character).toMatchObject({
      name: '林晓',
      aliases: JSON.stringify(['小林']),
      introduction: '调查记者',
      profileConfirmed: true,
    })
    expect(JSON.parse(character.profileData!)).toMatchObject({
      gender: 'female',
      ageRange: '25-30',
      roleLevel: 'S',
      personalityTags: ['坚毅'],
      suggestedColors: ['蓝色'],
      visualKeywords: ['短发'],
    })
    expect(character.appearances).toEqual([
      expect.objectContaining({
        appearanceIndex: 0,
        description: '短发蓝衣',
        descriptions: JSON.stringify(['短发蓝衣']),
        imageUrls: JSON.stringify(['']),
      }),
    ])

    const assets = await prisma.novelPromotionLocation.findMany({
      where: { novelPromotionProjectId: novelProjectId },
      include: { images: { orderBy: { imageIndex: 'asc' } } },
      orderBy: { assetKind: 'asc' },
    })
    expect(assets).toHaveLength(2)
    const location = assets.find((asset) => asset.assetKind === 'location')!
    const prop = assets.find((asset) => asset.assetKind === 'prop')!
    expect(location.images.map((image) => image.description)).toEqual([
      '深夜编辑室全景',
      '窗边工位',
    ])
    expect(location.images.every(
      (image) => image.availableSlots === JSON.stringify(['窗边', '门口']),
    )).toBe(true)
    expect(prop.images).toEqual([
      expect.objectContaining({
        imageIndex: 0,
        description: '磨损的银色发夹',
      }),
    ])
    expect(result.payload.data.locations[0].imageSlotIds).toEqual(
      location.images.map((image) => image.id),
    )
    expect(result.payload.data.props[0].imageSlotIds).toEqual(
      prop.images.map((image) => image.id),
    )

    const persistedRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(persistedRun).toMatchObject({
      status: 'assets_committed',
      currentStage: 'assets_committed',
    })
    expect(parseArtifactHashes(persistedRun.artifactHashesJson!).assets)
      .toBe(body.artifactHash)
    expect(parseAssetMap(persistedRun.assetMapJson!))
      .toMatchObject({
        characters: {
          'character.lin': {
            characterId: character.id,
          },
        },
      })
    await expect(Promise.all([
      prisma.task.count(),
      prisma.taskEvent.count(),
      prisma.graphRun.count(),
      prisma.usageCost.count(),
    ])).resolves.toEqual([0, 0, 0, 0])
  })

  it('creates same-name locations and props as separate asset kinds', async () => {
    const run = await createReadyRun()
    const body = assetsRequest({
      data: {
        characters: [],
        props: [{
          propKey: 'prop.newsroom',
          name: '新闻编辑室',
          summary: '缩微模型',
          visualDescription: '新闻编辑室缩微模型',
        }],
      },
    })
    const result = await commit(run.id, body)
    expect(result.response.status).toBe(200)
    expect(result.payload.data).toMatchObject({
      locations: [{ locationKey: 'location.newsroom', reused: false }],
      props: [{ propKey: 'prop.newsroom', reused: false }],
    })
    const rows = await prisma.novelPromotionLocation.findMany({
      where: {
        novelPromotionProjectId: novelProjectId,
        name: '新闻编辑室',
      },
      orderBy: { assetKind: 'asc' },
    })
    expect(rows.map((row) => row.assetKind)).toEqual(['location', 'prop'])
  })

  it('creates a new requested kind when only the same-name opposite kind exists', async () => {
    const existingProp = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProjectId,
        name: '旧道具同名',
        summary: '必须保持的旧道具',
        assetKind: 'prop',
      },
    })
    const existingLocation = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProjectId,
        name: '旧场景同名',
        summary: '必须保持的旧场景',
        assetKind: 'location',
      },
    })
    const run = await createReadyRun()
    const body = assetsRequest({
      data: {
        characters: [],
        locations: [{
          locationKey: 'location.from-opposite',
          name: '旧道具同名',
          summary: '新场景',
          availableSlots: [],
          descriptions: ['新场景描述'],
        }],
        props: [{
          propKey: 'prop.from-opposite',
          name: '旧场景同名',
          summary: '新道具',
          visualDescription: '新道具描述',
        }],
      },
    })
    const result = await commit(run.id, body)
    expect(result.response.status).toBe(200)
    expect(result.payload.data).toMatchObject({
      locations: [{
        locationKey: 'location.from-opposite',
        reused: false,
      }],
      props: [{
        propKey: 'prop.from-opposite',
        reused: false,
      }],
    })
    expect(result.payload.data.locations[0].locationId).not.toBe(existingProp.id)
    expect(result.payload.data.props[0].propId).not.toBe(existingLocation.id)
    await expect(prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: existingProp.id },
    })).resolves.toEqual(existingProp)
    await expect(prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: existingLocation.id },
    })).resolves.toEqual(existingLocation)
    const rows = await prisma.novelPromotionLocation.findMany({
      where: { novelPromotionProjectId: novelProjectId },
    })
    expect(rows).toHaveLength(4)
    expect(rows.filter((row) => row.name === '旧道具同名')
      .map((row) => row.assetKind).sort()).toEqual(['location', 'prop'])
    expect(rows.filter((row) => row.name === '旧场景同名')
      .map((row) => row.assetKind).sort()).toEqual(['location', 'prop'])
  })

  it('creates distinct indexed appearances for a new character with repeated change reasons', async () => {
    const run = await createReadyRun()
    const baseCharacter = assetsRequest().data.characters[0]
    const body = assetsRequest({
      data: {
        locations: [],
        props: [],
        characters: [{
          ...baseCharacter,
          appearances: [{
            ...baseCharacter.appearances[0],
            appearanceKey: 'appearance.lin.one',
            appearanceOrdinal: 1,
          }, {
            ...baseCharacter.appearances[0],
            appearanceKey: 'appearance.lin.two',
            appearanceOrdinal: 2,
          }],
        }],
      },
    })
    const result = await commit(run.id, body)
    expect(result.response.status).toBe(200)
    expect(result.payload.data.characters[0].appearances).toEqual([
      expect.objectContaining({
        appearanceKey: 'appearance.lin.one',
        appearanceIndex: 0,
        reused: false,
      }),
      expect.objectContaining({
        appearanceKey: 'appearance.lin.two',
        appearanceIndex: 1,
        reused: false,
      }),
    ])
    const rows = await prisma.characterAppearance.findMany({
      orderBy: { appearanceIndex: 'asc' },
    })
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.appearanceIndex)).toEqual([0, 1])
    expect(rows.map((row) => row.id)).toEqual(
      result.payload.data.characters[0].appearances.map(
        (appearance: { appearanceId: string }) => appearance.appearanceId,
      ),
    )
  })

  it('reuses existing assets, preserves historical fields and selections, and retry adds no slot', async () => {
    const existingCharacter = await prisma.novelPromotionCharacter.create({
      data: {
        novelPromotionProjectId: novelProjectId,
        name: '历史角色名',
        aliases: JSON.stringify(['林晓']),
        introduction: '历史介绍',
        profileData: JSON.stringify({ gender: 'female', custom: 'keep' }),
        profileConfirmed: false,
        appearances: {
          create: {
            appearanceIndex: 5,
            changeReason: ' 默认 ',
            description: '历史描述',
            descriptions: JSON.stringify(['历史描述']),
            imageUrl: 'history-main.jpg',
            imageUrls: JSON.stringify(['history-a.jpg', 'history-b.jpg']),
            selectedIndex: 1,
          },
        },
      },
      include: { appearances: true },
    })
    const existingLocation = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProjectId,
        name: '新闻编辑室',
        summary: '历史简介',
        assetKind: 'location',
        images: {
          create: {
            imageIndex: 4,
            description: '历史场景图',
            imageUrl: 'history-location.jpg',
            isSelected: true,
          },
        },
      },
      include: { images: true },
    })
    await prisma.novelPromotionLocation.update({
      where: { id: existingLocation.id },
      data: { selectedImageId: existingLocation.images[0].id },
    })
    const run = await createReadyRun()
    const body = assetsRequest({ data: { props: [] } })

    const first = await commit(run.id, body)
    const second = await commit(run.id, body)
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    expect(second.payload.data).toEqual({
      ...first.payload.data,
      warnings: [],
    })
    expect(first.payload.data).toMatchObject({
      characters: [{
        characterId: existingCharacter.id,
        reused: true,
        appearances: [{
          appearanceId: existingCharacter.appearances[0].id,
          appearanceIndex: 5,
          reused: true,
        }],
      }],
      locations: [{
        locationId: existingLocation.id,
        reused: true,
      }],
      warnings: expect.arrayContaining([
        expect.objectContaining({
          code: 'EXISTING_ASSET_PRESERVED',
          targetKey: 'character.lin',
        }),
      ]),
    })

    const preservedCharacter = await prisma.novelPromotionCharacter.findUniqueOrThrow({
      where: { id: existingCharacter.id },
      include: { appearances: true },
    })
    expect(preservedCharacter).toMatchObject({
      name: '历史角色名',
      introduction: '历史介绍',
      profileData: JSON.stringify({ gender: 'female', custom: 'keep' }),
      profileConfirmed: false,
    })
    expect(JSON.parse(preservedCharacter.aliases!)).toEqual(['林晓', '小林'])
    expect(preservedCharacter.appearances).toHaveLength(1)
    expect(preservedCharacter.appearances[0]).toMatchObject({
      description: '历史描述',
      imageUrl: 'history-main.jpg',
      imageUrls: JSON.stringify(['history-a.jpg', 'history-b.jpg', '']),
      selectedIndex: 1,
    })

    const preservedLocation = await prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: existingLocation.id },
      include: { images: { orderBy: { imageIndex: 'asc' } } },
    })
    expect(preservedLocation).toMatchObject({
      summary: '历史简介',
      selectedImageId: existingLocation.images[0].id,
    })
    expect(preservedLocation.images).toHaveLength(3)
    expect(preservedLocation.images.slice(1).map((image) => image.id))
      .toEqual(first.payload.data.locations[0].imageSlotIds)
  })

  it('rolls back the whole artifact when matched historical imageUrls are malformed', async () => {
    const character = await prisma.novelPromotionCharacter.create({
      data: {
        novelPromotionProjectId: novelProjectId,
        name: '林晓',
        aliases: JSON.stringify(['小林']),
        introduction: '历史介绍',
        profileData: JSON.stringify({ gender: 'female' }),
        profileConfirmed: true,
        appearances: {
          create: {
            appearanceIndex: 3,
            changeReason: '默认',
            description: '历史描述',
            imageUrl: 'history-main.jpg',
            imageUrls: '{broken',
            selectedIndex: 0,
          },
        },
      },
      include: { appearances: true },
    })
    const run = await createReadyRun()
    const beforeRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    const result = await commit(run.id, assetsRequest())
    expect(result.response.status).toBe(500)
    expect(result.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: {
        field: 'imageUrls',
        targetKey: 'appearance.lin.default',
      },
    })
    await expect(prisma.characterAppearance.findUniqueOrThrow({
      where: { id: character.appearances[0].id },
    })).resolves.toMatchObject({
      imageUrl: 'history-main.jpg',
      imageUrls: '{broken',
      selectedIndex: 0,
    })
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })).resolves.toEqual(beforeRun)
    await expect(Promise.all([
      prisma.novelPromotionCharacter.count(),
      prisma.characterAppearance.count(),
      prisma.novelPromotionLocation.count(),
      prisma.locationImage.count(),
    ])).resolves.toEqual([1, 1, 0, 0])
  })

  it('enforces idempotency/hash/rules and reports deterministic identity conflicts', async () => {
    const run = await createReadyRun()
    const body = assetsRequest()
    const wrongKey = await commit(run.id, body, `sha256:${'e'.repeat(64)}`)
    expect(wrongKey.response.status).toBe(400)
    expect(wrongKey.payload.error.code).toBe('CONTRACT_INVALID')

    const first = await commit(run.id, body)
    expect(first.response.status).toBe(200)
    const different = assetsRequest({
      data: {
        characters: [{
          ...body.data.characters[0],
          introduction: '改变后的介绍',
        }],
      },
    })
    const conflict = await commit(run.id, different)
    expect(conflict.response.status).toBe(409)
    expect(conflict.payload.error.code).toBe('RUN_DEFINITION_CONFLICT')

    const otherRun = await createReadyRun()
    await prisma.novelPromotionCharacter.create({
      data: {
        novelPromotionProjectId: novelProjectId,
        name: '另一角色',
        aliases: JSON.stringify(['小林']),
        profileData: JSON.stringify({ gender: 'female' }),
      },
    })
    const identityConflict = await commit(otherRun.id, body)
    expect(identityConflict.response.status).toBe(409)
    expect(identityConflict.payload.error.code).toBe('ASSET_IDENTITY_CONFLICT')
  })
})
