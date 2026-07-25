import { Prisma } from '@prisma/client'

import { hashArtifact } from '@/lib/agent-api/canonical-json'
import {
  ScreenplayCommitRequestSchema,
  type ScreenplayCommitRequest,
  type ScreenplayCommitResponse,
} from '@/lib/agent-api/contracts/screenplay'
import {
  RunStatusSchema,
  type RunStatus,
} from '@/lib/agent-api/contracts/common'
import { buildProjectedEntityId } from '@/lib/agent-api/entity-id'
import { AgentApiError, isAgentApiError } from '@/lib/agent-api/errors'
import {
  assertRunAcceptsArtifact,
  parseArtifactHashes,
  parseAssetMap,
  parseClipMap,
  parseEpisodeMap,
  serializeArtifactHashes,
  serializeClipMap,
  serializeEpisodeMap,
  transitionRunStatus,
  type AssetMap,
  type ClipMap,
  type EpisodeMap,
} from '@/lib/agent-api/run-state'
import {
  validateScreenplayAnchors,
  validateScreenplayReferences,
} from '@/lib/agent-api/screenplay-validation'
import { prisma } from '@/lib/prisma'

const SCREENPLAY_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const

const SCREENPLAY_RUN_SELECT = {
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
  artifactHashesJson: true,
  createdAt: true,
  project: {
    select: { userId: true },
  },
} satisfies Prisma.AgentCreationRunSelect

type ScreenplayCommitData = ScreenplayCommitResponse['data']
type TransactionClient = Prisma.TransactionClient

type AssetNames = {
  characters: Map<string, string>
  locations: Map<string, string>
  props: Map<string, string>
}

function parseMappedImageUrls(
  value: string | null,
  targetKey: string,
): string[] {
  if (value === null) internalState('assetMapJson', targetKey)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    internalState('assetMapJson', targetKey)
  }
  if (
    !Array.isArray(parsed)
    || !parsed.every((entry) => typeof entry === 'string')
  ) {
    internalState('assetMapJson', targetKey)
  }
  return parsed
}

function parseRunStatus(value: string): RunStatus {
  const result = RunStatusSchema.safeParse(value)
  if (!result.success) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'status' },
    })
  }
  return result.data
}

function internalState(field: string, targetKey?: string): never {
  throw new AgentApiError('AGENT_INTERNAL_ERROR', {
    details: {
      field,
      ...(targetKey ? { targetKey } : {}),
    },
  })
}

function definitionEntries(episodes: EpisodeMap) {
  return Object.values(episodes)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => ({
      episodeKey: entry.episodeKey,
      ordinal: entry.ordinal,
      sourceHash: entry.sourceHash,
      name: entry.name,
      ...(entry.description !== undefined
        ? { description: entry.description }
        : {}),
    }))
}

