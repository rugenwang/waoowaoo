import sharp from 'sharp'
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

const storageMock = vi.hoisted(() => ({
  uploadObject: vi.fn(async (_body: Buffer, key: string) => key),
}))
const mediaMock = vi.hoisted(() => ({
  ensureMediaObjectFromStorageKey: vi.fn(),
}))

vi.mock('@/lib/storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage')>(),
  uploadObject: storageMock.uploadObject,
}))
vi.mock('@/lib/media/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/service')>()
  mediaMock.ensureMediaObjectFromStorageKey.mockImplementation(
    actual.ensureMediaObjectFromStorageKey,
  )
  return {
    ...actual,
    ensureMediaObjectFromStorageKey:
      mediaMock.ensureMediaObjectFromStorageKey,
  }
})

import { sha256Prefixed } from '@/lib/agent-api/canonical-json'
import { buildProjectedEntityId } from '@/lib/agent-api/entity-id'
import {
  isCompletedUploadReceipt,
  isPendingUploadReceipt,
  parseUploadReceipts,
  serializeAssetMap,
  serializeStoryboardMap,
  serializeUploadReceipts,
  type AssetMap,
} from '@/lib/agent-api/run-state'
import { commitGeneratedImageUpload } from '@/lib/agent-api/services/upload-service'
import { resetSystemState } from '../../helpers/db-reset'
import {
  createFixtureNovelProject,
  createFixtureProject,
  createFixtureUser,
} from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function png(color: string) {
  return sharp({
    create: {
      width: 5,
      height: 4,
      channels: 3,
      background: color,
    },
  }).png().toBuffer()
}

async function createFixture() {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const runId = crypto.randomUUID()
  const firstLocation = await prisma.novelPromotionLocation.create({
    data: {
      id: buildProjectedEntityId(runId, 'Location', 'location.first'),
      novelPromotionProjectId: novelProject.id,
      name: '甲地',
      assetKind: 'location',
    },
  })
  const secondLocation = await prisma.novelPromotionLocation.create({
    data: {
      id: buildProjectedEntityId(runId, 'Location', 'location.second'),
      novelPromotionProjectId: novelProject.id,
      name: '乙地',
      assetKind: 'location',
    },
  })
  const firstImage = await prisma.locationImage.create({
    data: {
      id: buildProjectedEntityId(runId, 'LocationImage', 'location.first:0'),
      locationId: firstLocation.id,
      imageIndex: 0,
    },
  })
  const secondImage = await prisma.locationImage.create({
    data: {
      id: buildProjectedEntityId(runId, 'LocationImage', 'location.second:0'),
      locationId: secondLocation.id,
      imageIndex: 0,
    },
  })
  const assets: AssetMap = {
    characters: {},
    locations: {
      'location.first': {
        assetKey: 'location.first',
        entityId: firstLocation.id,
        reused: false,
        imageSlots: {
          0: { entityId: firstImage.id, index: 0 },
        },
      },
      'location.second': {
        assetKey: 'location.second',
        entityId: secondLocation.id,
        reused: false,
        imageSlots: {
          0: { entityId: secondImage.id, index: 0 },
        },
      },
    },
    props: {},
  }
  const run = await prisma.agentCreationRun.create({
    data: {
      id: runId,
      userId: user.id,
      projectId: project.id,
      sourceHash: `sha256:${'1'.repeat(64)}`,
      runFingerprint: `upload-concurrency-${crypto.randomUUID()}`,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: '{}',
      ruleSetVersion: 'test-v1',
      ruleSetHash: `sha256:${'2'.repeat(64)}`,
      definitionHash: `sha256:${'3'.repeat(64)}`,
      status: 'storyboards_committed',
      currentStage: 'storyboards_committed',
      episodeMapJson: '{}',
      assetMapJson: serializeAssetMap(assets),
      storyboardMapJson: serializeStoryboardMap({
        storyboards: {},
        panels: {},
        frames: {},
      }),
      receiptJson: serializeUploadReceipts([]),
    },
  })
  return { user, run, firstImage, secondImage }
}

function upload(
  fixture: Fixture,
  targetKey: 'location.first' | 'location.second',
  raw: Buffer,
) {
  return commitGeneratedImageUpload({
    userId: fixture.user.id,
    runId: fixture.run.id,
    fields: {
      targetType: 'location-image',
      targetKey,
      variantIndex: 0,
      contentSha256: sha256Prefixed(raw),
      file: {
        name: 'generated.png',
        type: 'image/png',
        size: raw.length,
        arrayBuffer: async () => raw.buffer.slice(
          raw.byteOffset,
          raw.byteOffset + raw.byteLength,
        ) as ArrayBuffer,
      },
    },
  })
}

async function receipts(runId: string) {
  const run = await prisma.agentCreationRun.findUniqueOrThrow({
    where: { id: runId },
  })
  return parseUploadReceipts(run.receiptJson!)
}

function completedReceipts(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const suffix = index.toString(16).padStart(64, '0')
    return {
      targetType: 'panel-frame' as const,
      targetKey: `historical-${index}`,
      variantIndex: 0,
      contentSha256: `sha256:${suffix}`,
      mediaId: 'historical-media',
      storageKey: `historical/${index}.jpg`,
      url: `/m/historical-${index}`,
    }
  })
}

