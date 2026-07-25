import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { POST as CREATE_RUN } from '@/app/api/agent/v1/projects/[projectId]/runs/route'
import { PUT as COMMIT_STORY } from '@/app/api/agent/v1/runs/[runId]/episodes/[episodeKey]/story/route'
import {
  buildRunFingerprint,
  hashArtifact,
} from '@/lib/agent-api/canonical-json'
import type { CreateRunRequest } from '@/lib/agent-api/contracts/run'
import {
  StoryCommitResponseSchema,
  type StoryCommitRequest,
} from '@/lib/agent-api/contracts/story'
import {
  parseArtifactHashes,
  parseEpisodeMap,
} from '@/lib/agent-api/run-state'
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

const SOURCE_HASH_1 = `sha256:${'1'.repeat(64)}`
const SOURCE_HASH_2 = `sha256:${'2'.repeat(64)}`
const OTHER_HASH = `sha256:${'e'.repeat(64)}`

let userId: string
let projectId: string
let preRunEpisodeId: string

async function runRequest(): Promise<CreateRunRequest> {
  const rules = await loadCreatorRuleBundle({ projectId, locale: 'zh' })
  const episodes = [{
    episodeKey: 'episode-001',
    ordinal: 1,
    sourceHash: SOURCE_HASH_1,
    name: '第一集',
    description: '定义简介一',
  }, {
    episodeKey: 'episode-002',
    ordinal: 2,
    sourceHash: SOURCE_HASH_2,
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
  }
}

function agentHeaders(idempotencyKey: string) {
  return {
    Authorization: 'Bearer integration-agent-token',
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Waoo-User-Id': userId,
    'X-Request-Id': `req-story-${Math.random().toString(36).slice(2)}`,
  }
}

async function createRun() {
  const body = await runRequest()
  const response = await CREATE_RUN(new Request(
    `http://localhost/api/agent/v1/projects/${projectId}/runs`,
    {
      method: 'POST',
      headers: agentHeaders(body.runFingerprint),
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ projectId }),
  })
  const payload = await response.json()
  expect(response.status).toBe(200)
  return {
    runId: payload.data.runId as string,
    episodes: payload.data.episodes as Array<{
      episodeKey: string
      episodeId: string
      episodeNumber: number
    }>,
    definition: body,
  }
}

function storyRequest(
  definition: CreateRunRequest,
  episodeKey: 'episode-001' | 'episode-002',
  overrides: {
    envelope?: Partial<Omit<StoryCommitRequest, 'data'>>
    data?: Partial<StoryCommitRequest['data']>
  } = {},
): StoryCommitRequest {
  const episode = definition.episodes.find(
    (candidate) => candidate.episodeKey === episodeKey,
  )!
  const data = {
    episodeKey,
    sourceHash: episode.sourceHash,
    inputKind: 'story' as const,
    name: episode.name,
    description: `${episode.name}提交简介`,
    novelText: `${episode.name}提交正文`,
    ...overrides.data,
  }
  return {
    schemaVersion: 1,
    ruleSetVersion: definition.ruleSetVersion,
    ruleSetHash: definition.ruleSetHash,
    artifactHash: hashArtifact(data),
    dryRun: false,
    data,
    ...overrides.envelope,
  }
}

async function commit(
  runId: string,
  episodeKey: string,
  body: StoryCommitRequest | Record<string, unknown>,
  idempotencyKey = body.artifactHash as string,
) {
  const response = await COMMIT_STORY(new Request(
    `http://localhost/api/agent/v1/runs/${runId}/episodes/${episodeKey}/story`,
    {
      method: 'PUT',
      headers: agentHeaders(idempotencyKey),
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ runId, episodeKey }),
  })
  return { response, payload: await response.json() }
}

