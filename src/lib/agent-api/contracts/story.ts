import { z } from 'zod'

import {
  createCommitEnvelopeSchema,
  createSuccessSchema,
  ExternalKeySchema,
  IdSchema,
  InputKindSchema,
  LongContentSchema,
  NameSchema,
  Sha256Schema,
  trimmedTextSchema,
} from './common'

export const StoryArtifactSchema = z.object({
  episodeKey: ExternalKeySchema,
  sourceHash: Sha256Schema,
  inputKind: InputKindSchema,
  name: NameSchema,
  description: trimmedTextSchema(2_000).optional(),
  novelText: LongContentSchema,
}).strict()

export const StoryCommitRequestSchema = createCommitEnvelopeSchema(StoryArtifactSchema)

export const StoryCommitResponseSchema = createSuccessSchema(z.object({
  dryRun: z.boolean(),
  episodeKey: ExternalKeySchema,
  episodeId: IdSchema,
  episodeNumber: z.number().int().positive(),
  artifactHash: Sha256Schema,
}).strict())

export type StoryArtifact = z.infer<typeof StoryArtifactSchema>
export type StoryCommitRequest = z.infer<typeof StoryCommitRequestSchema>
export type StoryCommitResponse = z.infer<typeof StoryCommitResponseSchema>
