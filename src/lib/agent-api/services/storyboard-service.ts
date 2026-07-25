import { Prisma } from '@prisma/client'

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import {
  type StoryboardsCommitRequest,
  type StoryboardsCommitResponse,
  StoryboardsCommitRequestSchema,
} from '@/lib/agent-api/contracts/storyboards'
import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import { AgentApiError, isAgentApiError } from '@/lib/agent-api/errors'
import {
  parseArtifactHashes,
  parseAssetMap,
  parseClipMap,
  parseEpisodeMap,
  parseStoryboardMap,
  serializeArtifactHashes,
  serializeEpisodeMap,
  serializeStoryboardMap,
  transitionRunStatus,
  type AssetMap,
  type ClipMap,
  type EpisodeMap,
  type StoryboardMap,
} from '@/lib/agent-api/run-state'
import {
  createFrameRows,
  createPanelRows,
  createStoryboardRows,
  updateClipShotCounts,
  updateFrameRows,
  updatePanelRows,
  updateStoryboardRows,
  type FrameCreate,
  type FrameWrite,
  type PanelCreate,
  type PanelWrite,
  type StoryboardCreate,
  type StoryboardWrite,
} from '@/lib/agent-api/storyboard-bulk-write'
import { validateStoryboardArtifact } from '@/lib/agent-api/storyboard-validation'
import { prisma } from '@/lib/prisma'
import { serializePanelFrameDependencyPlan } from '@/lib/novel-promotion/panel-tail-reference'
import {
  RunStatusSchema,
  type RunStatus,
} from '@/lib/agent-api/contracts/common'

const STORYBOARD_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 120_000,
} as const
const READ_CHUNK_SIZE = 500

const RUN_SELECT = {
  id: true,
  userId: true,
  projectId: true,
  ruleSetVersion: true,
  ruleSetHash: true,
  definitionHash: true,
  status: true,
  currentStage: true,
  episodeMapJson: true,
  assetMapJson: true,
  clipMapJson: true,
  storyboardMapJson: true,
  artifactHashesJson: true,
  createdAt: true,
  project: { select: { userId: true } },
} satisfies Prisma.AgentCreationRunSelect

const PREFLIGHT_RUN_SELECT = {
  id: true,
  userId: true,
  projectId: true,
  episodeMapJson: true,
  assetMapJson: true,
  clipMapJson: true,
  project: { select: { userId: true } },
} satisfies Prisma.AgentCreationRunSelect

type TransactionClient = Prisma.TransactionClient
type CommitData = StoryboardsCommitResponse['data']
type PreflightSnapshot = {
  episodeMapJson: string
  assetMapJson: string
  clipMapJson: string
}

type AssetDisplay = {
  characterNames: Map<string, string>
  appearanceReasons: Map<string, string>
  locationNames: Map<string, string>
  propNames: Map<string, string>
}

function internalState(field: string, targetKey?: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: {
      field,
      ...(targetKey ? { targetKey } : {}),
    },
  })
}

async function findManyInChunks<T>(
  ids: string[],
  load: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < ids.length; offset += READ_CHUNK_SIZE) {
    rows.push(...await load(ids.slice(offset, offset + READ_CHUNK_SIZE)))
  }
  return rows
}

