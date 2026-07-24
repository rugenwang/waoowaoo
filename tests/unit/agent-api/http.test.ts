import { z } from 'zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
}))

vi.mock('@/lib/logging/core', () => ({
  createScopedLogger: () => loggerMock,
}))

import {
  AGENT_ERROR_SPECS,
  AgentApiError,
} from '@/lib/agent-api/errors'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  toAgentFailure,
} from '@/lib/agent-api/http'

async function json(response: Response) {
  return await response.json() as Record<string, unknown>
}

describe('Agent API errors', () => {
  it('defines every normative error code with its exact HTTP status and default retryability', () => {
    expect(AGENT_ERROR_SPECS).toEqual({
      CONTRACT_INVALID: { status: 400, retryable: false, message: expect.any(String) },
      REFERENCE_INVALID: { status: 400, retryable: false, message: expect.any(String) },
      ARTIFACT_HASH_MISMATCH: { status: 400, retryable: false, message: expect.any(String) },
      AGENT_UNAUTHORIZED: { status: 401, retryable: false, message: expect.any(String) },
      AGENT_FORBIDDEN: { status: 403, retryable: false, message: expect.any(String) },
      AGENT_RESOURCE_NOT_FOUND: { status: 404, retryable: false, message: expect.any(String) },
      PROJECT_NAME_AMBIGUOUS: { status: 409, retryable: false, message: expect.any(String) },
      RUN_DEFINITION_CONFLICT: { status: 409, retryable: false, message: expect.any(String) },
      EPISODE_NUMBER_CONFLICT: { status: 409, retryable: false, message: expect.any(String) },
      ASSET_IDENTITY_CONFLICT: { status: 409, retryable: false, message: expect.any(String) },
      RULESET_MISMATCH: { status: 409, retryable: false, message: expect.any(String) },
      UPLOAD_TOO_LARGE: { status: 413, retryable: false, message: expect.any(String) },
      UPLOAD_TYPE_UNSUPPORTED: { status: 415, retryable: false, message: expect.any(String) },
      RUN_INCOMPLETE: { status: 422, retryable: false, message: expect.any(String) },
      AGENT_INTERNAL_ERROR: { status: 500, retryable: true, message: expect.any(String) },
    })
  })

  it('permits an explicit retry override and retains only safe scalar details', () => {
    const error = new AgentApiError('EPISODE_NUMBER_CONFLICT', {
      retryable: true,
      details: {
        attempt: 2,
        temporary: true,
        reason: 'concurrent allocation',
        empty: null,
        nested: { secret: 'db-password' },
        list: ['db-password'],
        missing: undefined,
        infinite: Number.POSITIVE_INFINITY,
        notANumber: Number.NaN,
      },
    })

    expect(error.retryable).toBe(true)
    expect(error.details).toEqual({
      attempt: 2,
      temporary: true,
      reason: 'concurrent allocation',
      empty: null,
    })
    expect(JSON.stringify(error)).not.toContain('db-password')
  })
})

describe('Agent API HTTP envelopes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds a success envelope and mirrors the request id in the response header', async () => {
    const response = agentSuccess('req_success', { projectId: 'project-1' }, { status: 201 })

    expect(response.status).toBe(201)
    expect(response.headers.get('x-request-id')).toBe('req_success')
    expect(await json(response)).toEqual({
      success: true,
      requestId: 'req_success',
      data: { projectId: 'project-1' },
    })
  })

  it('normalizes a known Agent API error without unsafe detail values', async () => {
    const response = toAgentFailure(
      new AgentApiError('CONTRACT_INVALID', {
        field: 'episodes[0].ordinal',
        details: {
          expected: 1,
          unsafe: { database: 'mysql://root:secret@host/db' },
        },
      }),
      'req_failure',
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('x-request-id')).toBe('req_failure')
    expect(await json(response)).toEqual({
      success: false,
      requestId: 'req_failure',
      error: {
        code: 'CONTRACT_INVALID',
        message: AGENT_ERROR_SPECS.CONTRACT_INVALID.message,
        field: 'episodes[0].ordinal',
        retryable: false,
        details: { expected: 1 },
      },
    })
  })

  it('turns an unknown exception into a generic 500 without leaking sensitive text', async () => {
    const secret = 'Bearer env-token-value mysql://root:db-password@host/db'
    const error = new Error(secret)
    error.stack = `Error: ${secret}\n at secret-stack.ts:1`

    const response = toAgentFailure(error, 'req_internal')
    const serialized = JSON.stringify(await json(response))

    expect(response.status).toBe(500)
    expect(serialized).toContain('AGENT_INTERNAL_ERROR')
    expect(serialized).not.toContain('env-token-value')
    expect(serialized).not.toContain('db-password')
    expect(serialized).not.toContain('secret-stack')
  })
})

