import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as STORYBOARD_ROUTE from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/storyboards/route'
import { hashArtifact } from '@/lib/agent-api/canonical-json'
import type { StoryboardsCommitRequest } from '@/lib/agent-api/contracts/storyboards'
import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import {
  parseArtifactHashes,
  parseEpisodeMap,
  parseStoryboardMap,
  serializeArtifactHashes,
  serializeAssetMap,
  serializeClipMap,
  serializeEpisodeMap,
  serializeStoryboardMap,
  type AssetMap,
  type ClipMap,
} from '@/lib/agent-api/run-state'
import { parsePanelFrameDependencyPlan } from '@/lib/novel-promotion/panel-tail-reference'
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
const RULE_HASH = `sha256:${'a'.repeat(64)}`
const ASSET_HASH = `sha256:${'b'.repeat(64)}`
const STORY_HASH = `sha256:${'c'.repeat(64)}`
const SCREENPLAY_HASH = `sha256:${'d'.repeat(64)}`
const SOURCE_HASH = `sha256:${'e'.repeat(64)}`

let userId: string
let projectId: string
let novelProjectId: string
let episodeId: string
let characterId: string
let appearanceId: string
let locationId: string
let propId: string

function definitions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    episodeKey: `episode-${String(index + 1).padStart(3, '0')}`,
    ordinal: index + 1,
    sourceHash: SOURCE_HASH,
    name: `第${index + 1}集`,
  }))
}

async function createReadyRun(options: {
  episodeCount?: number
  clipsPerEpisode?: number
} = {}) {
  const episodeCount = options.episodeCount ?? 1
  const clipsPerEpisode = options.clipsPerEpisode ?? 1
  const runId = crypto.randomUUID()
  const definition = definitions(episodeCount)
  const episodeRows = [{
    id: episodeId,
    episodeNumber: 1,
    name: '第1集',
  }]
  for (let index = 1; index < episodeCount; index += 1) {
    const row = await createFixtureEpisode(novelProjectId, index + 1)
    await prisma.novelPromotionEpisode.update({
      where: { id: row.id },
      data: { name: `第${index + 1}集` },
    })
    episodeRows.push({
      id: row.id,
      episodeNumber: index + 1,
      name: `第${index + 1}集`,
    })
  }

  const candidateIndex = 0
  await prisma.characterAppearance.update({
    where: { id: appearanceId },
    data: { imageUrls: JSON.stringify(['']) },
  })
  const locationImageId = buildProjectedEntityId(
    runId,
    'LocationImage',
    'location.home:0',
  )
  const propImageId = buildProjectedEntityId(
    runId,
    'LocationImage',
    'prop.bag:0',
  )
  await prisma.locationImage.createMany({
    data: [{
      id: locationImageId,
      locationId,
      imageIndex: 0,
    }, {
      id: propImageId,
      locationId: propId,
      imageIndex: 0,
    }],
  })
  const assets: AssetMap = {
    characters: {
      'character.lin': {
        characterKey: 'character.lin',
        characterId,
        reused: true,
        appearances: {
          'appearance.lin.default': {
            appearanceKey: 'appearance.lin.default',
            appearanceId,
            appearanceIndex: 0,
            reused: true,
            variantSlots: {
              0: {
                entityId: buildAppearanceCandidateOwnerId(
                  runId,
                  'appearance.lin.default',
                  0,
                  candidateIndex,
                ),
                index: candidateIndex,
              },
            },
          },
        },
      },
    },
    locations: {
      'location.home': {
        assetKey: 'location.home',
        entityId: locationId,
        reused: true,
        imageSlots: {
          0: { entityId: locationImageId, index: 0 },
        },
      },
    },
    props: {
      'prop.bag': {
        assetKey: 'prop.bag',
        entityId: propId,
        reused: true,
        imageSlots: {
          0: { entityId: propImageId, index: 0 },
        },
      },
    },
  }
  const clipMap: ClipMap = {}
  const clips = []
  for (let episodeIndex = 0; episodeIndex < episodeCount; episodeIndex += 1) {
    const episodeKey = definition[episodeIndex].episodeKey
    for (let clipIndex = 0; clipIndex < clipsPerEpisode; clipIndex += 1) {
      const clipKey = `clip-${episodeIndex + 1}-${String(clipIndex + 1).padStart(3, '0')}`
      const clipId = buildProjectedEntityId(runId, 'Clip', clipKey)
      clipMap[clipKey] = {
        clipKey,
        clipId,
        episodeKey,
        ordinal: clipIndex + 1,
      }
      clips.push({
        id: clipId,
        episodeId: episodeRows[episodeIndex].id,
        summary: `片段${clipIndex + 1}`,
        content: `内容${clipIndex + 1}`,
      })
    }
  }
  if (clips.length > 0) {
    await prisma.novelPromotionClip.createMany({ data: clips })
  }
  const episodeMap = Object.fromEntries(definition.map((entry, index) => [
    entry.episodeKey,
    {
      ...entry,
      episodeId: episodeRows[index].id,
      episodeNumber: index + 1,
      status: 'screenplay_committed' as const,
    },
  ]))
  const run = await prisma.agentCreationRun.create({
    data: {
      id: runId,
      userId,
      projectId,
      sourceHash: SOURCE_HASH,
      runFingerprint: `storyboard-${crypto.randomUUID()}`,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: '{}',
      ruleSetVersion: 'waoo-creator-v1',
      ruleSetHash: RULE_HASH,
      definitionHash: hashArtifact(definition),
      status: 'screenplay_committed',
      currentStage: 'screenplay_committed',
      episodeMapJson: serializeEpisodeMap(episodeMap),
      assetMapJson: serializeAssetMap(assets),
      clipMapJson: serializeClipMap(clipMap),
      storyboardMapJson: serializeStoryboardMap({
        storyboards: {},
        panels: {},
        frames: {},
      }),
      artifactHashesJson: serializeArtifactHashes({
        assets: ASSET_HASH,
        stories: Object.fromEntries(definition.map((entry) => [
          entry.episodeKey,
          STORY_HASH,
        ])),
        screenplays: Object.fromEntries(definition.map((entry) => [
          entry.episodeKey,
          clipsPerEpisode === 0
            ? hashArtifact({ episodeKey: entry.episodeKey, clips: [] })
            : SCREENPLAY_HASH,
        ])),
        storyboards: {},
      }),
    },
  })
  return { run, clipMap, episodeRows }
}

