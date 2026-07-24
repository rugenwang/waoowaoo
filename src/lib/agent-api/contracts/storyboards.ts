import { z } from 'zod'

import {
  createCommitEnvelopeSchema,
  createSuccessSchema,
  DescriptionSchema,
  ExternalKeySchema,
  IdSchema,
  PromptSchema,
  Sha256Schema,
} from './common'

export const PanelCharacterRefSchema = z.object({
  characterKey: ExternalKeySchema,
  appearanceKey: ExternalKeySchema,
  slot: DescriptionSchema,
}).strict()

export const PhotographyRuleArtifactSchema = z.object({
  panelNumber: z.number().int().positive(),
  composition: DescriptionSchema,
  lighting: DescriptionSchema,
  colorPalette: DescriptionSchema,
  atmosphere: DescriptionSchema,
  technicalNotes: DescriptionSchema,
  depthOfField: DescriptionSchema.optional(),
  colorTone: DescriptionSchema.optional(),
  characters: z.array(z.object({
    characterKey: ExternalKeySchema,
    blocking: DescriptionSchema,
  }).strict()).max(500),
}).strict()

export const ActingDirectionArtifactSchema = z.object({
  panelNumber: z.number().int().positive(),
  characters: z.array(z.object({
    characterKey: ExternalKeySchema,
    acting: DescriptionSchema,
  }).strict()).max(500),
}).strict()

export const OrderedReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('frame'),
    targetKey: ExternalKeySchema,
  }).strict(),
  z.object({
    kind: z.literal('previous-panel-tail'),
    targetKey: ExternalKeySchema,
  }).strict(),
  z.object({
    kind: z.literal('location'),
    targetKey: ExternalKeySchema,
  }).strict(),
  z.object({
    kind: z.literal('character-appearance'),
    targetKey: ExternalKeySchema,
  }).strict(),
  z.object({
    kind: z.literal('prop'),
    targetKey: ExternalKeySchema,
  }).strict(),
])

export const FrameArtifactSchema = z.object({
  frameKey: ExternalKeySchema,
  frameIndex: z.number().int().nonnegative(),
  frameTimeSec: z.number().int().nonnegative(),
  frameRole: z.enum(['hero', 'transition', 'action', 'reaction', 'detail']),
  dependencyFrameKeys: z.array(ExternalKeySchema).max(20),
  imagePrompt: PromptSchema,
  videoPrompt: PromptSchema,
  referencePolicy: z.object({
    orderedReferences: z.array(OrderedReferenceSchema).max(500),
  }).strict(),
}).strict()

export const PanelArtifactSchema = z.object({
  panelKey: ExternalKeySchema,
  panelNumber: z.number().int().positive(),
  description: DescriptionSchema,
  characters: z.array(PanelCharacterRefSchema).max(500),
  propKeys: z.array(ExternalKeySchema).max(500),
  locationKey: ExternalKeySchema.nullable(),
  sceneType: DescriptionSchema,
  sourceText: DescriptionSchema,
  shotType: DescriptionSchema,
  cameraMove: DescriptionSchema,
  videoPrompt: PromptSchema,
  durationSec: z.number().int().min(1).max(20),
  panelMode: z.enum(['single', 'group']),
  groupVideoPrompt: PromptSchema.nullable(),
  usePreviousPanelTailAsReference: z.boolean(),
  frames: z.array(FrameArtifactSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (value.panelMode === 'single') {
    const heroCount = value.frames.filter((frame) => frame.frameRole === 'hero').length
    if (heroCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single panels must contain exactly one hero frame role',
        path: ['frames'],
      })
    }
    if (value.groupVideoPrompt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single panel groupVideoPrompt must be null',
        path: ['groupVideoPrompt'],
      })
    }
  } else {
    if (value.frames.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'group panels must contain 2 to 20 frames',
        path: ['frames'],
      })
    }
    if (value.groupVideoPrompt === null || value.groupVideoPrompt.trim() === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'group panel groupVideoPrompt must be non-empty',
        path: ['groupVideoPrompt'],
      })
    }
  }

  const frameIndexes = new Map<string, number>()
  value.frames.forEach((frame, index) => {
    frameIndexes.set(frame.frameKey, index)
  })

  value.frames.forEach((frame, index) => {
    if (frame.frameIndex !== index) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'frameIndex must be continuous from 0',
        path: ['frames', index, 'frameIndex'],
      })
    }
    if (index === 0 && frame.frameTimeSec !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the first frame time must be 0',
        path: ['frames', index, 'frameTimeSec'],
      })
    }
    if (frame.frameTimeSec > value.durationSec) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'frame time must not exceed panel duration',
        path: ['frames', index, 'frameTimeSec'],
      })
    }
    frame.dependencyFrameKeys.forEach((dependencyKey, dependencyIndex) => {
      const targetIndex = frameIndexes.get(dependencyKey)
      if (targetIndex === undefined || targetIndex >= index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'dependencies must target an earlier frame in the same panel',
          path: ['frames', index, 'dependencyFrameKeys', dependencyIndex],
        })
      }
    })
  })
})

