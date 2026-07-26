import { z } from 'zod'

import { ART_STYLES, ASPECT_RATIO_CONFIGS } from '@/lib/constants'

import {
  createSuccessSchema,
  DescriptionSchema,
  ExternalKeySchema,
  IdSchema,
  IntroductionSchema,
  LocaleSchema,
  NameSchema,
  OpenJsonObjectSchema,
  PromptSchema,
  RuleSetVersionSchema,
  Sha256Schema,
  UrlSchema,
} from './common'

const InitialVideoRatioSchema = z.enum(
  Object.keys(ASPECT_RATIO_CONFIGS) as [string, ...string[]],
)
const InitialArtStyleSchema = z.enum(
  ART_STYLES.map((style) => style.value) as [string, ...string[]],
)

export const ResolveProjectRequestSchema = z.object({
  name: NameSchema,
  description: IntroductionSchema.optional(),
  initialVideoRatio: InitialVideoRatioSchema.optional(),
  initialArtStyle: InitialArtStyleSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasRatio = value.initialVideoRatio !== undefined
  const hasStyle = value.initialArtStyle !== undefined
  if (hasRatio === hasStyle) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'initialVideoRatio and initialArtStyle must be provided together',
    path: hasRatio ? ['initialArtStyle'] : ['initialVideoRatio'],
  })
})

export const ResolveProjectResponseSchema = createSuccessSchema(z.object({
  projectId: IdSchema,
  name: NameSchema,
  created: z.boolean(),
}).strict())

export const CreatorRulesResponseSchema = createSuccessSchema(z.object({
  schemaVersion: z.literal(1),
  ruleSetVersion: RuleSetVersionSchema,
  contentHash: Sha256Schema,
  locale: LocaleSchema,
  projectSettings: z.object({
    artStyle: DescriptionSchema,
    artStylePrompt: PromptSchema.nullable(),
    videoRatio: DescriptionSchema,
    imageResolution: DescriptionSchema,
    forcedStoryboardDurationSec: z.number().finite().nonnegative().nullable(),
  }).strict(),
  rules: z.array(z.object({
    id: ExternalKeySchema,
    kind: z.enum(['hard', 'creative', 'hard-and-creative']),
    content: DescriptionSchema,
    hash: Sha256Schema,
  }).strict()).max(500),
  contracts: z.array(z.object({
    id: ExternalKeySchema,
    url: UrlSchema,
    hash: Sha256Schema,
  }).strict()).max(500),
}).strict())

export const ContractResponseSchema = createSuccessSchema(z.object({
  id: ExternalKeySchema,
  hash: Sha256Schema,
  jsonSchema: OpenJsonObjectSchema,
}).strict())

export type ResolveProjectRequest = z.infer<typeof ResolveProjectRequestSchema>
export type ResolveProjectResponse = z.infer<typeof ResolveProjectResponseSchema>
export type CreatorRulesResponse = z.infer<typeof CreatorRulesResponseSchema>
export type ContractResponse = z.infer<typeof ContractResponseSchema>
