import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as SCREENPLAY_ROUTE from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/screenplay/route'
import { hashArtifact } from '@/lib/agent-api/canonical-json'
import {
  ScreenplayCommitResponseSchema,
  type ScreenplayCommitRequest,
} from '@/lib/agent-api/contracts/screenplay'
import { buildProjectedEntityId } from '@/lib/agent-api/entity-id'
import {
  parseArtifactHashes,
  parseClipMap,
  parseEpisodeMap,
  serializeArtifactHashes,
  serializeAssetMap,
  serializeClipMap,
  serializeEpisodeMap,
  type AssetMap,
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
const SOURCE_HASH_1 = `sha256:${'1'.repeat(64)}`
const SOURCE_HASH_2 = `sha256:${'2'.repeat(64)}`
const RULE_SET_HASH = `sha256:${'a'.repeat(64)}`
const ASSET_HASH = `sha256:${'b'.repeat(64)}`
const STORY_HASH_1 = `sha256:${'c'.repeat(64)}`
const STORY_HASH_2 = `sha256:${'d'.repeat(64)}`
const NOVEL_TEXT = '清晨，林晓拿起背包出门。夜里，她在新闻编辑室查看发夹。'

let userId: string
let projectId: string
let episodeId: string
let secondEpisodeId: string
let assets: AssetMap

function definitions(includeSecond = false) {
  return [{
    episodeKey: 'episode-001',
    ordinal: 1,
    sourceHash: SOURCE_HASH_1,
    name: '第一集',
  }, ...(includeSecond ? [{
    episodeKey: 'episode-002',
    ordinal: 2,
    sourceHash: SOURCE_HASH_2,
    name: '第二集',
  }] : [])]
}

function screenplayRequest(overrides: {
  envelope?: Partial<Omit<ScreenplayCommitRequest, 'data'>>
  data?: Partial<ScreenplayCommitRequest['data']>
} = {}): ScreenplayCommitRequest {
  const data = {
    episodeKey: 'episode-001',
    clips: [{
      clipKey: 'clip-001',
      ordinal: 1,
      startText: '清晨',
      endText: '出门。',
      summary: '林晓清晨出门',
      locationKey: 'location.home',
      characterKeys: ['character.lin'],
      propKeys: ['prop.bag'],
      content: '清晨，林晓拿起背包出门。',
      screenplay: {
        originalText: '清晨，林晓拿起背包出门。',
        scenes: [{
          sceneNumber: 1,
          heading: {
            intExt: 'INT' as const,
            locationKey: 'location.home',
            time: '清晨',
          },
          description: '林晓拿起背包。',
          characterKeys: ['character.lin'],
          content: [{
            type: 'dialogue' as const,
            characterKey: 'character.lin',
            lines: '今天要找到线索。',
          }],
        }],
      },
    }, {
      clipKey: 'clip-002',
      ordinal: 2,
      startText: '夜里',
      endText: '发夹。',
      summary: '林晓夜查线索',
      locationKey: 'location.newsroom',
      characterKeys: ['character.lin'],
      propKeys: ['prop.hairpin'],
      content: '夜里，她在新闻编辑室查看发夹。',
      screenplay: {
        originalText: '夜里，她在新闻编辑室查看发夹。',
        scenes: [{
          sceneNumber: 1,
          heading: {
            intExt: 'INT' as const,
            locationKey: 'location.newsroom',
            time: '夜',
          },
          description: '林晓查看发夹。',
          characterKeys: ['character.lin'],
          content: [{
            type: 'voiceover' as const,
            speakerLabel: '旁白',
            text: '关键线索终于出现。',
          }],
        }],
      },
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

function secondEpisodeRequest(): ScreenplayCommitRequest {
  const data: ScreenplayCommitRequest['data'] = {
    episodeKey: 'episode-002',
    clips: [{
      clipKey: 'clip-201',
      ordinal: 1,
      startText: '第二集',
      endText: '结束。',
      summary: '第二集内容',
      locationKey: 'location.home',
      characterKeys: ['character.lin'],
      propKeys: [],
      content: '第二集开始并结束。',
      screenplay: {
        originalText: '第二集开始并结束。',
        scenes: [{
          sceneNumber: 1,
          heading: {
            intExt: 'INT',
            locationKey: 'location.home',
            time: '日',
          },
          description: '第二集场景。',
          characterKeys: ['character.lin'],
          content: [{ type: 'action', text: '故事结束。' }],
        }],
      },
    }],
  }
  return {
    schemaVersion: 1,
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: RULE_SET_HASH,
    artifactHash: hashArtifact(data),
    dryRun: false,
    data,
  }
}

async function createReadyRun(options: {
  includeSecond?: boolean
  fingerprint?: string
} = {}) {
  const episodeDefinitions = definitions(options.includeSecond)
  return await prisma.agentCreationRun.create({
    data: {
      userId,
      projectId,
      sourceHash: SOURCE_HASH_1,
      runFingerprint: options.fingerprint ?? `run-${crypto.randomUUID()}`,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: JSON.stringify({}),
      ruleSetVersion: 'waoo-creator-v1',
      ruleSetHash: RULE_SET_HASH,
      definitionHash: hashArtifact(episodeDefinitions),
      status: 'assets_committed',
      currentStage: 'assets_committed',
      episodeMapJson: serializeEpisodeMap(Object.fromEntries(
        episodeDefinitions.map((entry, index) => [
          entry.episodeKey,
          {
            ...entry,
            episodeId: index === 0 ? episodeId : secondEpisodeId,
            episodeNumber: index + 1,
            status: 'story_committed' as const,
          },
        ]),
      )),
      assetMapJson: serializeAssetMap(assets),
      clipMapJson: serializeClipMap({}),
      artifactHashesJson: serializeArtifactHashes({
        assets: ASSET_HASH,
        stories: {
          'episode-001': STORY_HASH_1,
          ...(options.includeSecond
            ? { 'episode-002': STORY_HASH_2 }
            : {}),
        },
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
    'X-Request-Id': `req-screenplay-${crypto.randomUUID()}`,
  }
}

async function commit(
  runId: string,
  episodeKey: string,
  body: ScreenplayCommitRequest | Record<string, unknown>,
  idempotencyKey = body.artifactHash as string,
) {
  const response = await SCREENPLAY_ROUTE.PUT(new Request(
    `http://localhost/api/agent/v1/runs/${runId}/episodes/${episodeKey}/screenplay`,
    {
      method: 'PUT',
      headers: headers(idempotencyKey),
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ runId, episodeKey }),
  })
  return { response, payload: await response.json() }
}

describe('Agent screenplay artifact commit with MySQL', () => {
  beforeEach(async () => {
    await resetSystemState()
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const episode = await createFixtureEpisode(novelProject.id, 1)
    const secondEpisode = await createFixtureEpisode(novelProject.id, 2)
    await prisma.novelPromotionEpisode.update({
      where: { id: episode.id },
      data: { name: '第一集', novelText: NOVEL_TEXT },
    })
    await prisma.novelPromotionEpisode.update({
      where: { id: secondEpisode.id },
      data: { name: '第二集', novelText: '第二集开始并结束。' },
    })
    const character = await prisma.novelPromotionCharacter.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '林晓',
      },
    })
    const appearance = await prisma.characterAppearance.create({
      data: {
        characterId: character.id,
        appearanceIndex: 0,
        changeReason: '默认',
        imageUrls: JSON.stringify(['']),
      },
    })
    const home = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '林家',
        assetKind: 'location',
      },
    })
    const homeImage = await prisma.locationImage.create({
      data: { locationId: home.id, imageIndex: 0 },
    })
    const newsroom = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '新闻编辑室',
        assetKind: 'location',
      },
    })
    const newsroomImage = await prisma.locationImage.create({
      data: { locationId: newsroom.id, imageIndex: 0 },
    })
    const bag = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '黑色背包',
        assetKind: 'prop',
      },
    })
    const bagImage = await prisma.locationImage.create({
      data: { locationId: bag.id, imageIndex: 0 },
    })
    const hairpin = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '银色发夹',
        assetKind: 'prop',
      },
    })
    const hairpinImage = await prisma.locationImage.create({
      data: { locationId: hairpin.id, imageIndex: 0 },
    })
    assets = {
      characters: {
        'character.lin': {
          characterKey: 'character.lin',
          characterId: character.id,
          reused: false,
          appearances: {
            'appearance.lin.default': {
              appearanceKey: 'appearance.lin.default',
              appearanceId: appearance.id,
              appearanceIndex: 0,
              reused: false,
              variantSlots: {
                0: { entityId: appearance.id, index: 0 },
              },
            },
          },
        },
      },
      locations: {
        'location.home': {
          assetKey: 'location.home',
          entityId: home.id,
          reused: false,
          imageSlots: {
            0: { entityId: homeImage.id, index: 0 },
          },
        },
        'location.newsroom': {
          assetKey: 'location.newsroom',
          entityId: newsroom.id,
          reused: false,
          imageSlots: {
            0: { entityId: newsroomImage.id, index: 0 },
          },
        },
      },
      props: {
        'prop.bag': {
          assetKey: 'prop.bag',
          entityId: bag.id,
          reused: false,
          imageSlots: {
            0: { entityId: bagImage.id, index: 0 },
          },
        },
        'prop.hairpin': {
          assetKey: 'prop.hairpin',
          entityId: hairpin.id,
          reused: false,
          imageSlots: {
            0: { entityId: hairpinImage.id, index: 0 },
          },
        },
      },
    }
    userId = user.id
    projectId = project.id
    episodeId = episode.id
    secondEpisodeId = secondEpisode.id
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

  it('exports only PUT for the artifact route', () => {
    expect(typeof SCREENPLAY_ROUTE.PUT).toBe('function')
    expect('POST' in SCREENPLAY_ROUTE).toBe(false)
  })

  it('dry-runs with stable IDs, then commits complete page-compatible Clip fields without side effects', async () => {
    const run = await createReadyRun()
    const preRunClip = await prisma.novelPromotionClip.create({
      data: {
        episodeId,
        summary: '用户原有片段',
        content: '不得修改',
      },
    })
    const body = screenplayRequest({ envelope: { dryRun: true } })
    const beforeRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })

    const dryRun = await commit(run.id, 'episode-001', body)
    expect(dryRun.response.status).toBe(200)
    expect(ScreenplayCommitResponseSchema.safeParse(dryRun.payload).success).toBe(true)
    expect(dryRun.payload.data).toEqual({
      dryRun: true,
      episodeKey: 'episode-001',
      artifactHash: body.artifactHash,
      clips: [{
        clipKey: 'clip-001',
        clipId: buildProjectedEntityId(run.id, 'Clip', 'clip-001'),
        ordinal: 1,
      }, {
        clipKey: 'clip-002',
        clipId: buildProjectedEntityId(run.id, 'Clip', 'clip-002'),
        ordinal: 2,
      }],
    })
    await expect(prisma.novelPromotionClip.count({
      where: { episodeId },
    })).resolves.toBe(1)
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })).resolves.toEqual(beforeRun)

    const committed = await commit(run.id, 'episode-001', {
      ...body,
      dryRun: false,
    })
    expect(committed.response.status).toBe(200)
    expect({
      ...committed.payload.data,
      dryRun: true,
    }).toEqual(dryRun.payload.data)
    const clips = await prisma.novelPromotionClip.findMany({
      where: {
        id: { in: committed.payload.data.clips.map(
          (entry: { clipId: string }) => entry.clipId,
        ) },
      },
      orderBy: { createdAt: 'asc' },
    })
    expect(clips).toHaveLength(2)
    expect(clips.map((clip) => ({
      id: clip.id,
      episodeId: clip.episodeId,
      summary: clip.summary,
      location: clip.location,
      content: clip.content,
      startText: clip.startText,
      endText: clip.endText,
      characters: JSON.parse(clip.characters!),
      props: JSON.parse(clip.props!),
      screenplay: JSON.parse(clip.screenplay!),
    }))).toEqual([{
      id: buildProjectedEntityId(run.id, 'Clip', 'clip-001'),
      episodeId,
      summary: '林晓清晨出门',
      location: '林家',
      content: '清晨，林晓拿起背包出门。',
      startText: '清晨',
      endText: '出门。',
      characters: ['林晓'],
      props: ['黑色背包'],
      screenplay: body.data.clips[0].screenplay,
    }, {
      id: buildProjectedEntityId(run.id, 'Clip', 'clip-002'),
      episodeId,
      summary: '林晓夜查线索',
      location: '新闻编辑室',
      content: '夜里，她在新闻编辑室查看发夹。',
      startText: '夜里',
      endText: '发夹。',
      characters: ['林晓'],
      props: ['银色发夹'],
      screenplay: body.data.clips[1].screenplay,
    }])
    expect(clips[0].createdAt.getTime()).toBeLessThan(clips[1].createdAt.getTime())
    await expect(prisma.novelPromotionClip.findUniqueOrThrow({
      where: { id: preRunClip.id },
    })).resolves.toMatchObject({
      summary: '用户原有片段',
      content: '不得修改',
    })
    const persistedRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(parseClipMap(persistedRun.clipMapJson!)).toEqual({
      'clip-001': {
        clipKey: 'clip-001',
        clipId: buildProjectedEntityId(run.id, 'Clip', 'clip-001'),
        episodeKey: 'episode-001',
        ordinal: 1,
      },
      'clip-002': {
        clipKey: 'clip-002',
        clipId: buildProjectedEntityId(run.id, 'Clip', 'clip-002'),
        episodeKey: 'episode-001',
        ordinal: 2,
      },
    })
    expect(parseArtifactHashes(persistedRun.artifactHashesJson!).screenplays)
      .toEqual({ 'episode-001': body.artifactHash })
    expect(parseEpisodeMap(persistedRun.episodeMapJson)['episode-001'].status)
      .toBe('screenplay_committed')
    expect(persistedRun).toMatchObject({
      status: 'screenplay_committed',
      currentStage: 'screenplay_committed',
    })
    await expect(Promise.all([
      prisma.novelPromotionStoryboard.count(),
      prisma.task.count(),
      prisma.taskEvent.count(),
      prisma.graphRun.count(),
      prisma.usageCost.count(),
    ])).resolves.toEqual([0, 0, 0, 0, 0])
  })

  it('same-hash retry is read-only and same-topology revision preserves IDs/createdAt without touching another run', async () => {
    const firstRun = await createReadyRun()
    const secondRun = await createReadyRun()
    const initial = screenplayRequest()
    expect((await commit(firstRun.id, 'episode-001', initial)).response.status)
      .toBe(200)
    expect((await commit(secondRun.id, 'episode-001', initial)).response.status)
      .toBe(200)
    const beforeFirst = await prisma.novelPromotionClip.findMany({
      where: { id: { in: [
        buildProjectedEntityId(firstRun.id, 'Clip', 'clip-001'),
        buildProjectedEntityId(firstRun.id, 'Clip', 'clip-002'),
      ] } },
      orderBy: { createdAt: 'asc' },
    })
    const beforeSecond = await prisma.novelPromotionClip.findMany({
      where: { id: { in: [
        buildProjectedEntityId(secondRun.id, 'Clip', 'clip-001'),
        buildProjectedEntityId(secondRun.id, 'Clip', 'clip-002'),
      ] } },
      orderBy: { createdAt: 'asc' },
    })

    const retry = await commit(firstRun.id, 'episode-001', initial)
    expect(retry.response.status).toBe(200)
    await expect(prisma.novelPromotionClip.findMany({
      where: { id: { in: beforeFirst.map((clip) => clip.id) } },
      orderBy: { createdAt: 'asc' },
    })).resolves.toEqual(beforeFirst)

    const revisedData = structuredClone(initial.data)
    revisedData.clips[0].summary = '修订后的梗概'
    revisedData.clips[0].content = '清晨，林晓拿起黑色背包出门。'
    revisedData.clips[0].screenplay.originalText = revisedData.clips[0].content
    const revised: ScreenplayCommitRequest = {
      ...initial,
      artifactHash: hashArtifact(revisedData),
      data: revisedData,
    }
    const revision = await commit(firstRun.id, 'episode-001', revised)
    expect(revision.response.status).toBe(200)
    expect(revision.payload.data.clips).toEqual(retry.payload.data.clips)
    const afterFirst = await prisma.novelPromotionClip.findMany({
      where: { id: { in: beforeFirst.map((clip) => clip.id) } },
      orderBy: { createdAt: 'asc' },
    })
    expect(afterFirst.map((clip) => clip.createdAt))
      .toEqual(beforeFirst.map((clip) => clip.createdAt))
    expect(afterFirst[0]).toMatchObject({
      summary: '修订后的梗概',
      content: '清晨，林晓拿起黑色背包出门。',
    })
    await expect(prisma.novelPromotionClip.findMany({
      where: { id: { in: beforeSecond.map((clip) => clip.id) } },
      orderBy: { createdAt: 'asc' },
    })).resolves.toEqual(beforeSecond)
  })

  it('rejects different-hash topology changes without partially updating clips or the run', async () => {
    const run = await createReadyRun()
    const initial = screenplayRequest()
    expect((await commit(run.id, 'episode-001', initial)).response.status)
      .toBe(200)
    const before = await Promise.all([
      prisma.novelPromotionClip.findMany({
        where: { id: { in: [
          buildProjectedEntityId(run.id, 'Clip', 'clip-001'),
          buildProjectedEntityId(run.id, 'Clip', 'clip-002'),
        ] } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.agentCreationRun.findUniqueOrThrow({ where: { id: run.id } }),
    ])
    const changedData = {
      ...initial.data,
      clips: [initial.data.clips[0]],
    }
    const changed = {
      ...initial,
      artifactHash: hashArtifact(changedData),
      data: changedData,
    }

    const result = await commit(run.id, 'episode-001', changed)
    expect(result.response.status).toBe(409)
    expect(result.payload.error.code).toBe('RUN_DEFINITION_CONFLICT')
    await expect(Promise.all([
      prisma.novelPromotionClip.findMany({
        where: { id: { in: before[0].map((clip) => clip.id) } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.agentCreationRun.findUniqueOrThrow({ where: { id: run.id } }),
    ])).resolves.toEqual(before)
  })

  it('rejects route/body episode mismatch, contract topology, anchors, and every invalid asset reference with zero writes', async () => {
    const run = await createReadyRun()
    const valid = screenplayRequest()
    const invalidBodies: Array<{
      body: ScreenplayCommitRequest | Record<string, unknown>
      episodeKey?: string
      code: string
    }> = []

    const wrongEpisode = structuredClone(valid.data)
    wrongEpisode.episodeKey = 'episode-002'
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(wrongEpisode),
        data: wrongEpisode,
      },
      code: 'REFERENCE_INVALID',
    })
    const wrongOrdinal = structuredClone(valid.data)
    wrongOrdinal.clips[1].ordinal = 3
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(wrongOrdinal),
        data: wrongOrdinal,
      },
      code: 'CONTRACT_INVALID',
    })
    const wrongScene = structuredClone(valid.data)
    wrongScene.clips[0].screenplay.scenes[0].sceneNumber = 2
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(wrongScene),
        data: wrongScene,
      },
      code: 'CONTRACT_INVALID',
    })
    const wrongOriginal = structuredClone(valid.data)
    wrongOriginal.clips[0].screenplay.originalText = '不相等'
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(wrongOriginal),
        data: wrongOriginal,
      },
      code: 'CONTRACT_INVALID',
    })
    const missingAnchor = structuredClone(valid.data)
    missingAnchor.clips[0].startText = '不存在'
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(missingAnchor),
        data: missingAnchor,
      },
      code: 'REFERENCE_INVALID',
    })
    const missingCharacter = structuredClone(valid.data)
    missingCharacter.clips[0].screenplay.scenes[0].content[0] = {
      type: 'dialogue',
      characterKey: 'character.missing',
      lines: '无效',
    }
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(missingCharacter),
        data: missingCharacter,
      },
      code: 'REFERENCE_INVALID',
    })
    const missingLocation = structuredClone(valid.data)
    missingLocation.clips[0].screenplay.scenes[0].heading.locationKey =
      'location.missing'
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(missingLocation),
        data: missingLocation,
      },
      code: 'REFERENCE_INVALID',
    })
    const missingProp = structuredClone(valid.data)
    missingProp.clips[0].propKeys = ['prop.missing']
    invalidBodies.push({
      body: {
        ...valid,
        artifactHash: hashArtifact(missingProp),
        data: missingProp,
      },
      code: 'REFERENCE_INVALID',
    })

    for (const item of invalidBodies) {
      const result = await commit(
        run.id,
        item.episodeKey ?? 'episode-001',
        item.body,
      )
      expect(result.response.status, JSON.stringify(result.payload)).toBeGreaterThanOrEqual(400)
      expect(result.payload.error.code).toBe(item.code)
    }
    await expect(prisma.novelPromotionClip.count({
      where: { episodeId },
    })).resolves.toBe(0)
    const persisted = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(parseClipMap(persisted.clipMapJson!)).toEqual({})
    expect(parseArtifactHashes(persisted.artifactHashesJson!).screenplays)
      .toEqual({})
  })

  it('rejects corrupted asset and clip mappings atomically instead of rebuilding them', async () => {
    const assetCorruptRun = await createReadyRun()
    const corruptAssets = structuredClone(assets)
    corruptAssets.characters['character.lin'].appearances[
      'appearance.lin.default'
    ].appearanceId = 'missing-appearance-id'
    await prisma.agentCreationRun.update({
      where: { id: assetCorruptRun.id },
      data: { assetMapJson: serializeAssetMap(corruptAssets) },
    })
    const body = screenplayRequest()
    const assetResult = await commit(
      assetCorruptRun.id,
      'episode-001',
      body,
    )
    expect(assetResult.response.status).toBe(500)
    expect(assetResult.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'assetMapJson' },
    })

    const clipCorruptRun = await createReadyRun()
    await prisma.agentCreationRun.update({
      where: { id: clipCorruptRun.id },
      data: {
        status: 'screenplay_committed',
        currentStage: 'screenplay_committed',
        episodeMapJson: serializeEpisodeMap({
          'episode-001': {
            ...definitions()[0],
            episodeId,
            episodeNumber: 1,
            status: 'screenplay_committed',
          },
        }),
        artifactHashesJson: serializeArtifactHashes({
          assets: ASSET_HASH,
          stories: { 'episode-001': STORY_HASH_1 },
          screenplays: { 'episode-001': body.artifactHash },
          storyboards: {},
        }),
        clipMapJson: serializeClipMap({}),
      },
    })
    const clipResult = await commit(
      clipCorruptRun.id,
      'episode-001',
      body,
    )
    expect(clipResult.response.status).toBe(500)
    expect(clipResult.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'clipMapJson' },
    })
    await expect(prisma.novelPromotionClip.count()).resolves.toBe(0)
  })

  it('rejects out-of-range, malformed, and null character candidate slots without writing clips', async () => {
    const outOfRangeRun = await createReadyRun()
    const outOfRangeAssets = structuredClone(assets)
    outOfRangeAssets.characters['character.lin'].appearances[
      'appearance.lin.default'
    ].variantSlots['0'].index = 999
    await prisma.agentCreationRun.update({
      where: { id: outOfRangeRun.id },
      data: { assetMapJson: serializeAssetMap(outOfRangeAssets) },
    })
    const outOfRange = await commit(
      outOfRangeRun.id,
      'episode-001',
      screenplayRequest(),
    )
    expect(outOfRange.response.status).toBe(500)
    expect(outOfRange.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'assetMapJson' },
    })

    const malformedRun = await createReadyRun()
    const appearanceId = assets.characters[
      'character.lin'
    ].appearances['appearance.lin.default'].appearanceId
    await prisma.characterAppearance.update({
      where: { id: appearanceId },
      data: { imageUrls: '{broken' },
    })
    const malformed = await commit(
      malformedRun.id,
      'episode-001',
      screenplayRequest(),
    )
    expect(malformed.response.status).toBe(500)
    expect(malformed.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'assetMapJson' },
    })

    const nullRun = await createReadyRun()
    await prisma.characterAppearance.update({
      where: { id: appearanceId },
      data: { imageUrls: null },
    })
    const nullCandidate = await commit(
      nullRun.id,
      'episode-001',
      screenplayRequest(),
    )
    expect(nullCandidate.response.status).toBe(500)
    expect(nullCandidate.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'assetMapJson' },
    })
    await expect(prisma.novelPromotionClip.count()).resolves.toBe(0)
  })

  it('rejects another committed episode whose non-empty screenplay hash has no clip mapping', async () => {
    const run = await createReadyRun({ includeSecond: true })
    const second = secondEpisodeRequest()
    await prisma.agentCreationRun.update({
      where: { id: run.id },
      data: {
        currentStage: 'screenplay_committing:1/2',
        episodeMapJson: serializeEpisodeMap({
          'episode-001': {
            ...definitions(true)[0],
            episodeId,
            episodeNumber: 1,
            status: 'story_committed',
          },
          'episode-002': {
            ...definitions(true)[1],
            episodeId: secondEpisodeId,
            episodeNumber: 2,
            status: 'screenplay_committed',
          },
        }),
        artifactHashesJson: serializeArtifactHashes({
          assets: ASSET_HASH,
          stories: {
            'episode-001': STORY_HASH_1,
            'episode-002': STORY_HASH_2,
          },
          screenplays: { 'episode-002': second.artifactHash },
          storyboards: {},
        }),
      },
    })
    const beforeRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })

    const result = await commit(
      run.id,
      'episode-001',
      screenplayRequest(),
    )
    expect(result.response.status).toBe(500)
    expect(result.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'clipMapJson' },
    })
    await expect(prisma.novelPromotionClip.count()).resolves.toBe(0)
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })).resolves.toEqual(beforeRun)
  })

  it('rejects an orphan clip mapping on another uncommitted episode', async () => {
    const run = await createReadyRun({ includeSecond: true })
    const orphanId = buildProjectedEntityId(run.id, 'Clip', 'clip-201')
    await prisma.novelPromotionClip.create({
      data: {
        id: orphanId,
        episodeId: secondEpisodeId,
        summary: '孤儿映射',
        content: '不得存在',
      },
    })
    await prisma.agentCreationRun.update({
      where: { id: run.id },
      data: {
        clipMapJson: serializeClipMap({
          'clip-201': {
            clipKey: 'clip-201',
            clipId: orphanId,
            episodeKey: 'episode-002',
            ordinal: 1,
          },
        }),
      },
    })
    const beforeRun = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })

    const result = await commit(
      run.id,
      'episode-001',
      screenplayRequest(),
    )
    expect(result.response.status).toBe(500)
    expect(result.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'clipMapJson' },
    })
    await expect(prisma.novelPromotionClip.findMany()).resolves.toHaveLength(1)
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })).resolves.toEqual(beforeRun)
  })

  it('accepts an intentionally empty committed episode only with its exact empty artifact hash', async () => {
    const run = await createReadyRun()
    const emptyData: ScreenplayCommitRequest['data'] = {
      episodeKey: 'episode-001',
      clips: [],
    }
    const body: ScreenplayCommitRequest = {
      schemaVersion: 1,
      ruleSetVersion: 'waoo-creator-v1',
      ruleSetHash: RULE_SET_HASH,
      artifactHash: hashArtifact(emptyData),
      dryRun: false,
      data: emptyData,
    }

    const first = await commit(run.id, 'episode-001', body)
    const retry = await commit(run.id, 'episode-001', body)
    expect(first.response.status).toBe(200)
    expect(retry.response.status).toBe(200)
    expect(first.payload.data.clips).toEqual([])
    expect(retry.payload.data).toEqual(first.payload.data)
    const persisted = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(parseClipMap(persisted.clipMapJson!)).toEqual({})
    expect(parseArtifactHashes(persisted.artifactHashesJson!).screenplays)
      .toEqual({ 'episode-001': body.artifactHash })
    expect(parseEpisodeMap(persisted.episodeMapJson)['episode-001'].status)
      .toBe('screenplay_committed')
  })

  it('rejects a persisted partial-stage counter that disagrees with the episode map', async () => {
    const run = await createReadyRun()
    await prisma.agentCreationRun.update({
      where: { id: run.id },
      data: { currentStage: 'screenplay_committing:9/9' },
    })

    const result = await commit(
      run.id,
      'episode-001',
      screenplayRequest(),
    )
    expect(result.response.status).toBe(500)
    expect(result.payload.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      details: { field: 'currentStage' },
    })
    await expect(prisma.novelPromotionClip.count()).resolves.toBe(0)
  })

  it('keeps multi-episode status partial until every screenplay is committed', async () => {
    const run = await createReadyRun({ includeSecond: true })
    const first = screenplayRequest()
    expect((await commit(run.id, 'episode-001', first)).response.status)
      .toBe(200)
    const partial = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(partial).toMatchObject({
      status: 'assets_committed',
      currentStage: 'screenplay_committing:1/2',
    })
    expect(parseEpisodeMap(partial.episodeMapJson)).toMatchObject({
      'episode-001': { status: 'screenplay_committed' },
      'episode-002': { status: 'story_committed' },
    })

    const second = secondEpisodeRequest()
    expect((await commit(run.id, 'episode-002', second)).response.status)
      .toBe(200)
    const complete = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(complete).toMatchObject({
      status: 'screenplay_committed',
      currentStage: 'screenplay_committed',
    })
    expect(parseArtifactHashes(complete.artifactHashesJson!).screenplays)
      .toEqual({
        'episode-001': first.artifactHash,
        'episode-002': second.artifactHash,
      })
  })

  it('requires the exact artifact hash as Idempotency-Key', async () => {
    const run = await createReadyRun()
    const body = screenplayRequest()
    const result = await commit(
      run.id,
      'episode-001',
      body,
      `sha256:${'f'.repeat(64)}`,
    )
    expect(result.response.status).toBe(400)
    expect(result.payload.error).toMatchObject({
      code: 'CONTRACT_INVALID',
      field: 'Idempotency-Key',
    })
  })
})
