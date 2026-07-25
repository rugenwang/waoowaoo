import { Prisma } from '@prisma/client'

import {
  appendMissingStoredAliases,
  assertUniqueRequestedAssetIdentities,
  findCharacterIdentity,
  findImageAssetIdentity,
  normalizeAssetIdentityText,
} from '@/lib/agent-api/asset-identity'
import { hashArtifact } from '@/lib/agent-api/canonical-json'
import {
  AssetsCommitRequestSchema,
  type AssetsArtifact,
  type AssetsCommitRequest,
  type AssetsCommitResponse,
} from '@/lib/agent-api/contracts/assets'
import {
  RunStatusSchema,
  type RunStatus,
} from '@/lib/agent-api/contracts/common'
import {
  buildAppearanceCandidateOwnerId,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'
import { AgentApiError, isAgentApiError } from '@/lib/agent-api/errors'
import {
  assertRunAcceptsArtifact,
  parseArtifactHashes,
  parseAssetMap,
  parseEpisodeMap,
  serializeArtifactHashes,
  serializeAssetMap,
  transitionRunStatus,
  type AssetMap,
} from '@/lib/agent-api/run-state'
import { stringifyLocationAvailableSlots } from '@/lib/location-available-slots'
import { prisma } from '@/lib/prisma'

const ASSET_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 30_000,
} as const

const ASSET_RUN_SELECT = {
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
  artifactHashesJson: true,
  project: {
    select: { userId: true },
  },
} satisfies Prisma.AgentCreationRunSelect

type AssetsCommitData = AssetsCommitResponse['data']
type AssetWarning = AssetsCommitData['warnings'][number]
type CharacterInput = AssetsArtifact['characters'][number]
type LocationInput = AssetsArtifact['locations'][number]
type PropInput = AssetsArtifact['props'][number]
type ImageAssetInput = LocationInput | PropInput
type ImageAssetKind = 'location' | 'prop'

type ExistingCharacter = {
  id: string
  name: string
  aliases: string | null
  profileData: string | null
  profileConfirmed: boolean
  introduction: string | null
}

type ExistingAppearance = {
  id: string
  characterId: string
  appearanceIndex: number
  changeReason: string
  description: string | null
  descriptions: string | null
  imageUrl: string | null
  imageUrls: string | null
  selectedIndex: number | null
}

type ExistingImageAsset = {
  id: string
  name: string
  summary: string | null
  assetKind: string
  selectedImageId: string | null
}

type ExistingLocationImage = {
  id: string
  imageIndex: number
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

function emptyAssetMap(): AssetMap {
  return {
    characters: {},
    locations: {},
    props: {},
  }
}

function addWarning(
  warnings: AssetWarning[],
  targetKey: string,
  field: string,
): void {
  if (warnings.length >= 2_000) return
  if (warnings.some(
    (warning) => warning.targetKey === targetKey && warning.field === field,
  )) return
  warnings.push({
    code: 'EXISTING_ASSET_PRESERVED',
    targetKey,
    field,
  })
}

function responseFromMap(
  request: AssetsCommitRequest,
  mapping: AssetMap,
  warnings: AssetWarning[],
): AssetsCommitData {
  const characters = request.data.characters.map((character) => {
    const mapped = mapping.characters[character.characterKey]
    if (!mapped) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        details: {
          field: 'assetMapJson',
          targetKey: character.characterKey,
        },
      })
    }
    return {
      characterKey: character.characterKey,
      characterId: mapped.characterId,
      reused: mapped.reused,
      appearances: character.appearances.map((appearance) => {
        const mappedAppearance = mapped.appearances[appearance.appearanceKey]
        if (!mappedAppearance) {
          throw new AgentApiError('AGENT_INTERNAL_ERROR', {
            details: {
              field: 'assetMapJson',
              targetKey: appearance.appearanceKey,
            },
          })
        }
        return {
          appearanceKey: appearance.appearanceKey,
          appearanceId: mappedAppearance.appearanceId,
          appearanceIndex: mappedAppearance.appearanceIndex,
          reused: mappedAppearance.reused,
        }
      }),
    }
  })

  const mappedImageSlotIds = (
    mapped: AssetMap['locations'][string] | undefined,
  ) => {
    if (!mapped) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        details: { field: 'assetMapJson' },
      })
    }
    return Object.entries(mapped.imageSlots)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, slot]) => slot.entityId)
  }

  return {
    dryRun: request.dryRun,
    artifactHash: request.artifactHash,
    characters,
    locations: request.data.locations.map((location) => {
      const mapped = mapping.locations[location.locationKey]
      return {
        locationKey: location.locationKey,
        locationId: mapped?.entityId ?? '',
        reused: mapped?.reused ?? false,
        imageSlotIds: mappedImageSlotIds(mapped),
      }
    }),
    props: request.data.props.map((prop) => {
      const mapped = mapping.props[prop.propKey]
      return {
        propKey: prop.propKey,
        propId: mapped?.entityId ?? '',
        reused: mapped?.reused ?? false,
        imageSlotIds: mappedImageSlotIds(mapped),
      }
    }),
    warnings,
  }
}