function assertScreenplayStage(
  status: RunStatus,
  currentStage: string,
  episodes: EpisodeMap,
  artifactHashes: ReturnType<typeof parseArtifactHashes>,
): void {
  if (status !== 'assets_committed' && status !== 'screenplay_committed') {
    throw new AgentApiError('RUN_INCOMPLETE', {
      message: 'Run is not ready for screenplay artifacts',
    })
  }
  if (!artifactHashes.assets) internalState('artifactHashesJson')

  const episodeKeys = new Set(Object.keys(episodes))
  if (
    Object.keys(artifactHashes.stories).some((key) => !episodeKeys.has(key))
    || Object.keys(artifactHashes.screenplays).some(
      (key) => !episodeKeys.has(key),
    )
  ) {
    internalState('artifactHashesJson')
  }
  for (const episode of Object.values(episodes)) {
    if (!artifactHashes.stories[episode.episodeKey]) {
      internalState('artifactHashesJson', episode.episodeKey)
    }
    const screenplayHash = artifactHashes.screenplays[episode.episodeKey]
    if (episode.status === 'screenplay_committed') {
      if (!screenplayHash) {
        internalState('artifactHashesJson', episode.episodeKey)
      }
    } else if (episode.status === 'story_committed') {
      if (screenplayHash) {
        internalState('episodeMapJson', episode.episodeKey)
      }
    } else {
      internalState('episodeMapJson', episode.episodeKey)
    }
  }

  const committedCount = Object.values(episodes).filter(
    (episode) => episode.status === 'screenplay_committed',
  ).length
  const episodeCount = Object.keys(episodes).length
  if (status === 'assets_committed') {
    if (committedCount >= episodeCount) internalState('episodeMapJson')
    const expectedStage = committedCount === 0
      ? 'assets_committed'
      : `screenplay_committing:${committedCount}/${episodeCount}`
    if (currentStage !== expectedStage) internalState('currentStage')
  } else {
    if (committedCount !== episodeCount) internalState('episodeMapJson')
    if (currentStage !== 'screenplay_committed') internalState('currentStage')
  }
  if (Object.keys(artifactHashes.storyboards).length > 0) {
    internalState('artifactHashesJson')
  }
}

async function loadAndValidateAssetNames(
  tx: TransactionClient,
  projectId: string,
  assets: AssetMap,
): Promise<AssetNames> {
  const novelProject = await tx.novelPromotionProject.findUnique({
    where: { projectId },
    select: { id: true },
  })
  if (!novelProject) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'projectId',
    })
  }

  const characterEntries = Object.entries(assets.characters)
  const characterIds = characterEntries.map(([, entry]) => entry.characterId)
  const characterRows = characterIds.length === 0
    ? []
    : await tx.novelPromotionCharacter.findMany({
        where: { id: { in: characterIds } },
        select: {
          id: true,
          name: true,
          novelPromotionProjectId: true,
        },
      })
  const characterRowsById = new Map(characterRows.map((row) => [row.id, row]))
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
  const appearanceIds = appearanceEntries.map(
    (entry) => entry.appearance.appearanceId,
  )
  const appearanceRows = appearanceIds.length === 0
    ? []
    : await tx.characterAppearance.findMany({
        where: { id: { in: appearanceIds } },
        select: {
          id: true,
          characterId: true,
          appearanceIndex: true,
          imageUrls: true,
        },
      })
  const appearanceRowsById = new Map(appearanceRows.map((row) => [row.id, row]))

  for (const [characterKey, character] of characterEntries) {
    const row = characterRowsById.get(character.characterId)
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
    const variantSlotKeys = Object.keys(entry.appearance.variantSlots)
    if (
      variantSlotKeys.length !== 1
      || variantSlotKeys[0] !== '0'
    ) {
      internalState('assetMapJson', entry.appearanceKey)
    }
    const row = appearanceRowsById.get(entry.appearance.appearanceId)
    const imageUrls = row
      ? parseMappedImageUrls(row.imageUrls, entry.appearanceKey)
      : []
    if (
      !row
      || row.characterId !== entry.characterId
      || row.appearanceIndex !== entry.appearance.appearanceIndex
      || Object.values(entry.appearance.variantSlots).some(
        (slot) => (
          slot.entityId !== entry.appearance.appearanceId
          || !Number.isInteger(slot.index)
          || slot.index < 0
          || slot.index >= imageUrls.length
        ),
      )
    ) {
      internalState('assetMapJson', entry.appearanceKey)
    }
  }

  const imageAssetEntries = [
    ...Object.entries(assets.locations).map(([key, entry]) => ({
      key,
      entry,
      kind: 'location' as const,
    })),
    ...Object.entries(assets.props).map(([key, entry]) => ({
      key,
      entry,
      kind: 'prop' as const,
    })),
  ]
  for (const { key, entry, kind } of imageAssetEntries) {
    const slotKeys = Object.keys(entry.imageSlots)
      .sort((left, right) => Number(left) - Number(right))
    if (
      slotKeys.length === 0
      || slotKeys.some((slotKey, index) => slotKey !== String(index))
      || (kind === 'prop' && slotKeys.length !== 1)
    ) {
      internalState('assetMapJson', key)
    }
  }
  const imageAssetIds = imageAssetEntries.map(({ entry }) => entry.entityId)
  const imageAssetRows = imageAssetIds.length === 0
    ? []
    : await tx.novelPromotionLocation.findMany({
        where: { id: { in: imageAssetIds } },
        select: {
          id: true,
          name: true,
          assetKind: true,
          novelPromotionProjectId: true,
        },
      })
  const imageAssetRowsById = new Map(
    imageAssetRows.map((row) => [row.id, row]),
  )
  const imageSlotEntries = imageAssetEntries.flatMap(
    ({ key, entry, kind }) => Object.values(entry.imageSlots).map((slot) => ({
      key,
      kind,
      entityId: entry.entityId,
      slot,
    })),
  )
  const imageIds = imageSlotEntries.map(({ slot }) => slot.entityId)
  const imageRows = imageIds.length === 0
    ? []
    : await tx.locationImage.findMany({
        where: { id: { in: imageIds } },
        select: {
          id: true,
          locationId: true,
          imageIndex: true,
        },
      })
  const imageRowsById = new Map(imageRows.map((row) => [row.id, row]))
  const locationNames = new Map<string, string>()
  const propNames = new Map<string, string>()

  for (const { key, entry, kind } of imageAssetEntries) {
    const row = imageAssetRowsById.get(entry.entityId)
    if (
      !row
      || row.novelPromotionProjectId !== novelProject.id
      || row.assetKind !== kind
      || !row.name.trim()
    ) {
      internalState('assetMapJson', key)
    }
    if (kind === 'location') locationNames.set(key, row.name)
    else propNames.set(key, row.name)
  }
  for (const { key, entityId, slot } of imageSlotEntries) {
    const row = imageRowsById.get(slot.entityId)
    if (
      !row
      || row.locationId !== entityId
      || row.imageIndex !== slot.index
    ) {
      internalState('assetMapJson', key)
    }
  }

  return {
    characters: characterNames,
    locations: locationNames,
    props: propNames,
  }
}

