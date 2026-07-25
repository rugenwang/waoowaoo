import { Prisma } from '@prisma/client'
import { z } from 'zod'

import { RunStatusSchema, type RunStatus } from '@/lib/agent-api/contracts/common'
import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import { AgentApiError } from '@/lib/agent-api/errors'
import {
  ArtifactHashesSchema,
  AssetMapSchema,
  ClipMapSchema,
  EpisodeMapSchema,
  StoryboardMapSchema,
  UploadReceiptsSchema,
  isCompletedUploadReceipt,
  isPendingUploadReceipt,
  type ArtifactHashes,
  type AssetMap,
  type ClipMap,
  type EpisodeMap,
  type StoryboardMap,
  type UploadReceipt,
} from '@/lib/agent-api/run-state'
import { decodeImageUrlsFromDb } from '@/lib/contracts/image-urls-contract'

const RUN_SELECT = {
  id: true,
  userId: true,
  projectId: true,
  status: true,
  currentStage: true,
  ruleSetHash: true,
  completedAt: true,
  episodeMapJson: true,
  assetMapJson: true,
  clipMapJson: true,
  storyboardMapJson: true,
  artifactHashesJson: true,
  receiptJson: true,
  project: { select: { userId: true } },
} satisfies Prisma.AgentCreationRunSelect

export type IntegrityRun = Prisma.AgentCreationRunGetPayload<{
  select: typeof RUN_SELECT
}>

export type IntegrityMissing = {
  code: string
  targetType: string
  targetKey: string
  message: string
}

export type SnapshotUpload = Pick<
  UploadReceipt,
  | 'targetType'
  | 'targetKey'
  | 'variantIndex'
  | 'contentSha256'
  | 'mediaId'
  | 'url'
>

export type IntegrityCounts = {
  episodes: number
  characters: number
  locations: number
  props: number
  clips: number
  storyboards: number
  panels: number
  frames: number
  uploadedImages: number
}

export type IntegrityReport = {
  runId: string
  status: RunStatus
  committedArtifactHashes: ArtifactHashes
  uploads: SnapshotUpload[]
  missing: IntegrityMissing[]
  counts: IntegrityCounts
}

type IntegrityDb = Pick<
  Prisma.TransactionClient,
  | 'agentCreationRun'
  | 'novelPromotionEpisode'
  | 'novelPromotionCharacter'
  | 'characterAppearance'
  | 'novelPromotionLocation'
  | 'locationImage'
  | 'novelPromotionClip'
  | 'novelPromotionStoryboard'
  | 'novelPromotionPanel'
  | 'novelPromotionPanelFrame'
  | 'mediaObject'
  | 'task'
  | 'graphRun'
  | 'usageCost'
>

type ParsedRunState = {
  episodes?: EpisodeMap
  assets?: AssetMap
  clips?: ClipMap
  storyboards?: StoryboardMap
  hashes?: ArtifactHashes
  receipts?: z.infer<typeof UploadReceiptsSchema>
}

function emptyHashes(): ArtifactHashes {
  return {
    stories: {},
    screenplays: {},
    storyboards: {},
  }
}

function parseRunStatus(value: string): RunStatus {
  const parsed = RunStatusSchema.safeParse(value)
  if (!parsed.success) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'status' },
    })
  }
  return parsed.data
}

function missingKey(item: IntegrityMissing): string {
  return [
    item.code,
    item.targetType,
    item.targetKey,
    item.message,
  ].join('\u0000')
}

