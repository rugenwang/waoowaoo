import {
  canonicalJson,
  sha256Prefixed,
} from './canonical-json'
import { AgentApiError } from './errors'

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const WRITE_METHODS = new Set(['POST', 'PUT'])

export type UploadIdempotencyInput = {
  runId: string
  targetType: string
  targetKey: string
  variantIndex: number
  contentSha256: string
}

function invalidIdempotencyKey(): never {
  throw new AgentApiError('CONTRACT_INVALID', {
    field: 'Idempotency-Key',
  })
}

export function requireIdempotencyKey(
  request: Request,
  expectedKey: string,
): string | undefined {
  const key = request.headers.get('idempotency-key')
  if (!key) {
    if (WRITE_METHODS.has(request.method.toUpperCase())) {
      invalidIdempotencyKey()
    }
    return undefined
  }

  if (!SHA256_PATTERN.test(key) || key !== expectedKey) {
    invalidIdempotencyKey()
  }
  return key
}

export type ResolveProjectInitialVisualSettings = {
  description?: string
  initialVideoRatio?: string
  initialArtStyle?: string
}

export function resolveProjectIdempotencyKey(
  normalizedName: string,
  initialSettings: ResolveProjectInitialVisualSettings = {},
): string {
  const name = normalizedName.trim()
  const { initialVideoRatio, initialArtStyle } = initialSettings
  if (initialVideoRatio === undefined && initialArtStyle === undefined) {
    return sha256Prefixed(`resolve-project:${name}`)
  }
  if (initialVideoRatio === undefined || initialArtStyle === undefined) {
    throw new TypeError('initialVideoRatio and initialArtStyle must be provided together')
  }
  const description = initialSettings.description?.trim()
  return sha256Prefixed(canonicalJson({
    name,
    ...(description ? { description } : {}),
    initialVideoRatio,
    initialArtStyle,
  }))
}

export function uploadIdempotencyKey(input: UploadIdempotencyInput): string {
  return sha256Prefixed(canonicalJson({
    runId: input.runId,
    targetType: input.targetType,
    targetKey: input.targetKey,
    variantIndex: input.variantIndex,
    contentSha256: input.contentSha256,
  }))
}

export function finalizeIdempotencyKey(body: unknown): string {
  return sha256Prefixed(canonicalJson(body))
}
