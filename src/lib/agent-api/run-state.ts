import { z } from 'zod'

import {
  ExternalKeySchema,
  IdSchema,
  NameSchema,
  RunStatusSchema,
  Sha256Schema,
  trimmedTextSchema,
  UrlSchema,
  type RunStatus,
} from './contracts/common'
import {
  EffectiveOptionsSchema,
  type CreateRunRequest,
} from './contracts/run'
import { AgentApiError } from './errors'

const EpisodeMapEntrySchema = z.object({
  episodeKey: ExternalKeySchema,
  episodeId: IdSchema,
  episodeNumber: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  sourceHash: Sha256Schema,
  name: NameSchema,
  description: trimmedTextSchema(2_000).optional(),
  status: RunStatusSchema,
}).strict()

export const EpisodeMapSchema = z.record(
  ExternalKeySchema,
  EpisodeMapEntrySchema,
).superRefine((entries, context) => {
  const episodeIds = new Set<string>()
  const episodeNumbers = new Set<number>()
  const ordinals = new Set<number>()
  for (const [episodeKey, entry] of Object.entries(entries)) {
    if (entry.episodeKey !== episodeKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'episodeKey must match its record key',
        path: [episodeKey, 'episodeKey'],
      })
    }
    if (episodeIds.has(entry.episodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'episodeId must be unique',
        path: [episodeKey, 'episodeId'],
      })
    }
    if (episodeNumbers.has(entry.episodeNumber)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'episodeNumber must be unique',
        path: [episodeKey, 'episodeNumber'],
      })
    }
    if (ordinals.has(entry.ordinal)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ordinal must be unique',
        path: [episodeKey, 'ordinal'],
      })
    }
    episodeIds.add(entry.episodeId)
    episodeNumbers.add(entry.episodeNumber)
    ordinals.add(entry.ordinal)
  }
  for (let ordinal = 1; ordinal <= ordinals.size; ordinal += 1) {
    if (!ordinals.has(ordinal)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ordinals must be continuous from 1',
        path: [],
      })
      break
    }
  }
})

const VariantSlotSchema = z.object({
  entityId: IdSchema,
  index: z.number().int().nonnegative(),
}).strict()

const CharacterAppearanceMapEntrySchema = z.object({
  appearanceKey: ExternalKeySchema,
  appearanceId: IdSchema,
  appearanceIndex: z.number().int().nonnegative(),
  reused: z.boolean(),
  variantSlots: z.record(z.string().regex(/^(0|[1-9]\d*)$/), VariantSlotSchema),
}).strict()

const CharacterMapEntrySchema = z.object({
  characterKey: ExternalKeySchema,
  characterId: IdSchema,
  reused: z.boolean(),
  appearances: z.record(ExternalKeySchema, CharacterAppearanceMapEntrySchema),
}).strict().superRefine((entry, context) => {
  for (const [appearanceKey, appearance] of Object.entries(entry.appearances)) {
    if (appearance.appearanceKey !== appearanceKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'appearanceKey must match its record key',
        path: ['appearances', appearanceKey, 'appearanceKey'],
      })
    }
  }
})

const ImageAssetMapEntrySchema = z.object({
  assetKey: ExternalKeySchema,
  entityId: IdSchema,
  reused: z.boolean(),
  imageSlots: z.record(z.string().regex(/^(0|[1-9]\d*)$/), VariantSlotSchema),
}).strict()

export const AssetMapSchema = z.object({
  characters: z.record(ExternalKeySchema, CharacterMapEntrySchema),
  locations: z.record(ExternalKeySchema, ImageAssetMapEntrySchema),
  props: z.record(ExternalKeySchema, ImageAssetMapEntrySchema),
}).strict().superRefine((assets, context) => {
  for (const [characterKey, character] of Object.entries(assets.characters)) {
    if (character.characterKey !== characterKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'characterKey must match its record key',
        path: ['characters', characterKey, 'characterKey'],
      })
    }
  }
  for (const category of ['locations', 'props'] as const) {
    for (const [assetKey, asset] of Object.entries(assets[category])) {
      if (asset.assetKey !== assetKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'assetKey must match its record key',
          path: [category, assetKey, 'assetKey'],
        })
      }
    }
  }
})

