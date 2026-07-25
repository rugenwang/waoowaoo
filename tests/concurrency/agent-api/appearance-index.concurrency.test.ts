import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PUT as COMMIT_ASSETS } from '@/app/api/agent/v1/runs/[runId]/assets/route'
import { hashArtifact } from '@/lib/agent-api/canonical-json'
import type { AssetsCommitRequest } from '@/lib/agent-api/contracts/assets'
import {
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

async function createReadyRun(runFingerprint: string) {
  return await prisma.agentCreationRun.create({
    data: {
      userId,
      projectId,
      sourceHash: SOURCE_HASH,
      runFingerprint,
      inputKindHint: 'story',
      locale: 'zh',
      effectiveOptionsJson: '{}',
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
        stories: { 'episode-001': `sha256:${'c'.repeat(64)}` },
        screenplays: {},
        storyboards: {},
      }),
    },
  })
}

function request(
  characterKey: string,
  appearanceKey: string,
  changeReason: string,
): AssetsCommitRequest {
  const data = {
    characters: [{
      characterKey,
      name: '林晓',
      aliases: ['小林'],
      introduction: '记者',
      gender: 'female' as const,
      roleLevel: 'S' as const,
      personalityTags: ['坚毅'],
      suggestedColors: ['蓝色'],
      visualKeywords: ['短发'],
      appearances: [{
        appearanceKey,
        appearanceOrdinal: 1,
        changeReason,
        visualDescription: `${changeReason}造型`,
      }],
    }],
    locations: [],
    props: [],
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

async function commit(runId: string, body: AssetsCommitRequest) {
  const response = await COMMIT_ASSETS(new Request(
    `http://localhost/api/agent/v1/runs/${runId}/assets`,
    {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer integration-agent-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': body.artifactHash,
        'X-Waoo-User-Id': userId,
      },
      body: JSON.stringify(body),
    },
  ), {
    params: Promise.resolve({ runId }),
  })
  return { response, payload: await response.json() }
}

describe('Agent appearance allocation concurrency with MySQL', () => {
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

  it('serializes same-project identity creation and allocates unique contiguous indexes', async () => {
    const [firstRun, secondRun] = await Promise.all([
      createReadyRun(`run-a-${crypto.randomUUID()}`),
      createReadyRun(`run-b-${crypto.randomUUID()}`),
    ])
    const firstBody = request(
      'character.lin.a',
      'appearance.lin.rain',
      '雨夜',
    )
    const secondBody = request(
      'character.lin.b',
      'appearance.lin.formal',
      '正式场合',
    )

    const [first, second] = await Promise.all([
      commit(firstRun.id, firstBody),
      commit(secondRun.id, secondBody),
    ])
    expect([first.response.status, second.response.status]).toEqual([200, 200])

    const characters = await prisma.novelPromotionCharacter.findMany({
      where: { novelPromotionProjectId: novelProjectId },
      include: {
        appearances: { orderBy: { appearanceIndex: 'asc' } },
      },
    })
    expect(characters).toHaveLength(1)
    expect(characters[0].appearances.map(
      (appearance) => appearance.appearanceIndex,
    )).toEqual([0, 1])
    expect(new Set([
      first.payload.data.characters[0].appearances[0].appearanceIndex,
      second.payload.data.characters[0].appearances[0].appearanceIndex,
    ])).toEqual(new Set([0, 1]))
    expect(first.payload.data.characters[0].characterId)
      .toBe(second.payload.data.characters[0].characterId)
  })
})