describe('Agent story artifact commit with MySQL', () => {
  beforeEach(async () => {
    await resetSystemState()
    const user = await createFixtureUser()
    const project = await createFixtureProject(user.id)
    const novelProject = await createFixtureNovelProject(project.id)
    const preRunEpisode = await createFixtureEpisode(novelProject.id, 3)
    userId = user.id
    projectId = project.id
    preRunEpisodeId = preRunEpisode.id
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

  it('dry-runs all validation without changing the episode or run', async () => {
    const created = await createRun()
    const body = storyRequest(created.definition, 'episode-001', {
      envelope: { dryRun: true },
    })
    const episodeId = created.episodes[0].episodeId
    const before = await Promise.all([
      prisma.novelPromotionEpisode.findUniqueOrThrow({
        where: { id: episodeId },
      }),
      prisma.agentCreationRun.findUniqueOrThrow({
        where: { id: created.runId },
      }),
    ])

    const result = await commit(created.runId, 'episode-001', body)
    expect(result.response.status).toBe(200)
    expect(StoryCommitResponseSchema.safeParse(result.payload).success).toBe(true)
    expect(result.payload.data).toMatchObject({
      dryRun: true,
      episodeId,
      artifactHash: body.artifactHash,
    })
    await expect(Promise.all([
      prisma.novelPromotionEpisode.findUniqueOrThrow({ where: { id: episodeId } }),
      prisma.agentCreationRun.findUniqueOrThrow({ where: { id: created.runId } }),
    ])).resolves.toEqual(before)
  })

  it('commits mapped episodes, reports partial progress, seals all stories, and is idempotent', async () => {
    const created = await createRun()
    const firstBody = storyRequest(created.definition, 'episode-001')
    const first = await commit(created.runId, 'episode-001', firstBody)
    expect(first.response.status).toBe(200)

    const partial = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: created.runId },
    })
    expect(partial.status).toBe('created')
    expect(partial.currentStage).toBe('story_committing:1/2')
    expect(parseEpisodeMap(partial.episodeMapJson)).toMatchObject({
      'episode-001': { status: 'story_committed' },
      'episode-002': { status: 'created' },
    })
    expect(parseArtifactHashes(partial.artifactHashesJson!).stories)
      .toEqual({ 'episode-001': firstBody.artifactHash })

    const committedEpisode = await prisma.novelPromotionEpisode.findUniqueOrThrow({
      where: { id: created.episodes[0].episodeId },
    })
    expect(committedEpisode).toMatchObject({
      description: firstBody.data.description,
      novelText: firstBody.data.novelText,
    })
    await expect(prisma.novelPromotionEpisode.findUniqueOrThrow({
      where: { id: created.episodes[1].episodeId },
    })).resolves.toMatchObject({ novelText: null })
    await expect(prisma.novelPromotionEpisode.findUniqueOrThrow({
      where: { id: preRunEpisodeId },
    })).resolves.toMatchObject({ novelText: 'test novel text' })

    const beforeRetry = await prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: created.runId },
    })
    const retry = await commit(created.runId, 'episode-001', firstBody)
    expect(retry.payload.data).toEqual(first.payload.data)
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: created.runId },
    })).resolves.toEqual(beforeRetry)

    const secondBody = storyRequest(created.definition, 'episode-002')
    const second = await commit(created.runId, 'episode-002', secondBody)
    expect(second.response.status).toBe(200)
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: created.runId },
    })).resolves.toMatchObject({
      status: 'story_committed',
      currentStage: 'story_committed',
    })
    await expect(Promise.all([
      prisma.task.count(),
      prisma.taskEvent.count(),
      prisma.graphRun.count(),
      prisma.usageCost.count(),
    ])).resolves.toEqual([0, 0, 0, 0])
  })

  it('rejects envelope, hash, path, source, and name mismatches before writes', async () => {
    const created = await createRun()
    const valid = storyRequest(created.definition, 'episode-001')
    const cases = [
      await commit(created.runId, 'episode-001', {
        ...valid,
        unexpected: true,
      }),
      await commit(created.runId, 'episode-001', {
        ...valid,
        ruleSetHash: OTHER_HASH,
      }),
      await commit(created.runId, 'episode-001', {
        ...valid,
        artifactHash: OTHER_HASH,
      }, OTHER_HASH),
      await commit(created.runId, 'episode-002', valid),
      await commit(created.runId, 'episode-001', storyRequest(
        created.definition,
        'episode-001',
        { data: { sourceHash: OTHER_HASH } },
      )),
      await commit(created.runId, 'episode-001', storyRequest(
        created.definition,
        'episode-001',
        { data: { name: '篡改集名' } },
      )),
      await commit(created.runId, 'episode-001', valid, OTHER_HASH),
    ]
    expect(cases.map(({ response }) => response.status))
      .toEqual([400, 409, 400, 400, 400, 400, 400])
    expect(cases.map(({ payload }) => payload.error.code)).toEqual([
      'CONTRACT_INVALID',
      'RULESET_MISMATCH',
      'ARTIFACT_HASH_MISMATCH',
      'REFERENCE_INVALID',
      'REFERENCE_INVALID',
      'REFERENCE_INVALID',
      'CONTRACT_INVALID',
    ])

    await expect(prisma.novelPromotionEpisode.findUniqueOrThrow({
      where: { id: created.episodes[0].episodeId },
    })).resolves.toMatchObject({ novelText: null })
    await expect(prisma.agentCreationRun.findUniqueOrThrow({
      where: { id: created.runId },
    })).resolves.toMatchObject({
      status: 'created',
      currentStage: 'created',
    })
  })

  it('rejects completed and corrupted runs without touching story data', async () => {
    const created = await createRun()
    const body = storyRequest(created.definition, 'episode-001')
    await prisma.agentCreationRun.update({
      where: { id: created.runId },
      data: { status: 'completed', currentStage: 'completed' },
    })
    const completed = await commit(created.runId, 'episode-001', body)
    expect(completed.response.status).toBe(422)
    expect(completed.payload.error.code).toBe('RUN_INCOMPLETE')

    await prisma.agentCreationRun.update({
      where: { id: created.runId },
      data: {
        status: 'created',
        currentStage: 'created',
        episodeMapJson: '{broken',
      },
    })
    const corrupted = await commit(created.runId, 'episode-001', body)
    expect(corrupted.response.status).toBe(500)
    expect(corrupted.payload.error.code).toBe('AGENT_INTERNAL_ERROR')
    await expect(prisma.novelPromotionEpisode.findUniqueOrThrow({
      where: { id: created.episodes[0].episodeId },
    })).resolves.toMatchObject({ novelText: null })
  })
})