async function validatePersistedClipMap(
  tx: TransactionClient,
  runId: string,
  episodes: EpisodeMap,
  mapping: ClipMap,
): Promise<void> {
  const entries = Object.values(mapping)
  for (const entry of entries) {
    const episode = episodes[entry.episodeKey]
    if (
      !episode
      || entry.clipId !== buildProjectedEntityId(
        runId,
        'Clip',
        entry.clipKey,
      )
    ) {
      internalState('clipMapJson', entry.clipKey)
    }
  }
  if (entries.length === 0) return

  const rows = await tx.novelPromotionClip.findMany({
    where: { id: { in: entries.map((entry) => entry.clipId) } },
    select: { id: true, episodeId: true },
  })
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  for (const entry of entries) {
    const row = rowsById.get(entry.clipId)
    if (!row || row.episodeId !== episodes[entry.episodeKey].episodeId) {
      internalState('clipMapJson', entry.clipKey)
    }
  }
}

function currentEpisodeMapping(
  mapping: ClipMap,
  episodeKey: string,
) {
  return Object.values(mapping)
    .filter((entry) => entry.episodeKey === episodeKey)
    .sort((left, right) => left.ordinal - right.ordinal)
}

function assertGlobalClipState(
  episodes: EpisodeMap,
  artifactHashes: ReturnType<typeof parseArtifactHashes>,
  mapping: ClipMap,
): void {
  const mappedByEpisode = new Map<string, Array<ClipMap[string]>>()
  for (const entry of Object.values(mapping)) {
    const episode = episodes[entry.episodeKey]
    if (
      !episode
      || episode.status !== 'screenplay_committed'
      || !artifactHashes.screenplays[entry.episodeKey]
    ) {
      internalState('clipMapJson', entry.clipKey)
    }
    const list = mappedByEpisode.get(entry.episodeKey) ?? []
    list.push(entry)
    mappedByEpisode.set(entry.episodeKey, list)
  }

  for (const episode of Object.values(episodes)) {
    const mapped = (mappedByEpisode.get(episode.episodeKey) ?? [])
      .sort((left, right) => left.ordinal - right.ordinal)
    const screenplayHash = artifactHashes.screenplays[episode.episodeKey]
    if (episode.status === 'story_committed') {
      if (mapped.length > 0) {
        internalState('clipMapJson', episode.episodeKey)
      }
      continue
    }
    if (episode.status !== 'screenplay_committed' || !screenplayHash) {
      internalState('episodeMapJson', episode.episodeKey)
    }
    const emptyArtifactHash = hashArtifact({
      episodeKey: episode.episodeKey,
      clips: [],
    })
    if (
      (mapped.length === 0 && screenplayHash !== emptyArtifactHash)
      || (mapped.length > 0 && screenplayHash === emptyArtifactHash)
      || mapped.some((entry, index) => (
        entry.episodeKey !== episode.episodeKey
        || entry.clipKey !== mapping[entry.clipKey]?.clipKey
        || entry.ordinal !== index + 1
      ))
    ) {
      internalState('clipMapJson', episode.episodeKey)
    }
  }
}

