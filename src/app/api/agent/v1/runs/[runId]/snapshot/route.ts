import { requireAgentRun } from '@/lib/agent-api/auth'
import {
  agentRoute,
  agentSuccess,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import {
  getRunSnapshot,
  SnapshotDataSchema,
} from '@/lib/agent-api/services/snapshot-service'

export const GET = agentRoute(async (
  request,
  context: AgentRouteContext<{ runId: string }>,
  requestId,
) => {
  const { runId } = await context.params
  const auth = await requireAgentRun(request, runId)
  const snapshot = await getRunSnapshot({
    userId: auth.userId,
    runId,
  })
  return agentSuccess(requestId, SnapshotDataSchema.parse(snapshot))
})