describe('Agent upload receipt concurrency', () => {
  beforeEach(async () => {
    await resetSystemState()
    vi.clearAllMocks()
    process.env.WAOO_AGENT_UPLOAD_MAX_BYTES = String(1024 * 1024)
    process.env.WAOO_AGENT_UPLOAD_MAX_PIXELS = String(40_000_000)
  })

  afterAll(async () => {
    delete process.env.WAOO_AGENT_UPLOAD_MAX_BYTES
    delete process.env.WAOO_AGENT_UPLOAD_MAX_PIXELS
    await prisma.$disconnect()
  })

  it('converges identical concurrent uploads to one logical receipt and media', async () => {
    const fixture = await createFixture()
    const raw = await png('#111111')
    const [left, right] = await Promise.all([
      upload(fixture, 'location.first', raw),
      upload(fixture, 'location.first', raw),
    ])

    expect(left.mediaId).toBe(right.mediaId)
    expect(left.storageKey).toBe(right.storageKey)
    expect([left.reused, right.reused].sort()).toEqual([false, true])
    expect(await receipts(fixture.run.id)).toHaveLength(1)
    expect(await prisma.mediaObject.count({
      where: { storageKey: { startsWith: `agent-runs/${fixture.run.id}/` } },
    })).toBe(1)
  })

  it('preserves receipts for different targets uploaded concurrently', async () => {
    const fixture = await createFixture()
    const [leftRaw, rightRaw] = await Promise.all([
      png('#222222'),
      png('#333333'),
    ])
    await Promise.all([
      upload(fixture, 'location.first', leftRaw),
      upload(fixture, 'location.second', rightRaw),
    ])

    expect((await receipts(fixture.run.id)).map((entry) => entry.targetKey))
      .toEqual(['location.first', 'location.second'])
    expect((await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.firstImage.id },
    })).imageUrl).toContain('agent-runs/')
    expect((await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.secondImage.id },
    })).imageUrl).toContain('agent-runs/')
  })

  it('serializes different hashes for one slot without losing either receipt', async () => {
    const fixture = await createFixture()
    const [leftRaw, rightRaw] = await Promise.all([
      png('#444444'),
      png('#555555'),
    ])
    const results = await Promise.all([
      upload(fixture, 'location.first', leftRaw),
      upload(fixture, 'location.first', rightRaw),
    ])

    const storedReceipts = await receipts(fixture.run.id)
    expect(storedReceipts).toHaveLength(2)
    expect(new Set(storedReceipts.map((entry) => entry.contentSha256)))
      .toEqual(new Set([sha256Prefixed(leftRaw), sha256Prefixed(rightRaw)]))
    const slot = await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.firstImage.id },
    })
    expect(results.map((result) => result.storageKey)).toContain(slot.imageUrl)
    expect(results.map((result) => result.mediaId)).toHaveLength(2)
  })

  it('rejects a full 20,000 receipt run before storage or MediaObject writes', async () => {
    const fixture = await createFixture()
    await prisma.agentCreationRun.update({
      where: { id: fixture.run.id },
      data: {
        receiptJson: serializeUploadReceipts(completedReceipts(20_000)),
      },
    })
    const raw = await png('#666666')

    await expect(upload(fixture, 'location.first', raw)).rejects.toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      message: 'Upload receipt limit reached',
    })
    expect(storageMock.uploadObject).not.toHaveBeenCalled()
    expect(mediaMock.ensureMediaObjectFromStorageKey).not.toHaveBeenCalled()
    expect(await prisma.mediaObject.count({
      where: { storageKey: { startsWith: `agent-runs/${fixture.run.id}/` } },
    })).toBe(0)
    expect((await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.firstImage.id },
    })).imageUrl).toBeNull()
  })

  it('atomically reserves the last capacity slot for only one of two hashes', async () => {
    const fixture = await createFixture()
    await prisma.agentCreationRun.update({
      where: { id: fixture.run.id },
      data: {
        receiptJson: serializeUploadReceipts(completedReceipts(19_999)),
      },
    })
    const [leftRaw, rightRaw] = await Promise.all([
      png('#777777'),
      png('#888888'),
    ])

    const results = await Promise.allSettled([
      upload(fixture, 'location.first', leftRaw),
      upload(fixture, 'location.first', rightRaw),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(storageMock.uploadObject).toHaveBeenCalledTimes(1)
    expect(mediaMock.ensureMediaObjectFromStorageKey).toHaveBeenCalledTimes(1)
    expect(await receipts(fixture.run.id)).toHaveLength(20_000)
    expect(await prisma.mediaObject.count({
      where: { storageKey: { startsWith: `agent-runs/${fixture.run.id}/` } },
    })).toBe(1)
  })

  it('keeps a failed storage reservation pending and completes it on retry', async () => {
    const fixture = await createFixture()
    const raw = await png('#999999')
    storageMock.uploadObject.mockRejectedValueOnce(new Error('storage down'))

    await expect(upload(fixture, 'location.first', raw))
      .rejects.toThrow('storage down')
    const pending = await receipts(fixture.run.id)
    expect(pending).toHaveLength(1)
    expect(isPendingUploadReceipt(pending[0])).toBe(true)
    expect((await prisma.locationImage.findUniqueOrThrow({
      where: { id: fixture.firstImage.id },
    })).imageUrl).toBeNull()

    const retried = await upload(fixture, 'location.first', raw)
    expect(retried.reused).toBe(false)
    const completed = await receipts(fixture.run.id)
    expect(completed).toHaveLength(1)
    expect(isCompletedUploadReceipt(completed[0])).toBe(true)
    expect(storageMock.uploadObject).toHaveBeenCalledTimes(2)
  })
})
