import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { POST } from '@/app/api/agent/v1/projects/[projectId]/runs/route'
import { GET } from '@/app/api/agent/v1/runs/[runId]/route'
import {
  buildRunFingerprint,
  hashArtifact,
} from '@/lib/agent-api/canonical-json'
import {
  CreateRunResponseSchema,
  RunResponseSchema,
  type CreateRunRequest,
} from '@/lib/agent-api/contracts/run'
import { loadCreatorRuleBundle } from '@/lib/agent-api/rules/load-rule-bundle'
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

let userId: string
let projectId: string

async function body(
  overrides: Partial<CreateRunRequest> = {},
): Promise<CreateRunRequest> {
  const rules = await loadCreatorRuleBundle({ projectId, locale: 'zh' })
  const episodes = [{
    episodeKey: 'episode-001',
    ordinal: 1,
    sourceHash: `sha256:${'1'.repeat(64)}`,
    name: '第一集',
    description: '第一集简介',
  }, {
    episodeKey: 'episode-002',
    ordinal: 2,
    sourceHash: `sha256:${'2'.repeat(64)}`,
    name: '第二集',
  }]
  const base = {
    schemaVersion: 1 as const,
    sourceHash: `sha256:${'f'.repeat(64)}`,
    inputKindHint: 'story' as const,
    locale: 'zh' as const,
    effectiveOptions: {
      artStyle: rules.projectSettings.artStyle,
      videoRatio: rules.projectSettings.videoRatio,
      episodeSplitHint: 'auto',
    },
    ruleSetVersion: rules.ruleSetVersion,
    ruleSetHash: rules.contentHash,
    definitionHash: hashArtifact(episodes),
    episodes,
  }
  return {
    ...base,
    runFingerprint: buildRunFingerprint({
      projectId,
      sourceHash: base.sourceHash,
      inputKindHint: base.inputKindHint,
      locale: base.locale,
      effectiveOptions: base.effectiveOptions,
      ruleSetHash: base.ruleSetHash,
    }),
    ...overrides,
  }
}

function postRequest(run: CreateRunRequest, idempotencyKey = run.runFingerprint) {
  return new Request(`http://localhost/api/agent/v1/projects/${projectId}/runs`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer integration-agent-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Waoo-User-Id': userId,
      'X-Request-Id': `req-run-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(run),
  })
}

async function create(run: CreateRunRequest, idempotencyKey = run.runFingerprint) {
  const response = await POST(postRequest(run, idempotencyKey), {
    params: Promise.resolve({ projectId }),
  })
  return { response, body: await response.json() }
}

function getRequest(runId: string, requestUserId = userId) {
  return new Request(`http://localhost/api/agent/v1/runs/${runId}`, {
    headers: {
      Authorization: 'Bearer integration-agent-token',
      'X-Waoo-User-Id': requestUserId,
      'X-Request-Id': `req-get-run-${Math.random().toString(36).slice(2)}`,
    },
  })
}

