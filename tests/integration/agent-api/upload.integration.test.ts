import sharp from 'sharp'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const storageMock = vi.hoisted(() => ({
  uploadObject: vi.fn(async (_body: Buffer, key: string) => key),
}))

vi.mock('@/lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage')>(),
  uploadObject: storageMock.uploadObject,
}))

import { POST } from '@/app/api/agent/v1/runs/[runId]/uploads/route'
import { sha256Prefixed } from '@/lib/agent-api/canonical-json'
import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import { uploadIdempotencyKey } from '@/lib/agent-api/idempotency'
import {
  parseUploadReceipts,
  serializeAssetMap,
  serializeStoryboardMap,
  serializeUploadReceipts,
  type AssetMap,
  type StoryboardMap,
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
  WAOO_AGENT_UPLOAD_MAX_BYTES: process.env.WAOO_AGENT_UPLOAD_MAX_BYTES,
}

type Fixture = Awaited<ReturnType<typeof createReadyFixture>>
let fixture: Fixture

async function image(color: string, format: 'png' | 'jpeg' = 'png') {
  const pipeline = sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: color,
    },
  })
  return format === 'png'
    ? pipeline.png().toBuffer()
    : pipeline.jpeg().toBuffer()
}

async function createReadyFixture() {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const runId = crypto.randomUUID()
  const episode = await createFixtureEpisode(novelProject.id)
  const clip = await prisma.novelPromotionClip.create({
    data: {
      episodeId: episode.id,
      summary: '片段',
      content: '内容',
    },
  })
  const storyboard = await prisma.novelPromotionStoryboard.create({
    data: {
      id: buildProjectedEntityId(runId, 'Storyboard', 'storyboard.main'),
      episodeId: episode.id,
      clipId: clip.id,
      panelCount: 1,
    },
  })
  const panel = await prisma.novelPromotionPanel.create({
    data: {
      id: buildProjectedEntityId(runId, 'Panel', 'panel.main'),
      storyboardId: storyboard.id,
      panelIndex: 0,
      imageUrl: 'old/panel.jpg',
    },
  })
  const firstFrame = await prisma.novelPromotionPanelFrame.create({
    data: {
      id: buildProjectedEntityId(runId, 'Frame', 'frame.first'),
      panelId: panel.id,
      frameIndex: 0,
      frameTimeSec: 0,
    },
  })
  const secondFrame = await prisma.novelPromotionPanelFrame.create({
    data: {
      id: buildProjectedEntityId(runId, 'Frame', 'frame.second'),
      panelId: panel.id,
      frameIndex: 1,
      frameTimeSec: 1,
    },
  })

  const character = await prisma.novelPromotionCharacter.create({
    data: {
      novelPromotionProjectId: novelProject.id,
      name: '林默',
    },
  })
  const appearance = await prisma.characterAppearance.create({
    data: {
      characterId: character.id,
      appearanceIndex: 0,
      changeReason: '默认',
      imageUrl: 'old/character.jpg',
      imageUrls: JSON.stringify(['old/character.jpg', '']),
      selectedIndex: 0,
    },
  })
  const newAppearance = await prisma.characterAppearance.create({
    data: {
      id: buildProjectedEntityId(runId, 'Appearance', 'appearance.lin.rain'),
      characterId: character.id,
      appearanceIndex: 1,
      changeReason: '雨夜',
      imageUrls: JSON.stringify(['']),
    },
  })
  const location = await prisma.novelPromotionLocation.create({
    data: {
      id: buildProjectedEntityId(runId, 'Location', 'location.home'),
      novelPromotionProjectId: novelProject.id,
      name: '家',
      assetKind: 'location',
    },
  })
  const locationSlot = await prisma.locationImage.create({
    data: {
      id: buildProjectedEntityId(runId, 'LocationImage', 'location.home:0'),
      locationId: location.id,
      imageIndex: 0,
    },
  })
  const locationSlotTwo = await prisma.locationImage.create({
    data: {
      id: buildProjectedEntityId(runId, 'LocationImage', 'location.home:1'),
      locationId: location.id,
      imageIndex: 1,
    },
  })
  const prop = await prisma.novelPromotionLocation.create({
    data: {
      novelPromotionProjectId: novelProject.id,
      name: '包',
      assetKind: 'prop',
    },
  })
  const propHistorical = await prisma.locationImage.create({
    data: {
      locationId: prop.id,
      imageIndex: 0,
      imageUrl: 'old/prop.jpg',
      isSelected: true,
    },
  })
  await prisma.novelPromotionLocation.update({
    where: { id: prop.id },
    data: { selectedImageId: propHistorical.id },
  })
  const propSlot = await prisma.locationImage.create({
    data: {
      id: buildProjectedEntityId(runId, 'LocationImage', 'prop.bag:0'),
      locationId: prop.id,
      imageIndex: 1,
    },
  })
  const assets: AssetMap = {
    characters: {
      'character.lin': {
        characterKey: 'character.lin',
        characterId: character.id,
        reused: true,
        appearances: {
          'appearance.lin.default': {
            appearanceKey: 'appearance.lin.default',
            appearanceId: appearance.id,
            appearanceIndex: 0,
            reused: true,
            variantSlots: {
              0: {
                entityId: buildAppearanceCandidateOwnerId(
                  runId,
                  'appearance.lin.default',
                  0,
                  1,
                ),
                index: 1,
              },
            },
          },
          'appearance.lin.rain': {
            appearanceKey: 'appearance.lin.rain',
            appearanceId: newAppearance.id,
            appearanceIndex: 1,
            reused: false,
            variantSlots: {
              0: {
                entityId: buildAppearanceCandidateOwnerId(
                  runId,
                  'appearance.lin.rain',
                  0,
                  0,
                ),
                index: 0,
              },
            },
          },
        },
      },
    },
    locations: {
      'location.home': {
        assetKey: 'location.home',
        entityId: location.id,
        reused: false,
        imageSlots: {
          0: { entityId: locationSlot.id, index: 0 },
          1: { entityId: locationSlotTwo.id, index: 1 },
        },
      },
    },
    props: {
      'prop.bag': {
        assetKey: 'prop.bag',
        entityId: prop.id,
        reused: true,
        imageSlots: {
          0: { entityId: propSlot.id, index: 1 },
        },
      },
    },
  }
  const storyboards: StoryboardMap = {
    storyboards: {
      'storyboard.main': {
        storyboardKey: 'storyboard.main',
        storyboardId: storyboard.id,
        episodeKey: 'episode-001',
        clipKey: 'clip-001',
      },
    },
    panels: {
      'panel.main': {
        panelKey: 'panel.main',
        panelId: panel.id,
        storyboardKey: 'storyboard.main',
        panelIndex: 0,
      },
    },
    frames: {
      'frame.first': {
        frameKey: 'frame.first',
        frameId: firstFrame.id,
        panelKey: 'panel.main',
        frameIndex: 0,
      },
      'frame.second': {
        frameKey: 'frame.second',
        frameId: secondFrame.id,
        panelKey: 'panel.main',
        frameIndex: 1,
      },
    },
  }
  const run = await prisma.agentCreationRun.create({
    data: {
      id: runId,
      userId: user.id,
      projectId: project.id,
      sourceHash: `sha256:${'a'.repeat(64)}`,
      runFingerprint: `upload-${crypto.randomUUID()}`,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: '{}',
      ruleSetVersion: 'test-v1',
      ruleSetHash: `sha256:${'b'.repeat(64)}`,
      definitionHash: `sha256:${'c'.repeat(64)}`,
      status: 'storyboards_committed',
      currentStage: 'storyboards_committed',
      episodeMapJson: '{}',
      assetMapJson: serializeAssetMap(assets),
      storyboardMapJson: serializeStoryboardMap(storyboards),
      receiptJson: serializeUploadReceipts([]),
    },
  })
  return {
    user,
    run,
    appearance,
    newAppearance,
    location,
    locationSlot,
    locationSlotTwo,
    prop,
    propHistorical,
    propSlot,
    panel,
    firstFrame,
    secondFrame,
  }
}

