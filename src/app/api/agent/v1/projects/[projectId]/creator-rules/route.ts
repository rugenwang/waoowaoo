import { requireAgentProject } from '@/lib/agent-api/auth'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  agentRoute,
  agentSuccess,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import {
  loadCreatorRuleBundle,
  type CreatorRuleLocale,
} from '@/lib/agent-api/rules/load-rule-bundle'

export const GET = agentRoute(async (
  request,
  context: AgentRouteContext<{ projectId: string }>,
  requestId,
) => {
  const { projectId } = await context.params
  await requireAgentProject(request, projectId)

  const locale = new URL(request.url).searchParams.get('locale') ?? 'zh'
  if (locale !== 'zh' && locale !== 'en') {
    throw new AgentApiError('CONTRACT_INVALID', { field: 'locale' })
  }

  const data = await loadCreatorRuleBundle({
    projectId,
    locale: locale as CreatorRuleLocale,
  })
  return agentSuccess(requestId, data)
})