describe('parseAgentJson', () => {
  const schema = z.object({
    storyboards: z.array(z.object({
      panels: z.array(z.object({
        frames: z.array(z.object({
          frameTimeSec: z.number().positive(),
        }).strict()),
      }).strict()),
    }).strict()),
  }).strict()

  it('strictly parses valid JSON into the schema output', async () => {
    const body = {
      storyboards: [{
        panels: [{
          frames: [{ frameTimeSec: 1.5 }],
        }],
      }],
    }
    const request = new Request('http://localhost/api/agent/v1/test', {
      method: 'POST',
      body: JSON.stringify(body),
    })

    await expect(parseAgentJson(request, schema)).resolves.toEqual(body)
  })

  it('reports the first Zod issue using dotted object and bracketed array segments', async () => {
    const request = new Request('http://localhost/api/agent/v1/test', {
      method: 'POST',
      body: JSON.stringify({
        storyboards: [{
          panels: [
            { frames: [{ frameTimeSec: 1 }] },
            { frames: [{ frameTimeSec: -1 }] },
          ],
        }],
      }),
    })

    await expect(parseAgentJson(request, schema)).rejects.toMatchObject({
      code: 'CONTRACT_INVALID',
      field: 'storyboards[0].panels[1].frames[0].frameTimeSec',
    })
  })

  it('rejects malformed JSON and unknown properties as CONTRACT_INVALID', async () => {
    const malformed = new Request('http://localhost/api/agent/v1/test', {
      method: 'POST',
      body: '{"storyboards":',
    })
    await expect(parseAgentJson(malformed, schema)).rejects.toMatchObject({
      code: 'CONTRACT_INVALID',
    })

    const extra = new Request('http://localhost/api/agent/v1/test', {
      method: 'POST',
      body: JSON.stringify({
        storyboards: [],
        dryRun: true,
      }),
    })
    await expect(parseAgentJson(extra, schema)).rejects.toMatchObject({
      code: 'CONTRACT_INVALID',
      field: 'dryRun',
    })
  })
})