const ClipMapEntrySchema = z.object({
  clipKey: ExternalKeySchema,
  clipId: IdSchema,
  episodeKey: ExternalKeySchema,
  ordinal: z.number().int().positive(),
}).strict()

export const ClipMapSchema = z.record(
  ExternalKeySchema,
  ClipMapEntrySchema,
).superRefine((entries, context) => {
  const ordinalsByEpisode = new Map<string, Set<number>>()
  for (const [clipKey, entry] of Object.entries(entries)) {
    if (entry.clipKey !== clipKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clipKey must match its record key',
        path: [clipKey, 'clipKey'],
      })
    }
    const ordinals = ordinalsByEpisode.get(entry.episodeKey) ?? new Set<number>()
    if (ordinals.has(entry.ordinal)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clip ordinal must be unique within an episode',
        path: [clipKey, 'ordinal'],
      })
    }
    ordinals.add(entry.ordinal)
    ordinalsByEpisode.set(entry.episodeKey, ordinals)
  }
  for (const ordinals of ordinalsByEpisode.values()) {
    for (let ordinal = 1; ordinal <= ordinals.size; ordinal += 1) {
      if (!ordinals.has(ordinal)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'clip ordinals must be continuous from 1',
          path: [],
        })
        break
      }
    }
  }
})

const StoryboardMapEntrySchema = z.object({
  storyboardKey: ExternalKeySchema,
  storyboardId: IdSchema,
  episodeKey: ExternalKeySchema,
  clipKey: ExternalKeySchema,
}).strict()

const PanelMapEntrySchema = z.object({
  panelKey: ExternalKeySchema,
  panelId: IdSchema,
  storyboardKey: ExternalKeySchema,
  panelIndex: z.number().int().nonnegative(),
}).strict()

const FrameMapEntrySchema = z.object({
  frameKey: ExternalKeySchema,
  frameId: IdSchema,
  panelKey: ExternalKeySchema,
  frameIndex: z.number().int().nonnegative(),
}).strict()

