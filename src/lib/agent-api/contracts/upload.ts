import { z } from 'zod'

import {
  createSuccessSchema,
  ExternalKeySchema,
  IdSchema,
  Sha256Schema,
  UrlSchema,
} from './common'

export const UPLOAD_FILE_JSON_SCHEMA_MARKER = 'waoo-agent-upload-file-like'
export const UPLOAD_FILE_DESCRIPTION =
  'Required binary image file. MIME type must be image/png, image/jpeg, or image/webp; size is a nonnegative byte count.'

export type UploadFileLike = {
  arrayBuffer: () => Promise<ArrayBuffer>
  type: string
  size: number
  name: string
}

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

function isUploadFileLike(value: unknown): value is UploadFileLike {
  if (typeof value !== 'object' || value === null) return false

  const candidate = value as Partial<UploadFileLike>
  return typeof candidate.arrayBuffer === 'function'
    && typeof candidate.type === 'string'
    && ALLOWED_IMAGE_MIME_TYPES.has(candidate.type)
    && typeof candidate.size === 'number'
    && Number.isFinite(candidate.size)
    && Number.isInteger(candidate.size)
    && candidate.size >= 0
    && typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && candidate.name.length <= 255
}

export const UploadFileLikeSchema = z.custom<UploadFileLike>(
  isUploadFileLike,
  { message: UPLOAD_FILE_DESCRIPTION },
).describe(UPLOAD_FILE_JSON_SCHEMA_MARKER)

export const UploadTargetTypeSchema = z.enum([
  'character-appearance',
  'location-image',
  'prop-image',
  'panel-frame',
])

export const UploadFieldsSchema = z.object({
  targetType: UploadTargetTypeSchema,
  targetKey: ExternalKeySchema,
  variantIndex: z.number().int().nonnegative(),
  contentSha256: Sha256Schema,
  file: UploadFileLikeSchema,
}).strict().superRefine((value, context) => {
  if (value.targetType === 'panel-frame' && value.variantIndex !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'panel-frame variantIndex must be 0',
      path: ['variantIndex'],
    })
  }
})

export const UploadResponseSchema = createSuccessSchema(z.object({
  runId: IdSchema,
  targetType: UploadTargetTypeSchema,
  targetKey: ExternalKeySchema,
  variantIndex: z.number().int().nonnegative(),
  contentSha256: Sha256Schema,
  mediaId: IdSchema,
  storageKey: z.string().trim().min(1).max(2_000).regex(/\S/),
  url: UrlSchema,
  reused: z.boolean(),
  panelImageUpdated: z.boolean().optional(),
}).strict())

export type UploadFields = z.infer<typeof UploadFieldsSchema>
export type UploadResponse = z.infer<typeof UploadResponseSchema>
