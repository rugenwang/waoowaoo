import { createHash, timingSafeEqual } from 'node:crypto'

import { prisma } from '@/lib/prisma'

import { AgentApiError } from './errors'

export type AgentAuthContext = {
  userId: string
}

export type AgentProjectContext = AgentAuthContext & {
  projectId: string
}

export type AgentRunContext = AgentProjectContext & {
  runId: string
}

function tokenDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function tokensMatch(actual: string, expected: string): boolean {
  return timingSafeEqual(tokenDigest(actual), tokenDigest(expected))
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get('authorization')
  const match = authorization?.match(/^Bearer ([^\s]+)$/)
  return match?.[1]
}

export async function requireAgentAuth(request: Request): Promise<AgentAuthContext> {
  if (process.env.WAOO_AGENT_API_ENABLED !== 'true') {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }

  const expectedToken = process.env.WAOO_AGENT_TOKEN
  const actualToken = bearerToken(request)
  if (!expectedToken || !actualToken || !tokensMatch(actualToken, expectedToken)) {
    throw new AgentApiError('AGENT_UNAUTHORIZED')
  }

  const expectedUserId = process.env.WAOO_AGENT_USER_ID
  const actualUserId = request.headers.get('x-waoo-user-id')
  if (!expectedUserId || !actualUserId || actualUserId !== expectedUserId) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }

  const user = await prisma.user.findUnique({
    where: { id: expectedUserId },
    select: { id: true },
  })
  if (!user) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }

  return { userId: expectedUserId }
}

export async function requireAgentProject(
  request: Request,
  projectId: string,
): Promise<AgentProjectContext> {
  const auth = await requireAgentAuth(request)
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })

  if (!project) {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }
  if (project.userId !== auth.userId) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }

  return {
    ...auth,
    projectId: project.id,
  }
}

export async function requireAgentRun(
  request: Request,
  runId: string,
): Promise<AgentRunContext> {
  const auth = await requireAgentAuth(request)
  const run = await prisma.agentCreationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      userId: true,
      projectId: true,
      project: {
        select: { userId: true },
      },
    },
  })

  if (!run) {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }
  if (run.userId !== auth.userId || run.project.userId !== auth.userId) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }

  return {
    ...auth,
    projectId: run.projectId,
    runId: run.id,
  }
}
