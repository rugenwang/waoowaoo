import { z } from 'zod'

import {
  createCommitEnvelopeSchema,
  createSuccessSchema,
  DescriptionSchema,
  ExternalKeySchema,
  IdSchema,
  LongContentSchema,
  Sha256Schema,
} from './common'

export const ScreenplayActionSchema = z.object({
  type: z.literal('action'),
  text: DescriptionSchema,
}).strict()

export const ScreenplayDialogueSchema = z.object({
  type: z.literal('dialogue'),
  characterKey: ExternalKeySchema,
  parenthetical: DescriptionSchema.optional(),
  lines: DescriptionSchema,
}).strict()

export const ScreenplayVoiceoverSchema = z.object({
  type: z.literal('voiceover'),
  characterKey: ExternalKeySchema.optional(),
  speakerLabel: z.string().trim().min(1).max(100).regex(/\S/).optional(),
  text: DescriptionSchema,
}).strict().superRefine((value, context) => {
  if (value.characterKey === undefined && value.speakerLabel === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'speakerLabel is required when characterKey is absent',
      path: ['speakerLabel'],
    })
  }
})

export const ScreenplayContentSchema = z.union([
  ScreenplayActionSchema,
  ScreenplayDialogueSchema,
  ScreenplayVoiceoverSchema,
])

export const ScreenplaySceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  heading: z.object({
    intExt: z.enum(['INT', 'EXT']),
    locationKey: ExternalKeySchema,
    time: z.string().trim().min(1).max(100).regex(/\S/),
  }).strict(),
  description: DescriptionSchema,
  characterKeys: z.array(ExternalKeySchema).max(500),
  content: z.array(ScreenplayContentSchema).max(10_000),
}).strict()

export const ClipArtifactSchema = z.object({
  clipKey: ExternalKeySchema,
  ordinal: z.number().int().positive(),
  startText: DescriptionSchema,
  endText: DescriptionSchema,
  summary: z.string().trim().min(1).max(2_000).regex(/\S/),
  locationKey: ExternalKeySchema.nullable(),
  characterKeys: z.array(ExternalKeySchema).max(500),
  propKeys: z.array(ExternalKeySchema).max(500),
  content: LongContentSchema,
  screenplay: z.object({
    originalText: LongContentSchema,
    scenes: z.array(ScreenplaySceneSchema).max(10_000),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.screenplay.originalText !== value.content) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'screenplay.originalText must equal clip content',
      path: ['screenplay', 'originalText'],
    })
  }

  value.screenplay.scenes.forEach((scene, index) => {
    if (scene.sceneNumber !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sceneNumber must be continuous from 1',
        path: ['screenplay', 'scenes', index, 'sceneNumber'],
      })
    }
  })
})

export const ScreenplayArtifactSchema = z.object({
  episodeKey: ExternalKeySchema,
  clips: z.array(ClipArtifactSchema).max(1_000),
}).strict().superRefine((value, context) => {
  const clipKeys = new Set<string>()
  value.clips.forEach((clip, index) => {
    if (clip.ordinal !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clip ordinal must be continuous from 1',
        path: ['clips', index, 'ordinal'],
      })
    }
    if (clipKeys.has(clip.clipKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clipKey must be unique',
        path: ['clips', index, 'clipKey'],
      })
    }
    clipKeys.add(clip.clipKey)
  })
})

export const ScreenplayCommitRequestSchema = createCommitEnvelopeSchema(ScreenplayArtifactSchema)

export const ScreenplayCommitResponseSchema = createSuccessSchema(z.object({
  dryRun: z.boolean(),
  episodeKey: ExternalKeySchema,
  artifactHash: Sha256Schema,
  clips: z.array(z.object({
    clipKey: ExternalKeySchema,
    clipId: IdSchema,
    ordinal: z.number().int().positive(),
  }).strict()).max(1_000),
}).strict())

export type ScreenplayArtifact = z.infer<typeof ScreenplayArtifactSchema>
export type ScreenplayCommitRequest = z.infer<typeof ScreenplayCommitRequestSchema>
export type ScreenplayCommitResponse = z.infer<typeof ScreenplayCommitResponseSchema>