function profileData(character: CharacterInput): string {
  return JSON.stringify({
    gender: character.gender,
    ...(character.ageRange !== undefined
      ? { ageRange: character.ageRange }
      : {}),
    roleLevel: character.roleLevel,
    ...(character.archetype !== undefined
      ? { archetype: character.archetype }
      : {}),
    personalityTags: character.personalityTags,
    ...(character.eraPeriod !== undefined
      ? { eraPeriod: character.eraPeriod }
      : {}),
    ...(character.socialClass !== undefined
      ? { socialClass: character.socialClass }
      : {}),
    ...(character.occupation !== undefined
      ? { occupation: character.occupation }
      : {}),
    ...(character.costumeTier !== undefined
      ? { costumeTier: character.costumeTier }
      : {}),
    suggestedColors: character.suggestedColors,
    ...(character.primaryIdentifier !== undefined
      ? { primaryIdentifier: character.primaryIdentifier }
      : {}),
    visualKeywords: character.visualKeywords,
  })
}

function parseImageUrls(raw: string | null, targetKey: string): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'imageUrls', targetKey },
    })
  }
  if (
    !Array.isArray(parsed)
    || !parsed.every((entry) => typeof entry === 'string')
  ) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'imageUrls', targetKey },
    })
  }
  return parsed
}

