import { createScopedLogger } from '@/lib/logging/core'
import { z } from 'zod'

import {
  AgentApiError,
  isAgentApiError,
} from './errors'

type RouteParamValue = string | string[] | undefined
type RouteParams = Record<string, RouteParamValue>

export type AgentRouteContext<TParams extends RouteParams = RouteParams> = {
  params: Promise<TParams>
}

export type AgentRouteHandler<TParams extends RouteParams = RouteParams> = (
  request: Request,
  context: AgentRouteContext<TParams>,
  requestId: string,
) => Promise<Response | unknown>

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const logger = createScopedLogger({ module: 'agent-api' })

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `req_${crypto.randomUUID()}`
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function requestIdFor(request: Request): string {
  const supplied = request.headers.get('x-request-id')
  return supplied && REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : createRequestId()
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers)
  headers.set('x-request-id', requestId)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function issuePath(path: Array<string | number>): string {
  return path.reduce<string>((field, segment) => {
    if (typeof segment === 'number') return `${field}[${segment}]`
    return field ? `${field}.${segment}` : segment
  }, '')
}

function issueField(issue: z.ZodIssue): string | undefined {
  const path = issuePath(issue.path)
  if (issue.code !== z.ZodIssueCode.unrecognized_keys || issue.keys.length === 0) {
    return path || undefined
  }

  const unknownKey = issue.keys[0]
  return path ? `${path}.${unknownKey}` : unknownKey
}

export function agentSuccess<T>(
  requestId: string,
  data: T,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  headers.set('x-request-id', requestId)

  return new Response(JSON.stringify({
    success: true,
    requestId,
    data,
  }), {
    ...init,
    headers,
  })
}

export async function parseAgentJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new AgentApiError('CONTRACT_INVALID')
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0]
    throw new AgentApiError('CONTRACT_INVALID', {
      field: firstIssue ? issueField(firstIssue) : undefined,
    })
  }
  return parsed.data
}

export function toAgentFailure(error: unknown, requestId: string): Response {
  const normalized = isAgentApiError(error)
    ? error
    : new AgentApiError('AGENT_INTERNAL_ERROR')

  const headers = new Headers({
    'content-type': 'application/json',
    'x-request-id': requestId,
  })
  const body = {
    success: false,
    requestId,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.field !== undefined ? { field: normalized.field } : {}),
      retryable: normalized.retryable,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  }

  return new Response(JSON.stringify(body), {
    status: normalized.status,
    headers,
  })
}

export function agentRoute<TParams extends RouteParams = RouteParams>(
  handler: AgentRouteHandler<TParams>,
) {
  return async (
    request: Request,
    context: AgentRouteContext<TParams>,
  ): Promise<Response> => {
    const requestId = requestIdFor(request)

    try {
      const result = await handler(request, context, requestId)
      return result instanceof Response
        ? withRequestId(result, requestId)
        : agentSuccess(requestId, result)
    } catch (error) {
      const normalized = isAgentApiError(error)
        ? error
        : new AgentApiError('AGENT_INTERNAL_ERROR')

      logger.error({
        action: 'agent_api.request.error',
        message: 'Agent API request failed',
        errorCode: normalized.code,
        retryable: normalized.retryable,
        details: {
          method: request.method,
          path: new URL(request.url).pathname,
          errorType: error instanceof Error ? error.name : typeof error,
        },
      })

      return toAgentFailure(normalized, requestId)
    }
  }
}