async function lockIdsInChunks(
  tx: TransactionClient,
  table:
    | 'novel_promotion_storyboards'
    | 'novel_promotion_panels'
    | 'novel_promotion_panel_frames',
  ids: string[],
): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += READ_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + READ_CHUNK_SIZE)
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM ${Prisma.raw(table)}
      WHERE id IN (${Prisma.join(chunk)})
      FOR UPDATE
    `)
  }
}

async function hasCollisionInChunks(
  ids: string[],
  find: (ids: string[]) => Promise<{ id: string } | null>,
): Promise<boolean> {
  for (let offset = 0; offset < ids.length; offset += READ_CHUNK_SIZE) {
    const collision = await find(ids.slice(offset, offset + READ_CHUNK_SIZE))
    if (collision) return true
  }
  return false
}

function parseRunStatus(value: string): RunStatus {
  const result = RunStatusSchema.safeParse(value)
  if (!result.success) internalState('status')
  return result.data
}

function definitionEntries(episodes: EpisodeMap) {
  return Object.values(episodes)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => ({
      episodeKey: entry.episodeKey,
      ordinal: entry.ordinal,
      sourceHash: entry.sourceHash,
      name: entry.name,
      ...(entry.description === undefined
        ? {}
        : { description: entry.description }),
    }))
}

function assertGlobalStage(
  status: RunStatus,
  currentStage: string,
  episodes: EpisodeMap,
  hashes: ReturnType<typeof parseArtifactHashes>,
  clipMap: ClipMap,
  storyboardMap: StoryboardMap,
): void {
  if (status !== 'screenplay_committed' && status !== 'storyboards_committed') {
    throw new AgentApiError('RUN_INCOMPLETE', {
      message: 'Run is not ready for storyboard artifacts',
    })
  }
  if (!hashes.assets) internalState('artifactHashesJson')
  const episodeKeys = new Set(Object.keys(episodes))
  for (const record of [hashes.stories, hashes.screenplays, hashes.storyboards]) {
    if (Object.keys(record).some((key) => !episodeKeys.has(key))) {
      internalState('artifactHashesJson')
    }
  }

  const clipsByEpisode = new Map<string, ClipMap[string][]>()
  for (const entry of Object.values(clipMap)) {
    const episode = episodes[entry.episodeKey]
    if (!episode || !hashes.screenplays[entry.episodeKey]) {
      internalState('clipMapJson', entry.clipKey)
    }
    const list = clipsByEpisode.get(entry.episodeKey) ?? []
    list.push(entry)
    clipsByEpisode.set(entry.episodeKey, list)
  }

  for (const episode of Object.values(episodes)) {
    if (!hashes.stories[episode.episodeKey] || !hashes.screenplays[episode.episodeKey]) {
      internalState('artifactHashesJson', episode.episodeKey)
    }
    const clips = (clipsByEpisode.get(episode.episodeKey) ?? [])
      .sort((left, right) => left.ordinal - right.ordinal)
    if (clips.some((entry, index) => entry.ordinal !== index + 1)) {
      internalState('clipMapJson', episode.episodeKey)
    }
    const emptyScreenplayHash = hashArtifact({
      episodeKey: episode.episodeKey,
      clips: [],
    })
    if (
      (clips.length === 0
        && hashes.screenplays[episode.episodeKey] !== emptyScreenplayHash)
      || (clips.length > 0
        && hashes.screenplays[episode.episodeKey] === emptyScreenplayHash)
    ) {
      internalState('clipMapJson', episode.episodeKey)
    }
    const storyboardHash = hashes.storyboards[episode.episodeKey]
    if (episode.status === 'storyboards_committed') {
      if (!storyboardHash) internalState('artifactHashesJson', episode.episodeKey)
    } else if (episode.status === 'screenplay_committed') {
      if (storyboardHash) internalState('episodeMapJson', episode.episodeKey)
    } else {
      internalState('episodeMapJson', episode.episodeKey)
    }
  }

  for (const [storyboardKey, entry] of Object.entries(
    storyboardMap.storyboards,
  )) {
    const episode = episodes[entry.episodeKey]
    const clip = clipMap[entry.clipKey]
    if (
      !episode
      || episode.status !== 'storyboards_committed'
      || !hashes.storyboards[entry.episodeKey]
      || !clip
      || clip.episodeKey !== entry.episodeKey
    ) {
      internalState('storyboardMapJson', storyboardKey)
    }
  }

  const committed = Object.values(episodes).filter(
    (episode) => episode.status === 'storyboards_committed',
  ).length
  const total = Object.keys(episodes).length
  if (status === 'screenplay_committed') {
    if (committed >= total) internalState('episodeMapJson')
    const expected = committed === 0
      ? 'screenplay_committed'
      : `storyboard_committing:${committed}/${total}`
    if (currentStage !== expected) internalState('currentStage')
  } else {
    if (committed !== total) internalState('episodeMapJson')
    if (currentStage !== 'storyboards_committed') {
      internalState('currentStage')
    }
  }
}

function parseImageUrls(value: string | null, targetKey: string): string[] {
  try {
    const parsed = JSON.parse(value ?? '')
    if (
      Array.isArray(parsed)
      && parsed.every((entry) => typeof entry === 'string')
    ) {
      return parsed
    }
  } catch {
    // Handled as persisted-state corruption below.
  }
  internalState('assetMapJson', targetKey)
}

async function loadAssetDisplay(
  tx: TransactionClient,
  runId: string,
  projectId: string,
  assets: AssetMap,
): Promise<AssetDisplay> {
  const novelProject = await tx.novelPromotionProject.findUnique({
    where: { projectId },
    select: { id: true },
  })
  if (!novelProject) internalState('projectId')

  const characterEntries = Object.entries(assets.characters)
  const characterRows = await tx.novelPromotionCharacter.findMany({
    where: {
      id: { in: characterEntries.map(([, entry]) => entry.characterId) },
    },
    select: { id: true, name: true, novelPromotionProjectId: true },
  })
  const charactersById = new Map(characterRows.map((row) => [row.id, row]))
  const characterNames = new Map<string, string>()
  const appearanceEntries = characterEntries.flatMap(
    ([characterKey, character]) => Object.entries(character.appearances)
      .map(([appearanceKey, appearance]) => ({
        characterKey,
        characterId: character.characterId,
        appearanceKey,
        appearance,
      })),
  )
  const appearanceRows = await tx.characterAppearance.findMany({
    where: {
      id: {
        in: appearanceEntries.map((entry) => entry.appearance.appearanceId),
      },
    },
    select: {
      id: true,
      characterId: true,
      appearanceIndex: true,
      changeReason: true,
      imageUrls: true,
    },
  })
  const appearancesById = new Map(appearanceRows.map((row) => [row.id, row]))
  const appearanceReasons = new Map<string, string>()
  for (const [characterKey, character] of characterEntries) {
    const row = charactersById.get(character.characterId)
    if (
      !row
      || row.novelPromotionProjectId !== novelProject.id
      || !row.name.trim()
    ) {
      internalState('assetMapJson', characterKey)
    }
    characterNames.set(characterKey, row.name)
  }
  for (const entry of appearanceEntries) {
    const row = appearancesById.get(entry.appearance.appearanceId)
    const slots = Object.entries(entry.appearance.variantSlots)
    if (
      !row
      || row.characterId !== entry.characterId
      || row.appearanceIndex !== entry.appearance.appearanceIndex
      || !row.changeReason.trim()
      || slots.length !== 1
      || slots[0][0] !== '0'
    ) {
      internalState('assetMapJson', entry.appearanceKey)
    }
    const imageUrls = parseImageUrls(row.imageUrls, entry.appearanceKey)
    for (const [localVariant, slot] of slots) {
      if (
        slot.index < 0
        || slot.index >= imageUrls.length
        || slot.entityId !== buildAppearanceCandidateOwnerId(
          runId,
          entry.appearanceKey,
          Number(localVariant),
          slot.index,
        )
      ) {
        internalState('assetMapJson', entry.appearanceKey)
      }
    }
    appearanceReasons.set(entry.appearanceKey, row.changeReason)
  }

  const imageAssets = [
    ...Object.entries(assets.locations).map(([key, entry]) => ({
      key,
      entry,
      kind: 'location',
    })),
    ...Object.entries(assets.props).map(([key, entry]) => ({
      key,
      entry,
      kind: 'prop',
    })),
  ] as const
  const assetRows = await tx.novelPromotionLocation.findMany({
    where: { id: { in: imageAssets.map(({ entry }) => entry.entityId) } },
    select: {
      id: true,
      name: true,
      assetKind: true,
      novelPromotionProjectId: true,
    },
  })
  const assetRowsById = new Map(assetRows.map((row) => [row.id, row]))
  const slotEntries = imageAssets.flatMap(({ key, entry, kind }) => (
    Object.entries(entry.imageSlots).map(([localSlot, slot]) => ({
      key,
      kind,
      localSlot,
      ownerId: entry.entityId,
      slot,
    }))
  ))
  const slotRows = await tx.locationImage.findMany({
    where: { id: { in: slotEntries.map(({ slot }) => slot.entityId) } },
    select: { id: true, locationId: true, imageIndex: true },
  })
  const slotRowsById = new Map(slotRows.map((row) => [row.id, row]))
  const locationNames = new Map<string, string>()
  const propNames = new Map<string, string>()
  for (const { key, entry, kind } of imageAssets) {
    const row = assetRowsById.get(entry.entityId)
    const slotKeys = Object.keys(entry.imageSlots)
      .sort((left, right) => Number(left) - Number(right))
    if (
      !row
      || row.novelPromotionProjectId !== novelProject.id
      || row.assetKind !== kind
      || !row.name.trim()
      || slotKeys.length === 0
      || slotKeys.some((slot, index) => slot !== String(index))
      || (kind === 'prop' && slotKeys.length !== 1)
    ) {
      internalState('assetMapJson', key)
    }
    if (kind === 'location') locationNames.set(key, row.name)
    else propNames.set(key, row.name)
  }
  for (const { key, localSlot, ownerId, slot } of slotEntries) {
    const row = slotRowsById.get(slot.entityId)
    if (
      slot.entityId !== buildProjectedEntityId(
        runId,
        'LocationImage',
        `${key}:${localSlot}`,
      )
      || !row
      || row.locationId !== ownerId
      || row.imageIndex !== slot.index
    ) {
      internalState('assetMapJson', key)
    }
  }
  return {
    characterNames,
    appearanceReasons,
    locationNames,
    propNames,
  }
}

async function validatePersistedClipMap(
  tx: TransactionClient,
  runId: string,
  episodes: EpisodeMap,
  clipMap: ClipMap,
): Promise<void> {
  const entries = Object.values(clipMap)
  for (const entry of entries) {
    if (
      !episodes[entry.episodeKey]
      || entry.clipId !== buildProjectedEntityId(
        runId,
        'Clip',
        entry.clipKey,
      )
    ) {
      internalState('clipMapJson', entry.clipKey)
    }
  }
  const rows = await findManyInChunks(
    entries.map((entry) => entry.clipId),
    (ids) => tx.novelPromotionClip.findMany({
      where: { id: { in: ids } },
      select: { id: true, episodeId: true },
    }),
  )
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  for (const entry of entries) {
    if (
      rowsById.get(entry.clipId)?.episodeId
      !== episodes[entry.episodeKey].episodeId
    ) {
      internalState('clipMapJson', entry.clipKey)
    }
  }
}

function episodeStoryboardEntries(
  mapping: StoryboardMap,
  episodeKey: string,
  clipMap: ClipMap,
) {
  return Object.values(mapping.storyboards)
    .filter((entry) => entry.episodeKey === episodeKey)
    .sort((left, right) => (
      clipMap[left.clipKey].ordinal - clipMap[right.clipKey].ordinal
    ))
}

function assertMappingTopology(
  mapping: StoryboardMap,
  episodes: EpisodeMap,
  clipMap: ClipMap,
): void {
  const panelsByStoryboard = new Map<string, StoryboardMap['panels'][string][]>()
  for (const panel of Object.values(mapping.panels)) {
    const list = panelsByStoryboard.get(panel.storyboardKey) ?? []
    list.push(panel)
    panelsByStoryboard.set(panel.storyboardKey, list)
  }
  const framesByPanel = new Map<string, StoryboardMap['frames'][string][]>()
  for (const frame of Object.values(mapping.frames)) {
    const list = framesByPanel.get(frame.panelKey) ?? []
    list.push(frame)
    framesByPanel.set(frame.panelKey, list)
  }
  for (const episode of Object.values(episodes)) {
    const storyboards = episodeStoryboardEntries(
      mapping,
      episode.episodeKey,
      clipMap,
    )
    if (episode.status === 'screenplay_committed') {
      if (storyboards.length > 0) {
        internalState('storyboardMapJson', episode.episodeKey)
      }
      continue
    }
    const clips = Object.values(clipMap)
      .filter((entry) => entry.episodeKey === episode.episodeKey)
      .sort((left, right) => left.ordinal - right.ordinal)
    if (
      storyboards.length !== clips.length
      || storyboards.some((entry, index) => (
        entry.clipKey !== clips[index].clipKey
      ))
    ) {
      internalState('storyboardMapJson', episode.episodeKey)
    }
  }
  for (const storyboard of Object.values(mapping.storyboards)) {
    const panels = (panelsByStoryboard.get(storyboard.storyboardKey) ?? [])
      .sort((left, right) => left.panelIndex - right.panelIndex)
    if (panels.some((entry, index) => entry.panelIndex !== index)) {
      internalState('storyboardMapJson', storyboard.storyboardKey)
    }
  }
  for (const panel of Object.values(mapping.panels)) {
    const frames = (framesByPanel.get(panel.panelKey) ?? [])
      .sort((left, right) => left.frameIndex - right.frameIndex)
    if (
      frames.length === 0
      || frames.some((entry, index) => entry.frameIndex !== index)
    ) {
      internalState('storyboardMapJson', panel.panelKey)
    }
  }
}

async function validatePersistedStoryboardMap(
  tx: TransactionClient,
  runId: string,
  episodes: EpisodeMap,
  clipMap: ClipMap,
  mapping: StoryboardMap,
): Promise<void> {
  assertMappingTopology(mapping, episodes, clipMap)
  const storyboardEntries = Object.values(mapping.storyboards)
  const panelEntries = Object.values(mapping.panels)
  const frameEntries = Object.values(mapping.frames)
  for (const entry of storyboardEntries) {
    if (
      entry.storyboardId !== buildProjectedEntityId(
        runId,
        'Storyboard',
        entry.storyboardKey,
      )
    ) internalState('storyboardMapJson', entry.storyboardKey)
  }
  for (const entry of panelEntries) {
    if (
      entry.panelId !== buildProjectedEntityId(
        runId,
        'Panel',
        entry.panelKey,
      )
    ) internalState('storyboardMapJson', entry.panelKey)
  }
  for (const entry of frameEntries) {
    if (
      entry.frameId !== buildProjectedEntityId(
        runId,
        'Frame',
        entry.frameKey,
      )
    ) internalState('storyboardMapJson', entry.frameKey)
  }
  const storyboardRows = await findManyInChunks(
    storyboardEntries.map((entry) => entry.storyboardId),
    (ids) => tx.novelPromotionStoryboard.findMany({
      where: { id: { in: ids } },
      select: { id: true, episodeId: true, clipId: true },
    }),
  )
  const panelRows = await findManyInChunks(
    panelEntries.map((entry) => entry.panelId),
    (ids) => tx.novelPromotionPanel.findMany({
      where: { id: { in: ids } },
      select: { id: true, storyboardId: true, panelIndex: true },
    }),
  )
  const frameRows = await findManyInChunks(
    frameEntries.map((entry) => entry.frameId),
    (ids) => tx.novelPromotionPanelFrame.findMany({
      where: { id: { in: ids } },
      select: { id: true, panelId: true, frameIndex: true },
    }),
  )
  const storyboardRowsById = new Map(
    storyboardRows.map((row) => [row.id, row]),
  )
  const panelRowsById = new Map(panelRows.map((row) => [row.id, row]))
  const frameRowsById = new Map(frameRows.map((row) => [row.id, row]))
  for (const entry of storyboardEntries) {
    const row = storyboardRowsById.get(entry.storyboardId)
    if (
      !row
      || row.episodeId !== episodes[entry.episodeKey].episodeId
      || row.clipId !== clipMap[entry.clipKey].clipId
    ) internalState('storyboardMapJson', entry.storyboardKey)
  }
  for (const entry of panelEntries) {
    const row = panelRowsById.get(entry.panelId)
    const parent = mapping.storyboards[entry.storyboardKey]
    if (
      !row
      || row.storyboardId !== parent.storyboardId
      || row.panelIndex !== entry.panelIndex
    ) internalState('storyboardMapJson', entry.panelKey)
  }
  for (const entry of frameEntries) {
    const row = frameRowsById.get(entry.frameId)
    const parent = mapping.panels[entry.panelKey]
    if (
      !row
      || row.panelId !== parent.panelId
      || row.frameIndex !== entry.frameIndex
    ) internalState('storyboardMapJson', entry.frameKey)
  }
}

function sameTopology(
  request: StoryboardsCommitRequest,
  mapping: StoryboardMap,
  clipMap: ClipMap,
): boolean {
  const panelsByStoryboard = new Map<string, StoryboardMap['panels'][string][]>()
  for (const panel of Object.values(mapping.panels)) {
    const list = panelsByStoryboard.get(panel.storyboardKey) ?? []
    list.push(panel)
    panelsByStoryboard.set(panel.storyboardKey, list)
  }
  const framesByPanel = new Map<string, StoryboardMap['frames'][string][]>()
  for (const frame of Object.values(mapping.frames)) {
    const list = framesByPanel.get(frame.panelKey) ?? []
    list.push(frame)
    framesByPanel.set(frame.panelKey, list)
  }
  const mappedStoryboards = episodeStoryboardEntries(
    mapping,
    request.data.episodeKey,
    clipMap,
  )
  return request.data.storyboards.length === mappedStoryboards.length
    && request.data.storyboards.every((storyboard, storyboardIndex) => {
      const mappedStoryboard = mappedStoryboards[storyboardIndex]
      if (
        !mappedStoryboard
        || mappedStoryboard.storyboardKey !== storyboard.storyboardKey
        || mappedStoryboard.clipKey !== storyboard.clipKey
      ) return false
      const mappedPanels = (
        panelsByStoryboard.get(storyboard.storyboardKey) ?? []
      )
        .sort((left, right) => left.panelIndex - right.panelIndex)
      return storyboard.panels.length === mappedPanels.length
        && storyboard.panels.every((panel, panelIndex) => {
          const mappedPanel = mappedPanels[panelIndex]
          if (
            !mappedPanel
            || mappedPanel.panelKey !== panel.panelKey
            || mappedPanel.panelIndex !== panelIndex
          ) return false
          const mappedFrames = (framesByPanel.get(panel.panelKey) ?? [])
            .sort((left, right) => left.frameIndex - right.frameIndex)
          return panel.frames.length === mappedFrames.length
            && panel.frames.every((frame, frameIndex) => (
              mappedFrames[frameIndex]?.frameKey === frame.frameKey
              && mappedFrames[frameIndex]?.frameIndex === frameIndex
            ))
        })
    })
}

function buildResponse(
  request: StoryboardsCommitRequest,
  runId: string,
  mapping?: StoryboardMap,
): CommitData {
  return {
    dryRun: request.dryRun,
    episodeKey: request.data.episodeKey,
    artifactHash: request.artifactHash,
    storyboards: request.data.storyboards.map((storyboard) => ({
      storyboardKey: storyboard.storyboardKey,
      storyboardId: mapping?.storyboards[storyboard.storyboardKey]
        ?.storyboardId
        ?? buildProjectedEntityId(
          runId,
          'Storyboard',
          storyboard.storyboardKey,
        ),
      clipKey: storyboard.clipKey,
      panels: storyboard.panels.map((panel) => ({
        panelKey: panel.panelKey,
        panelId: mapping?.panels[panel.panelKey]?.panelId
          ?? buildProjectedEntityId(runId, 'Panel', panel.panelKey),
        frames: panel.frames.map((frame) => ({
          frameKey: frame.frameKey,
          frameId: mapping?.frames[frame.frameKey]?.frameId
            ?? buildProjectedEntityId(runId, 'Frame', frame.frameKey),
        })),
      })),
    })),
  }
}

function buildWrites(
  request: StoryboardsCommitRequest,
  runId: string,
  episodeId: string,
  clipMap: ClipMap,
  display: AssetDisplay,
  createdAt: Date,
): {
  storyboards: StoryboardCreate[]
  panels: PanelCreate[]
  frames: FrameCreate[]
} {
  const storyboards: StoryboardCreate[] = []
  const panels: PanelCreate[] = []
  const frames: FrameCreate[] = []
  let panelSequence = 0
  let frameSequence = 0
  request.data.storyboards.forEach((storyboard) => {
    const storyboardId = buildProjectedEntityId(
      runId,
      'Storyboard',
      storyboard.storyboardKey,
    )
    storyboards.push({
      id: storyboardId,
      episodeId,
      clipId: clipMap[storyboard.clipKey].clipId,
      panelCount: storyboard.panels.length,
      storyboardTextJson: JSON.stringify(storyboard),
      photographyPlan: JSON.stringify(storyboard.photographyPlan),
      createdAt: new Date(
        createdAt.getTime() + clipMap[storyboard.clipKey].ordinal,
      ),
    })
    storyboard.panels.forEach((panel, panelIndex) => {
      panelSequence += 1
      const panelId = buildProjectedEntityId(runId, 'Panel', panel.panelKey)
      const photographyRule = storyboard.photographyPlan.rules.find(
        (rule) => rule.panelNumber === panel.panelNumber,
      )
      const actingDirection = storyboard.actingDirections.find(
        (direction) => direction.panelNumber === panel.panelNumber,
      )
      const characters = panel.characters.map((entry) => ({
        name: display.characterNames.get(entry.characterKey)
          ?? internalState('assetMapJson', entry.characterKey),
        appearance: display.appearanceReasons.get(entry.appearanceKey)
          ?? internalState('assetMapJson', entry.appearanceKey),
        slot: entry.slot,
      }))
      const props = panel.propKeys.map((key) => (
        display.propNames.get(key) ?? internalState('assetMapJson', key)
      ))
      const location = panel.locationKey === null
        ? null
        : display.locationNames.get(panel.locationKey)
          ?? internalState('assetMapJson', panel.locationKey)
      panels.push({
        id: panelId,
        storyboardId,
        panelIndex,
        panelNumber: panel.panelNumber,
        shotType: panel.shotType,
        cameraMove: panel.cameraMove,
        description: panel.description,
        location,
        characters: JSON.stringify(characters),
        props: JSON.stringify(props),
        srtSegment: panel.sourceText,
        duration: panel.durationSec,
        panelMode: panel.panelMode,
        groupDurationSec: panel.panelMode === 'group'
          ? panel.durationSec
          : null,
        groupVideoPrompt: panel.panelMode === 'group'
          ? panel.groupVideoPrompt
          : null,
        groupPlanJson: panel.panelMode === 'group'
          ? JSON.stringify({
              panelMode: panel.panelMode,
              durationSec: panel.durationSec,
              frames: panel.frames,
            })
          : null,
        imagePrompt: panel.frames.find(
          (frame) => frame.frameRole === 'hero',
        )?.imagePrompt ?? panel.frames[0].imagePrompt,
        videoPrompt: panel.videoPrompt,
        sceneType: panel.sceneType,
        photographyRules: photographyRule
          ? JSON.stringify(photographyRule)
          : null,
        actingNotes: actingDirection
          ? JSON.stringify(actingDirection)
          : null,
        usePreviousPanelTailAsReference:
          panel.usePreviousPanelTailAsReference,
        createdAt: new Date(createdAt.getTime() + 10_000 + panelSequence),
      })
      panel.frames.forEach((frame) => {
        frameSequence += 1
        const dependencyIndexes = frame.dependencyFrameKeys.map(
          (dependencyKey) => {
            const dependency = panel.frames.find(
              (entry) => entry.frameKey === dependencyKey,
            )
            return dependency?.frameIndex
              ?? internalState('storyboardMapJson', dependencyKey)
          },
        )
        const previousTail = frame.frameIndex === 0
          && frame.referencePolicy.orderedReferences.some(
            (reference) => reference.kind === 'previous-panel-tail',
          )
        frames.push({
          id: buildProjectedEntityId(runId, 'Frame', frame.frameKey),
          panelId,
          frameIndex: frame.frameIndex,
          frameTimeSec: frame.frameTimeSec,
          frameRole: frame.frameRole,
          dependencyFrameIds: serializePanelFrameDependencyPlan({
            frameIndexes: dependencyIndexes,
            previousTail,
          }),
          imagePrompt: frame.imagePrompt,
          videoPrompt: frame.videoPrompt,
          promptJson: JSON.stringify(frame),
          referencePolicy: JSON.stringify(frame.referencePolicy),
          createdAt: new Date(createdAt.getTime() + 20_000 + frameSequence),
        })
      })
    })
  })
  return { storyboards, panels, frames }
}

function mergeMapping(
  mapping: StoryboardMap,
  request: StoryboardsCommitRequest,
  writes: ReturnType<typeof buildWrites>,
): void {
  let storyboardIndex = 0
  let panelIndex = 0
  let frameIndex = 0
  request.data.storyboards.forEach((storyboard) => {
    const canonicalStoryboard = writes.storyboards[storyboardIndex]
    storyboardIndex += 1
    if (!canonicalStoryboard) internalState('storyboardMapJson')
    mapping.storyboards[storyboard.storyboardKey] = {
      storyboardKey: storyboard.storyboardKey,
      storyboardId: canonicalStoryboard.id,
      episodeKey: request.data.episodeKey,
      clipKey: storyboard.clipKey,
    }
    storyboard.panels.forEach((panel, localPanelIndex) => {
      const canonicalPanel = writes.panels[panelIndex]
      panelIndex += 1
      if (
        !canonicalPanel
        || canonicalPanel.storyboardId !== canonicalStoryboard.id
        || canonicalPanel.panelIndex !== localPanelIndex
      ) {
        internalState('storyboardMapJson')
      }
      mapping.panels[panel.panelKey] = {
        panelKey: panel.panelKey,
        panelId: canonicalPanel.id,
        storyboardKey: storyboard.storyboardKey,
        panelIndex: localPanelIndex,
      }
      panel.frames.forEach((frame, localFrameIndex) => {
        const canonicalFrame = writes.frames[frameIndex]
        frameIndex += 1
        if (
          !canonicalFrame
          || canonicalFrame.panelId !== canonicalPanel.id
          || canonicalFrame.frameIndex !== localFrameIndex
        ) {
          internalState('storyboardMapJson')
        }
        mapping.frames[frame.frameKey] = {
          frameKey: frame.frameKey,
          frameId: canonicalFrame.id,
          panelKey: panel.panelKey,
          frameIndex: localFrameIndex,
        }
      })
    })
  })
}

function toStoryboardUpdates(
  rows: StoryboardCreate[],
): StoryboardWrite[] {
  return rows.map(({
    id,
    panelCount,
    storyboardTextJson,
    photographyPlan,
  }) => ({ id, panelCount, storyboardTextJson, photographyPlan }))
}

function toPanelUpdates(rows: PanelCreate[]): PanelWrite[] {
  return rows.map((row) => ({
    id: row.id,
    panelIndex: row.panelIndex,
    panelNumber: row.panelNumber,
    shotType: row.shotType,
    cameraMove: row.cameraMove,
    description: row.description,
    location: row.location,
    characters: row.characters,
    props: row.props,
    srtSegment: row.srtSegment,
    duration: row.duration,
    panelMode: row.panelMode,
    groupDurationSec: row.groupDurationSec,
    groupVideoPrompt: row.groupVideoPrompt,
    groupPlanJson: row.groupPlanJson,
    imagePrompt: row.imagePrompt,
    videoPrompt: row.videoPrompt,
    sceneType: row.sceneType,
    photographyRules: row.photographyRules,
    actingNotes: row.actingNotes,
    usePreviousPanelTailAsReference:
      row.usePreviousPanelTailAsReference,
  }))
}

function toFrameUpdates(rows: FrameCreate[]): FrameWrite[] {
  return rows.map((row) => ({
    id: row.id,
    frameIndex: row.frameIndex,
    frameTimeSec: row.frameTimeSec,
    frameRole: row.frameRole,
    dependencyFrameIds: row.dependencyFrameIds,
    imagePrompt: row.imagePrompt,
    videoPrompt: row.videoPrompt,
    promptJson: row.promptJson,
    referencePolicy: row.referencePolicy,
  }))
}

async function commitInTransaction(
  tx: TransactionClient,
  input: CommitStoryboardArtifactInput & {
    request: StoryboardsCommitRequest
    preflightSnapshot: PreflightSnapshot
  },
): Promise<CommitData> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM agent_creation_runs
    WHERE id = ${input.runId}
    FOR UPDATE
  `)
  const run = await tx.agentCreationRun.findUnique({
    where: { id: input.runId },
    select: RUN_SELECT,
  })
  if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (run.userId !== input.userId || run.project.userId !== input.userId) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }
  if (
    run.episodeMapJson !== input.preflightSnapshot.episodeMapJson
    || run.assetMapJson !== input.preflightSnapshot.assetMapJson
    || run.clipMapJson !== input.preflightSnapshot.clipMapJson
  ) {
    throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
      message: 'Storyboard preflight inputs changed; retry the request',
      field: 'preflightSnapshot',
      retryable: true,
      details: { operation: 'storyboard_preflight_snapshot' },
    })
  }
  const status = parseRunStatus(run.status)
  if (
    run.ruleSetVersion !== input.request.ruleSetVersion
    || run.ruleSetHash !== input.request.ruleSetHash
  ) throw new AgentApiError('RULESET_MISMATCH')

  const episodes = parseEpisodeMap(run.episodeMapJson)
  if (hashArtifact(definitionEntries(episodes)) !== run.definitionHash) {
    internalState('definitionHash')
  }
  const episode = episodes[input.episodeKey]
  if (!episode || input.request.data.episodeKey !== input.episodeKey) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'data.episodeKey',
    })
  }
  if (
    !run.assetMapJson
    || !run.clipMapJson
    || !run.storyboardMapJson
    || !run.artifactHashesJson
  ) internalState('runMappings')
  const assets = parseAssetMap(run.assetMapJson)
  const clipMap = parseClipMap(run.clipMapJson)
  const mapping = parseStoryboardMap(run.storyboardMapJson)
  const hashes = parseArtifactHashes(run.artifactHashesJson)
  assertGlobalStage(
    status,
    run.currentStage,
    episodes,
    hashes,
    clipMap,
    mapping,
  )
  await validatePersistedClipMap(tx, run.id, episodes, clipMap)
  await validatePersistedStoryboardMap(
    tx,
    run.id,
    episodes,
    clipMap,
    mapping,
  )
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM novel_promotion_episodes
    WHERE id = ${episode.episodeId}
    FOR UPDATE
  `)
  const targetClipIds = Object.values(clipMap)
    .filter((entry) => entry.episodeKey === input.episodeKey)
    .map((entry) => entry.clipId)
  if (targetClipIds.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM novel_promotion_clips
      WHERE id IN (${Prisma.join(targetClipIds)})
      FOR UPDATE
    `)
  }
  const targetStoryboardIds = episodeStoryboardEntries(
    mapping,
    input.episodeKey,
    clipMap,
  ).map((entry) => entry.storyboardId)
  const targetStoryboardIdSet = new Set(targetStoryboardIds)
  const targetPanelIds = Object.values(mapping.panels)
    .filter((entry) => (
      targetStoryboardIdSet.has(
        mapping.storyboards[entry.storyboardKey].storyboardId,
      )
    ))
    .map((entry) => entry.panelId)
  const targetPanelIdSet = new Set(targetPanelIds)
  const targetFrameIds = Object.values(mapping.frames)
    .filter((entry) => (
      targetPanelIdSet.has(mapping.panels[entry.panelKey].panelId)
    ))
    .map((entry) => entry.frameId)
  await lockIdsInChunks(
    tx,
    'novel_promotion_storyboards',
    targetStoryboardIds,
  )
  await lockIdsInChunks(tx, 'novel_promotion_panels', targetPanelIds)
  await lockIdsInChunks(
    tx,
    'novel_promotion_panel_frames',
    targetFrameIds,
  )
  const episodeRow = await tx.novelPromotionEpisode.findUnique({
    where: { id: episode.episodeId },
    select: {
      id: true,
      episodeNumber: true,
      name: true,
      novelPromotionProject: { select: { projectId: true } },
    },
  })
  if (
    !episodeRow
    || episodeRow.episodeNumber !== episode.episodeNumber
    || episodeRow.name !== episode.name
    || episodeRow.novelPromotionProject.projectId !== run.projectId
  ) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'data.episodeKey',
    })
  }
  const display = await loadAssetDisplay(
    tx,
    run.id,
    run.projectId,
    assets,
  )
  const existingHash = hashes.storyboards[input.episodeKey]
  const mappedStoryboards = episodeStoryboardEntries(
    mapping,
    input.episodeKey,
    clipMap,
  )
  if (existingHash !== undefined) {
    if (!sameTopology(input.request, mapping, clipMap)) {
      if (existingHash === input.request.artifactHash) {
        internalState('storyboardMapJson', input.episodeKey)
      }
      throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
        field: 'data.storyboards',
      })
    }
    if (
      existingHash === input.request.artifactHash
      || input.request.dryRun
    ) {
      return buildResponse(input.request, run.id, mapping)
    }
  } else if (
    mappedStoryboards.length > 0
    || Object.values(mapping.panels).some((panel) => (
      mapping.storyboards[panel.storyboardKey]?.episodeKey === input.episodeKey
    ))
  ) {
    internalState('storyboardMapJson', input.episodeKey)
  }

  if (existingHash === undefined) {
    for (const storyboard of input.request.data.storyboards) {
      const existing = mapping.storyboards[storyboard.storyboardKey]
      if (existing) {
        throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
          field: 'data.storyboards',
          details: { targetKey: storyboard.storyboardKey },
        })
      }
      for (const panel of storyboard.panels) {
        if (mapping.panels[panel.panelKey]) {
          throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
            field: 'data.storyboards',
            details: { targetKey: panel.panelKey },
          })
        }
        for (const frame of panel.frames) {
          if (mapping.frames[frame.frameKey]) {
            throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
              field: 'data.storyboards',
              details: { targetKey: frame.frameKey },
            })
          }
        }
      }
    }
  }

  const writes = buildWrites(
    input.request,
    run.id,
    episode.episodeId,
    clipMap,
    display,
    run.createdAt,
  )
  if (existingHash === undefined) {
    const storyboardCollision = await hasCollisionInChunks(
      writes.storyboards.map((row) => row.id),
      (ids) => tx.novelPromotionStoryboard.findFirst({
        where: { id: { in: ids } },
        select: { id: true },
      }),
    )
    const panelCollision = await hasCollisionInChunks(
      writes.panels.map((row) => row.id),
      (ids) => tx.novelPromotionPanel.findFirst({
        where: { id: { in: ids } },
        select: { id: true },
      }),
    )
    const frameCollision = await hasCollisionInChunks(
      writes.frames.map((row) => row.id),
      (ids) => tx.novelPromotionPanelFrame.findFirst({
        where: { id: { in: ids } },
        select: { id: true },
      }),
    )
    if (storyboardCollision || panelCollision || frameCollision) {
      throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
        field: 'data.storyboards',
      })
    }
  }
  if (input.request.dryRun) {
    return buildResponse(input.request, run.id, existingHash ? mapping : undefined)
  }

  if (existingHash === undefined) {
    await createStoryboardRows(tx, writes.storyboards)
    await createPanelRows(tx, writes.panels)
    await createFrameRows(tx, writes.frames)
    mergeMapping(mapping, input.request, writes)
  } else {
    await updateStoryboardRows(tx, toStoryboardUpdates(writes.storyboards))
    await updatePanelRows(tx, toPanelUpdates(writes.panels))
    await updateFrameRows(tx, toFrameUpdates(writes.frames))
  }
  await updateClipShotCounts(
    tx,
    input.request.data.storyboards.map((storyboard) => ({
      id: clipMap[storyboard.clipKey].clipId,
      shotCount: storyboard.panels.length,
    })),
  )

  episodes[input.episodeKey] = {
    ...episode,
    status: 'storyboards_committed',
  }
  hashes.storyboards[input.episodeKey] = input.request.artifactHash
  const committed = Object.values(episodes).filter(
    (entry) => entry.status === 'storyboards_committed',
  ).length
  const allCommitted = committed === Object.keys(episodes).length
  const nextStatus = allCommitted && status === 'screenplay_committed'
    ? transitionRunStatus(
        status,
        run.currentStage,
        'storyboards_committed',
      )
    : status
  await tx.agentCreationRun.update({
    where: { id: run.id },
    data: {
      episodeMapJson: serializeEpisodeMap(episodes),
      storyboardMapJson: serializeStoryboardMap(mapping),
      artifactHashesJson: serializeArtifactHashes(hashes),
      status: nextStatus,
      currentStage: allCommitted
        ? 'storyboards_committed'
        : `storyboard_committing:${committed}/${Object.keys(episodes).length}`,
    },
  })
  return buildResponse(input.request, run.id, mapping)
}