function buildDryRunMapping(
  runId: string,
  request: AssetsCommitRequest,
  characters: ExistingCharacter[],
  appearancesByCharacter: Map<string, ExistingAppearance[]>,
  imageAssets: ExistingImageAsset[],
  imagesByAsset: Map<string, ExistingLocationImage[]>,
  warnings: AssetWarning[],
): AssetMap {
  const mapping = emptyAssetMap()

  for (const character of request.data.characters) {
    const identity = findCharacterIdentity(
      character,
      characters,
      character.gender,
    )
    for (const warning of identity.warnings) {
      addWarning(warnings, character.characterKey, warning.field)
    }
    const existing = identity.match
    if (existing) {
      addWarning(warnings, character.characterKey, 'name')
      addWarning(warnings, character.characterKey, 'introduction')
      addWarning(warnings, character.characterKey, 'profileData')
    }
    const characterId = existing?.id ?? buildProjectedEntityId(
      runId,
      'Character',
      character.characterKey,
    )
    const storedAppearances = existing
      ? (appearancesByCharacter.get(existing.id) ?? [])
      : []
    let nextIndex = existing
      ? Math.max(-1, ...storedAppearances.map((entry) => entry.appearanceIndex)) + 1
      : 0
    const mappedAppearances: AssetMap['characters'][string]['appearances'] = {}

    for (const appearance of character.appearances) {
      const exact = storedAppearances
        .filter((entry) => (
          normalizeAssetIdentityText(entry.changeReason)
            === normalizeAssetIdentityText(appearance.changeReason)
        ))
        .sort((left, right) => left.appearanceIndex - right.appearanceIndex)[0]
      const appearanceId = exact?.id ?? buildProjectedEntityId(
        runId,
        'Appearance',
        appearance.appearanceKey,
      )
      const appearanceIndex = exact?.appearanceIndex ?? nextIndex++
      const candidateIndex = exact
        ? parseImageUrls(exact.imageUrls, appearance.appearanceKey).length
        : 0
      if (exact) {
        addWarning(warnings, appearance.appearanceKey, 'description')
        addWarning(warnings, appearance.appearanceKey, 'imageUrls')
      }
      mappedAppearances[appearance.appearanceKey] = {
        appearanceKey: appearance.appearanceKey,
        appearanceId,
        appearanceIndex,
        reused: Boolean(exact),
        variantSlots: {
          0: {
            entityId: buildAppearanceCandidateOwnerId(
              runId,
              appearance.appearanceKey,
              0,
              candidateIndex,
            ),
            index: candidateIndex,
          },
        },
      }
    }
    mapping.characters[character.characterKey] = {
      characterKey: character.characterKey,
      characterId,
      reused: Boolean(existing),
      appearances: mappedAppearances,
    }
  }

  const addImageAsset = (
    asset: ImageAssetInput,
    kind: ImageAssetKind,
    slotCount: number,
  ) => {
    const externalKey = kind === 'location'
      ? (asset as LocationInput).locationKey
      : (asset as PropInput).propKey
    const existing = findImageAssetIdentity(asset.name, kind, imageAssets)
    if (existing) {
      addWarning(warnings, externalKey, 'summary')
      addWarning(warnings, externalKey, kind === 'location'
        ? 'descriptions'
        : 'visualDescription')
    }
    const entityId = existing?.id ?? buildProjectedEntityId(
      runId,
      kind === 'location' ? 'Location' : 'Prop',
      externalKey,
    )
    const priorImages = existing
      ? (imagesByAsset.get(existing.id) ?? [])
      : []
    const firstIndex = Math.max(
      -1,
      ...priorImages.map((entry) => entry.imageIndex),
    ) + 1
    const imageSlots = Object.fromEntries(
      Array.from({ length: slotCount }, (_, slotIndex) => [
        String(slotIndex),
        {
          entityId: buildProjectedEntityId(
            runId,
            'LocationImage',
            `${externalKey}:${slotIndex}`,
          ),
          index: firstIndex + slotIndex,
        },
      ]),
    )
    const entry = {
      assetKey: externalKey,
      entityId,
      reused: Boolean(existing),
      imageSlots,
    }
    if (kind === 'location') mapping.locations[externalKey] = entry
    else mapping.props[externalKey] = entry
  }

  for (const location of request.data.locations) {
    addImageAsset(location, 'location', location.descriptions.length)
  }
  for (const prop of request.data.props) addImageAsset(prop, 'prop', 1)
  return mapping
}

async function loadExistingAssets(
  tx: Prisma.TransactionClient,
  novelProjectId: string,
): Promise<{
  characters: ExistingCharacter[]
  appearancesByCharacter: Map<string, ExistingAppearance[]>
  imageAssets: ExistingImageAsset[]
  imagesByAsset: Map<string, ExistingLocationImage[]>
}> {
  const characters = await tx.novelPromotionCharacter.findMany({
    where: { novelPromotionProjectId: novelProjectId },
    select: {
      id: true,
      name: true,
      aliases: true,
      profileData: true,
      profileConfirmed: true,
      introduction: true,
    },
  })
  const appearances = characters.length === 0
    ? []
    : await tx.characterAppearance.findMany({
      where: { characterId: { in: characters.map((entry) => entry.id) } },
      select: {
        id: true,
        characterId: true,
        appearanceIndex: true,
        changeReason: true,
        description: true,
        descriptions: true,
        imageUrl: true,
        imageUrls: true,
        selectedIndex: true,
      },
      orderBy: [
        { characterId: 'asc' },
        { appearanceIndex: 'asc' },
      ],
    })
  const appearancesByCharacter = new Map<string, ExistingAppearance[]>()
  for (const appearance of appearances) {
    const list = appearancesByCharacter.get(appearance.characterId) ?? []
    list.push(appearance)
    appearancesByCharacter.set(appearance.characterId, list)
  }

  const imageAssets = await tx.novelPromotionLocation.findMany({
    where: { novelPromotionProjectId: novelProjectId },
    select: {
      id: true,
      name: true,
      summary: true,
      assetKind: true,
      selectedImageId: true,
    },
  })
  const images = imageAssets.length === 0
    ? []
    : await tx.locationImage.findMany({
      where: { locationId: { in: imageAssets.map((entry) => entry.id) } },
      select: { id: true, locationId: true, imageIndex: true },
      orderBy: [
        { locationId: 'asc' },
        { imageIndex: 'asc' },
      ],
    })
  const imagesByAsset = new Map<string, ExistingLocationImage[]>()
  for (const image of images) {
    const list = imagesByAsset.get(image.locationId) ?? []
    list.push(image)
    imagesByAsset.set(image.locationId, list)
  }
  return {
    characters,
    appearancesByCharacter,
    imageAssets,
    imagesByAsset,
  }
}

