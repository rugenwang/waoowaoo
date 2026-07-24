import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { POST } from '@/app/api/agent/v1/projects/resolve/route'
import { resolveProjectIdempotencyKey } from '@/lib/agent-api/idempotency'
import { resetSystemState } from '../../helpers/db-reset'
import { createFixtureUser } from '../../helpers/fixtures'
import { prisma } from '../../helpers/prisma'

const ORIGINAL_ENV = {
  WAOO_AGENT_API_ENABLED: process.env.WAOO_AGENT_API_ENABLED,
  WAOO_AGENT_TOKEN: process.env.WAOO_AGENT_TOKEN,
  WAOO_AGENT_USER_ID: process.env.WAOO_AGENT_USER_ID,
}

function request(name: string, body: Record<string, unknown> = { name }) {
  return new Request('http://localhost/api/agent/v1/projects/resolve', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer integration-agent-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': resolveProjectIdempotencyKey(name.trim()),
      'X-Waoo-User-Id': process.env.WAOO_AGENT_USER_ID ?? '',
      'X-Request-Id': `req-project-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(body),
  })
}

async function resolve(name: string, body: Record<string, unknown> = { name }) {
  const response = await POST(
    request(name, body),
    { params: Promise.resolve({}) },
  )
  return {
    response,
    body: await response.json(),
  }
}

describe('Agent project resolver with MySQL', () => {
  beforeEach(async () => {
    await resetSystemState()
    const user = await createFixtureUser()
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'integration-agent-token'
    process.env.WAOO_AGENT_USER_ID = user.id
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('uses JS exact equality after MySQL case-insensitive candidate lookup', async () => {
    const userId = process.env.WAOO_AGENT_USER_ID!
    const upper = await prisma.project.create({
      data: { userId, name: 'Case Project' },
    })
    await prisma.project.create({
      data: { userId, name: 'case project' },
    })

    const reused = await resolve('  Case Project  ')
    expect(reused.response.status).toBe(200)
    expect(reused.body.data).toEqual({
      projectId: upper.id,
      name: 'Case Project',
      created: false,
    })

    const created = await resolve('CASE PROJECT')
    expect(created.response.status).toBe(200)
    expect(created.body.data).toMatchObject({
      name: 'CASE PROJECT',
      created: true,
    })
    await expect(prisma.project.count({
      where: { userId },
    })).resolves.toBe(3)
  })

  it('creates Project and NovelPromotionProject atomically with the legacy preference defaults', async () => {
    const userId = process.env.WAOO_AGENT_USER_ID!
    await prisma.userPreference.create({
      data: {
        userId,
        analysisModel: 'analysis-model',
        characterModel: 'character-model',
        locationModel: 'location-model',
        storyboardModel: 'storyboard-model',
        editModel: 'edit-model',
        videoModel: 'video-model',
        audioModel: 'audio-model',
        videoRatio: '16:9',
        artStyle: 'realistic',
        ttsRate: '+25%',
      },
    })

    const result = await resolve('  New Project  ', {
      name: '  New Project  ',
      description: '  New description  ',
    })
    expect(result.response.status).toBe(200)
    expect(result.body.data).toMatchObject({
      name: 'New Project',
      created: true,
    })

    const project = await prisma.project.findUnique({
      where: { id: result.body.data.projectId },
      include: { novelPromotionData: true },
    })
    expect(project).toMatchObject({
      name: 'New Project',
      description: 'New description',
      novelPromotionData: {
        analysisModel: 'analysis-model',
        characterModel: 'character-model',
        locationModel: 'location-model',
        storyboardModel: 'storyboard-model',
        editModel: 'edit-model',
        videoModel: 'video-model',
        audioModel: 'audio-model',
        videoRatio: '16:9',
        artStyle: 'realistic',
        ttsRate: '+25%',
      },
    })
  })

  it('falls back an invalid stored artStyle without changing the user preference', async () => {
    const userId = process.env.WAOO_AGENT_USER_ID!
    await prisma.userPreference.create({
      data: {
        userId,
        artStyle: 'not-supported',
      },
    })

    const result = await resolve('Fallback Project')
    expect(result.response.status).toBe(200)

    const [preference, novelProject] = await Promise.all([
      prisma.userPreference.findUnique({ where: { userId } }),
      prisma.novelPromotionProject.findUnique({
        where: { projectId: result.body.data.projectId },
      }),
    ])
    expect(preference?.artStyle).toBe('not-supported')
    expect(novelProject?.artStyle).toBe('american-comic')
  })

  it('does not update a reused project, its description, or its mode settings', async () => {
    const userId = process.env.WAOO_AGENT_USER_ID!
    const project = await prisma.project.create({
      data: {
        userId,
        name: 'Existing Project',
        description: 'keep this description',
        novelPromotionData: {
          create: {
            videoRatio: '16:9',
            artStyle: 'realistic',
          },
        },
      },
    })

    const result = await resolve('Existing Project', {
      name: 'Existing Project',
      description: 'must not overwrite',
    })
    expect(result.body.data).toEqual({
      projectId: project.id,
      name: 'Existing Project',
      created: false,
    })

    await expect(prisma.project.findUnique({
      where: { id: project.id },
      include: { novelPromotionData: true },
    })).resolves.toMatchObject({
      description: 'keep this description',
      novelPromotionData: {
        videoRatio: '16:9',
        artStyle: 'realistic',
      },
    })
  })

  it('returns PROJECT_NAME_AMBIGUOUS for duplicate exact rows', async () => {
    const userId = process.env.WAOO_AGENT_USER_ID!
    await prisma.project.createMany({
      data: [
        { userId, name: 'Duplicate Project' },
        { userId, name: 'Duplicate Project' },
      ],
    })

    const result = await resolve('Duplicate Project')
    expect(result.response.status).toBe(409)
    expect(result.body.error).toMatchObject({
      code: 'PROJECT_NAME_AMBIGUOUS',
      retryable: false,
    })
  })

  it('serializes concurrent same-name resolution on the user row', async () => {
    const [first, second] = await Promise.all([
      resolve('Concurrent Project'),
      resolve('Concurrent Project'),
    ])

    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    expect([first.body.data.created, second.body.data.created].sort())
      .toEqual([false, true])
    expect(first.body.data.projectId).toBe(second.body.data.projectId)
    await expect(prisma.project.count({
      where: {
        userId: process.env.WAOO_AGENT_USER_ID,
        name: 'Concurrent Project',
      },
    })).resolves.toBe(1)
  })
})
