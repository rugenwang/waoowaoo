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

import { POST as FINALIZE } from '@/app/api/agent/v1/runs/[runId]/finalize/route'
import { GET as SNAPSHOT } from '@/app/api/agent/v1/runs/[runId]/snapshot/route'
import { PUT as STORY } from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/story/route'
import { POST as UPLOAD } from '@/app/api/agent/v1/runs/[runId]/uploads/route'
import {
  hashArtifact,
  sha256Prefixed,
} from '@/lib/agent-api/canonical-json'
import type { FinalizeRequest } from '@/lib/agent-api/contracts/finalize'
import type { StoryCommitRequest } from '@/lib/agent-api/contracts/story'
import { buildProjectedEntityId } from '@/lib/agent-api/entity-id'
import {
  finalizeIdempotencyKey,
  uploadIdempotencyKey,
} from '@/lib/agent-api/idempotency'
import {
  serializeArtifactHashes,
  serializeAssetMap,
  serializeClipMap,
  serializeEpisodeMap,
  serializeStoryboardMap,
  serializeUploadReceipts,
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
const RULE_HASH = `sha256:${'1'.repeat(64)}`
const SOURCE_HASH = `sha256:${'2'.repeat(64)}`
const ASSET_HASH = `sha256:${'3'.repeat(64)}`
const STORY_HASH = `sha256:${'4'.repeat(64)}`
const SCREENPLAY_HASH = `sha256:${'5'.repeat(64)}`
const STORYBOARD_HASH = `sha256:${'6'.repeat(64)}`

type Fixture = Awaited<ReturnType<typeof createFixture>>
let fixture: Fixture

async function createFixture() {
  const user = await createFixtureUser()
  const project = await createFixtureProject(user.id)
  const novelProject = await createFixtureNovelProject(project.id)
  const episode = await createFixtureEpisode(novelProject.id)
  await prisma.novelPromotionEpisode.update({
    where: { id: episode.id },
    data: {
      name: '第一集',
      novelText: '完整的故事正文',
    },
  })
  const runId = crypto.randomUUID()
  const clipKey = 'clip-1'
  const storyboardKey = 'storyboard-1'
  const panelKey = 'panel-1'
  const frameKey = 'frame-1'
  const clip = await prisma.novelPromotionClip.create({
    data: {
      id: buildProjectedEntityId(runId, 'Clip', clipKey),
      episodeId: episode.id,
      summary: '片段',
      content: '完整的故事正文',
    },
  })
  const storyboard = await prisma.novelPromotionStoryboard.create({
    data: {
      id: buildProjectedEntityId(runId, 'Storyboard', storyboardKey),
      episodeId: episode.id,
      clipId: clip.id,
      panelCount: 1,
    },
  })
  const panel = await prisma.novelPromotionPanel.create({
    data: {
      id: buildProjectedEntityId(runId, 'Panel', panelKey),
      storyboardId: storyboard.id,
      panelIndex: 0,
    },
  })
  const frame = await prisma.novelPromotionPanelFrame.create({
    data: {
      id: buildProjectedEntityId(runId, 'Frame', frameKey),
      panelId: panel.id,
      frameIndex: 0,
      frameTimeSec: 0,
    },
  })
  const run = await prisma.agentCreationRun.create({
    data: {
      id: runId,
      userId: user.id,
      projectId: project.id,
      sourceHash: SOURCE_HASH,
      runFingerprint: `finalize-${crypto.randomUUID()}`,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: '{}',
      ruleSetVersion: 'test-v1',
      ruleSetHash: RULE_HASH,
      definitionHash: `sha256:${'7'.repeat(64)}`,
      status: 'storyboards_committed',
      currentStage: 'storyboards_committed',
      episodeMapJson: serializeEpisodeMap({
        ep1: {
          episodeKey: 'ep1',
          episodeId: episode.id,
          episodeNumber: 1,
          ordinal: 1,
          sourceHash: SOURCE_HASH,
          name: '第一集',
          status: 'storyboards_committed',
        },
      }),
      assetMapJson: serializeAssetMap({
        characters: {},
        locations: {},
        props: {},
      }),
      clipMapJson: serializeClipMap({
        [clipKey]: {
          clipKey,
          clipId: clip.id,
          episodeKey: 'ep1',
          ordinal: 1,
        },
      }),
      storyboardMapJson: serializeStoryboardMap({
        storyboards: {
          [storyboardKey]: {
            storyboardKey,
            storyboardId: storyboard.id,
            episodeKey: 'ep1',
            clipKey,
          },
        },
        panels: {
          [panelKey]: {
            panelKey,
            panelId: panel.id,
            storyboardKey,
            panelIndex: 0,
          },
        },
        frames: {
          [frameKey]: {
            frameKey,
            frameId: frame.id,
            panelKey,
            frameIndex: 0,
          },
        },
      }),
      artifactHashesJson: serializeArtifactHashes({
        assets: ASSET_HASH,
        stories: { ep1: STORY_HASH },
        screenplays: { ep1: SCREENPLAY_HASH },
        storyboards: { ep1: STORYBOARD_HASH },
      }),
      receiptJson: serializeUploadReceipts([]),
    },
  })
  const expected: FinalizeRequest = {
    schemaVersion: 1,
    ruleSetHash: RULE_HASH,
    expected: {
      assets: ASSET_HASH,
      stories: { ep1: STORY_HASH },
      screenplays: { ep1: SCREENPLAY_HASH },
      storyboards: { ep1: STORYBOARD_HASH },
    },
  }
  return {
    user,
    project,
    run,
    episode,
    frameKey,
    expected,
  }
}

function authHeaders(userId = fixture.user.id) {
  return {
    authorization: 'Bearer integration-agent-token',
    'x-waoo-user-id': userId,
  }
}

async function finalize(body: FinalizeRequest = fixture.expected) {
  const response = await FINALIZE(new Request(
    `http://localhost/api/agent/v1/runs/${fixture.run.id}/finalize`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
        'idempotency-key': finalizeIdempotencyKey(body),
      },
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ runId: fixture.run.id }),
  })
  return {
    response,
    payload: await response.json(),
  }
}