async function commitCharacters(
  tx: Prisma.TransactionClient,
  runId: string,
  novelProjectId: string,
  inputs: CharacterInput[],
  existingCharacters: ExistingCharacter[],
  appearancesByCharacter: Map<string, ExistingAppearance[]>,
  mapping: AssetMap,
  warnings: AssetWarning[],
): Promise<void> {
  for (const character of inputs) {
    const identity = findCharacterIdentity(
      character,
      existingCharacters,
      character.gender,
    )
    for (const warning of identity.warnings) {
      addWarning(warnings, character.characterKey, warning.field)
    }
    let stored = identity.match
    const characterReused = Boolean(stored)
    if (!stored) {
      const created = await tx.novelPromotionCharacter.create({
        data: {
          id: buildProjectedEntityId(
            runId,
            'Character',
            character.characterKey,
          ),
          novelPromotionProjectId: novelProjectId,
          name: character.name,
          aliases: JSON.stringify(character.aliases),
          introduction: character.introduction,
          profileData: profileData(character),
          profileConfirmed: true,
        },
        select: {
          id: true,
          name: true,
          aliases: true,
          profileData: true,
          profileConfirmed: true,
          introduction: true,
        },
      })
      stored = created
      existingCharacters.push(created)
      appearancesByCharacter.set(created.id, [])
    } else {
      addWarning(warnings, character.characterKey, 'name')
      addWarning(warnings, character.characterKey, 'introduction')
      addWarning(warnings, character.characterKey, 'profileData')
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM novel_promotion_characters
        WHERE id = ${stored.id}
        FOR UPDATE
      `)
      const aliases = appendMissingStoredAliases(
        stored.aliases,
        stored.name,
        character.name,
        character.aliases,
      )
      if (aliases !== undefined) {
        await tx.novelPromotionCharacter.update({
          where: { id: stored.id },
          data: { aliases },
        })
        stored.aliases = aliases
      }
    }

    const storedAppearances = appearancesByCharacter.get(stored.id) ?? []
    const reusableAppearances = characterReused
      ? [...storedAppearances]
      : []
    let nextIndex = characterReused
      ? Math.max(
        -1,
        ...storedAppearances.map((entry) => entry.appearanceIndex),
      ) + 1
      : 0
    const mappedAppearances: AssetMap['characters'][string]['appearances'] = {}
    for (const appearance of character.appearances) {
      const exact = reusableAppearances
        .filter((entry) => (
          normalizeAssetIdentityText(entry.changeReason)
            === normalizeAssetIdentityText(appearance.changeReason)
        ))
        .sort((left, right) => left.appearanceIndex - right.appearanceIndex)[0]

      if (exact) {
        const historical = parseImageUrls(
          exact.imageUrls,
          appearance.appearanceKey,
        )
        const candidateIndex = historical.length
        const updatedImageUrls = JSON.stringify([...historical, ''])
        await tx.characterAppearance.update({
          where: { id: exact.id },
          data: { imageUrls: updatedImageUrls },
        })
        exact.imageUrls = updatedImageUrls
        addWarning(warnings, appearance.appearanceKey, 'description')
        addWarning(warnings, appearance.appearanceKey, 'imageUrls')
        mappedAppearances[appearance.appearanceKey] = {
          appearanceKey: appearance.appearanceKey,
          appearanceId: exact.id,
          appearanceIndex: exact.appearanceIndex,
          reused: true,
          variantSlots: {
            0: {
              entityId: buildAppearanceCandidateOwnerId(
                runId,
                appearance.appearanceKey,
                0,
                candidateIndex,
              ),
              index: candidateIndex,
            },
          },
        }
        continue
      }

      const appearanceIndex = characterReused
        ? nextIndex++
        : appearance.appearanceOrdinal - 1
      const created = await tx.characterAppearance.create({
        data: {
          id: buildProjectedEntityId(
            runId,
            'Appearance',
            appearance.appearanceKey,
          ),
          characterId: stored.id,
          appearanceIndex,
          changeReason: appearance.changeReason,
          description: appearance.visualDescription,
          descriptions: JSON.stringify([appearance.visualDescription]),
          imageUrls: JSON.stringify(['']),
        },
        select: {
          id: true,
          characterId: true,
          appearanceIndex: true,
          changeReason: true,
          description: true,
          descriptions: true,
          imageUrl: true,
          imageUrls: true,
          selectedIndex: true,
        },
      })
      storedAppearances.push(created)
      mappedAppearances[appearance.appearanceKey] = {
        appearanceKey: appearance.appearanceKey,
        appearanceId: created.id,
        appearanceIndex: created.appearanceIndex,
        reused: false,
        variantSlots: {
          0: {
            entityId: buildAppearanceCandidateOwnerId(
              runId,
              appearance.appearanceKey,
              0,
              0,
            ),
            index: 0,
          },
        },
      }
    }
    mapping.characters[character.characterKey] = {
      characterKey: character.characterKey,
      characterId: stored.id,
      reused: characterReused,
      appearances: mappedAppearances,
    }
  }
}

async function commitImageAsset(
  tx: Prisma.TransactionClient,
  runId: string,
  novelProjectId: string,
  input: ImageAssetInput,
  kind: ImageAssetKind,
  descriptions: string[],
  availableSlots: string[],
  existingAssets: ExistingImageAsset[],
  imagesByAsset: Map<string, ExistingLocationImage[]>,
  mapping: AssetMap,
  warnings: AssetWarning[],
): Promise<void> {
  const externalKey = kind === 'location'
    ? (input as LocationInput).locationKey
    : (input as PropInput).propKey
  let stored = findImageAssetIdentity(input.name, kind, existingAssets)
  const reused = Boolean(stored)
  if (!stored) {
    const created = await tx.novelPromotionLocation.create({
      data: {
        id: buildProjectedEntityId(
          runId,
          kind === 'location' ? 'Location' : 'Prop',
          externalKey,
        ),
        novelPromotionProjectId: novelProjectId,
        name: input.name,
        summary: input.summary,
        assetKind: kind,
      },
      select: {
        id: true,
        name: true,
        summary: true,
        assetKind: true,
        selectedImageId: true,
      },
    })
    stored = created
    imagesByAsset.set(created.id, [])
  } else {
    addWarning(warnings, externalKey, 'summary')
    addWarning(warnings, externalKey, kind === 'location'
      ? 'descriptions'
      : 'visualDescription')
  }

  const existingImages = imagesByAsset.get(stored.id) ?? []
  const firstIndex = Math.max(
    -1,
    ...existingImages.map((entry) => entry.imageIndex),
  ) + 1
  const imageSlots: AssetMap['locations'][string]['imageSlots'] = {}
  for (let slotIndex = 0; slotIndex < descriptions.length; slotIndex += 1) {
    const created = await tx.locationImage.create({
      data: {
        id: buildProjectedEntityId(
          runId,
          'LocationImage',
          `${externalKey}:${slotIndex}`,
        ),
        locationId: stored.id,
        imageIndex: firstIndex + slotIndex,
        description: descriptions[slotIndex],
        availableSlots: stringifyLocationAvailableSlots(availableSlots),
      },
      select: { id: true, imageIndex: true },
    })
    existingImages.push(created)
    imageSlots[String(slotIndex)] = {
      entityId: created.id,
      index: created.imageIndex,
    }
  }
  imagesByAsset.set(stored.id, existingImages)
  const entry = {
    assetKey: externalKey,
    entityId: stored.id,
    reused,
    imageSlots,
  }
  if (kind === 'location') mapping.locations[externalKey] = entry
  else mapping.props[externalKey] = entry
}

async function commitAssetsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    userId: string
    runId: string
    request: AssetsCommitRequest
  },
): Promise<AssetsCommitData> {
  await tx.$queryRaw(Prisma.sql`
    SELECT np.id
    FROM novel_promotion_projects np
    INNER JOIN agent_creation_runs ar ON ar.projectId = np.projectId
    WHERE ar.id = ${input.runId}
    FOR UPDATE
  `)
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM agent_creation_runs
    WHERE id = ${input.runId}
    FOR UPDATE
  `)

  const run = await tx.agentCreationRun.findUnique({
    where: { id: input.runId },
    select: ASSET_RUN_SELECT,
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
  const definitions = Object.values(episodes)
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
  if (hashArtifact(definitions) !== run.definitionHash) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'definitionHash' },
    })
  }

  const persistedMapping = run.assetMapJson
    ? parseAssetMap(run.assetMapJson)
    : emptyAssetMap()
  const artifactHashes = parseArtifactHashes(run.artifactHashesJson ?? '')
  const existingHash = artifactHashes.assets
  if (
    existingHash !== undefined
    && existingHash !== input.request.artifactHash
  ) {
    throw new AgentApiError('RUN_DEFINITION_CONFLICT', {
      field: 'artifactHash',
    })
  }
  if (existingHash !== undefined) {
    if (!run.assetMapJson) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        details: { field: 'assetMapJson' },
      })
    }
    return responseFromMap(
      input.request,
      persistedMapping,
      [],
    )
  }
  if (
    Object.keys(persistedMapping.characters).length > 0
    || Object.keys(persistedMapping.locations).length > 0
    || Object.keys(persistedMapping.props).length > 0
  ) {
    throw new AgentApiError('AGENT_INTERNAL_ERROR', {
      details: { field: 'assetMapJson' },
    })
  }

  const novelProject = await tx.novelPromotionProject.findUnique({
    where: { projectId: run.projectId },
    select: { id: true, projectId: true },
  })
  if (!novelProject || novelProject.projectId !== run.projectId) {
    throw new AgentApiError('REFERENCE_INVALID')
  }

  const existing = await loadExistingAssets(tx, novelProject.id)
  const warnings: AssetWarning[] = []
  if (input.request.dryRun) {
    const dryRunMapping = buildDryRunMapping(
      run.id,
      input.request,
      existing.characters,
      existing.appearancesByCharacter,
      existing.imageAssets,
      existing.imagesByAsset,
      warnings,
    )
    return responseFromMap(input.request, dryRunMapping, warnings)
  }

  const mapping = emptyAssetMap()
  await commitCharacters(
    tx,
    run.id,
    novelProject.id,
    input.request.data.characters,
    existing.characters,
    existing.appearancesByCharacter,
    mapping,
    warnings,
  )
  const identityImageAssets = [...existing.imageAssets]
  for (const location of input.request.data.locations) {
    await commitImageAsset(
      tx,
      run.id,
      novelProject.id,
      location,
      'location',
      location.descriptions,
      location.availableSlots,
      identityImageAssets,
      existing.imagesByAsset,
      mapping,
      warnings,
    )
  }
  for (const prop of input.request.data.props) {
    await commitImageAsset(
      tx,
      run.id,
      novelProject.id,
      prop,
      'prop',
      [prop.visualDescription],
      [],
      identityImageAssets,
      existing.imagesByAsset,
      mapping,
      warnings,
    )
  }

  artifactHashes.assets = input.request.artifactHash
  const status = transitionRunStatus(
    runStatus,
    run.currentStage,
    'assets_committed',
  )
  await tx.agentCreationRun.update({
    where: { id: run.id },
    data: {
      assetMapJson: serializeAssetMap(mapping),
      artifactHashesJson: serializeArtifactHashes(artifactHashes),
      status,
      currentStage: 'assets_committed',
    },
  })
  return responseFromMap(input.request, mapping, warnings)
}

export async function commitAssetsArtifact(input: {
  userId: string
  runId: string
  request: AssetsCommitRequest
}): Promise<AssetsCommitData> {
  const parsed = AssetsCommitRequestSchema.safeParse(input.request)
  if (!parsed.success) {
    throw new AgentApiError('CONTRACT_INVALID', {
      details: {
        field: parsed.error.issues[0]?.path.join('.') ?? 'request',
      },
    })
  }
  assertUniqueRequestedAssetIdentities(parsed.data.data)

  try {
    return await prisma.$transaction(
      (tx) => commitAssetsInTransaction(tx, {
        ...input,
        request: parsed.data,
      }),
      ASSET_TRANSACTION_OPTIONS,
    )
  } catch (error) {
    if (isAgentApiError(error)) throw error
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new AgentApiError('AGENT_INTERNAL_ERROR', {
        message: error.code === 'P2028' || error.code === 'P2034'
          ? 'Asset transaction timed out or conflicted'
          : 'Asset transaction failed',
        details: {
          operation: 'assets_commit',
          prismaCode: error.code,
        },
      })
    }
    throw error
  }
}
