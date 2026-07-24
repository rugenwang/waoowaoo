import { z } from 'zod'

import {
  createCommitEnvelopeSchema,
  createSuccessSchema,
  DescriptionSchema,
  ExternalKeySchema,
  IdSchema,
  IntroductionSchema,
  NameSchema,
  Sha256Schema,
  trimmedTextSchema,
} from './common'

const NonEmptyTextSchema = trimmedTextSchema(20_000)

export const RoleLevelSchema = z.enum(['S', 'A', 'B', 'C', 'D'])
export const GenderSchema = z.enum(['male', 'female', 'nonbinary', 'unknown'])

export const CharacterAppearanceArtifactSchema = z.object({
  appearanceKey: ExternalKeySchema,
  appearanceOrdinal: z.number().int().positive(),
  changeReason: DescriptionSchema,
  visualDescription: DescriptionSchema,
}).strict()

export const CharacterArtifactSchema = z.object({
  characterKey: ExternalKeySchema,
  name: NameSchema,
  aliases: z.array(NameSchema).max(500),
  introduction: IntroductionSchema,
  gender: GenderSchema,
  ageRange: NonEmptyTextSchema.optional(),
  roleLevel: RoleLevelSchema,
  archetype: NonEmptyTextSchema.optional(),
  personalityTags: z.array(NonEmptyTextSchema).max(5),
  eraPeriod: NonEmptyTextSchema.optional(),
  socialClass: NonEmptyTextSchema.optional(),
  occupation: NonEmptyTextSchema.optional(),
  costumeTier: z.number().int().min(1).max(5).optional(),
  suggestedColors: z.array(NonEmptyTextSchema).max(3),
  primaryIdentifier: NonEmptyTextSchema.optional(),
  visualKeywords: z.array(NonEmptyTextSchema).max(10),
  appearances: z.array(CharacterAppearanceArtifactSchema).max(500),
}).strict().superRefine((value, context) => {
  value.appearances.forEach((appearance, index) => {
    if (appearance.appearanceOrdinal !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'appearanceOrdinal must be continuous from 1',
        path: ['appearances', index, 'appearanceOrdinal'],
      })
    }
  })
})

export const LocationArtifactSchema = z.object({
  locationKey: ExternalKeySchema,
  name: NameSchema,
  summary: IntroductionSchema,
  availableSlots: z.array(NonEmptyTextSchema).max(20),
  descriptions: z.array(DescriptionSchema).min(1).max(10),
}).strict()

export const PropArtifactSchema = z.object({
  propKey: ExternalKeySchema,
  name: NameSchema,
  summary: IntroductionSchema,
  visualDescription: DescriptionSchema,
}).strict()

export const AssetsArtifactSchema = z.object({
  characters: z.array(CharacterArtifactSchema).max(500),
  locations: z.array(LocationArtifactSchema).max(500),
  props: z.array(PropArtifactSchema).max(500),
}).strict().superRefine((value, context) => {
  if (value.characters.length + value.locations.length + value.props.length > 500) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum: 500,
      type: 'array',
      inclusive: true,
      message: 'a request can contain at most 500 project assets',
      path: [],
    })
  }

  const keys = new Set<string>()
  const checkKey = (key: string, path: (string | number)[]) => {
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'external keys must be unique in one assets request',
        path,
      })
    }
    keys.add(key)
  }

  value.characters.forEach((character, characterIndex) => {
    checkKey(character.characterKey, ['characters', characterIndex, 'characterKey'])
    character.appearances.forEach((appearance, appearanceIndex) => {
      checkKey(appearance.appearanceKey, [
        'characters',
        characterIndex,
        'appearances',
        appearanceIndex,
        'appearanceKey',
      ])
    })
  })
  value.locations.forEach((location, index) => {
    checkKey(location.locationKey, ['locations', index, 'locationKey'])
  })
  value.props.forEach((prop, index) => {
    checkKey(prop.propKey, ['props', index, 'propKey'])
  })
})

export const AssetsCommitRequestSchema = createCommitEnvelopeSchema(AssetsArtifactSchema)

export const AssetsCommitResponseSchema = createSuccessSchema(z.object({
  dryRun: z.boolean(),
  artifactHash: Sha256Schema,
  characters: z.array(z.object({
    characterKey: ExternalKeySchema,
    characterId: IdSchema,
    reused: z.boolean(),
    appearances: z.array(z.object({
      appearanceKey: ExternalKeySchema,
      appearanceId: IdSchema,
      appearanceIndex: z.number().int().nonnegative(),
      reused: z.boolean(),
    }).strict()).max(500),
  }).strict()).max(500),
  locations: z.array(z.object({
    locationKey: ExternalKeySchema,
    locationId: IdSchema,
    reused: z.boolean(),
    imageSlotIds: z.array(IdSchema).max(10),
  }).strict()).max(500),
  props: z.array(z.object({
    propKey: ExternalKeySchema,
    propId: IdSchema,
    reused: z.boolean(),
    imageSlotIds: z.array(IdSchema).max(20),
  }).strict()).max(500),
  warnings: z.array(z.object({
    code: z.literal('EXISTING_ASSET_PRESERVED'),
    targetKey: ExternalKeySchema,
    field: trimmedTextSchema(2_000),
  }).strict()).max(2_000),
}).strict())

export type AssetsArtifact = z.infer<typeof AssetsArtifactSchema>
export type AssetsCommitRequest = z.infer<typeof AssetsCommitRequestSchema>
export type AssetsCommitResponse = z.infer<typeof AssetsCommitResponseSchema>