export type CommitStoryboardArtifactInput = {
  userId: string
  runId: string
  episodeKey: string
  request: StoryboardsCommitRequest
}

async function preflightStoryboardArtifact(
  input: CommitStoryboardArtifactInput & {
    request: StoryboardsCommitRequest
  },
): Promise<PreflightSnapshot> {
  if (input.request.data.episodeKey !== input.episodeKey) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'data.episodeKey',
    })
  }
  const run = await prisma.agentCreationRun.findUnique({
    where: { id: input.runId },
    select: PREFLIGHT_RUN_SELECT,
  })
  if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (run.userId !== input.userId || run.project.userId !== input.userId) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }
  if (!run.assetMapJson || !run.clipMapJson) {
    internalState('runMappings')
  }
  const episodes = parseEpisodeMap(run.episodeMapJson)
  if (!episodes[input.episodeKey]) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'data.episodeKey',
    })
  }
  const assets = parseAssetMap(run.assetMapJson)
  const clipMap = parseClipMap(run.clipMapJson)
  validateStoryboardArtifact(
    input.request.data,
    assets,
    clipMap,
    input.episodeKey,
  )
  return {
    episodeMapJson: run.episodeMapJson,
    assetMapJson: run.assetMapJson,
    clipMapJson: run.clipMapJson,
  }
}