export function stableMissing(
  values: IntegrityMissing[],
): IntegrityMissing[] {
  const unique = new Map<string, IntegrityMissing>()
  for (const value of values) unique.set(missingKey(value), value)
  return [...unique.values()].sort((left, right) => {
    const leftKey = missingKey(left)
    const rightKey = missingKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

function addMissing(
  missing: IntegrityMissing[],
  code: string,
  targetType: string,
  targetKey: string,
  message: string,
): void {
  missing.push({ code, targetType, targetKey, message })
}

function safeParseField<T>(
  run: IntegrityRun,
  field: keyof Pick<
    IntegrityRun,
    | 'episodeMapJson'
    | 'assetMapJson'
    | 'clipMapJson'
    | 'storyboardMapJson'
    | 'artifactHashesJson'
    | 'receiptJson'
  >,
  schema: z.ZodType<T>,
  missing: IntegrityMissing[],
): T | undefined {
  const raw = run[field]
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch {
    // Converted below into a stable, recoverable integrity item.
  }
  addMissing(
    missing,
    'MAPPING_INVALID',
    'run',
    run.id,
    `${field} is invalid`,
  )
  return undefined
}

export function parseIntegrityRunState(
  run: IntegrityRun,
  missing: IntegrityMissing[],
): ParsedRunState {
  return {
    episodes: safeParseField(
      run,
      'episodeMapJson',
      EpisodeMapSchema,
      missing,
    ),
    assets: safeParseField(run, 'assetMapJson', AssetMapSchema, missing),
    clips: safeParseField(run, 'clipMapJson', ClipMapSchema, missing),
    storyboards: safeParseField(
      run,
      'storyboardMapJson',
      StoryboardMapSchema,
      missing,
    ),
    hashes: safeParseField(
      run,
      'artifactHashesJson',
      ArtifactHashesSchema,
      missing,
    ),
    receipts: safeParseField(
      run,
      'receiptJson',
      UploadReceiptsSchema,
      missing,
    ),
  }
}

function hasExplicitRunMarker(value: unknown, runId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const meta = (value as Record<string, unknown>).meta
  return !!meta
    && typeof meta === 'object'
    && !Array.isArray(meta)
    && (meta as Record<string, unknown>).agentCreationRunId === runId
}

function hasUsageRunMarker(value: string | null, runId: string): boolean {
  if (!value) return false
  try {
    const parsed = JSON.parse(value)
    return hasExplicitRunMarker(parsed, runId)
      || (
        !!parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>).agentCreationRunId === runId
      )
  } catch {
    return false
  }
}

function mediaUrl(publicId: string): string {
  return `/m/${encodeURIComponent(publicId)}`
}

function receiptIdentity(
  receipt: Pick<
    UploadReceipt,
    'targetType' | 'targetKey' | 'variantIndex' | 'contentSha256'
  >,
): string {
  return [
    receipt.targetType,
    receipt.targetKey,
    String(receipt.variantIndex),
    receipt.contentSha256,
  ].join('\u0000')
}

function receiptTarget(
  receipt: Pick<UploadReceipt, 'targetType' | 'targetKey' | 'variantIndex'>,
): string {
  return [
    receipt.targetType,
    receipt.targetKey,
    String(receipt.variantIndex),
  ].join('\u0000')
}

function expectedStorageKey(runId: string, receipt: UploadReceipt): string {
  return [
    'agent-runs',
    runId,
    receipt.targetType,
    receipt.targetKey,
    String(receipt.variantIndex),
    `${receipt.contentSha256.slice('sha256:'.length)}.jpg`,
  ].join('/')
}

function sortedUploads(receipts: UploadReceipt[]): SnapshotUpload[] {
  return [...receipts]
    .sort((left, right) => {
      const leftKey = receiptIdentity(left)
      const rightKey = receiptIdentity(right)
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    })
    .map((receipt) => ({
      targetType: receipt.targetType,
      targetKey: receipt.targetKey,
      variantIndex: receipt.variantIndex,
      contentSha256: receipt.contentSha256,
      mediaId: receipt.mediaId,
      url: receipt.url,
    }))
}

function mappedIds(state: ParsedRunState) {
  const episodeIds = Object.values(state.episodes ?? {}).map(
    (entry) => entry.episodeId,
  )
  const characterIds: string[] = []
  const appearanceIds: string[] = []
  const locationIds: string[] = []
  const locationImageIds: string[] = []
  for (const character of Object.values(state.assets?.characters ?? {})) {
    characterIds.push(character.characterId)
    for (const appearance of Object.values(character.appearances)) {
      appearanceIds.push(appearance.appearanceId)
    }
  }
  for (
    const entry of [
      ...Object.values(state.assets?.locations ?? {}),
      ...Object.values(state.assets?.props ?? {}),
    ]
  ) {
    locationIds.push(entry.entityId)
    for (const slot of Object.values(entry.imageSlots)) {
      locationImageIds.push(slot.entityId)
    }
  }
  return {
    episodeIds,
    characterIds,
    appearanceIds,
    locationIds,
    locationImageIds,
    clipIds: Object.values(state.clips ?? {}).map((entry) => entry.clipId),
    storyboardIds: Object.values(
      state.storyboards?.storyboards ?? {},
    ).map((entry) => entry.storyboardId),
    panelIds: Object.values(state.storyboards?.panels ?? {}).map(
      (entry) => entry.panelId,
    ),
    frameIds: Object.values(state.storyboards?.frames ?? {}).map(
      (entry) => entry.frameId,
    ),
  }
}

export async function lockRunIntegrityEntities(
  tx: Prisma.TransactionClient,
  run: IntegrityRun,
  state: ParsedRunState,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM agent_creation_runs
    WHERE id = ${run.id}
    FOR UPDATE
  `)
  const ids = mappedIds(state)
  const lock = async (table: string, values: string[]) => {
    if (values.length === 0) return
    const allowed = new Set([
      'novel_promotion_episodes',
      'novel_promotion_characters',
      'character_appearances',
      'novel_promotion_locations',
      'location_images',
      'novel_promotion_clips',
      'novel_promotion_storyboards',
      'novel_promotion_panels',
      'novel_promotion_panel_frames',
    ])
    if (!allowed.has(table)) throw new Error('invalid integrity lock table')
    await tx.$queryRawUnsafe(
      `SELECT id FROM ${table} WHERE id IN (${values.map(() => '?').join(',')}) FOR UPDATE`,
      ...values,
    )
  }
  await lock('novel_promotion_episodes', ids.episodeIds)
  await lock('novel_promotion_characters', ids.characterIds)
  await lock('character_appearances', ids.appearanceIds)
  await lock('novel_promotion_locations', ids.locationIds)
  await lock('location_images', ids.locationImageIds)
  await lock('novel_promotion_clips', ids.clipIds)
  await lock('novel_promotion_storyboards', ids.storyboardIds)
  await lock('novel_promotion_panels', ids.panelIds)
  await lock('novel_promotion_panel_frames', ids.frameIds)
}

export async function inspectRunIntegrity(
  db: IntegrityDb,
  run: IntegrityRun,
  initialState?: ParsedRunState,
): Promise<IntegrityReport> {
  const missing: IntegrityMissing[] = []
  const state = initialState ?? parseIntegrityRunState(run, missing)
  const hashes = state.hashes ?? emptyHashes()
  if (!state.clips && Object.keys(hashes.screenplays).length > 0) {
    addMissing(
      missing,
      'MAPPING_INVALID',
      'run',
      run.id,
      'clipMapJson is unavailable for committed screenplays',
    )
  }
  if (!state.storyboards && Object.keys(hashes.storyboards).length > 0) {
    addMissing(
      missing,
      'MAPPING_INVALID',
      'run',
      run.id,
      'storyboardMapJson is unavailable for committed storyboards',
    )
  }
  if (!state.receipts && state.storyboards) {
    addMissing(
      missing,
      'MAPPING_INVALID',
      'run',
      run.id,
      'receiptJson is unavailable for committed storyboards',
    )
  }
  const ids = mappedIds(state)
  const [
    episodes,
    characters,
    appearances,
    locations,
    locationImages,
    clips,
    storyboards,
    panels,
    frames,
    tasks,
    graphRuns,
    usageCosts,
  ] = await Promise.all([
    db.novelPromotionEpisode.findMany({
      where: { id: { in: ids.episodeIds } },
      select: {
        id: true,
        episodeNumber: true,
        novelText: true,
        novelPromotionProjectId: true,
        novelPromotionProject: { select: { projectId: true } },
      },
    }),
    db.novelPromotionCharacter.findMany({
      where: { id: { in: ids.characterIds } },
      select: {
        id: true,
        novelPromotionProjectId: true,
        novelPromotionProject: { select: { projectId: true } },
      },
    }),
    db.characterAppearance.findMany({
      where: { id: { in: ids.appearanceIds } },
      select: {
        id: true,
        characterId: true,
        appearanceIndex: true,
        imageUrls: true,
        imageUrl: true,
        imageMediaId: true,
      },
    }),
    db.novelPromotionLocation.findMany({
      where: { id: { in: ids.locationIds } },
      select: {
        id: true,
        novelPromotionProjectId: true,
        assetKind: true,
        selectedImageId: true,
        novelPromotionProject: { select: { projectId: true } },
      },
    }),
    db.locationImage.findMany({
      where: { id: { in: ids.locationImageIds } },
      select: {
        id: true,
        locationId: true,
        imageIndex: true,
        imageUrl: true,
        imageMediaId: true,
      },
    }),
    db.novelPromotionClip.findMany({
      where: { id: { in: ids.clipIds } },
      select: { id: true, episodeId: true },
    }),
    db.novelPromotionStoryboard.findMany({
      where: { id: { in: ids.storyboardIds } },
      select: { id: true, clipId: true, episodeId: true },
    }),
    db.novelPromotionPanel.findMany({
      where: { id: { in: ids.panelIds } },
      select: {
        id: true,
        storyboardId: true,
        panelIndex: true,
        imageUrl: true,
        imageMediaId: true,
      },
    }),
    db.novelPromotionPanelFrame.findMany({
      where: { id: { in: ids.frameIds } },
      select: {
        id: true,
        panelId: true,
        frameIndex: true,
        imageUrl: true,
        imageMediaId: true,
        generationStatus: true,
      },
    }),
    db.task.findMany({
      where: { projectId: run.projectId },
      select: { id: true, payload: true },
    }),
    db.graphRun.findMany({
      where: { projectId: run.projectId },
      select: { id: true, input: true },
    }),
    db.usageCost.findMany({
      where: { projectId: run.projectId },
      select: { id: true, metadata: true },
    }),
  ])

  const completedReceipts = (state.receipts ?? []).filter(
    isCompletedUploadReceipt,
  )
  const pendingReceipts = (state.receipts ?? []).filter(
    isPendingUploadReceipt,
  )
  const mediaIds = [...new Set(completedReceipts.map(
    (receipt) => receipt.mediaId,
  ))]
  const mediaObjects = await db.mediaObject.findMany({
    where: { id: { in: mediaIds } },
    select: { id: true, publicId: true, storageKey: true },
  })

  const episodeById = new Map(episodes.map((row) => [row.id, row]))
  const characterById = new Map(characters.map((row) => [row.id, row]))
  const appearanceById = new Map(appearances.map((row) => [row.id, row]))
  const locationById = new Map(locations.map((row) => [row.id, row]))
  const locationImageById = new Map(locationImages.map(
    (row) => [row.id, row],
  ))
  const clipById = new Map(clips.map((row) => [row.id, row]))
  const storyboardById = new Map(storyboards.map((row) => [row.id, row]))
  const panelById = new Map(panels.map((row) => [row.id, row]))
  const frameById = new Map(frames.map((row) => [row.id, row]))
  const mediaById = new Map(mediaObjects.map((row) => [row.id, row]))

  const completedByTarget = new Map<string, UploadReceipt[]>()
  for (const receipt of completedReceipts) {
    const key = receiptTarget(receipt)
    completedByTarget.set(key, [
      ...(completedByTarget.get(key) ?? []),
      receipt,
    ])
  }

  const expectedTargets = new Set<string>()
  const receiptValid = (
    receipt: UploadReceipt,
    storageKey: string | null,
    mediaId: string | null,
    allowMissingMediaLink: boolean,
  ) => {
    const media = mediaById.get(receipt.mediaId)
    return !!storageKey
      && receipt.storageKey === storageKey
      && expectedStorageKey(run.id, receipt) === receipt.storageKey
      && (
        allowMissingMediaLink
        || (!!mediaId && receipt.mediaId === mediaId)
      )
      && !!media
      && media.storageKey === receipt.storageKey
      && receipt.url === mediaUrl(media.publicId)
  }
  const findCurrentReceipt = (
    targetType: UploadReceipt['targetType'],
    targetKey: string,
    variantIndex: number,
    storageKey: string | null,
    mediaId: string | null,
    allowMissingMediaLink = false,
  ) => {
    const target = [targetType, targetKey, String(variantIndex)].join('\u0000')
    expectedTargets.add(target)
    return (completedByTarget.get(target) ?? []).find(
      (receipt) => receiptValid(
        receipt,
        storageKey,
        mediaId,
        allowMissingMediaLink,
      ),
    )
  }

  if (!state.episodes) {
    addMissing(
      missing,
      'MAPPING_INVALID',
      'run',
      run.id,
      'episode mapping is unavailable',
    )
  } else {
    for (const episode of Object.values(state.episodes)) {
      const row = episodeById.get(episode.episodeId)
      if (
        !row
        || row.episodeNumber !== episode.episodeNumber
        || row.novelPromotionProject.projectId !== run.projectId
      ) {
        addMissing(
          missing,
          'MAPPING_INVALID',
          'episode',
          episode.episodeKey,
          'Mapped episode does not belong to the run project',
        )
      }
      const episodeStatusRank = [
        'created',
        'story_committed',
        'assets_committed',
        'screenplay_committed',
        'storyboards_committed',
        'images_in_progress',
        'incomplete',
        'completed',
      ].indexOf(episode.status)
      if (
        !hashes.stories[episode.episodeKey]
        || !row?.novelText?.trim()
        || episodeStatusRank < 1
      ) {
        addMissing(
          missing,
          'STORY_MISSING',
          'episode',
          episode.episodeKey,
          'Committed story text is missing',
        )
      }
      if (
        !hashes.screenplays[episode.episodeKey]
        || episodeStatusRank < 3
      ) {
        addMissing(
          missing,
          'SCREENPLAY_MISSING',
          'episode',
          episode.episodeKey,
          'Committed screenplay is missing',
        )
      }
      if (
        !hashes.storyboards[episode.episodeKey]
        || episodeStatusRank < 4
      ) {
        addMissing(
          missing,
          'STORYBOARD_MISSING',
          'episode',
          episode.episodeKey,
          'Committed storyboards are missing',
        )
      }
    }
  }

  const episodeKeys = new Set(Object.keys(state.episodes ?? {}))
  for (
    const [kind, values] of [
      ['stories', hashes.stories],
      ['screenplays', hashes.screenplays],
      ['storyboards', hashes.storyboards],
    ] as const
  ) {
    for (const key of Object.keys(values)) {
      if (!episodeKeys.has(key)) {
        addMissing(
          missing,
          'MAPPING_INVALID',
          'episode',
          key,
          `${kind} hash references an unknown episode`,
        )
      }
    }
  }

  if (!hashes.assets || !state.assets) {
    addMissing(
      missing,
      'ASSETS_MISSING',
      'run',
      run.id,
      'Committed assets are missing',
    )
  }

  for (const character of Object.values(state.assets?.characters ?? {})) {
    const characterRow = characterById.get(character.characterId)
    if (
      !characterRow
      || characterRow.novelPromotionProject.projectId !== run.projectId
    ) {
      addMissing(
        missing,
        'MAPPING_INVALID',
        'character',
        character.characterKey,
        'Mapped character does not belong to the run project',
      )
    }
    for (const appearance of Object.values(character.appearances)) {
      const row = appearanceById.get(appearance.appearanceId)
      const slot = appearance.variantSlots['0']
      let imageUrls: string[] = []
      try {
        imageUrls = decodeImageUrlsFromDb(
          row?.imageUrls ?? null,
          'characterAppearance.imageUrls',
        )
      } catch {
        // An invalid DB value is reported as an invalid mapping below.
      }
      const validMapping = !!row
        && row.characterId === character.characterId
        && row.appearanceIndex === appearance.appearanceIndex
        && !!slot
        && slot.entityId === buildAppearanceCandidateOwnerId(
          run.id,
          appearance.appearanceKey,
          0,
          slot.index,
        )
      if (!validMapping) {
        addMissing(
          missing,
          'MAPPING_INVALID',
          'character-appearance',
          appearance.appearanceKey,
          'Mapped character appearance is invalid',
        )
      }
      const storageKey = slot ? imageUrls[slot.index] ?? null : null
      if (!findCurrentReceipt(
        'character-appearance',
        appearance.appearanceKey,
        0,
        storageKey,
        null,
        true,
      )) {
        addMissing(
          missing,
          'ASSET_IMAGE_MISSING',
          'character-appearance',
          appearance.appearanceKey,
          'Run-owned character appearance image is missing',
        )
      }
    }
  }

  const checkImageAssets = (
    collection: NonNullable<ParsedRunState['assets']>['locations'],
    targetType: 'location-image' | 'prop-image',
    expectedKind: 'location' | 'prop',
  ) => {
    for (const asset of Object.values(collection)) {
      const row = locationById.get(asset.entityId)
      if (
        !row
        || row.assetKind !== expectedKind
        || row.novelPromotionProject.projectId !== run.projectId
      ) {
        addMissing(
          missing,
          'MAPPING_INVALID',
          expectedKind,
          asset.assetKey,
          `Mapped ${expectedKind} does not belong to the run project`,
        )
      }
      for (const [localIndex, slot] of Object.entries(asset.imageSlots)) {
        const image = locationImageById.get(slot.entityId)
        const validMapping = !!image
          && image.locationId === asset.entityId
          && image.imageIndex === slot.index
          && slot.entityId === buildProjectedEntityId(
            run.id,
            'LocationImage',
            `${asset.assetKey}:${localIndex}`,
          )
        if (!validMapping) {
          addMissing(
            missing,
            'MAPPING_INVALID',
            targetType,
            asset.assetKey,
            `Mapped ${expectedKind} image variant ${localIndex} is invalid`,
          )
        }
        if (!findCurrentReceipt(
          targetType,
          asset.assetKey,
          Number(localIndex),
          image?.imageUrl ?? null,
          image?.imageMediaId ?? null,
        )) {
          addMissing(
            missing,
            'ASSET_IMAGE_MISSING',
            targetType,
            asset.assetKey,
            `Run-owned ${expectedKind} image variant ${localIndex} is missing`,
          )
        }
      }
    }
  }
  checkImageAssets(state.assets?.locations ?? {}, 'location-image', 'location')
  checkImageAssets(state.assets?.props ?? {}, 'prop-image', 'prop')

  for (const clip of Object.values(state.clips ?? {})) {
    const episode = state.episodes?.[clip.episodeKey]
    const row = clipById.get(clip.clipId)
    if (
      !episode
      || !row
      || row.episodeId !== episode.episodeId
      || clip.clipId !== buildProjectedEntityId(run.id, 'Clip', clip.clipKey)
    ) {
      addMissing(
        missing,
        'MAPPING_INVALID',
        'clip',
        clip.clipKey,
        'Mapped clip is invalid',
      )
    }
    const mappedStoryboards = Object.values(
      state.storyboards?.storyboards ?? {},
    ).filter((entry) => entry.clipKey === clip.clipKey)
    if (mappedStoryboards.length !== 1) {
      addMissing(
        missing,
        'CLIP_STORYBOARD_MISSING',
        'clip',
        clip.clipKey,
        'Clip must have exactly one run storyboard',
      )
    }
  }

  for (
    const storyboard of Object.values(
      state.storyboards?.storyboards ?? {},
    )
  ) {
    const clip = state.clips?.[storyboard.clipKey]
    const episode = state.episodes?.[storyboard.episodeKey]
    const row = storyboardById.get(storyboard.storyboardId)
    if (
      !clip
      || !episode
      || !row
      || row.clipId !== clip.clipId
      || row.episodeId !== episode.episodeId
      || storyboard.storyboardId !== buildProjectedEntityId(
        run.id,
        'Storyboard',
        storyboard.storyboardKey,
      )
    ) {
      addMissing(
        missing,
        'MAPPING_INVALID',
        'storyboard',
        storyboard.storyboardKey,
        'Mapped storyboard is invalid',
      )
    }
  }

  for (const panel of Object.values(state.storyboards?.panels ?? {})) {
    const storyboard = state.storyboards?.storyboards[panel.storyboardKey]
    const row = panelById.get(panel.panelId)
    if (
      !storyboard
      || !row
      || row.storyboardId !== storyboard.storyboardId
      || row.panelIndex !== panel.panelIndex
      || panel.panelId !== buildProjectedEntityId(
        run.id,
        'Panel',
        panel.panelKey,
      )
    ) {
      addMissing(
        missing,
        'MAPPING_INVALID',
        'panel',
        panel.panelKey,
        'Mapped panel is invalid',
      )
    }
    const mappedFrames = Object.values(
      state.storyboards?.frames ?? {},
    ).filter((frame) => frame.panelKey === panel.panelKey)
    if (mappedFrames.length === 0) {
      addMissing(
        missing,
        'PANEL_FRAME_MISSING',
        'panel',
        panel.panelKey,
        'Panel has no mapped frame',
      )
    }
  }

  for (const frame of Object.values(state.storyboards?.frames ?? {})) {
    const panel = state.storyboards?.panels[frame.panelKey]
    const panelRow = panel ? panelById.get(panel.panelId) : undefined
    const row = frameById.get(frame.frameId)
    const validMapping = !!panel
      && !!row
      && row.panelId === panel.panelId
      && row.frameIndex === frame.frameIndex
      && frame.frameId === buildProjectedEntityId(
        run.id,
        'Frame',
        frame.frameKey,
      )
    if (!validMapping) {
      addMissing(
        missing,
        'PANEL_FRAME_MISSING',
        'panel-frame',
        frame.frameKey,
        'Mapped panel frame is missing or invalid',
      )
    }
    const receipt = findCurrentReceipt(
      'panel-frame',
      frame.frameKey,
      0,
      row?.imageUrl ?? null,
      row?.imageMediaId ?? null,
    )
    const firstFrameSynced = frame.frameIndex !== 0
      || (
        !!panelRow
        && panelRow.imageUrl === row?.imageUrl
        && !!panelRow.imageMediaId
        && panelRow.imageMediaId === row?.imageMediaId
        && panelRow.imageMediaId === receipt?.mediaId
      )
    if (
      !receipt
      || row?.generationStatus !== 'completed'
      || !firstFrameSynced
    ) {
      addMissing(
        missing,
        'FRAME_IMAGE_MISSING',
        'panel-frame',
        frame.frameKey,
        'Completed run-owned frame image is missing',
      )
    }
  }

  for (const receipt of pendingReceipts) {
    addMissing(
      missing,
      'UPLOAD_PENDING',
      receipt.targetType,
      receipt.targetKey,
      `Upload variant ${receipt.variantIndex} is pending`,
    )
  }
  for (const receipt of completedReceipts) {
    const target = receiptTarget(receipt)
    const media = mediaById.get(receipt.mediaId)
    const invalidReceipt = expectedStorageKey(run.id, receipt)
      !== receipt.storageKey
      || !media
      || media.storageKey !== receipt.storageKey
      || receipt.url !== mediaUrl(media.publicId)
    if (!expectedTargets.has(target) || invalidReceipt) {
      addMissing(
        missing,
        'RECEIPT_INVALID',
        receipt.targetType,
        receipt.targetKey,
        `Upload variant ${receipt.variantIndex} has no run-owned target`,
      )
    }
  }

  for (const task of tasks) {
    if (hasExplicitRunMarker(task.payload, run.id)) {
      addMissing(
        missing,
        'FORBIDDEN_TASK',
        'task',
        task.id,
        'Generation task was created for this agent run',
      )
    }
  }
  for (const graphRun of graphRuns) {
    if (hasExplicitRunMarker(graphRun.input, run.id)) {
      addMissing(
        missing,
        'FORBIDDEN_GRAPH_RUN',
        'graph-run',
        graphRun.id,
        'Graph run was created for this agent run',
      )
    }
  }
  for (const usageCost of usageCosts) {
    if (hasUsageRunMarker(usageCost.metadata, run.id)) {
      addMissing(
        missing,
        'FORBIDDEN_USAGE_COST',
        'usage-cost',
        usageCost.id,
        'Usage cost was created for this agent run',
      )
    }
  }

  return {
    runId: run.id,
    status: parseRunStatus(run.status),
    committedArtifactHashes: hashes,
    uploads: sortedUploads(completedReceipts),
    missing: stableMissing(missing),
    counts: {
      episodes: Object.keys(state.episodes ?? {}).length,
      characters: Object.keys(state.assets?.characters ?? {}).length,
      locations: Object.keys(state.assets?.locations ?? {}).length,
      props: Object.keys(state.assets?.props ?? {}).length,
      clips: Object.keys(state.clips ?? {}).length,
      storyboards: Object.keys(
        state.storyboards?.storyboards ?? {},
      ).length,
      panels: Object.keys(state.storyboards?.panels ?? {}).length,
      frames: Object.keys(state.storyboards?.frames ?? {}).length,
      uploadedImages: completedReceipts.length,
    },
  }
}

export async function loadIntegrityRun(
  db: Pick<IntegrityDb, 'agentCreationRun'>,
  input: { userId: string; runId: string },
): Promise<IntegrityRun> {
  const run = await db.agentCreationRun.findUnique({
    where: { id: input.runId },
    select: RUN_SELECT,
  })
  if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (
    run.userId !== input.userId
    || run.project.userId !== input.userId
  ) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }
  return run
}