async function upload(options: {
  targetType: 'character-appearance' | 'location-image' | 'prop-image' | 'panel-frame'
  targetKey: string
  variantIndex?: number
  raw?: Buffer
  mime?: string
  contentSha256?: string
  extraField?: [string, string]
  duplicateTargetType?: boolean
  omitIdempotency?: boolean
}) {
  const raw = options.raw ?? await image('#ff0000')
  const variantIndex = options.variantIndex ?? 0
  const contentSha256 = options.contentSha256 ?? sha256Prefixed(raw)
  const form = new FormData()
  form.set('targetType', options.targetType)
  form.set('targetKey', options.targetKey)
  form.set('variantIndex', String(variantIndex))
  form.set('contentSha256', contentSha256)
  if (options.extraField) form.set(...options.extraField)
  if (options.duplicateTargetType) {
    form.append('targetType', options.targetType)
  }
  form.set(
    'file',
    new Blob([
      raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      ) as ArrayBuffer,
    ], { type: options.mime ?? 'image/png' }),
    'image.png',
  )
  const headers: Record<string, string> = {
    authorization: 'Bearer integration-agent-token',
    'x-waoo-user-id': fixture.user.id,
  }
  if (!options.omitIdempotency) {
    headers['idempotency-key'] = uploadIdempotencyKey({
      runId: fixture.run.id,
      targetType: options.targetType,
      targetKey: options.targetKey,
      variantIndex,
      contentSha256,
    })
  }
  const request = new Request(
    `http://localhost/api/agent/v1/runs/${fixture.run.id}/uploads`,
    {
      method: 'POST',
      headers,
      body: form,
    },
  )
  const response = await POST(request, {
    params: Promise.resolve({ runId: fixture.run.id }),
  })
  return {
    response,
    payload: await response.json(),
  }
}