function storyboardRequest(options: {
  episodeKey?: string
  clipKeys?: string[]
  panelCount?: number
  revision?: number
  dryRun?: boolean
} = {}): StoryboardsCommitRequest {
  const episodeKey = options.episodeKey ?? 'episode-001'
  const clipKeys = options.clipKeys ?? ['clip-1-001']
  const revision = options.revision ?? 1
  const panelCount = options.panelCount ?? 2
  const storyboards = clipKeys.map((clipKey) => ({
    storyboardKey: `storyboard-${clipKey}`,
    clipKey,
    photographyPlan: {
      visualStrategy: `写实摄影修订${revision}`,
      continuityRules: ['保持轴线'],
      rules: panelCount === 0 ? [] : [{
        panelNumber: 1,
        composition: '三分构图',
        lighting: '侧光',
        colorPalette: '冷色',
        atmosphere: '紧张',
        technicalNotes: '35mm',
        characters: [{
          characterKey: 'character.lin',
          blocking: '画面左侧',
        }],
      }],
    },
    actingDirections: panelCount === 0 ? [] : [{
      panelNumber: 1,
      characters: [{
        characterKey: 'character.lin',
        acting: '克制地观察',
      }],
    }],
    panels: Array.from({ length: panelCount }, (_, panelIndex) => {
      const panelNumber = panelIndex + 1
      const panelKey = `panel-${clipKey}-${panelNumber}`
      const previousTail = panelIndex > 0
        ? `frame-${clipKey}-${panelIndex}-2`
        : null
      return {
        panelKey,
        panelNumber,
        description: `镜头${panelNumber}修订${revision}`,
        characters: [{
          characterKey: 'character.lin',
          appearanceKey: 'appearance.lin.default',
          slot: 'left',
        }],
        propKeys: ['prop.bag'],
        locationKey: 'location.home',
        sceneType: '室内',
        sourceText: `镜头原文${panelNumber}`,
        shotType: panelIndex === 0 ? '中景' : '特写',
        cameraMove: panelIndex === 0 ? '固定' : '推进',
        videoPrompt: `镜头动态${panelNumber}修订${revision}`,
        durationSec: 6,
        panelMode: (panelIndex === 0 ? 'single' : 'group') as 'single' | 'group',
        groupVideoPrompt: panelIndex === 0
          ? null
          : `组视频提示${panelNumber}`,
        usePreviousPanelTailAsReference: panelIndex > 0,
        frames: [{
          frameKey: `frame-${clipKey}-${panelNumber}-1`,
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'hero' as const,
          dependencyFrameKeys: [],
          imagePrompt: `首帧提示${panelNumber}修订${revision}`,
          videoPrompt: `首帧视频${panelNumber}`,
          referencePolicy: {
            orderedReferences: [
              ...(previousTail ? [{
                kind: 'previous-panel-tail' as const,
                targetKey: previousTail,
              }] : []),
              { kind: 'location' as const, targetKey: 'location.home' },
              {
                kind: 'character-appearance' as const,
                targetKey: 'appearance.lin.default',
              },
              { kind: 'prop' as const, targetKey: 'prop.bag' },
            ],
          },
        }, {
          frameKey: `frame-${clipKey}-${panelNumber}-2`,
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'detail' as const,
          dependencyFrameKeys: [`frame-${clipKey}-${panelNumber}-1`],
          imagePrompt: `尾帧提示${panelNumber}修订${revision}`,
          videoPrompt: `尾帧视频${panelNumber}`,
          referencePolicy: {
            orderedReferences: [{
              kind: 'frame' as const,
              targetKey: `frame-${clipKey}-${panelNumber}-1`,
            }],
          },
        }],
      }
    }),
  }))
  const data = { episodeKey, storyboards }
  return {
    schemaVersion: 1,
    ruleSetVersion: 'waoo-creator-v1',
    ruleSetHash: RULE_HASH,
    artifactHash: hashArtifact(data),
    dryRun: options.dryRun ?? false,
    data,
  }
}

