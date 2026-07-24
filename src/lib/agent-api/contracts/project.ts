import { z } from 'zod'

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

export const ResolveProjectRequestSchema = z.object({
  name: NameSchema,
  description: IntroductionSchema.optional(),
}).strict()

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
