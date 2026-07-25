import { requireAgentRun } from '@/lib/agent-api/auth'
import {
  StoryboardsCommitRequestSchema,
  StoryboardsCommitResponseSchema,
} from '@/lib/agent-api/contracts/storyboards'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import { requireIdempotencyKey } from '@/lib/agent-api/idempotency'
import { commitStoryboardArtifact } from '@/lib/agent-api/services/storyboard-service'

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
  const body = await parseAgentJson(request, StoryboardsCommitRequestSchema)
  requireIdempotencyKey(request, body.artifactHash)
  const serviceData = await commitStoryboardArtifact({
    userId: auth.userId,
    runId,
    episodeKey,
    request: body,
  })
  const data = StoryboardsCommitResponseSchema.shape.data.parse(serviceData)
  return agentSuccess(requestId, data)
})
