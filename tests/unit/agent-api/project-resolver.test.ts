import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const txMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  project: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  userPreference: {
    findUnique: vi.fn(),
  },
  novelPromotionProject: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}))

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  user: {
    findUnique: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import { resolveProjectIdempotencyKey } from '@/lib/agent-api/idempotency'
import {
  PROJECT_PREFERENCE_DEFAULT_FIELDS,
  resolveCreatorProject,
} from '@/lib/agent-api/services/project-resolver'
import { POST } from '@/app/api/agent/v1/projects/resolve/route'

const ORIGINAL_ENV = {
  WAOO_AGENT_API_ENABLED: process.env.WAOO_AGENT_API_ENABLED,
  WAOO_AGENT_TOKEN: process.env.WAOO_AGENT_TOKEN,
  WAOO_AGENT_USER_ID: process.env.WAOO_AGENT_USER_ID,
}

function routeRequest(
  body: unknown,
  idempotencyKey = resolveProjectIdempotencyKey(
    typeof body === 'object' && body !== null && 'name' in body
      ? String((body as { name: unknown }).name).trim()
      : '',
  ),
) {
  return new Request('http://localhost/api/agent/v1/projects/resolve', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer agent-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Waoo-User-Id': 'user-1',
      'X-Request-Id': 'req-project-resolver-unit',
    },
    body: JSON.stringify(body),
  })
}

describe('resolveCreatorProject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    txMock.$queryRaw.mockResolvedValue([{ id: 'user-1' }])
    txMock.project.findMany.mockResolvedValue([])
    txMock.userPreference.findUnique.mockResolvedValue(null)
    txMock.project.create.mockResolvedValue({
      id: 'project-created',
      name: 'Exact Project',
    })
    txMock.novelPromotionProject.create.mockResolvedValue({
      id: 'novel-created',
    })
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
    )
  })

  it('locks the current user before the only candidate query and filters with JS exact equality', async () => {
    txMock.project.findMany.mockResolvedValue([
      { id: 'project-uppercase', name: 'Exact Project' },
      { id: 'project-lowercase', name: 'exact project' },
      { id: 'project-contains', name: 'Exact Project sequel' },
    ])

    await expect(resolveCreatorProject({
      userId: 'user-1',
      name: '  Exact Project  ',
    })).resolves.toEqual({
      projectId: 'project-uppercase',
      name: 'Exact Project',
      created: false,
    })

    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    expect(txMock.project.findMany).toHaveBeenCalledTimes(1)
    expect(txMock.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(txMock.project.findMany.mock.invocationCallOrder[0])

    const lockQuery = txMock.$queryRaw.mock.calls[0]?.[0] as {
      sql?: string
      values?: unknown[]
    }
    expect(lockQuery.sql?.replace(/\s+/g, ' ').trim())
      .toBe('SELECT id FROM user WHERE id = ? FOR UPDATE')
    expect(lockQuery.values).toEqual(['user-1'])
    expect(txMock.project.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        name: 'Exact Project',
      },
      select: {
        id: true,
        name: true,
      },
    })
    expect(txMock.project.update).not.toHaveBeenCalled()
    expect(txMock.project.updateMany).not.toHaveBeenCalled()
    expect(txMock.novelPromotionProject.update).not.toHaveBeenCalled()
    expect(txMock.novelPromotionProject.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    ['ASCII lowercase', 'EXACT PROJECT', 'Exact Project'],
    ['contains', 'Exact', 'Exact Project'],
    ['pinyin', 'ceshi', '测试'],
    ['Unicode lowercase', 'ä', 'Ä'],
  ])('does not reuse a project through %s matching', async (_kind, requested, stored) => {
    txMock.project.findMany.mockResolvedValue([
      { id: 'non-exact-project', name: stored },
    ])
    txMock.project.create.mockResolvedValue({
      id: 'created-project',
      name: requested,
    })

    await expect(resolveCreatorProject({
      userId: 'user-1',
      name: requested,
    })).resolves.toEqual({
      projectId: 'created-project',
      name: requested,
      created: true,
    })
  })

  it('throws a deterministic conflict instead of choosing among exact duplicates', async () => {
    txMock.project.findMany.mockResolvedValue([
      { id: 'project-a', name: 'Duplicate' },
      { id: 'project-b', name: 'Duplicate' },
      { id: 'project-case-variant', name: 'duplicate' },
    ])

    await expect(resolveCreatorProject({
      userId: 'user-1',
      name: 'Duplicate',
    })).rejects.toMatchObject({
      code: 'PROJECT_NAME_AMBIGUOUS',
      status: 409,
    })
    expect(txMock.project.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionProject.create).not.toHaveBeenCalled()
  })

  it('creates both project rows in the same transaction and trims persisted text', async () => {
    await expect(resolveCreatorProject({
      userId: 'user-1',
      name: '  Exact Project  ',
      description: '  Project introduction  ',
    })).resolves.toEqual({
      projectId: 'project-created',
      name: 'Exact Project',
      created: true,
    })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(txMock.project.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        name: 'Exact Project',
        description: 'Project introduction',
      },
      select: {
        id: true,
        name: true,
      },
    })
    expect(txMock.novelPromotionProject.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-created',
      },
    })
  })

  it('locks the complete shared preference field list and inherits valid values', async () => {
    expect(PROJECT_PREFERENCE_DEFAULT_FIELDS).toEqual([
      'analysisModel',
      'characterModel',
      'locationModel',
      'storyboardModel',
      'editModel',
      'videoModel',
      'audioModel',
      'videoRatio',
      'artStyle',
      'ttsRate',
    ])
    txMock.userPreference.findUnique.mockResolvedValue({
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
    })

    await resolveCreatorProject({
      userId: 'user-1',
      name: 'Exact Project',
    })

    expect(txMock.userPreference.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: {
        analysisModel: true,
        characterModel: true,
        locationModel: true,
        storyboardModel: true,
        editModel: true,
        videoModel: true,
        audioModel: true,
        videoRatio: true,
        artStyle: true,
        ttsRate: true,
      },
    })
    expect(txMock.novelPromotionProject.create).toHaveBeenCalledWith({
      data: {
        projectId: 'project-created',
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

  it('falls back only an invalid stored artStyle while retaining other preferences', async () => {
    txMock.userPreference.findUnique.mockResolvedValue({
      analysisModel: null,
      characterModel: null,
      locationModel: null,
      storyboardModel: null,
      editModel: null,
      videoModel: null,
      audioModel: null,
      videoRatio: '9:16',
      artStyle: 'unsupported-style',
      ttsRate: '+50%',
    })

    await resolveCreatorProject({
      userId: 'user-1',
      name: 'Exact Project',
    })

    expect(txMock.novelPromotionProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-created',
        videoRatio: '9:16',
        artStyle: 'american-comic',
        ttsRate: '+50%',
      }),
    })
  })

  it('uses a complete initial visual-settings pair for a newly created project', async () => {
    txMock.userPreference.findUnique.mockResolvedValue({
      videoRatio: '9:16',
      artStyle: 'realistic',
    })

    await resolveCreatorProject({
      userId: 'user-1',
      name: 'Exact Project',
      initialVideoRatio: '16:9',
      initialArtStyle: 'chinese-xianxia',
    })

    expect(txMock.novelPromotionProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: 'project-created',
        videoRatio: '16:9',
        artStyle: 'chinese-xianxia',
      }),
    })
  })

  it('returns an exact existing project without writing initial visual settings', async () => {
    txMock.project.findMany.mockResolvedValue([
      { id: 'existing-project', name: 'Exact Project' },
    ])

    await expect(resolveCreatorProject({
      userId: 'user-1',
      name: 'Exact Project',
      initialVideoRatio: '16:9',
      initialArtStyle: 'chinese-xianxia',
    })).resolves.toEqual({
      projectId: 'existing-project',
      name: 'Exact Project',
      created: false,
    })

    expect(txMock.userPreference.findUnique).not.toHaveBeenCalled()
    expect(txMock.novelPromotionProject.create).not.toHaveBeenCalled()
    expect(txMock.novelPromotionProject.update).not.toHaveBeenCalled()
    expect(txMock.novelPromotionProject.updateMany).not.toHaveBeenCalled()
  })
})