function hasSameTopology(
  request: ScreenplayCommitRequest,
  mapped: ReturnType<typeof currentEpisodeMapping>,
): boolean {
  return request.data.clips.length === mapped.length
    && request.data.clips.every((clip, index) => (
      clip.clipKey === mapped[index]?.clipKey
      && clip.ordinal === mapped[index]?.ordinal
    ))
}

function response(
  request: ScreenplayCommitRequest,
  runId: string,
  mapped?: ReturnType<typeof currentEpisodeMapping>,
): ScreenplayCommitData {
  return {
    dryRun: request.dryRun,
    episodeKey: request.data.episodeKey,
    artifactHash: request.artifactHash,
    clips: request.data.clips.map((clip, index) => ({
      clipKey: clip.clipKey,
      clipId: mapped?.[index]?.clipId ?? buildProjectedEntityId(
        runId,
        'Clip',
        clip.clipKey,
      ),
      ordinal: clip.ordinal,
    })),
  }
}

function clipData(
  clip: ScreenplayCommitRequest['data']['clips'][number],
  episodeId: string,
  names: AssetNames,
) {
  const characterNames = clip.characterKeys.map((key) => {
    const name = names.characters.get(key)
    if (!name) internalState('assetMapJson', key)
    return name
  })
  const propNames = clip.propKeys.map((key) => {
    const name = names.props.get(key)
    if (!name) internalState('assetMapJson', key)
    return name
  })
  const location = clip.locationKey === null
    ? null
    : names.locations.get(clip.locationKey)
  if (clip.locationKey !== null && !location) {
    internalState('assetMapJson', clip.locationKey)
  }

  return {
    episodeId,
    summary: clip.summary,
    location,
    content: clip.content,
    characters: JSON.stringify(characterNames),
    props: JSON.stringify(propNames),
    startText: clip.startText,
    endText: clip.endText,
    screenplay: JSON.stringify(clip.screenplay),
  }
}

