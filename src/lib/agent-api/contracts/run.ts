import { z } from 'zod'

import {
  createSuccessSchema,
  DescriptionSchema,
  ExternalKeySchema,
  IdSchema,
  InputKindHintSchema,
  LocaleSchema,
  NameSchema,
  RuleSetVersionSchema,
  RunStatusSchema,
  Sha256Schema,
} from './common'

export const EffectiveOptionsSchema = z.object({
  artStyle: DescriptionSchema,
  videoRatio: DescriptionSchema,
  episodeSplitHint: z.string().trim().min(1).max(2_000).regex(/\S/),
}).strict()

export const RunEpisodeDefinitionSchema = z.object({
  episodeKey: ExternalKeySchema,
  ordinal: z.number().int().positive(),
  sourceHash: Sha256Schema,
  name: NameSchema,
  description: z.string().trim().min(1).max(2_000).regex(/\S/).optional(),
}).strict()

export const CreateRunRequestSchema = z.object({
  schemaVersion: z.literal(1),
  sourceHash: Sha256Schema,
  runFingerprint: Sha256Schema,
  inputKindHint: InputKindHintSchema,
  locale: LocaleSchema,
  effectiveOptions: EffectiveOptionsSchema,
  ruleSetVersion: RuleSetVersionSchema,
  ruleSetHash: Sha256Schema,
  definitionHash: Sha256Schema,
  episodes: z.array(RunEpisodeDefinitionSchema).min(1).max(200),
}).strict().superRefine((value, context) => {
  const episodeKeys = new Set<string>()
  value.episodes.forEach((episode, index) => {
    if (episode.ordinal !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ordinal must be continuous from 1',
        path: ['episodes', index, 'ordinal'],
      })
    }
    if (episodeKeys.has(episode.episodeKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'episodeKey must be unique',
        path: ['episodes', index, 'episodeKey'],
      })
    }
    episodeKeys.add(episode.episodeKey)
  })
})

export const CreateRunResponseSchema = createSuccessSchema(z.object({
  runId: IdSchema,
  resumed: z.boolean(),
  status: RunStatusSchema,
  projectId: IdSchema,
  sourceHash: Sha256Schema,
  runFingerprint: Sha256Schema,
  episodes: z.array(z.object({
    episodeKey: ExternalKeySchema,
    episodeId: IdSchema,
    episodeNumber: z.number().int().positive(),
    name: NameSchema,
  }).strict()).max(200),
}).strict())

export const RunResponseSchema = createSuccessSchema(z.object({
  runId: IdSchema,
  projectId: IdSchema,
  status: RunStatusSchema,
  currentStage: z.string().trim().min(1).max(100).regex(/\S/),
  sourceHash: Sha256Schema,
  runFingerprint: Sha256Schema,
  ruleSetVersion: RuleSetVersionSchema,
  ruleSetHash: Sha256Schema,
  episodes: z.array(z.object({
    episodeKey: ExternalKeySchema,
    episodeId: IdSchema,
    episodeNumber: z.number().int().positive(),
    status: RunStatusSchema,
  }).strict()).max(200),
}).strict())

export const SnapshotResponseSchema = createSuccessSchema(z.object({
  runId: IdSchema,
  status: RunStatusSchema,
  committedArtifactHashes: z.object({
    assets: Sha256Schema.optional(),
    stories: z.record(ExternalKeySchema, Sha256Schema),
    screenplays: z.record(ExternalKeySchema, Sha256Schema),
    storyboards: z.record(ExternalKeySchema, Sha256Schema),
  }).strict(),
  uploads: z.array(z.object({
    targetType: z.enum([
      'character-appearance',
      'location-image',
      'prop-image',
      'panel-frame',
    ]),
    targetKey: ExternalKeySchema,
    variantIndex: z.number().int().nonnegative(),
    contentSha256: Sha256Schema,
    mediaId: IdSchema,
    url: DescriptionSchema,
  }).strict()).max(20_000),
  missing: z.array(z.object({
    code: z.string().trim().min(1).max(100).regex(/\S/),
    targetType: z.string().trim().min(1).max(100).regex(/\S/),
    targetKey: ExternalKeySchema,
    message: DescriptionSchema,
  }).strict()).max(20_000),
}).strict())

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>
export type RunResponse = z.infer<typeof RunResponseSchema>
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>