describe('POST /api/agent/v1/projects/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'agent-token'
    process.env.WAOO_AGENT_USER_ID = 'user-1'
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' })
    txMock.$queryRaw.mockResolvedValue([{ id: 'user-1' }])
    txMock.project.findMany.mockResolvedValue([])
    txMock.userPreference.findUnique.mockResolvedValue(null)
    txMock.project.create.mockResolvedValue({
      id: 'project-created',
      name: 'Exact Project',
    })
    txMock.novelPromotionProject.create.mockResolvedValue({ id: 'novel-created' })
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
    )
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

  it('requires the exact name-derived Idempotency-Key and returns only the strict result', async () => {
    const response = await POST(
      routeRequest({ name: '  Exact Project  ', description: ' intro ' }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      requestId: 'req-project-resolver-unit',
      data: {
        projectId: 'project-created',
        name: 'Exact Project',
        created: true,
      },
    })
  })

  it('accepts only a complete valid initial visual-settings pair', async () => {
    const valid = {
      name: 'Exact Project',
      initialVideoRatio: '16:9',
      initialArtStyle: 'chinese-xianxia',
    }
    const validResponse = await POST(
      routeRequest(valid, resolveProjectIdempotencyKey(valid.name, valid)),
      { params: Promise.resolve({}) },
    )
    expect(validResponse.status).toBe(200)

    for (const body of [
      { name: 'Exact Project', initialVideoRatio: '16:9' },
      { name: 'Exact Project', initialArtStyle: 'chinese-xianxia' },
      { name: 'Exact Project', initialVideoRatio: 'unknown', initialArtStyle: 'chinese-xianxia' },
      { name: 'Exact Project', initialVideoRatio: '16:9', initialArtStyle: 'unknown' },
    ]) {
      const response = await POST(routeRequest(body), { params: Promise.resolve({}) })
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('CONTRACT_INVALID')
    }
  })

  it.each([
    { name: 'unknown user id', body: { name: 'Exact Project', userId: 'other-user' } },
    { name: 'model field', body: { name: 'Exact Project', analysisModel: 'model-1' } },
    { name: 'dryRun', body: { name: 'Exact Project', dryRun: true } },
  ])('rejects $name without starting a transaction', async ({ body }) => {
    const response = await POST(
      routeRequest(body),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('CONTRACT_INVALID')
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a mismatched Idempotency-Key before resolving', async () => {
    const response = await POST(
      routeRequest(
        { name: 'Exact Project' },
        resolveProjectIdempotencyKey('Different Project'),
      ),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({
      code: 'CONTRACT_INVALID',
      field: 'Idempotency-Key',
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('sanitizes unexpected transaction errors', async () => {
    prismaMock.$transaction.mockRejectedValue(
      new Error('SQL password=super-secret failed'),
    )

    const response = await POST(
      routeRequest({ name: 'Exact Project' }),
      { params: Promise.resolve({}) },
    )
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toMatchObject({
      code: 'AGENT_INTERNAL_ERROR',
      retryable: true,
    })
    expect(JSON.stringify(body)).not.toContain('super-secret')
    expect(JSON.stringify(body)).not.toContain('SQL')
  })
})