export const StoryboardMapSchema = z.object({
  storyboards: z.record(ExternalKeySchema, StoryboardMapEntrySchema),
  panels: z.record(ExternalKeySchema, PanelMapEntrySchema),
  frames: z.record(ExternalKeySchema, FrameMapEntrySchema),
}).strict().superRefine((mapping, context) => {
  const collections = [
    ['storyboards', 'storyboardKey'],
    ['panels', 'panelKey'],
    ['frames', 'frameKey'],
  ] as const
  for (const [collection, keyField] of collections) {
    for (const [key, entry] of Object.entries(mapping[collection])) {
      if (entry[keyField] !== key) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${keyField} must match its record key`,
          path: [collection, key, keyField],
        })
      }
    }
  }
  for (const [panelKey, panel] of Object.entries(mapping.panels)) {
    if (!(panel.storyboardKey in mapping.storyboards)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'panel must reference a mapped storyboard',
        path: ['panels', panelKey, 'storyboardKey'],
      })
    }
  }
  for (const [frameKey, frame] of Object.entries(mapping.frames)) {
    if (!(frame.panelKey in mapping.panels)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'frame must reference a mapped panel',
        path: ['frames', frameKey, 'panelKey'],
      })
    }
  }
})

export const ArtifactHashesSchema = z.object({
  assets: Sha256Schema.optional(),
  stories: z.record(ExternalKeySchema, Sha256Schema),
  screenplays: z.record(ExternalKeySchema, Sha256Schema),
  storyboards: z.record(ExternalKeySchema, Sha256Schema),
}).strict()

export const UploadReceiptSchema = z.object({
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
  storageKey: UrlSchema,
  url: UrlSchema,
}).strict()

export const UploadReceiptsSchema = z.array(UploadReceiptSchema).max(20_000)

export type EpisodeMap = z.infer<typeof EpisodeMapSchema>
export type AssetMap = z.infer<typeof AssetMapSchema>
export type ClipMap = z.infer<typeof ClipMapSchema>
export type StoryboardMap = z.infer<typeof StoryboardMapSchema>
export type ArtifactHashes = z.infer<typeof ArtifactHashesSchema>
export type UploadReceipt = z.infer<typeof UploadReceiptSchema>
export type UploadReceipts = z.infer<typeof UploadReceiptsSchema>
export type EffectiveOptions = CreateRunRequest['effectiveOptions']

function invalidPersistedState(field: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: { field },
  })
}

function parseJson<T>(
  field: string,
  value: string,
  schema: z.ZodType<T>,
): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return invalidPersistedState(field)
  }

  const result = schema.safeParse(parsed)
  if (!result.success) return invalidPersistedState(field)
  return result.data
}

function serializeJson<T>(
  field: string,
  value: unknown,
  schema: z.ZodType<T>,
): string {
  const result = schema.safeParse(value)
  if (!result.success) return invalidPersistedState(field)
  return JSON.stringify(result.data)
}

export function parseEpisodeMap(value: string): EpisodeMap {
  return parseJson('episodeMapJson', value, EpisodeMapSchema)
}

export function parseEffectiveOptions(value: string): EffectiveOptions {
  return parseJson(
    'effectiveOptionsJson',
    value,
    EffectiveOptionsSchema,
  )
}

export function serializeEffectiveOptions(value: EffectiveOptions): string {
  return serializeJson(
    'effectiveOptionsJson',
    value,
    EffectiveOptionsSchema,
  )
}

export function serializeEpisodeMap(value: EpisodeMap): string {
  return serializeJson('episodeMapJson', value, EpisodeMapSchema)
}

export function parseAssetMap(value: string): AssetMap {
  return parseJson('assetMapJson', value, AssetMapSchema)
}

export function serializeAssetMap(value: AssetMap): string {
  return serializeJson('assetMapJson', value, AssetMapSchema)
}

export function parseClipMap(value: string): ClipMap {
  return parseJson('clipMapJson', value, ClipMapSchema)
}

export function serializeClipMap(value: ClipMap): string {
  return serializeJson('clipMapJson', value, ClipMapSchema)
}

export function parseStoryboardMap(value: string): StoryboardMap {
  return parseJson('storyboardMapJson', value, StoryboardMapSchema)
}

export function serializeStoryboardMap(value: StoryboardMap): string {
  return serializeJson('storyboardMapJson', value, StoryboardMapSchema)
}

export function parseArtifactHashes(value: string): ArtifactHashes {
  return parseJson('artifactHashesJson', value, ArtifactHashesSchema)
}

export function serializeArtifactHashes(value: ArtifactHashes): string {
  return serializeJson('artifactHashesJson', value, ArtifactHashesSchema)
}

export function parseUploadReceipts(value: string): UploadReceipts {
  return parseJson('receiptJson', value, UploadReceiptsSchema)
}

export function serializeUploadReceipts(value: UploadReceipts): string {
  return serializeJson('receiptJson', value, UploadReceiptsSchema)
}

const FORWARD_STATUSES: RunStatus[] = [
  'created',
  'story_committed',
  'assets_committed',
  'screenplay_committed',
  'storyboards_committed',
  'images_in_progress',
  'completed',
]

export function transitionRunStatus(
  current: RunStatus,
  currentStage: string,
  next: RunStatus,
): RunStatus {
  if (current === next) return next
  if (current === 'completed') {
    throw new AgentApiError('AGENT_INTERNAL_ERROR')
  }
  if (current === 'incomplete' || current === 'failed') {
    if (
      next !== 'incomplete'
      && next !== 'failed'
      && next !== 'completed'
      && currentStage === next
    ) {
      return next
    }
    throw new AgentApiError('AGENT_INTERNAL_ERROR')
  }
  if (next === 'incomplete' || next === 'failed') return next

  const currentIndex = FORWARD_STATUSES.indexOf(current)
  const nextIndex = FORWARD_STATUSES.indexOf(next)
  if (currentIndex < 0 || nextIndex !== currentIndex + 1) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR')
  }
  return next
}

export function assertRunAcceptsArtifact(status: RunStatus): void {
  if (status === 'completed') {
    throw new AgentApiError('RUN_INCOMPLETE', {
      message: 'Completed runs do not accept artifact writes',
    })
  }
}