async function commitScreenplayInTransaction(
  tx: TransactionClient,
  input: CommitScreenplayArtifactInput & {
    request: ScreenplayCommitRequest
  },
): Promise<ScreenplayCommitData> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM agent_creation_runs
    WHERE id = ${input.runId}
    FOR UPDATE
  `)
  const run = await tx.agentCreationRun.findUnique({
    where: { id: input.runId },
    select: SCREENPLAY_RUN_SELECT,
  })
  if (!run) throw new AgentApiError('AGENT_RESOURCE_NOT_FOUND')
  if (
    run.userId !== input.userId
    || run.project.userId !== input.userId
  ) {
    throw new AgentApiError('AGENT_FORBIDDEN')
  }
  const runStatus = parseRunStatus(run.status)
  assertRunAcceptsArtifact(runStatus)
  if (
    run.ruleSetVersion !== input.request.ruleSetVersion
    || run.ruleSetHash !== input.request.ruleSetHash
  ) {
    throw new AgentApiError('RULESET_MISMATCH')
  }
  if (hashArtifact(input.request.data) !== input.request.artifactHash) {
    throw new AgentApiError('ARTIFACT_HASH_MISMATCH', {
      field: 'artifactHash',
    })
  }

  const episodes = parseEpisodeMap(run.episodeMapJson)
  if (hashArtifact(definitionEntries(episodes)) !== run.definitionHash) {
    internalState('definitionHash')
  }
  const episode = episodes[input.episodeKey]
  if (
    !episode
    || input.request.data.episodeKey !== input.episodeKey
  ) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'data.episodeKey',
    })
  }
  const artifactHashes = parseArtifactHashes(run.artifactHashesJson ?? '')
  assertScreenplayStage(
    runStatus,
    run.currentStage,
    episodes,
    artifactHashes,
  )
  if (!run.assetMapJson) internalState('assetMapJson')
  if (!run.clipMapJson) internalState('clipMapJson')
  const assets = parseAssetMap(run.assetMapJson)
  const clipMapping = parseClipMap(run.clipMapJson)
  assertGlobalClipState(episodes, artifactHashes, clipMapping)

  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM novel_promotion_episodes
    WHERE id = ${episode.episodeId}
    FOR UPDATE
  `)
  const episodeRow = await tx.novelPromotionEpisode.findUnique({
    where: { id: episode.episodeId },
    select: {
      id: true,
      episodeNumber: true,
      name: true,
      novelText: true,
      novelPromotionProject: {
        select: { projectId: true },
      },
    },
  })
  if (
    !episodeRow
    || episodeRow.episodeNumber !== episode.episodeNumber
    || episodeRow.name !== episode.name
    || episodeRow.novelPromotionProject.projectId !== run.projectId
    || episodeRow.novelText === null
  ) {
    throw new AgentApiError('REFERENCE_INVALID', {
      field: 'data.episodeKey',
    })
  }

  validateScreenplayAnchors(
    episodeRow.novelText,
    input.request.data.clips,
  )
  validateScreenplayReferences(input.request.data, assets)
  const names = await loadAndValidateAssetNames(
    tx,
    run.projectId,
    assets,
  )
  await validatePersistedClipMap(
    tx,
    run.id,
    episodes,
    clipMapping,
  )

  const mapped = currentEpisodeMapping(clipMapping, input.episodeKey)
  const existingHash = artifactHashes.screenplays[input.episodeKey]
  if (existingHash !== undefined) {
    if (!hasSameTopology(input.request, mapped)) {
      if (existingHash === input.request.artifactHash) {
        internalState('clipMapJson', input.episodeKey)
      }
      throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
        field: 'data.clips',
      })
    }
    if (
      existingHash === input.request.artifactHash
      || input.request.dryRun
    ) {
      return response(input.request, run.id, mapped)
    }
  } else if (mapped.length > 0) {
    internalState('clipMapJson', input.episodeKey)
  }

  const keysMappedToOtherEpisodes = input.request.data.clips.find(
    (clip) => (
      clipMapping[clip.clipKey]
      && clipMapping[clip.clipKey].episodeKey !== input.episodeKey
    ),
  )
  if (keysMappedToOtherEpisodes) {
    throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
      field: 'data.clips',
      details: { targetKey: keysMappedToOtherEpisodes.clipKey },
    })
  }

  if (existingHash === undefined) {
    const projectedIds = input.request.data.clips.map((clip) => (
      buildProjectedEntityId(run.id, 'Clip', clip.clipKey)
    ))
    if (projectedIds.length > 0) {
      const collision = await tx.novelPromotionClip.findFirst({
        where: { id: { in: projectedIds } },
        select: { id: true },
      })
      if (collision) {
        throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
          field: 'data.clips',
        })
      }
    }
  }

  if (input.request.dryRun) return response(input.request, run.id, mapped)

  if (existingHash === undefined) {
    for (const clip of input.request.data.clips) {
      const clipId = buildProjectedEntityId(run.id, 'Clip', clip.clipKey)
      await tx.novelPromotionClip.create({
        data: {
          id: clipId,
          ...clipData(clip, episode.episodeId, names),
          createdAt: new Date(run.createdAt.getTime() + clip.ordinal),
        },
      })
      clipMapping[clip.clipKey] = {
        clipKey: clip.clipKey,
        clipId,
        episodeKey: input.episodeKey,
        ordinal: clip.ordinal,
      }
    }
  } else {
    for (const clip of input.request.data.clips) {
      const mappedClip = clipMapping[clip.clipKey]
      if (
        !mappedClip
        || mappedClip.episodeKey !== input.episodeKey
        || mappedClip.ordinal !== clip.ordinal
      ) {
        internalState('clipMapJson', clip.clipKey)
      }
      await tx.novelPromotionClip.update({
        where: { id: mappedClip.clipId },
        data: clipData(clip, episode.episodeId, names),
      })
    }
  }

  episodes[input.episodeKey] = {
    ...episode,
    status: 'screenplay_committed',
  }
  artifactHashes.screenplays[input.episodeKey] = input.request.artifactHash
  const committedCount = Object.values(episodes).filter(
    (entry) => entry.status === 'screenplay_committed',
  ).length
  const allCommitted = committedCount === Object.keys(episodes).length
  const nextStatus = allCommitted && runStatus === 'assets_committed'
    ? transitionRunStatus(
        runStatus,
        run.currentStage,
        'screenplay_committed',
      )
    : runStatus

  await tx.agentCreationRun.update({
    where: { id: run.id },
    data: {
      episodeMapJson: serializeEpisodeMap(episodes),
      clipMapJson: serializeClipMap(clipMapping),
      artifactHashesJson: serializeArtifactHashes(artifactHashes),
      status: nextStatus,
      currentStage: allCommitted
        ? 'screenplay_committed'
        : `screenplay_committing:${committedCount}/${Object.keys(episodes).length}`,
    },
  })
  return response(
    input.request,
    run.id,
    currentEpisodeMapping(clipMapping, input.episodeKey),
  )
}

export type CommitScreenplayArtifactInput = {
  userId: string
  runId: string
  episodeKey: string
  request: ScreenplayCommitRequest
}

export async function commitScreenplayArtifact(
  input: CommitScreenplayArtifactInput,
): Promise<ScreenplayCommitData> {
  const parsed = ScreenplayCommitRequestSchema.safeParse(input.request)
  if (!parsed.success) {
    throw new AgentApiError('CONTRACT_INVALID', {
      details: {
        field: parsed.error.issues[0]?.path.join('.') ?? 'request',
      },
    })
  }
  try {
    return await prisma.$transaction(
      (tx) => commitScreenplayInTransaction(tx, {
        ...input,
        request: parsed.data,
      }),
      SCREENPLAY_TRANSACTION_OPTIONS,
    )
  } catch (error) {
    if (isAgentApiError(error)) throw error
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        message: error.code === 'P2028' || error.code === 'P2034'
          ? 'Screenplay transaction timed out or conflicted'
          : 'Screenplay transaction failed',
        details: {
          operation: 'screenplay_commit',
          prismaCode: error.code,
        },
      })
    }
    throw error
  }
}
