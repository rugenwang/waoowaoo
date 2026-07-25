import { requireAgentRun } from '@/lib/agent-api/auth'
import {
  StoryCommitRequestSchema,
  StoryCommitResponseSchema,
} from '@/lib/agent-api/contracts/story'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import { requireIdempotencyKey } from '@/lib/agent-api/idempotency'
import { commitStoryArtifact } from '@/lib/agent-api/services/story-service'

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
  const body = await parseAgentJson(request, StoryCommitRequestSchema)
  requireIdempotencyKey(request, body.artifactHash)

  const serviceData = await commitStoryArtifact({
    userId: auth.userId,
    runId,
    episodeKey,
    request: body,
  })
  const data = StoryCommitResponseSchema.shape.data.parse(serviceData)
  return agentSuccess(requestId, data)
})
