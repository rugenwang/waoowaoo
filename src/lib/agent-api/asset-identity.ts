import type {
  AssetsArtifact,
  GenderSchema,
} from './contracts/assets'
import { AgentApiError } from './errors'

export type AssetGender = typeof GenderSchema._type

export type IdentityWarning = {
  field: 'aliases' | 'profileData.gender'
}

export type StoredCharacterIdentity = {
  id: string
  name: string
  aliases: string | null
  profileData: string | null
}

export type StoredImageAssetIdentity = {
  id: string
  name: string
  assetKind: string
}

const KNOWN_GENDERS = new Map<string, Exclude<AssetGender, 'unknown'>>([
  ['男', 'male'],
  ['male', 'male'],
  ['m', 'male'],
  ['男性', 'male'],
  ['女', 'female'],
  ['female', 'female'],
  ['f', 'female'],
  ['女性', 'female'],
  ['非二元', 'nonbinary'],
  ['nonbinary', 'nonbinary'],
  ['non-binary', 'nonbinary'],
])

export function normalizeAssetIdentityText(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[A-Z]/g, (character) => character.toLowerCase())
}

export function normalizeAssetGender(value: unknown): AssetGender {
  if (typeof value !== 'string') return 'unknown'
  const identity = normalizeAssetIdentityText(value)
  if (identity === 'unknown') return 'unknown'
  return KNOWN_GENDERS.get(identity) ?? 'unknown'
}

export function parseStoredAliases(raw: string | null): {
  aliases: string[]
  warning: boolean
} {
  if (raw === null) return { aliases: [], warning: true }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { aliases: [], warning: true }
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((entry) => typeof entry !== 'string')
  ) {
    return { aliases: [], warning: true }
  }

  const aliases = [...new Set(
    parsed
      .map(normalizeAssetIdentityText)
      .filter(Boolean),
  )]
  return { aliases, warning: false }
}

export function appendMissingStoredAliases(
  existingRaw: string | null,
  existingName: string,
  requestedName: string,
  requestedAliases: string[],
): string | undefined {
  let existing: string[] = []
  if (existingRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(existingRaw)
      if (
        Array.isArray(parsed)
        && parsed.every((entry) => typeof entry === 'string')
      ) {
        existing = parsed
      }
    } catch {
      existing = []
    }
  }
  const identities = new Set(
    [existingName, ...existing]
      .map(normalizeAssetIdentityText)
      .filter(Boolean),
  )
  const appended = [...existing]
  for (const alias of [requestedName, ...requestedAliases]) {
    const identity = normalizeAssetIdentityText(alias)
    if (!identity || identities.has(identity)) continue
    identities.add(identity)
    appended.push(alias)
  }
  return appended.length === existing.length
    ? undefined
    : JSON.stringify(appended)
}

export function assertUniqueRequestedAssetIdentities(
  data: AssetsArtifact,
): void {
  const characterIdentities = new Map<string, string>()
  for (const character of data.characters) {
    for (const identity of [character.name, ...character.aliases]
      .map(normalizeAssetIdentityText)
      .filter(Boolean)) {
      const prior = characterIdentities.get(identity)
      if (prior && prior !== character.characterKey) {
        throw new AgentApiError('ASSET_IDENTITY_CONFLICT', {
          details: {
            field: 'characters',
            targetKey: character.characterKey,
            conflictingTargetKey: prior,
          },
        })
      }
      characterIdentities.set(identity, character.characterKey)
    }
  }

  for (const [kind, assets] of [
    ['location', data.locations.map((asset) => ({
      key: asset.locationKey,
      name: asset.name,
    }))],
    ['prop', data.props.map((asset) => ({
      key: asset.propKey,
      name: asset.name,
    }))],
  ] as const) {
    const identities = new Map<string, string>()
    for (const asset of assets) {
      const identity = normalizeAssetIdentityText(asset.name)
      const prior = identities.get(identity)
      if (prior) {
        throw new AgentApiError('ASSET_IDENTITY_CONFLICT', {
          details: {
            field: kind,
            targetKey: asset.key,
            conflictingTargetKey: prior,
          },
        })
      }
      identities.set(identity, asset.key)
    }
  }
}

export function parseStoredGender(raw: string | null): {
  gender: AssetGender
  warning: boolean
} {
  if (raw === null) return { gender: 'unknown', warning: true }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { gender: 'unknown', warning: true }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { gender: 'unknown', warning: true }
  }

  const value = (parsed as Record<string, unknown>).gender
  if (typeof value !== 'string') return { gender: 'unknown', warning: true }
  const identity = normalizeAssetIdentityText(value)
  if (identity === 'unknown') return { gender: 'unknown', warning: false }
  const gender = KNOWN_GENDERS.get(identity)
  return gender
    ? { gender, warning: false }
    : { gender: 'unknown', warning: true }
}

function identitySet(name: string, aliases: string[]): Set<string> {
  return new Set(
    [name, ...aliases]
      .map(normalizeAssetIdentityText)
      .filter(Boolean),
  )
}

export function findCharacterIdentity<T extends StoredCharacterIdentity>(
  requested: { name: string; aliases: string[] },
  existing: T[],
  requestedGender: AssetGender,
): {
  match: T | undefined
  warnings: IdentityWarning[]
  storedAliases: string[]
} {
  const requestedIdentities = identitySet(requested.name, requested.aliases)
  const warnings: IdentityWarning[] = []
  const matches = existing.flatMap((candidate) => {
    const storedAliases = parseStoredAliases(candidate.aliases)
    const identities = identitySet(candidate.name, storedAliases.aliases)
    const intersects = [...requestedIdentities].some((value) => identities.has(value))
    if (!intersects) return []

    if (storedAliases.warning) warnings.push({ field: 'aliases' })
    const storedGender = parseStoredGender(candidate.profileData)
    if (storedGender.warning) warnings.push({ field: 'profileData.gender' })
    if (
      requestedGender !== 'unknown'
      && storedGender.gender !== 'unknown'
      && requestedGender !== storedGender.gender
    ) {
      throw new AgentApiError('ASSET_IDENTITY_CONFLICT', {
        details: {
          characterId: candidate.id,
          field: 'gender',
        },
      })
    }
    return [{ candidate, storedAliases: storedAliases.aliases }]
  })

  if (matches.length > 1) {
    throw new AgentApiError('ASSET_IDENTITY_CONFLICT', {
      details: { field: 'identity', matchCount: matches.length },
    })
  }
  return {
    match: matches[0]?.candidate,
    warnings,
    storedAliases: matches[0]?.storedAliases ?? [],
  }
}

export function findImageAssetIdentity<T extends StoredImageAssetIdentity>(
  requestedName: string,
  requestedKind: 'location' | 'prop',
  existing: T[],
): T | undefined {
  const identity = normalizeAssetIdentityText(requestedName)
  const nameMatches = existing.filter(
    (candidate) => normalizeAssetIdentityText(candidate.name) === identity,
  )
  const kindMatches = nameMatches.filter(
    (candidate) => candidate.assetKind === requestedKind,
  )
  if (kindMatches.length > 1 || (kindMatches.length === 0 && nameMatches.length > 0)) {
    throw new AgentApiError('ASSET_IDENTITY_CONFLICT', {
      details: {
        field: 'assetKind',
        assetKind: requestedKind,
        matchCount: nameMatches.length,
      },
    })
  }
  return kindMatches[0]
}
