export const AGENT_ERROR_SPECS = {
  CONTRACT_INVALID: {
    status: 400,
    retryable: false,
    message: 'Request contract is invalid',
  },
  REFERENCE_INVALID: {
    status: 400,
    retryable: false,
    message: 'A referenced resource is invalid',
  },
  ARTIFACT_HASH_MISMATCH: {
    status: 400,
    retryable: false,
    message: 'Artifact hash does not match the request content',
  },
  AGENT_UNAUTHORIZED: {
    status: 401,
    retryable: false,
    message: 'Agent authentication failed',
  },
  AGENT_FORBIDDEN: {
    status: 403,
    retryable: false,
    message: 'Agent access is forbidden',
  },
  AGENT_RESOURCE_NOT_FOUND: {
    status: 404,
    retryable: false,
    message: 'Agent resource was not found',
  },
  PROJECT_NAME_AMBIGUOUS: {
    status: 409,
    retryable: false,
    message: 'Project name matches more than one project',
  },
  RUN_DEFINITION_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'Run definition conflicts with the existing run',
  },
  EPISODE_NUMBER_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'Episode number allocation conflicted',
  },
  ASSET_IDENTITY_CONFLICT: {
    status: 409,
    retryable: false,
    message: 'Asset identity conflicts with an existing asset',
  },
  RULESET_MISMATCH: {
    status: 409,
    retryable: false,
    message: 'Rule set does not match the run',
  },
  UPLOAD_TOO_LARGE: {
    status: 413,
    retryable: false,
    message: 'Upload exceeds the configured size limit',
  },
  UPLOAD_TYPE_UNSUPPORTED: {
    status: 415,
    retryable: false,
    message: 'Upload type is not supported',
  },
  RUN_INCOMPLETE: {
    status: 422,
    retryable: false,
    message: 'Run is incomplete',
  },
  AGENT_INTERNAL_ERROR: {
    status: 500,
    retryable: true,
    message: 'Internal Agent API error',
  },
} as const

export type AgentErrorCode = keyof typeof AGENT_ERROR_SPECS
export type AgentErrorDetail = string | number | boolean | null
export type AgentErrorDetails = Record<string, AgentErrorDetail>

export type AgentApiErrorOptions = {
  message?: string
  field?: string
  retryable?: boolean
  details?: Record<string, unknown>
}

function safeDetails(details?: Record<string, unknown>): AgentErrorDetails | undefined {
  if (!details) return undefined

  const entries = Object.entries(details).filter((entry): entry is [string, AgentErrorDetail] => {
    const value = entry[1]
    return value === null
      || typeof value === 'string'
      || (typeof value === 'number' && Number.isFinite(value))
      || typeof value === 'boolean'
  })

  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export class AgentApiError extends Error {
  readonly code: AgentErrorCode
  readonly status: number
  readonly field?: string
  readonly retryable: boolean
  readonly details?: AgentErrorDetails

  constructor(code: AgentErrorCode, options: AgentApiErrorOptions = {}) {
    const spec = AGENT_ERROR_SPECS[code]
    super(options.message?.trim() || spec.message)
    this.name = 'AgentApiError'
    this.code = code
    this.status = spec.status
    this.field = options.field
    this.retryable = options.retryable ?? spec.retryable
    this.details = safeDetails(options.details)
  }
}

export function isAgentApiError(error: unknown): error is AgentApiError {
  return error instanceof AgentApiError
}
