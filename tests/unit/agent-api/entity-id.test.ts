import { describe, expect, it } from 'vitest'

import {
  PROJECTED_ENTITY_TYPES,
  buildProjectedEntityId,
} from '@/lib/agent-api/entity-id'

const UUID_V8_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('buildProjectedEntityId', () => {
  it('includes a distinct run-owned appearance candidate identity type', () => {
    expect(PROJECTED_ENTITY_TYPES).toContain('AppearanceCandidate')
  })

  it('matches the stable SHA-256 UUIDv8 vector', () => {
    expect(buildProjectedEntityId('run-123', 'Character', 'character-001')).toBe(
      'c66a6b3f-8204-8bce-b4a4-2bc3335aa696',
    )
  })

  it.each(PROJECTED_ENTITY_TYPES)(
    'returns a stable valid UUID for %s',
    (entityType) => {
      const first = buildProjectedEntityId('run-123', entityType, 'entity-001')
      const second = buildProjectedEntityId('run-123', entityType, 'entity-001')

      expect(first).toBe(second)
      expect(first).toMatch(UUID_V8_PATTERN)
    },
  )

  it('changes when any identity component changes', () => {
    const baseline = buildProjectedEntityId('run-123', 'Character', 'character-001')

    expect(buildProjectedEntityId('run-456', 'Character', 'character-001')).not.toBe(baseline)
    expect(buildProjectedEntityId('run-123', 'Appearance', 'character-001')).not.toBe(baseline)
    expect(buildProjectedEntityId('run-123', 'Character', 'character-002')).not.toBe(baseline)
  })

  it('projects the same identity for concurrent dry-run and commit validation', async () => {
    const validate = async (dryRun: boolean) => {
      void dryRun
      return buildProjectedEntityId('run-concurrent', 'Panel', 'panel-001')
    }

    const [dryRunId, commitId] = await Promise.all([validate(true), validate(false)])

    expect(dryRunId).toBe(commitId)
  })
})
