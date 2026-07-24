import { requireAgentAuth } from '@/lib/agent-api/auth'
import { getAgentContract } from '@/lib/agent-api/contracts/registry'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  agentRoute,
  agentSuccess,
  type AgentRouteContext,
} from '@/lib/agent-api/http'

export const GET = agentRoute(async (
  request,
  context: AgentRouteContext<{ contractId: string }>,
  requestId,
) => {
  await requireAgentAuth(request)
  const { contractId } = await context.params
  const contract = getAgentContract(contractId)
  if (!contract) {
    throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  }

  return agentSuccess(requestId, {
    id: contract.id,
    hash: contract.hash,
    jsonSchema: contract.jsonSchema,
  })
})
