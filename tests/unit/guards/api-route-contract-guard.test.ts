import { describe, expect, it } from 'vitest'
import {
  API_HANDLER_ALLOWLIST,
  PUBLIC_ROUTE_ALLOWLIST,
  inspectRouteContract,
} from '../../../scripts/guards/api-route-contract-guard.mjs'

describe('api route contract guard', () => {
  it('allows explicit public and framework-managed exceptions', () => {
    expect(API_HANDLER_ALLOWLIST.has('src/app/api/auth/[...nextauth]/route.ts')).toBe(true)
    expect(PUBLIC_ROUTE_ALLOWLIST.has('src/app/api/system/boot-id/route.ts')).toBe(true)
    expect(
      inspectRouteContract(
        'src/app/api/system/boot-id/route.ts',
        'export async function GET() { return Response.json({ bootId: "x" }) }',
      ),
    ).toEqual([])
  })

  it('passes protected routes that use apiHandler and explicit auth', () => {
    const content = `
      import { requireUserAuth } from '@/lib/api-auth'
      import { apiHandler } from '@/lib/api-errors'
      export const GET = apiHandler(async () => {
        await requireUserAuth()
        return Response.json({ ok: true })
      })
    `

    expect(inspectRouteContract('src/app/api/user/secure/route.ts', content)).toEqual([])
  })

  it('flags protected routes that skip apiHandler or auth', () => {
    const missingApiHandler = `
      import { requireUserAuth } from '@/lib/api-auth'
      export async function GET() {
        await requireUserAuth()
        return Response.json({ ok: true })
      }
    `
    const missingAuth = `
      import { apiHandler } from '@/lib/api-errors'
      export const GET = apiHandler(async () => Response.json({ ok: true }))
    `

    expect(inspectRouteContract('src/app/api/user/secure/route.ts', missingApiHandler)).toEqual([
      'src/app/api/user/secure/route.ts missing apiHandler wrapper',
    ])
    expect(inspectRouteContract('src/app/api/user/secure/route.ts', missingAuth)).toEqual([
      'src/app/api/user/secure/route.ts missing requireUserAuth/requireProjectAuth/requireProjectAuthLight',
    ])
  })

  it.each([
    'requireAgentAuth',
    'requireAgentProject',
    'requireAgentRun',
  ])('passes Agent routes with agentRoute and explicit %s', (authFunction) => {
    const content = `
      import { ${authFunction} } from '@/lib/agent-api/auth'
      import { agentRoute } from '@/lib/agent-api/http'
      export const GET = agentRoute(async (request) => {
        await ${authFunction}(request, 'resource-1')
        return { ok: true }
      })
    `

    expect(inspectRouteContract('src/app/api/agent/v1/resource/route.ts', content)).toEqual([])
  })

  it('also permits the existing apiHandler wrapper on an explicitly authenticated Agent route', () => {
    const content = `
      import { requireAgentAuth } from '@/lib/agent-api/auth'
      import { apiHandler } from '@/lib/api-errors'
      export const GET = apiHandler(async (request) => {
        await requireAgentAuth(request)
        return Response.json({ ok: true })
      })
    `

    expect(inspectRouteContract('src/app/api/agent/v1/resource/route.ts', content)).toEqual([])
  })

  it('requires both an approved wrapper and explicit Agent auth for Agent routes', () => {
    expect(inspectRouteContract(
      'src/app/api/agent/v1/resource/route.ts',
      `
        import { requireAgentAuth } from '@/lib/agent-api/auth'
        export async function GET(request: Request) {
          await requireAgentAuth(request)
          return Response.json({ ok: true })
        }
      `,
    )).toEqual([
      'src/app/api/agent/v1/resource/route.ts missing apiHandler/agentRoute wrapper',
    ])

    expect(inspectRouteContract(
      'src/app/api/agent/v1/resource/route.ts',
      `
        import { agentRoute } from '@/lib/agent-api/http'
        export const GET = agentRoute(async () => ({ ok: true }))
      `,
    )).toEqual([
      'src/app/api/agent/v1/resource/route.ts missing requireAgentAuth/requireAgentProject/requireAgentRun',
    ])
  })

  it('does not treat agentRoute or Agent auth as valid for ordinary protected routes', () => {
    const content = `
      import { requireAgentAuth } from '@/lib/agent-api/auth'
      import { agentRoute } from '@/lib/agent-api/http'
      export const GET = agentRoute(async (request) => {
        await requireAgentAuth(request)
        return { ok: true }
      })
    `

    expect(inspectRouteContract('src/app/api/user/secure/route.ts', content)).toEqual([
      'src/app/api/user/secure/route.ts missing apiHandler wrapper',
      'src/app/api/user/secure/route.ts missing requireUserAuth/requireProjectAuth/requireProjectAuthLight',
    ])
  })
})
