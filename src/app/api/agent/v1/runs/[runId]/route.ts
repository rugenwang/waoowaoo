import { requireAgentRun } from '@/lib/agent-api/auth'
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
  const data = await getCreatorRun({
    userId: auth.userId,
    runId,
  })
  return agentSuccess(requestId, data)
})