function headers(hash: string) {
  return {
    Authorization: 'Bearer integration-agent-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': hash,
    'X-Waoo-User-Id': userId,
    'X-Request-Id': `req-storyboard-${crypto.randomUUID()}`,
  }
}

async function commit(
  runId: string,
  episodeKey: string,
  body: StoryboardsCommitRequest | Record<string, unknown>,
) {
  const response = await STORYBOARD_ROUTE.PUT(new Request(
    `http://localhost/api/agent/v1/runs/${runId}/episodes/${episodeKey}/storyboards`,
    {
      method: 'PUT',
      headers: headers(body.artifactHash as string),
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ runId, episodeKey }),
  })
  return { response, payload: await response.json() }
}

describe('Agent storyboard commit with MySQL', () => {
  beforeEach(async () => {
    await resetSystemState()
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const episode = await createFixtureEpisode(novelProject.id, 1)
    await prisma.novelPromotionEpisode.update({
      where: { id: episode.id },
      data: { name: '第1集' },
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
        changeReason: '默认造型',
        imageUrls: JSON.stringify(['']),
      },
    })
    const location = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '林家',
        assetKind: 'location',
      },
    })
    const prop = await prisma.novelPromotionLocation.create({
      data: {
        novelPromotionProjectId: novelProject.id,
        name: '黑色背包',
        assetKind: 'prop',
      },
    })
    userId = user.id
    projectId = project.id
    novelProjectId = novelProject.id
    episodeId = episode.id
    characterId = character.id
    appearanceId = appearance.id
    locationId = location.id
    propId = prop.id
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

  it('exports only PUT', () => {
    expect(typeof STORYBOARD_ROUTE.PUT).toBe('function')
    expect('POST' in STORYBOARD_ROUTE).toBe(false)
  })

  it('dry-runs stable IDs with zero writes, then commits page-compatible fields without side effects', async () => {
    const { run } = await createReadyRun()
    const dry = storyboardRequest({ dryRun: true })
    const dryResult = await commit(run.id, 'episode-001', dry)
    expect(dryResult.response.status).toBe(200)
    const dryData = dryResult.payload.data
    expect(dryData.storyboards[0].storyboardId).toBe(
      buildProjectedEntityId(run.id, 'Storyboard', 'storyboard-clip-1-001'),
    )
    expect(await prisma.novelPromotionStoryboard.count()).toBe(0)
    expect(await prisma.novelPromotionPanel.count()).toBe(0)
    expect(await prisma.novelPromotionPanelFrame.count()).toBe(0)

    const body = { ...dry, dryRun: false }
    const result = await commit(run.id, 'episode-001', body)
    expect(result.response.status).toBe(200)
    expect(result.payload.data.storyboards).toEqual(dryData.storyboards)

    const storyboard = await prisma.novelPromotionStoryboard.findFirstOrThrow({
      include: {
        clip: true,
        panels: {
          orderBy: { panelIndex: 'asc' },
          include: { frames: { orderBy: { frameIndex: 'asc' } } },
        },
      },
    })
    expect(storyboard.panelCount).toBe(2)
    expect(storyboard.clip.shotCount).toBe(2)
    expect(JSON.parse(storyboard.storyboardTextJson ?? '{}').storyboardKey)
      .toBe('storyboard-clip-1-001')
    expect(JSON.parse(storyboard.photographyPlan ?? '{}').visualStrategy)
      .toContain('修订1')
    expect(storyboard.storyboardImageUrl).toBeNull()
    const first = storyboard.panels[0]
    expect(first).toMatchObject({
      panelIndex: 0,
      panelNumber: 1,
      location: '林家',
      props: JSON.stringify(['黑色背包']),
      srtSegment: '镜头原文1',
      sceneType: '室内',
      duration: 6,
      panelMode: 'single',
      groupDurationSec: null,
      imagePrompt: '首帧提示1修订1',
      imageUrl: null,
      videoUrl: null,
    })
    expect(JSON.parse(first.characters ?? '[]')).toEqual([{
      name: '林晓',
      appearance: '默认造型',
      slot: 'left',
    }])
    expect(first.groupPlanJson).toBeNull()
    expect(JSON.parse(
      storyboard.panels[1].groupPlanJson ?? '{}',
    ).frames).toHaveLength(2)
    expect(JSON.parse(first.photographyRules ?? '{}').panelNumber).toBe(1)
    expect(JSON.parse(first.actingNotes ?? '{}').panelNumber).toBe(1)
    expect(parsePanelFrameDependencyPlan(
      storyboard.panels[1].frames[0].dependencyFrameIds,
    )).toEqual({ frameIndexes: [], previousTail: true })
    expect(parsePanelFrameDependencyPlan(
      storyboard.panels[0].frames[1].dependencyFrameIds,
    )).toEqual({ frameIndexes: [0], previousTail: false })
    expect(storyboard.panels.flatMap((panel) => panel.frames).every(
      (frame) => frame.imageUrl === null
        && frame.imageMediaId === null
        && frame.generationStatus === null,
    )).toBe(true)
    expect(await prisma.task.count()).toBe(0)
    expect(await prisma.taskEvent.count()).toBe(0)
    expect(await prisma.graphRun.count()).toBe(0)
    expect(await prisma.usageCost.count()).toBe(0)
  })

  it('same-hash retry is write-free and a same-topology revision preserves media and identities', async () => {
    const { run } = await createReadyRun()
    const first = storyboardRequest()
    expect((await commit(run.id, 'episode-001', first)).response.status).toBe(200)
    const mapped = parseStoryboardMap(
      (await prisma.agentCreationRun.findUniqueOrThrow({
        where: { id: run.id },
      })).storyboardMapJson ?? '',
    )
    const panelId = mapped.panels['panel-clip-1-001-1'].panelId
    const frameId = mapped.frames['frame-clip-1-001-1-1'].frameId
    await prisma.novelPromotionPanel.update({
      where: { id: panelId },
      data: {
        imageUrl: 'media/panel.png',
        candidateImages: '["media/panel.png"]',
      },
    })
    await prisma.novelPromotionPanelFrame.update({
      where: { id: frameId },
      data: {
        imageUrl: 'media/frame.png',
        generationStatus: 'completed',
      },
    })
    const before = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await commit(run.id, 'episode-001', first)).response.status).toBe(200)
    const afterRetry = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(afterRetry.updatedAt).toEqual(before.updatedAt)

    const revision = storyboardRequest({ revision: 2 })
    expect((await commit(run.id, 'episode-001', revision)).response.status).toBe(200)
    expect(await prisma.novelPromotionPanel.findUniqueOrThrow({
      where: { id: panelId },
    })).toMatchObject({
      description: '镜头1修订2',
      imageUrl: 'media/panel.png',
      candidateImages: '["media/panel.png"]',
    })
    expect(await prisma.novelPromotionPanelFrame.findUniqueOrThrow({
      where: { id: frameId },
    })).toMatchObject({
      imagePrompt: '首帧提示1修订2',
      imageUrl: 'media/frame.png',
      generationStatus: 'completed',
    })
  })

  it('rejects topology revisions and corrupted maps without deleting existing rows', async () => {
    const { run } = await createReadyRun()
    const first = storyboardRequest()
    await commit(run.id, 'episode-001', first)
    const conflict = storyboardRequest()
    conflict.data.storyboards[0].panels[1].frames[1].frameKey =
      'frame-reordered'
    conflict.artifactHash = hashArtifact(conflict.data)
    const rejected = await commit(run.id, 'episode-001', conflict)
    expect(rejected.response.status).toBe(409)
    expect(rejected.payload.error.code).toBe('RUN_DEFINITION_CONFLICT')
    expect(await prisma.novelPromotionPanelFrame.count()).toBe(4)

    const stored = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    const mapping = parseStoryboardMap(stored.storyboardMapJson ?? '')
    delete mapping.frames['frame-clip-1-001-1-1']
    await prisma.agentCreationRun.update({
      where: { id: run.id },
      data: { storyboardMapJson: serializeStoryboardMap(mapping) },
    })
    const corrupt = await commit(run.id, 'episode-001', first)
    expect(corrupt.response.status).toBe(500)
    expect(corrupt.payload.error.code).toBe('AGENT_INTERNAL_ERROR')
  })

  it('keeps partial multi-episode progress and advances only after all episodes commit', async () => {
    const { run } = await createReadyRun({ episodeCount: 2 })
    expect((await commit(
      run.id,
      'episode-001',
      storyboardRequest(),
    )).response.status).toBe(200)
    let stored = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(stored.status).toBe('screenplay_committed')
    expect(stored.currentStage).toBe('storyboard_committing:1/2')
    expect(parseEpisodeMap(stored.episodeMapJson)['episode-001'].status)
      .toBe('storyboards_committed')

    expect((await commit(
      run.id,
      'episode-002',
      storyboardRequest({
        episodeKey: 'episode-002',
        clipKeys: ['clip-2-001'],
      }),
    )).response.status).toBe(200)
    stored = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: run.id },
    })
    expect(stored.status).toBe('storyboards_committed')
    expect(stored.currentStage).toBe('storyboards_committed')
    expect(Object.keys(parseArtifactHashes(
      stored.artifactHashesJson ?? '',
    ).storyboards)).toHaveLength(2)
  })

  it('accepts an exact empty artifact for an episode with no clips', async () => {
    const { run } = await createReadyRun({ clipsPerEpisode: 0 })
    const empty = storyboardRequest({ clipKeys: [], panelCount: 0 })
    const result = await commit(run.id, 'episode-001', empty)
    expect(result.response.status).toBe(200)
    expect(result.payload.data.storyboards).toEqual([])
    expect(await prisma.novelPromotionStoryboard.count()).toBe(0)
  })

  it('does not touch pre-run storyboard data in the same episode', async () => {
    const preRunClip = await prisma.novelPromotionClip.create({
      data: {
        episodeId,
        summary: '用户已有片段',
        content: '不得修改',
        shotCount: 7,
      },
    })
    const preRunStoryboard = await prisma.novelPromotionStoryboard.create({
      data: {
        episodeId,
        clipId: preRunClip.id,
        panelCount: 1,
        storyboardTextJson: '{"owner":"user"}',
      },
    })
    const preRunPanel = await prisma.novelPromotionPanel.create({
      data: {
        storyboardId: preRunStoryboard.id,
        panelIndex: 0,
        description: '用户已有分镜',
        imageUrl: 'media/user-panel.png',
      },
    })
    await prisma.novelPromotionPanelFrame.create({
      data: {
        panelId: preRunPanel.id,
        frameIndex: 0,
        frameTimeSec: 0,
        imageUrl: 'media/user-frame.png',
        generationStatus: 'completed',
      },
    })

    const { run } = await createReadyRun()
    expect((await commit(
      run.id,
      'episode-001',
      storyboardRequest(),
    )).response.status).toBe(200)
    expect(await prisma.novelPromotionClip.findUniqueOrThrow({
      where: { id: preRunClip.id },
    })).toMatchObject({
      content: '不得修改',
      shotCount: 7,
    })
    expect(await prisma.novelPromotionStoryboard.findUniqueOrThrow({
      where: { id: preRunStoryboard.id },
    })).toMatchObject({
      panelCount: 1,
      storyboardTextJson: '{"owner":"user"}',
    })
    expect(await prisma.novelPromotionPanel.findUniqueOrThrow({
      where: { id: preRunPanel.id },
    })).toMatchObject({
      description: '用户已有分镜',
      imageUrl: 'media/user-panel.png',
    })
  })

  it('uses bulk writes for a representative large MySQL artifact', async () => {
    const clipCount = 120
    const { run } = await createReadyRun({ clipsPerEpisode: clipCount })
    const clipKeys = Array.from(
      { length: clipCount },
      (_, index) => `clip-1-${String(index + 1).padStart(3, '0')}`,
    )
    const body = storyboardRequest({ clipKeys, panelCount: 3 })
    const result = await commit(run.id, 'episode-001', body)
    expect(result.response.status).toBe(200)
    expect(await prisma.novelPromotionStoryboard.count()).toBe(clipCount)
    expect(await prisma.novelPromotionPanel.count()).toBe(clipCount * 3)
    expect(await prisma.novelPromotionPanelFrame.count()).toBe(clipCount * 6)
  })
})