async function uploadFrame(raw: Buffer) {
  const contentSha256 = sha256Prefixed(raw)
  const form = new FormData()
  form.set('targetType', 'panel-frame')
  form.set('targetKey', fixture.frameKey)
  form.set('variantIndex', '0')
  form.set('contentSha256', contentSha256)
  form.set(
    'file',
    new Blob([
      raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      ) as ArrayBuffer,
    ], { type: 'image/png' }),
    'frame.png',
  )
  const response = await UPLOAD(new Request(
    `http://localhost/api/agent/v1/runs/${fixture.run.id}/uploads`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'idempotency-key': uploadIdempotencyKey({
          runId: fixture.run.id,
          targetType: 'panel-frame',
          targetKey: fixture.frameKey,
          variantIndex: 0,
          contentSha256,
        }),
      },
      body: form,
    },
  ), {
    params: Promise.resolve({ runId: fixture.run.id }),
  })
  return {
    response,
    payload: await response.json(),
  }
}

describe('agent finalize integration', () => {
  beforeEach(async () => {
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'integration-agent-token'
    delete process.env.WAOO_AGENT_USER_ID
    storageMock.uploadObject.mockClear()
    await resetSystemState()
    fixture = await createFixture()
    process.env.WAOO_AGENT_USER_ID = fixture.user.id
  })

  afterEach(async () => {
    await resetSystemState()
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('persists incomplete, recovers through upload, completes atomically, and seals writes', async () => {
    const incomplete = await finalize()
    expect(incomplete.response.status).toBe(422)
    expect(incomplete.payload.error.code).toBe('RUN_INCOMPLETE')
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    })).resolves.toMatchObject({
      status: 'incomplete',
      currentStage: 'images_in_progress',
    })

    const raw = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: '#cc0000',
      },
    }).png().toBuffer()
    const uploaded = await uploadFrame(raw)
    expect(uploaded.response.status).toBe(200)

    const completed = await finalize()
    expect(completed.response.status).toBe(200)
    expect(completed.payload.data).toMatchObject({
      runId: fixture.run.id,
      status: 'completed',
      counts: {
        episodes: 1,
        characters: 0,
        locations: 0,
        props: 0,
        clips: 1,
        storyboards: 1,
        panels: 1,
        frames: 1,
        uploadedImages: 1,
      },
    })
    const completedAt = completed.payload.data.completedAt

    const retry = await finalize()
    expect(retry.response.status).toBe(200)
    expect(retry.payload.data.completedAt).toBe(completedAt)
    expect(retry.payload.data.counts).toEqual(completed.payload.data.counts)

    const rejectedUpload = await uploadFrame(raw)
    expect(rejectedUpload.response.status).toBe(422)
    expect(rejectedUpload.payload.error.code).toBe('RUN_INCOMPLETE')

    const storyData = {
      episodeKey: 'ep1',
      sourceHash: SOURCE_HASH,
      inputKind: 'story' as const,
      name: '第一集',
      novelText: '完整的故事正文',
    }
    const storyBody: StoryCommitRequest = {
      schemaVersion: 1,
      ruleSetVersion: 'test-v1',
      ruleSetHash: RULE_HASH,
      artifactHash: hashArtifact(storyData),
      dryRun: false,
      data: storyData,
    }
    const rejectedStory = await STORY(new Request(
      `http://localhost/api/agent/v1/runs/${fixture.run.id}/episodes/ep1/story`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
          'idempotency-key': storyBody.artifactHash,
        },
        body: JSON.stringify(storyBody),
      },
    ), {
      params: Promise.resolve({
        runId: fixture.run.id,
        episodeKey: 'ep1',
      }),
    })
    expect(rejectedStory.status).toBe(422)

    await expect(prisma.task.count()).resolves.toBe(0)
    await expect(prisma.graphRun.count()).resolves.toBe(0)
  })

  it('rejects expected hash key/value mismatches without changing run status', async () => {
    const changed: FinalizeRequest = {
      ...fixture.expected,
      expected: {
        ...fixture.expected.expected,
        stories: {},
      },
    }
    const result = await finalize(changed)
    expect(result.response.status).toBe(409)
    expect(result.payload.error.code).toBe('RUN_DEFINITION_CONFLICT')
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    })).resolves.toMatchObject({
      status: 'storyboards_committed',
      currentStage: 'storyboards_committed',
    })
  })

  it('refuses to finalize a frame whose URL and receipt exist but persisted media links are missing', async () => {
    const raw = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: '#00cc00',
      },
    }).png().toBuffer()
    const uploaded = await uploadFrame(raw)
    expect(uploaded.response.status).toBe(200)

    await prisma.novelPromotionPanelFrame.update({
      where: {
        id: buildProjectedEntityId(
          fixture.run.id,
          'Frame',
          fixture.frameKey,
        ),
      },
      data: { imageMediaId: null },
    })
    await prisma.novelPromotionPanel.update({
      where: {
        id: buildProjectedEntityId(
          fixture.run.id,
          'Panel',
          'panel-1',
        ),
      },
      data: { imageMediaId: null },
    })

    const result = await finalize()
    expect(result.response.status).toBe(422)
    expect(result.payload.error.code).toBe('RUN_INCOMPLETE')
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    })).resolves.toMatchObject({
      status: 'incomplete',
      currentStage: 'images_in_progress',
    })
  })

  it('exposes the same stable missing list through snapshot without mutation', async () => {
    const before = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    })
    const response = await SNAPSHOT(new Request(
      `http://localhost/api/agent/v1/runs/${fixture.run.id}/snapshot`,
      { headers: authHeaders() },
    ), {
      params: Promise.resolve({ runId: fixture.run.id }),
    })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.data.missing).toEqual([
      expect.objectContaining({
        code: 'FRAME_IMAGE_MISSING',
        targetKey: fixture.frameKey,
      }),
    ])
    const after = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: fixture.run.id },
    })
    expect(after.status).toBe(before.status)
    expect(after.currentStage).toBe(before.currentStage)
    expect(after.lastErrorJson).toBe(before.lastErrorJson)
  })
})
