import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import { agentContractRegistry } from '@/lib/agent-api/contracts/registry'
import { AgentApiError } from '@/lib/agent-api/errors'

const authMock = vi.hoisted(() => ({
  requireAgentAuth: vi.fn(),
  requireAgentProject: vi.fn(),
}))

const rulesMock = vi.hoisted(() => ({
  loadCreatorRuleBundle: vi.fn(),
}))

vi.mock('@/lib/agent-api/auth', () => authMock)
vi.mock('@/lib/agent-api/rules/load-rule-bundle', () => rulesMock)

function request(path: string, requestId = 'req-rules-1') {
  return new Request(`http://localhost${path}`, {
    headers: {
      authorization: 'Bearer agent-token-must-not-leak',
      'x-waoo-user-id': 'user-1',
      'x-request-id': requestId,
    },
  })
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

const RULE_BUNDLE = {
  schemaVersion: 1 as const,
  ruleSetVersion: 'waoo-creator-v1',
  contentHash: `sha256:${'a'.repeat(64)}`,
  locale: 'zh' as const,
  projectSettings: {
    artStyle: 'realistic',
    artStylePrompt: 'current style prompt',
    videoRatio: '9:16',
    imageResolution: '2K',
    forcedStoryboardDurationSec: null,
  },
  rules: [],
  contracts: [],
}

describe('GET Agent creator rules route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.requireAgentProject.mockResolvedValue({
      userId: 'user-1',
      projectId: 'project-1',
    })
    rulesMock.loadCreatorRuleBundle.mockResolvedValue(RULE_BUNDLE)
  })

  it('authenticates project ownership, defaults locale to zh, and preserves requestId envelope', async () => {
    const { GET } = await import(
      '@/app/api/agent/v1/projects/[projectId]/creator-rules/route'
    )
    const req = request('/api/agent/v1/projects/project-1/creator-rules')
    const response = await GET(req, {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('req-rules-1')
    expect(authMock.requireAgentProject).toHaveBeenCalledWith(req, 'project-1')
    expect(rulesMock.loadCreatorRuleBundle).toHaveBeenCalledWith({
      projectId: 'project-1',
      locale: 'zh',
    })
    expect(await body(response)).toEqual({
      success: true,
      requestId: 'req-rules-1',
      data: RULE_BUNDLE,
    })
  })

  it('accepts en and rejects every locale outside zh|en', async () => {
    const { GET } = await import(
      '@/app/api/agent/v1/projects/[projectId]/creator-rules/route'
    )
    const enResponse = await GET(
      request('/api/agent/v1/projects/project-1/creator-rules?locale=en', 'req-en'),
      { params: Promise.resolve({ projectId: 'project-1' }) },
    )
    expect(enResponse.status).toBe(200)
    expect(rulesMock.loadCreatorRuleBundle).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      locale: 'en',
    })

    const invalidResponse = await GET(
      request('/api/agent/v1/projects/project-1/creator-rules?locale=fr', 'req-fr'),
      { params: Promise.resolve({ projectId: 'project-1' }) },
    )
    expect(invalidResponse.status).toBe(400)
    expect(await body(invalidResponse)).toMatchObject({
      success: false,
      requestId: 'req-fr',
      error: {
        code: 'CONTRACT_INVALID',
        field: 'locale',
        retryable: false,
      },
    })
  })

  it('returns the unified forbidden envelope when project ownership fails', async () => {
    authMock.requireAgentProject.mockRejectedValueOnce(
      new AgentApiError('AGENT_FORBIDDEN'),
    )
    const { GET } = await import(
      '@/app/api/agent/v1/projects/[projectId]/creator-rules/route'
    )
    const response = await GET(
      request('/api/agent/v1/projects/project-2/creator-rules', 'req-forbidden'),
      { params: Promise.resolve({ projectId: 'project-2' }) },
    )
    const responseBody = await body(response)

    expect(response.status).toBe(403)
    expect(responseBody).toMatchObject({
      success: false,
      requestId: 'req-forbidden',
      error: { code: 'AGENT_FORBIDDEN' },
    })
    expect(JSON.stringify(responseBody)).not.toContain('agent-token-must-not-leak')
    expect(rulesMock.loadCreatorRuleBundle).not.toHaveBeenCalled()
  })
})

describe('GET Agent contract route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authMock.requireAgentAuth.mockResolvedValue({ userId: 'user-1' })
  })

  it('returns only a registered canonical JSON Schema and its hash', async () => {
    const { GET } = await import(
      '@/app/api/agent/v1/contracts/[contractId]/route'
    )
    const contractId = 'waoo-agent-story.v1'
    const req = request(`/api/agent/v1/contracts/${contractId}`, 'req-contract')
    const response = await GET(req, {
      params: Promise.resolve({ contractId }),
    })
    const responseBody = await body(response)

    expect(authMock.requireAgentAuth).toHaveBeenCalledWith(req)
    expect(response.status).toBe(200)
    expect(responseBody).toEqual({
      success: true,
      requestId: 'req-contract',
      data: {
        id: contractId,
        hash: hashArtifact(agentContractRegistry[contractId].jsonSchema),
        jsonSchema: agentContractRegistry[contractId].jsonSchema,
      },
    })
  })

  it.each([
    'unknown-contract.v1',
    '../../package.json',
    'waoo-agent-story.v1/../../secret',
  ])('rejects unregistered contract id %s without arbitrary path access', async (contractId) => {
    const { GET } = await import(
      '@/app/api/agent/v1/contracts/[contractId]/route'
    )
    const response = await GET(
      request('/api/agent/v1/contracts/unknown', 'req-not-found'),
      { params: Promise.resolve({ contractId }) },
    )

    expect(response.status).toBe(404)
    expect(await body(response)).toMatchObject({
      success: false,
      requestId: 'req-not-found',
      error: {
        code: 'AGENT_RESOURCE_NOT_FOUND',
        retryable: false,
      },
    })
  })

  it('authenticates before exposing a registered contract', async () => {
    authMock.requireAgentAuth.mockRejectedValueOnce(
      new AgentApiError('AGENT_UNAUTHORIZED'),
    )
    const { GET } = await import(
      '@/app/api/agent/v1/contracts/[contractId]/route'
    )
    const response = await GET(
      request('/api/agent/v1/contracts/waoo-agent-assets.v1', 'req-unauthorized'),
      { params: Promise.resolve({ contractId: 'waoo-agent-assets.v1' }) },
    )
    const responseBody = await body(response)

    expect(response.status).toBe(401)
    expect(responseBody).toMatchObject({
      success: false,
      requestId: 'req-unauthorized',
      error: { code: 'AGENT_UNAUTHORIZED' },
    })
    expect(JSON.stringify(responseBody)).not.toContain('agent-token-must-not-leak')
  })
})
