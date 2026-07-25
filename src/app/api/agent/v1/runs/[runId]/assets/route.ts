import { requireAgentRun } from '@/lib/agent-api/auth'
import {
  AssetsCommitRequestSchema,
  AssetsCommitResponseSchema,
} from '@/lib/agent-api/contracts/assets'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import { requireIdempotencyKey } from '@/lib/agent-api/idempotency'
import { commitAssetsArtifact } from '@/lib/agent-api/services/asset-service'

export const PUT = agentRoute(async (
  request,
  context: AgentRouteContext<{ runId: string }>,
  requestId,
) => {
  const { runId } = await context.params
  const auth = await requireAgentRun(request, runId)
  const body = await parseAgentJson(request, AssetsCommitRequestSchema)
  requireIdempotencyKey(request, body.artifactHash)

  const serviceData = await commitAssetsArtifact({
    userId: auth.userId,
    runId,
    request: body,
  })
  const data = AssetsCommitResponseSchema.shape.data.parse(serviceData)
  return agentSuccess(requestId, data)
})
