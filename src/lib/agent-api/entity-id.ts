import { createHash } from 'node:crypto'

import { canonicalJson } from './canonical-json'

export const PROJECTED_ENTITY_TYPES = [
  'Character',
  'Appearance',
  'AppearanceCandidate',
  'Location',
  'Prop',
  'LocationImage',
  'Clip',
  'Storyboard',
  'Panel',
  'Frame',
] as const

export type ProjectedEntityType = (typeof PROJECTED_ENTITY_TYPES)[number]

export function buildProjectedEntityId(
  runId: string,
  entityType: ProjectedEntityType,
  externalKey: string,
): string {
  const bytes = createHash('sha256')
    .update(canonicalJson([runId, entityType, externalKey]), 'utf8')
    .digest()
    .subarray(0, 16)

  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

export function buildAppearanceCandidateOwnerId(
  runId: string,
  appearanceKey: string,
  localVariant: number,
  actualIndex: number,
): string {
  return buildProjectedEntityId(
    runId,
    'AppearanceCandidate',
    `${appearanceKey}:${localVariant}:${actualIndex}`,
  )
}
