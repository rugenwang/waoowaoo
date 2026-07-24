import { requireAgentAuth } from '@/lib/agent-api/auth'
import { ResolveProjectRequestSchema } from '@/lib/agent-api/contracts/project'
import {
  agentRoute,
  agentSuccess,
  parseAgentJson,
} from '@/lib/agent-api/http'
import {
  requireIdempotencyKey,
  resolveProjectIdempotencyKey,
} from '@/lib/agent-api/idempotency'
import { resolveCreatorProject } from '@/lib/agent-api/services/project-resolver'

export const POST = agentRoute(async (request, _context, requestId) => {
  const auth = await requireAgentAuth(request)
  const body = await parseAgentJson(request, ResolveProjectRequestSchema)
  requireIdempotencyKey(
    request,
    resolveProjectIdempotencyKey(body.name),
  )

  const data = await resolveCreatorProject({
    userId: auth.userId,
    name: body.name,
    description: body.description,
  })
  return agentSuccess(requestId, data)
})
