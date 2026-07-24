import { z } from 'zod'

import {
  createSuccessSchema,
  ExternalKeySchema,
  IdSchema,
  Sha256Schema,
} from './common'

const ArtifactHashRecordSchema = z.record(ExternalKeySchema, Sha256Schema)

export const FinalizeRequestSchema = z.object({
  schemaVersion: z.literal(1),
  ruleSetHash: Sha256Schema,
  expected: z.object({
    assets: Sha256Schema,
    stories: ArtifactHashRecordSchema,
    screenplays: ArtifactHashRecordSchema,
    storyboards: ArtifactHashRecordSchema,
  }).strict(),
}).strict()

export const FinalizeResponseSchema = createSuccessSchema(z.object({
  runId: IdSchema,
  status: z.literal('completed'),
  completedAt: z.string().datetime(),
  counts: z.object({
    episodes: z.number().int().nonnegative(),
    characters: z.number().int().nonnegative(),
    locations: z.number().int().nonnegative(),
    props: z.number().int().nonnegative(),
    clips: z.number().int().nonnegative(),
    storyboards: z.number().int().nonnegative(),
    panels: z.number().int().nonnegative(),
    frames: z.number().int().nonnegative(),
    uploadedImages: z.number().int().nonnegative(),
  }).strict(),
}).strict())

export type FinalizeRequest = z.infer<typeof FinalizeRequestSchema>
export type FinalizeResponse = z.infer<typeof FinalizeResponseSchema>
