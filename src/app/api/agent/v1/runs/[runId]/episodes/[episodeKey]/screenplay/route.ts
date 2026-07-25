import { requireAgentRun } from '@/lib/agent-api/auth'
import {
  ScreenplayCommitRequestSchema,
  ScreenplayCommitResponseSchema,
} from '@/lib/agent-api/contracts/screenplay'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import { requireIdempotencyKey } from '@/lib/agent-api/idempotency'
import { commitScreenplayArtifact } from '@/lib/agent-api/services/screenplay-service'

export const PUT = agentRoute(async (
  request,
  context: AgentRouteContext<{
    runId: string
    episodeKey: string
  }>,
  requestId,
) => {
  const { runId, episodeKey } = await context.params
  const auth = await requireAgentRun(request, runId)
  const body = await parseAgentJson(request, ScreenplayCommitRequestSchema)
  requireIdempotencyKey(request, body.artifactHash)

  const serviceData = await commitScreenplayArtifact({
    userId: auth.userId,
    runId,
    episodeKey,
    request: body,
  })
  const data = ScreenplayCommitResponseSchema.shape.data.parse(serviceData)
  return agentSuccess(requestId, data)
})