export async function commitStoryboardArtifact(
  input: CommitStoryboardArtifactInput,
): Promise<CommitData> {
  const parsed = StoryboardsCommitRequestSchema.safeParse(input.request)
  if (!parsed.success) {
    throw new AgentApiError('CONTRACT_INVALID', {
      details: {
        field: parsed.error.issues[0]?.path.join('.') ?? 'request',
      },
    })
  }
  if (hashArtifact(parsed.data.data) !== parsed.data.artifactHash) {
    throw new AgentApiError('ARTIFACT_HASH_MISMATCH', {
      field: 'artifactHash',
    })
  }
  try {
    const preflightSnapshot = await preflightStoryboardArtifact({
      ...input,
      request: parsed.data,
    })
    return await prisma.$transaction(
      (tx) => commitInTransaction(tx, {
        ...input,
        request: parsed.data,
        preflightSnapshot,
      }),
      STORYBOARD_TRANSACTION_OPTIONS,
    )
  } catch (error) {
    if (isAgentApiError(error)) throw error
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        message: error.code === 'P2028' || error.code === 'P2034'
          ? 'Storyboard transaction timed out or conflicted'
          : 'Storyboard transaction failed',
        details: {
          operation: 'storyboard_commit',
          prismaCode: error.code,
        },
      })
    }
    throw error
  }
}
