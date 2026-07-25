import {
  UploadFieldsSchema,
  UploadResponseSchema,
  type UploadFileLike,
} from '@/lib/agent-api/contracts/upload'
import { requireAgentRun } from '@/lib/agent-api/auth'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  agentRoute,
  agentSuccess,
  type AgentRouteContext,
} from '@/lib/agent-api/http'
import {
  requireIdempotencyKey,
  uploadIdempotencyKey,
} from '@/lib/agent-api/idempotency'
import { commitGeneratedImageUpload } from '@/lib/agent-api/services/upload-service'

const ALLOWED_FIELDS = new Set([
  'targetType',
  'targetKey',
  'variantIndex',
  'contentSha256',
  'file',
])
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

function contractInvalid(field?: string): never {
  throw new AgentApiError('CONTRACT_INVALID', { field })
}

function stringField(form: FormData, name: string): string {
  const values = form.getAll(name)
  if (values.length !== 1 || typeof values[0] !== 'string') {
    contractInvalid(name)
  }
  return values[0]
}

function fileField(form: FormData): UploadFileLike {
  const values = form.getAll('file')
  if (values.length !== 1) contractInvalid('file')
  const value = values[0]
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as Partial<UploadFileLike>).arrayBuffer !== 'function'
    || typeof (value as Partial<UploadFileLike>).type !== 'string'
    || typeof (value as Partial<UploadFileLike>).size !== 'number'
    || typeof (value as Partial<UploadFileLike>).name !== 'string'
  ) {
    contractInvalid('file')
  }
  const file = value as UploadFileLike
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new AgentApiError('UPLOAD_TYPE_UNSUPPORTED', { field: 'file' })
  }
  return file
}

async function parseMultipartUpload(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    contractInvalid('content-type')
  }
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    contractInvalid('body')
  }
  for (const key of form.keys()) {
    if (!ALLOWED_FIELDS.has(key)) contractInvalid(key)
  }
  for (const field of ALLOWED_FIELDS) {
    if (form.getAll(field).length !== 1) contractInvalid(field)
  }

  const variantIndexRaw = stringField(form, 'variantIndex')
  if (!/^(0|[1-9]\d*)$/.test(variantIndexRaw)) {
    contractInvalid('variantIndex')
  }
  const parsed = UploadFieldsSchema.safeParse({
    targetType: stringField(form, 'targetType'),
    targetKey: stringField(form, 'targetKey'),
    variantIndex: Number(variantIndexRaw),
    contentSha256: stringField(form, 'contentSha256'),
    file: fileField(form),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    contractInvalid(issue?.path.join('.') || undefined)
  }
  return parsed.data
}

export const POST = agentRoute(async (
  request,
  context: AgentRouteContext<{ runId: string }>,
  requestId,
) => {
  const { runId } = await context.params
  const auth = await requireAgentRun(request, runId)
  const fields = await parseMultipartUpload(request)
  requireIdempotencyKey(request, uploadIdempotencyKey({
    runId,
    targetType: fields.targetType,
    targetKey: fields.targetKey,
    variantIndex: fields.variantIndex,
    contentSha256: fields.contentSha256,
  }))
  const serviceData = await commitGeneratedImageUpload({
    userId: auth.userId,
    runId,
    fields,
  })
  return agentSuccess(
    requestId,
    UploadResponseSchema.shape.data.parse(serviceData),
  )
})