describe('agentRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a non-Response handler result instead of guessing a success envelope', async () => {
    const handler = vi.fn(async (
      _request: Request,
      _context: { params: Promise<Record<string, string>> },
      requestId: string,
    ) => ({ echoedRequestId: requestId }))
    const route = agentRoute(handler)

    const response = await route(
      new Request('http://localhost/api/agent/v1/projects/resolve', {
        headers: { 'x-request-id': 'req_from_client' },
      }),
      { params: Promise.resolve({}) },
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(response.headers.get('x-request-id')).toBe('req_from_client')
    expect(await json(response)).toEqual({
      success: false,
      requestId: 'req_from_client',
      error: {
        code: 'AGENT_INTERNAL_ERROR',
        message: AGENT_ERROR_SPECS.AGENT_INTERNAL_ERROR.message,
        retryable: true,
      },
    })
  })

  it('rejects a raw 200 Response without leaking its body', async () => {
    const rawBody = 'Bearer raw-secret-token mysql://root:password@host/db'
    const route = agentRoute(async () => new Response(
      JSON.stringify({ ok: true, rawBody }),
      { status: 200 },
    ))

    const response = await route(
      new Request('http://localhost/api/agent/v1/runs', {
        headers: { 'x-request-id': 'req_raw_200' },
      }),
      { params: Promise.resolve({}) },
    )
    const serialized = JSON.stringify(await json(response))

    expect(response.status).toBe(500)
    expect(response.headers.get('x-request-id')).toBe('req_raw_200')
    expect(serialized).toContain('AGENT_INTERNAL_ERROR')
    expect(serialized).toContain('req_raw_200')
    expect(serialized).not.toContain('raw-secret-token')
    expect(serialized).not.toContain('mysql://')
  })

  it.each([400, 404, 500, 503])(
    'rejects a raw %s Response instead of passing through a nonstandard failure',
    async (rawStatus) => {
      const rawBody = `unsafe-raw-body-${rawStatus}`
      const route = agentRoute(async () => new Response(rawBody, { status: rawStatus }))

      const response = await route(
        new Request('http://localhost/api/agent/v1/runs', {
          headers: { 'x-request-id': `req_raw_${rawStatus}` },
        }),
        { params: Promise.resolve({}) },
      )
      const body = await json(response)

      expect(response.status).toBe(500)
      expect(response.headers.get('x-request-id')).toBe(`req_raw_${rawStatus}`)
      expect(body).toEqual({
        success: false,
        requestId: `req_raw_${rawStatus}`,
        error: {
          code: 'AGENT_INTERNAL_ERROR',
          message: AGENT_ERROR_SPECS.AGENT_INTERNAL_ERROR.message,
          retryable: true,
        },
      })
      expect(JSON.stringify(body)).not.toContain(rawBody)
    },
  )

  it('preserves a branded agentSuccess response with its status, body, and request id', async () => {
    const route = agentRoute(async (_request, _context, requestId) => (
      agentSuccess(requestId, { accepted: true }, { status: 202 })
    ))

    const response = await route(
      new Request('http://localhost/api/agent/v1/runs', { method: 'POST' }),
      { params: Promise.resolve({}) },
    )
    const body = await json(response)

    expect(response.status).toBe(202)
    expect(body).toEqual({
      success: true,
      requestId: expect.stringMatching(/^req_/),
      data: { accepted: true },
    })
    expect(response.headers.get('x-request-id')).toBe(body.requestId)
  })

  it('allows a managed Response to be consumed only once across sequential requests', async () => {
    const requestId = 'req_sequential_reuse'
    const managedResponse = agentSuccess(
      requestId,
      { accepted: true },
      { status: 202 },
    )
    const route = agentRoute(async () => managedResponse)
    const context = { params: Promise.resolve({}) }

    const first = await route(
      new Request('http://localhost/api/agent/v1/runs', {
        headers: { 'x-request-id': requestId },
      }),
      context,
    )
    const second = await route(
      new Request('http://localhost/api/agent/v1/runs', {
        headers: { 'x-request-id': requestId },
      }),
      context,
    )

    expect(first.status).toBe(202)
    expect(await json(first)).toEqual({
      success: true,
      requestId,
      data: { accepted: true },
    })
    expect(second.status).toBe(500)
    expect(await json(second)).toEqual({
      success: false,
      requestId,
      error: {
        code: 'AGENT_INTERNAL_ERROR',
        message: AGENT_ERROR_SPECS.AGENT_INTERNAL_ERROR.message,
        retryable: true,
      },
    })
  })

  it('allows exactly one concurrent request to consume a shared managed Response', async () => {
    const requestId = 'req_concurrent_reuse'
    const managedResponse = agentSuccess(
      requestId,
      { accepted: true },
      { status: 202 },
    )
    const route = agentRoute(async () => managedResponse)
    const invoke = () => route(
      new Request('http://localhost/api/agent/v1/runs', {
        headers: { 'x-request-id': requestId },
      }),
      { params: Promise.resolve({}) },
    )

    const responses = await Promise.all([invoke(), invoke()])
    const successes = responses.filter((response) => response.status === 202)
    const failures = responses.filter((response) => response.status === 500)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(await json(successes[0])).toEqual({
      success: true,
      requestId,
      data: { accepted: true },
    })
    expect(await json(failures[0])).toEqual({
      success: false,
      requestId,
      error: {
        code: 'AGENT_INTERNAL_ERROR',
        message: AGENT_ERROR_SPECS.AGENT_INTERNAL_ERROR.message,
        retryable: true,
      },
    })
  })

  it('normalizes thrown errors and logs only safe metadata', async () => {
    const secret = 'Bearer super-secret-token DB query password=hidden'
    const unsafeError = new Error(secret)
    unsafeError.stack = `Error: ${secret}\n at secret-stack-marker.ts:1`
    const route = agentRoute(async () => {
      throw unsafeError
    })

    const response = await route(
      new Request('http://localhost/api/agent/v1/runs/run-1', {
        headers: { 'x-request-id': 'req_logged_failure' },
      }),
      { params: Promise.resolve({ runId: 'run-1' }) },
    )
    const body = await json(response)
    const serializedResponse = JSON.stringify(body)
    const serializedLogs = JSON.stringify(loggerMock.error.mock.calls)

    expect(response.status).toBe(500)
    expect(body.requestId).toBe('req_logged_failure')
    expect(loggerMock.error).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req_logged_failure',
      errorCode: 'AGENT_INTERNAL_ERROR',
    }))
    expect(serializedResponse).not.toContain(secret)
    expect(serializedLogs).not.toContain('super-secret-token')
    expect(serializedLogs).not.toContain('password=hidden')
    expect(serializedLogs).not.toContain('secret-stack-marker')
  })
})