describe('Agent generated image upload', () => {
  beforeEach(async () => {
    await resetSystemState()
    vi.clearAllMocks()
    fixture = await createReadyFixture()
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'integration-agent-token'
    process.env.WAOO_AGENT_USER_ID = fixture.user.id
    process.env.WAOO_AGENT_UPLOAD_MAX_BYTES = String(1024 * 1024)
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

  it('rejects forged MIME, bad bytes, hash mismatch, size, and unmapped variants without writes', async () => {
    const raw = await image('#00ff00')
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
      mime: 'image/jpeg',
    })).response.status).toBe(415)
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw: Buffer.from('broken'),
    })).response.status).toBe(415)
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
      contentSha256: `sha256:${'0'.repeat(64)}`,
    })).payload.error.code).toBe('ARTIFACT_HASH_MISMATCH')
    process.env.WAOO_AGENT_UPLOAD_MAX_BYTES = '1'
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
    })).response.status).toBe(413)
    process.env.WAOO_AGENT_UPLOAD_MAX_BYTES = String(1024 * 1024)
    expect((await upload({
      targetType: 'character-appearance',
      targetKey: 'appearance.lin.default',
      variantIndex: 1,
      raw,
    })).payload.error.code).toBe('REFERENCE_INVALID')
    expect((await upload({
      targetType: 'location-image',
      targetKey: 'location.home',
      variantIndex: 2,
      raw,
    })).payload.error.code).toBe('REFERENCE_INVALID')
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
      extraField: ['sourceImageUrl', 'https://example.com/image.png'],
    })).payload.error.code).toBe('CONTRACT_INVALID')
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
      duplicateTargetType: true,
    })).payload.error.code).toBe('CONTRACT_INVALID')
    expect((await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
      omitIdempotency: true,
    })).payload.error.code).toBe('CONTRACT_INVALID')
    expect(await prisma.mediaObject.count({
      where: { storageKey: { startsWith: `agent-runs/${fixture.run.id}/` } },
    })).toBe(0)
  })

  it('updates only run-owned asset slots and preserves reused selections', async () => {
    const characterResult = await upload({
      targetType: 'character-appearance',
      targetKey: 'appearance.lin.default',
    })
    expect(characterResult.response.status).toBe(200)
    const storedAppearance = await prisma.characterAppearance.findUniqueOrThrow({
      where: { id: fixture.appearance.id },
    })
    expect(JSON.parse(storedAppearance.imageUrls!)[0]).toBe('old/character.jpg')
    expect(JSON.parse(storedAppearance.imageUrls!)[1]).toContain('agent-runs/')
    expect(storedAppearance.imageUrl).toBe('old/character.jpg')
    expect(storedAppearance.selectedIndex).toBe(0)
    const newCharacterResult = await upload({
      targetType: 'character-appearance',
      targetKey: 'appearance.lin.rain',
    })
    expect(newCharacterResult.response.status).toBe(200)
    const storedNewAppearance = await prisma.characterAppearance.findUniqueOrThrow({
      where: { id: fixture.newAppearance.id },
    })
    expect(storedNewAppearance.imageUrl).toBe(
      newCharacterResult.payload.data.storageKey,
    )
    expect(storedNewAppearance.imageMediaId).toBe(
      newCharacterResult.payload.data.mediaId,
    )
    expect(storedNewAppearance.selectedIndex).toBe(0)

    const locationResult = await upload({
      targetType: 'location-image',
      targetKey: 'location.home',
    })
    expect(locationResult.response.status).toBe(200)
    expect((await prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: fixture.location.id },
    })).selectedImageId).toBe(fixture.locationSlot.id)
    const locationVariant = await upload({
      targetType: 'location-image',
      targetKey: 'location.home',
      variantIndex: 1,
    })
    expect(locationVariant.response.status).toBe(200)
    expect(locationVariant.payload.data.storageKey).not.toBe(
      locationResult.payload.data.storageKey,
    )
    expect((await prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: fixture.location.id },
    })).selectedImageId).toBe(fixture.locationSlot.id)

    const propResult = await upload({
      targetType: 'prop-image',
      targetKey: 'prop.bag',
    })
    expect(propResult.response.status).toBe(200)
    expect((await prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: fixture.prop.id },
    })).selectedImageId).toBe(fixture.propHistorical.id)
    expect((await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.propSlot.id },
    })).imageUrl).toContain('agent-runs/')
    const revisedProp = await upload({
      targetType: 'prop-image',
      targetKey: 'prop.bag',
      raw: await image('#abcdef'),
    })
    expect((await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.propSlot.id },
    })).previousImageUrl).toBe(propResult.payload.data.storageKey)
    expect(revisedProp.payload.data.storageKey).not.toBe(
      propResult.payload.data.storageKey,
    )
    expect((await prisma.novelPromotionLocation.findUniqueOrThrow({
      where: { id: fixture.prop.id },
    })).selectedImageId).toBe(fixture.propHistorical.id)

    expect(await prisma.task.count()).toBe(0)
    expect(await prisma.graphRun.count()).toBe(0)
    expect(await prisma.usageCost.count()).toBe(0)
  })

  it('is idempotent by four-part receipt and safely versions panel frame uploads', async () => {
    const raw = await image('#123456')
    const first = await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
    })
    expect(first.response.status).toBe(200)
    expect(first.payload.data.reused).toBe(false)
    expect(first.payload.data.panelImageUpdated).toBe(true)
    expect(first.payload.data.contentSha256).toBe(sha256Prefixed(raw))

    const media = await prisma.mediaObject.findUniqueOrThrow({
      where: { id: first.payload.data.mediaId },
    })
    expect(media.sha256).toMatch(/^sha256:/)
    expect(media.sha256).not.toBe(sha256Prefixed(raw))
    expect(media.mimeType).toBe('image/jpeg')
    expect(media.width).toBe(8)
    expect(media.height).toBe(6)

    const retry = await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw,
    })
    expect(retry.payload.data).toMatchObject({
      mediaId: first.payload.data.mediaId,
      storageKey: first.payload.data.storageKey,
      reused: true,
      panelImageUpdated: true,
    })
    expect(storageMock.uploadObject).toHaveBeenCalledTimes(1)

    const revisedRaw = await image('#654321')
    const revised = await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.first',
      raw: revisedRaw,
    })
    expect(revised.payload.data.reused).toBe(false)
    const panel = await prisma.novelPromotionPanel.findUniqueOrThrow({
      where: { id: fixture.panel.id },
    })
    expect(panel.previousImageUrl).toBe(first.payload.data.storageKey)
    expect(panel.imageUrl).toBe(revised.payload.data.storageKey)
    const run = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    })
    expect(parseUploadReceipts(run.receiptJson!)).toHaveLength(2)
    expect(run.status).toBe('images_in_progress')

    const second = await upload({
      targetType: 'panel-frame',
      targetKey: 'frame.second',
      raw,
    })
    expect(second.payload.data.panelImageUpdated).toBe(false)
    expect((await prisma.novelPromotionPanel.findUniqueOrThrow({
      where: { id: fixture.panel.id },
    })).imageUrl).toBe(revised.payload.data.storageKey)
    expect((await prisma.novelPromotionPanelFrame.findUniqueOrThrow({
      where: { id: fixture.secondFrame.id },
    })).generationStatus).toBe('completed')
  })
})
