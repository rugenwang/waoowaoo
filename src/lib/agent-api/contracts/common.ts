import { z } from 'zod'

export const ExternalKeySchema = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

export const Sha256Schema = z.string()
  .regex(/^sha256:[a-f0-9]{64}$/)

export const LocaleSchema = z.enum(['zh', 'en'])
export const InputKindSchema = z.enum(['outline', 'story', 'screenplay'])
export const InputKindHintSchema = z.enum(['auto', ...InputKindSchema.options])
export const RunStatusSchema = z.enum([
  'created',
  'story_committed',
  'assets_committed',
  'screenplay_committed',
  'storyboards_committed',
  'images_in_progress',
  'incomplete',
  'completed',
  'failed',
])

export const NameSchema = z.string().trim().min(1).max(100).regex(/\S/)
export const IntroductionSchema = z.string().trim().min(1).max(2_000).regex(/\S/)
export const DescriptionSchema = z.string().trim().min(1).max(20_000).regex(/\S/)
export const PromptSchema = DescriptionSchema
export const LongContentSchema = z.string().trim().min(1).max(500_000).regex(/\S/)
export const RuleSetVersionSchema = z.string().trim().min(1).max(64).regex(/\S/)
export const UrlSchema = z.string().trim().min(1).max(20_000).regex(/\S/)
export const IdSchema = z.string().trim().min(1).max(200).regex(/\S/)

const DetailValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
])

export const ErrorDetailsSchema = z.record(DetailValueSchema)
export const OpenJsonObjectSchema = z.record(z.unknown())

export const CommitEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  ruleSetVersion: RuleSetVersionSchema,
  ruleSetHash: Sha256Schema,
  artifactHash: Sha256Schema,
  dryRun: z.boolean(),
  data: z.unknown(),
}).strict()

export function createCommitEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    schemaVersion: z.literal(1),
    ruleSetVersion: RuleSetVersionSchema,
    ruleSetHash: Sha256Schema,
    artifactHash: Sha256Schema,
    dryRun: z.boolean(),
    data: dataSchema,
  }).strict()
}

export function createSuccessSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    requestId: IdSchema,
    data: dataSchema,
  }).strict()
}

export const FailureSchema = z.object({
  success: z.literal(false),
  requestId: IdSchema,
  error: z.object({
    code: z.string().trim().min(1).max(100).regex(/\S/),
    message: DescriptionSchema,
    field: z.string().trim().min(1).max(2_000).regex(/\S/).optional(),
    retryable: z.boolean(),
    details: ErrorDetailsSchema.optional(),
  }).strict(),
}).strict()

export const WriteHeadersSchema = z.object({
  'Idempotency-Key': Sha256Schema,
}).strict()

export type ExternalKey = z.infer<typeof ExternalKeySchema>
export type Sha256 = z.infer<typeof Sha256Schema>
export type Locale = z.infer<typeof LocaleSchema>
export type InputKind = z.infer<typeof InputKindSchema>
export type InputKindHint = z.infer<typeof InputKindHintSchema>
export type RunStatus = z.infer<typeof RunStatusSchema>
