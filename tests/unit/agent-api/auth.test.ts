import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
  project: {
    findUnique: vi.fn(),
  },
  agentCreationRun: {
    findUnique: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

import {
  requireAgentAuth,
  requireAgentProject,
  requireAgentRun,
} from '@/lib/agent-api/auth'

const ORIGINAL_ENV = {
  WAOO_AGENT_API_ENABLED: process.env.WAOO_AGENT_API_ENABLED,
  WAOO_AGENT_TOKEN: process.env.WAOO_AGENT_TOKEN,
  WAOO_AGENT_USER_ID: process.env.WAOO_AGENT_USER_ID,
}

function agentRequest(overrides: Record<string, string> = {}) {
  return new Request('http://localhost/api/agent/v1/runs/run-1', {
    headers: {
      Authorization: 'Bearer test-agent-token',
      'X-Waoo-User-Id': 'user-1',
      ...overrides,
    },
  })
}

describe('agent API authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'test-agent-token'
    process.env.WAOO_AGENT_USER_ID = 'user-1'
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' })
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

  it.each([undefined, '', 'false', 'TRUE'])(
    'hides the API with a 404 unless WAOO_AGENT_API_ENABLED is exactly true (%s)',
    async (enabled) => {
      if (enabled === undefined) {
        delete process.env.WAOO_AGENT_API_ENABLED
      } else {
        process.env.WAOO_AGENT_API_ENABLED = enabled
      }

      await expect(requireAgentAuth(agentRequest())).rejects.toMatchObject({
        code: 'AGENT_RESOURCE_NOT_FOUND',
        status: 404,
      })
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'the configured token is absent',
      setup: () => delete process.env.WAOO_AGENT_TOKEN,
      request: () => agentRequest(),
    },
    {
      name: 'the authorization header is absent',
      setup: () => undefined,
      request: () => new Request('http://localhost/api/agent/v1/runs/run-1', {
        headers: { 'X-Waoo-User-Id': 'user-1' },
      }),
    },
    {
      name: 'the authorization scheme is malformed',
      setup: () => undefined,
      request: () => agentRequest({ Authorization: 'Basic test-agent-token' }),
    },
    {
      name: 'the bearer token is different',
      setup: () => undefined,
      request: () => agentRequest({ Authorization: 'Bearer wrong-agent-token' }),
    },
    {
      name: 'the bearer token has a different length',
      setup: () => undefined,
      request: () => agentRequest({ Authorization: 'Bearer x' }),
    },
  ])('returns the same safe unauthorized error when $name', async ({ setup, request }) => {
    setup()

    const error = await requireAgentAuth(request()).catch((caught) => caught)

    expect(error).toMatchObject({
      code: 'AGENT_UNAUTHORIZED',
      status: 401,
    })
    expect(JSON.stringify(error)).not.toContain('test-agent-token')
    expect(JSON.stringify(error)).not.toContain('wrong-agent-token')
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'the configured user id is absent',
      setup: () => delete process.env.WAOO_AGENT_USER_ID,
      request: () => agentRequest(),
    },
    {
      name: 'the user header is absent',
      setup: () => undefined,
      request: () => new Request('http://localhost/api/agent/v1/runs/run-1', {
        headers: { Authorization: 'Bearer test-agent-token' },
      }),
    },
    {
      name: 'the user header differs from the configured user',
      setup: () => undefined,
      request: () => agentRequest({ 'X-Waoo-User-Id': 'user-2' }),
    },
  ])('returns forbidden when $name', async ({ setup, request }) => {
    setup()

    await expect(requireAgentAuth(request())).rejects.toMatchObject({
      code: 'AGENT_FORBIDDEN',
      status: 403,
    })
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled()
  })

  it('returns forbidden when the configured user does not exist', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)

    await expect(requireAgentAuth(agentRequest())).rejects.toMatchObject({
      code: 'AGENT_FORBIDDEN',
      status: 403,
    })
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true },
    })
  })

  it('returns only the configured authenticated user id', async () => {
    await expect(requireAgentAuth(agentRequest())).resolves.toEqual({
      userId: 'user-1',
    })
  })

  it('keeps bearer token verification on fixed-length timing-safe digests', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/lib/agent-api/auth.ts'),
      'utf8',
    )
    const directTokenComparison =
      /\b(?:actualToken|expectedToken|actual|expected)\b\s*(?:===|!==|==|!=)\s*\b(?:actualToken|expectedToken|actual|expected)\b/

    expect(source).toMatch(/\bcreateHash\s*\(\s*['"]sha256['"]\s*\)/)
    expect(source).toMatch(/\btimingSafeEqual\s*\(/)
    expect(source).not.toMatch(directTokenComparison)
  })
})

describe('agent API ownership checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WAOO_AGENT_API_ENABLED = 'true'
    process.env.WAOO_AGENT_TOKEN = 'test-agent-token'
    process.env.WAOO_AGENT_USER_ID = 'user-1'
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' })
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

  it('distinguishes a missing project from a project owned by another user', async () => {
    prismaMock.project.findUnique.mockResolvedValueOnce(null)

    await expect(requireAgentProject(agentRequest(), 'project-missing')).rejects.toMatchObject({
      code: 'AGENT_RESOURCE_NOT_FOUND',
      status: 404,
    })

    prismaMock.project.findUnique.mockResolvedValueOnce({
      id: 'project-2',
      userId: 'user-2',
    })

    await expect(requireAgentProject(agentRequest(), 'project-2')).rejects.toMatchObject({
      code: 'AGENT_FORBIDDEN',
      status: 403,
    })
  })

  it('returns a minimal context for a project owned by the authenticated user', async () => {
    prismaMock.project.findUnique.mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
    })

    await expect(requireAgentProject(agentRequest(), 'project-1')).resolves.toEqual({
      userId: 'user-1',
      projectId: 'project-1',
    })
    expect(prismaMock.project.findUnique).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      select: { id: true, userId: true },
    })
  })

  it('distinguishes a missing run from a run owned by another user', async () => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValueOnce(null)

    await expect(requireAgentRun(agentRequest(), 'run-missing')).rejects.toMatchObject({
      code: 'AGENT_RESOURCE_NOT_FOUND',
      status: 404,
    })

    prismaMock.agentCreationRun.findUnique.mockResolvedValueOnce({
      id: 'run-2',
      userId: 'user-2',
      projectId: 'project-2',
      project: { userId: 'user-2' },
    })

    await expect(requireAgentRun(agentRequest(), 'run-2')).rejects.toMatchObject({
      code: 'AGENT_FORBIDDEN',
      status: 403,
    })
  })

  it('rejects a run when its project relation is not owned by the authenticated user', async () => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValue({
      id: 'run-1',
      userId: 'user-1',
      projectId: 'project-2',
      project: { userId: 'user-2' },
    })

    await expect(requireAgentRun(agentRequest(), 'run-1')).rejects.toMatchObject({
      code: 'AGENT_FORBIDDEN',
      status: 403,
    })
  })

  it('returns a minimal context only when the run and its project belong to the user', async () => {
    prismaMock.agentCreationRun.findUnique.mockResolvedValue({
      id: 'run-1',
      userId: 'user-1',
      projectId: 'project-1',
      project: { userId: 'user-1' },
    })

    await expect(requireAgentRun(agentRequest(), 'run-1')).resolves.toEqual({
      userId: 'user-1',
      projectId: 'project-1',
      runId: 'run-1',
    })
    expect(prismaMock.agentCreationRun.findUnique).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      select: {
        id: true,
        userId: true,
        projectId: true,
        project: {
          select: { userId: true },
        },
      },
    })
  })
})
