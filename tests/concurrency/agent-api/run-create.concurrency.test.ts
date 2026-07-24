import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { POST } from '@/app/api/agent/v1/projects/[projectId]/runs/route'
import {
  buildRunFingerprint,
  hashArtifact,
} from '@/lib/agent-api/canonical-json'
import { loadCreatorRuleBundle } from '@/lib/agent-api/rules/load-rule-bundle'
import { resetSystemState } from '../../helpers/db-reset'
import {
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

async function runBody(sourceDigit: string) {
  const rules = await loadCreatorRuleBundle({ projectId, locale: 'zh' })
  const sourceHash = `sha256:${sourceDigit.repeat(64)}`
  const episodes = [{
    episodeKey: 'episode-001',
    ordinal: 1,
    sourceHash,
    name: `Episode ${sourceDigit}`,
  }]
  const effectiveOptions = {
    artStyle: rules.projectSettings.artStyle,
    videoRatio: rules.projectSettings.videoRatio,
    episodeSplitHint: 'auto',
  }
  return {
    schemaVersion: 1 as const,
    sourceHash,
    inputKindHint: 'story' as const,
    locale: 'zh' as const,
    effectiveOptions,
    ruleSetVersion: rules.ruleSetVersion,
    ruleSetHash: rules.contentHash,
    definitionHash: hashArtifact(episodes),
    episodes,
    runFingerprint: buildRunFingerprint({
      projectId,
      sourceHash,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptions,
      ruleSetHash: rules.contentHash,
    }),
  }
}

async function create(sourceDigit: string) {
  const body = await runBody(sourceDigit)
  const request = new Request(
    `http://localhost/api/agent/v1/projects/${projectId}/runs`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer integration-agent-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': body.runFingerprint,
        'X-Waoo-User-Id': userId,
        'X-Request-Id': `req-concurrent-${sourceDigit}-${Math.random()}`,
      },
      body: JSON.stringify(body),
    },
  )
  const response = await POST(request, {
    params: Promise.resolve({ projectId }),
  })
  return { response, body: await response.json() }
}

describe('Agent run episode allocation concurrency', () => {
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

  it('serializes different fingerprints without duplicate episode numbers', async () => {
    const [first, second] = await Promise.all([create('1'), create('2')])
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    const numbers = [
      first.body.data.episodes[0].episodeNumber,
      second.body.data.episodes[0].episodeNumber,
    ].sort((left, right) => left - right)
    expect(numbers).toEqual([1, 2])
    await expect(prisma.agentCreationRun.count()).resolves.toBe(2)
  })

  it('resumes one run for concurrent identical fingerprints', async () => {
    const [first, second] = await Promise.all([create('3'), create('3')])
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    expect(first.body.data.runId).toBe(second.body.data.runId)
    expect(first.body.data.episodes).toEqual(second.body.data.episodes)
    expect([first.body.data.resumed, second.body.data.resumed].sort())
      .toEqual([false, true])
    await expect(prisma.agentCreationRun.count()).resolves.toBe(1)
    await expect(prisma.novelPromotionEpisode.count()).resolves.toBe(1)
  })
})
