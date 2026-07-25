import { requireAgentRun } from '@/lib/agent-api/auth'
import {
  FinalizeRequestSchema,
  FinalizeResponseSchema,
} from '@/lib/agent-api/contracts/finalize'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import {
  finalizeIdempotencyKey,
  requireIdempotencyKey,
} from '@/lib/agent-api/idempotency'
import { finalizeCreationRun } from '@/lib/agent-api/services/finalize-service'

export const POST = agentRoute(async (
  request,
  context: AgentRouteContext<{ runId: string }>,
  requestId,
) => {
  const { runId } = await context.params
  const auth = await requireAgentRun(request, runId)
  const body = await parseAgentJson(request, FinalizeRequestSchema)
  requireIdempotencyKey(request, finalizeIdempotencyKey(body))
  const result = await finalizeCreationRun({
    userId: auth.userId,
    runId,
    request: body,
  })
  return agentSuccess(
    requestId,
    FinalizeResponseSchema.shape.data.parse(result),
  )
})