describe('Agent run creation with MySQL', () => {
  beforeEach(async () => {
    await resetSystemState()
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    await createFixtureNovelProject(project.id)
    userId = user.id
    projectId = project.id
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

  it('appends contiguous empty episodes after max, persists the map, and updates lastEpisodeId', async () => {
    const novelProject = await prisma.novelPromotionProject.findUniqueOrThrow({
      where: { projectId },
    })
    await createFixtureEpisode(novelProject.id, 2)
    await createFixtureEpisode(novelProject.id, 5)

    const result = await create(await body())
    expect(result.response.status).toBe(200)
    expect(CreateRunResponseSchema.safeParse(result.body).success).toBe(true)
    expect(result.body.data).toMatchObject({
      resumed: false,
      projectId,
      status: 'created',
      episodes: [
        { episodeKey: 'episode-001', episodeNumber: 6, name: '第一集' },
        { episodeKey: 'episode-002', episodeNumber: 7, name: '第二集' },
      ],
    })

    const rows = await prisma.novelPromotionEpisode.findMany({
      where: { novelPromotionProjectId: novelProject.id },
      orderBy: { episodeNumber: 'asc' },
    })
    expect(rows.map((episode) => episode.episodeNumber)).toEqual([2, 5, 6, 7])
    expect(rows.slice(-2)).toEqual([
      expect.objectContaining({
        name: '第一集',
        description: '第一集简介',
        novelText: null,
      }),
      expect.objectContaining({
        name: '第二集',
        description: null,
        novelText: null,
      }),
    ])
    await expect(prisma.novelPromotionProject.findUnique({
      where: { projectId },
      select: { lastEpisodeId: true },
    })).resolves.toEqual({ lastEpisodeId: result.body.data.episodes[1].episodeId })

    await expect(Promise.all([
      prisma.task.count(),
      prisma.taskEvent.count(),
      prisma.graphRun.count(),
      prisma.usageCost.count(),
    ])).resolves.toEqual([0, 0, 0, 0])
  })

  it('resumes the same fingerprint and original mapping without new episodes', async () => {
    const run = await body()
    const first = await create(run)
    const second = await create(run)
    expect(first.body.data.resumed).toBe(false)
    expect(second.body.data).toEqual({
      ...first.body.data,
      resumed: true,
    })
    await expect(prisma.novelPromotionEpisode.count()).resolves.toBe(2)
    await expect(prisma.agentCreationRun.count()).resolves.toBe(1)
  })

  it('restores an old run after current project rules change', async () => {
    const run = await body()
    const first = await create(run)
    await prisma.novelPromotionProject.update({
      where: { projectId },
      data: { artStyle: 'chinese-xianxia' },
    })

    const resumed = await create(run)
    expect(resumed.response.status).toBe(200)
    expect(resumed.body.data).toEqual({
      ...first.body.data,
      resumed: true,
    })
  })

  it('rejects invalid hashes, wrong idempotency, and current-rule mismatch before writes', async () => {
    const valid = await body()
    const invalidCases = [
      await create({ ...valid, definitionHash: `sha256:${'a'.repeat(64)}` }),
      await create({ ...valid, runFingerprint: `sha256:${'b'.repeat(64)}` }),
      await create(valid, `sha256:${'c'.repeat(64)}`),
      await create({
        ...valid,
        ruleSetHash: `sha256:${'d'.repeat(64)}`,
        runFingerprint: buildRunFingerprint({
          projectId,
          sourceHash: valid.sourceHash,
          inputKindHint: valid.inputKindHint,
          locale: valid.locale,
          effectiveOptions: valid.effectiveOptions,
          ruleSetHash: `sha256:${'d'.repeat(64)}`,
        }),
      }),
    ]
    expect(invalidCases.map((result) => result.response.status))
      .toEqual([400, 400, 400, 409])
    expect(invalidCases.map((result) => result.body.error.code)).toEqual([
      'ARTIFACT_HASH_MISMATCH',
      'ARTIFACT_HASH_MISMATCH',
      'CONTRACT_INVALID',
      'RULESET_MISMATCH',
    ])
    await expect(prisma.agentCreationRun.count()).resolves.toBe(0)
    await expect(prisma.novelPromotionEpisode.count()).resolves.toBe(0)
  })

  it('returns RUN_DEFINITION_CONFLICT for a same-fingerprint stored definition change', async () => {
    const run = await body()
    await create(run)
    await prisma.agentCreationRun.updateMany({
      where: { projectId },
      data: { definitionHash: `sha256:${'c'.repeat(64)}` },
    })
    const result = await create(run)
    expect(result.response.status).toBe(409)
    expect(result.body.error.code).toBe('RUN_DEFINITION_CONFLICT')
  })

  it('GET returns a strict owned RunResponse and never writes status', async () => {
    const created = await create(await body())
    const runId = created.body.data.runId
    const before = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { updatedAt: true, status: true, currentStage: true },
    })

    const response = await GET(getRequest(runId), {
      params: Promise.resolve({ runId }),
    })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(RunResponseSchema.safeParse(payload).success).toBe(true)
    expect(payload.data).toEqual({
      runId,
      projectId,
      status: 'created',
      currentStage: 'created',
      sourceHash: expect.stringMatching(/^sha256:/),
      runFingerprint: expect.stringMatching(/^sha256:/),
      ruleSetVersion: 'waoo-creator-v1',
      ruleSetHash: expect.stringMatching(/^sha256:/),
      episodes: [
        expect.objectContaining({ episodeKey: 'episode-001', status: 'created' }),
        expect.objectContaining({ episodeKey: 'episode-002', status: 'created' }),
      ],
    })
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: runId },
      select: { updatedAt: true, status: true, currentStage: true },
    })).resolves.toEqual(before)
  })

  it('GET enforces ownership and rejects corrupted persisted JSON', async () => {
    const created = await create(await body())
    const runId = created.body.data.runId
    const other = await createFixtureUser()
    process.env.WAOO_AGENT_USER_ID = other.id

    const forbidden = await GET(getRequest(runId, other.id), {
      params: Promise.resolve({ runId }),
    })
    expect(forbidden.status).toBe(403)

    process.env.WAOO_AGENT_USER_ID = userId
    await prisma.agentCreationRun.update({
      where: { id: runId },
      data: { episodeMapJson: '{broken' },
    })
    const corrupted = await GET(getRequest(runId), {
      params: Promise.resolve({ runId }),
    })
    expect(corrupted.status).toBe(500)
    expect((await corrupted.json()).error.code).toBe('AGENT_INTERNAL_ERROR')
  })
})