export const StoryboardArtifactSchema = z.object({
  storyboardKey: ExternalKeySchema,
  clipKey: ExternalKeySchema,
  photographyPlan: z.object({
    visualStrategy: DescriptionSchema,
    continuityRules: z.array(DescriptionSchema).max(500),
    rules: z.array(PhotographyRuleArtifactSchema).max(200),
  }).strict(),
  actingDirections: z.array(ActingDirectionArtifactSchema).max(200),
  panels: z.array(PanelArtifactSchema).max(200),
}).strict().superRefine((value, context) => {
  value.panels.forEach((panel, panelIndex) => {
    if (panel.panelNumber !== panelIndex + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'panelNumber must be continuous from 1',
        path: ['panels', panelIndex, 'panelNumber'],
      })
    }

    const previousTail = panelIndex > 0
      ? value.panels[panelIndex - 1].frames.at(-1)?.frameKey
      : undefined
    let previousTailReferenceCount = 0

    panel.frames.forEach((frame, frameIndex) => {
      frame.referencePolicy.orderedReferences.forEach((reference, referenceIndex) => {
        if (reference.kind !== 'previous-panel-tail') return
        previousTailReferenceCount += 1
        if (previousTail === undefined || reference.targetKey !== previousTail) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'previous-panel-tail must target the immediately previous panel last frame',
            path: [
              'panels',
              panelIndex,
              'frames',
              frameIndex,
              'referencePolicy',
              'orderedReferences',
              referenceIndex,
              'targetKey',
            ],
          })
        }
      })
    })

    if (panel.usePreviousPanelTailAsReference && previousTailReferenceCount === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'previous panel tail reference is required',
        path: ['panels', panelIndex, 'usePreviousPanelTailAsReference'],
      })
    }
    if (!panel.usePreviousPanelTailAsReference && previousTailReferenceCount > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'previous panel tail reference is not enabled',
        path: ['panels', panelIndex, 'usePreviousPanelTailAsReference'],
      })
    }
  })

})

export const StoryboardsArtifactSchema = z.object({
  episodeKey: ExternalKeySchema,
  storyboards: z.array(StoryboardArtifactSchema).max(1_000),
}).strict().superRefine((value, context) => {
  const storyboardKeys = new Set<string>()
  const clipKeys = new Set<string>()
  const panelKeys = new Set<string>()
  const frameKeys = new Set<string>()

  value.storyboards.forEach((storyboard, storyboardIndex) => {
    const check = (
      seen: Set<string>,
      key: string,
      path: (string | number)[],
      label: string,
    ) => {
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} must be unique`,
          path,
        })
      }
      seen.add(key)
    }

    check(storyboardKeys, storyboard.storyboardKey, [
      'storyboards',
      storyboardIndex,
      'storyboardKey',
    ], 'storyboardKey')
    check(clipKeys, storyboard.clipKey, [
      'storyboards',
      storyboardIndex,
      'clipKey',
    ], 'clipKey')

    storyboard.panels.forEach((panel, panelIndex) => {
      check(panelKeys, panel.panelKey, [
        'storyboards',
        storyboardIndex,
        'panels',
        panelIndex,
        'panelKey',
      ], 'panelKey')
      panel.frames.forEach((frame, frameIndex) => {
        check(frameKeys, frame.frameKey, [
          'storyboards',
          storyboardIndex,
          'panels',
          panelIndex,
          'frames',
          frameIndex,
          'frameKey',
        ], 'frameKey')
      })
    })
  })
})

export const StoryboardsCommitRequestSchema =
  createCommitEnvelopeSchema(StoryboardsArtifactSchema)

export const StoryboardsCommitResponseSchema = createSuccessSchema(z.object({
  dryRun: z.boolean(),
  episodeKey: ExternalKeySchema,
  artifactHash: Sha256Schema,
  storyboards: z.array(z.object({
    storyboardKey: ExternalKeySchema,
    storyboardId: IdSchema,
    clipKey: ExternalKeySchema,
    panels: z.array(z.object({
      panelKey: ExternalKeySchema,
      panelId: IdSchema,
      frames: z.array(z.object({
        frameKey: ExternalKeySchema,
        frameId: IdSchema,
      }).strict()).max(20),
    }).strict()).max(200),
  }).strict()).max(1_000),
}).strict())

export type StoryboardsArtifact = z.infer<typeof StoryboardsArtifactSchema>
export type StoryboardsCommitRequest = z.infer<typeof StoryboardsCommitRequestSchema>
export type StoryboardsCommitResponse = z.infer<typeof StoryboardsCommitResponseSchema>
