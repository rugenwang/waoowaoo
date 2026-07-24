import { requireAgentProject } from '@/lib/agent-api/auth'
import { CreateRunRequestSchema } from '@/lib/agent-api/contracts/run'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import { requireIdempotencyKey } from '@/lib/agent-api/idempotency'
import { createOrResumeRun } from '@/lib/agent-api/services/run-service'

export const POST = agentRoute(async (
  request,
  context: AgentRouteContext<{ projectId: string }>,
  requestId,
) => {
  const { projectId } = await context.params
  const auth = await requireAgentProject(request, projectId)
  const body = await parseAgentJson(request, CreateRunRequestSchema)
  requireIdempotencyKey(request, body.runFingerprint)

  const data = await createOrResumeRun({
    userId: auth.userId,
    projectId,
    request: body,
  })
  return agentSuccess(requestId, data)
})
