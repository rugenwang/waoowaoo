import { requireAgentRun } from '@/lib/agent-api/auth'
import { RunResponseSchema } from '@/lib/agent-api/contracts/run'
import {
  agentRoute,
  agentSuccess,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import { getCreatorRun } from '@/lib/agent-api/services/run-service'

export const GET = agentRoute(async (
  request,
  context: AgentRouteContext<{ runId: string }>,
  requestId,
) => {
  const { runId } = await context.params
  const auth = await requireAgentRun(request, runId)
  const serviceData = await getCreatorRun({
    userId: auth.userId,
    runId,
  })
  const data = RunResponseSchema.shape.data.parse(serviceData)
  return agentSuccess(requestId, data)
})
