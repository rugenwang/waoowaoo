import { describe, expect, it } from 'vitest'

import { sha256Prefixed } from '@/lib/agent-api/canonical-json'
import {
  finalizeIdempotencyKey,
  requireIdempotencyKey,
  resolveProjectIdempotencyKey,
  uploadIdempotencyKey,
} from '@/lib/agent-api/idempotency'

function request(
  method: string,
  idempotencyKey?: string,
) {
  return new Request('http://localhost/api/agent/v1/test', {
    method,
    headers: idempotencyKey
      ? { 'Idempotency-Key': idempotencyKey }
      : undefined,
  })
}

describe('requireIdempotencyKey', () => {
  const expected = `sha256:${'a'.repeat(64)}`

  it.each(['POST', 'PUT'])('rejects a missing Idempotency-Key on %s', (method) => {
    expect(() => requireIdempotencyKey(request(method), expected)).toThrowError(
      expect.objectContaining({
        code: 'CONTRACT_INVALID',
        field: 'Idempotency-Key',
      }),
    )
  })

  it.each([
    'not-a-sha256',
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
  ])('rejects a malformed or unexpected write key: %s', (key) => {
    expect(() => requireIdempotencyKey(request('POST', key), expected)).toThrowError(
      expect.objectContaining({
        code: 'CONTRACT_INVALID',
        field: 'Idempotency-Key',
      }),
    )
  })

  it('returns the exact expected key for a valid write request', () => {
    expect(requireIdempotencyKey(request('PUT', expected), expected)).toBe(expected)
  })

  it('does not require an Idempotency-Key for GET', () => {
    expect(requireIdempotencyKey(request('GET'), expected)).toBeUndefined()
  })
})

describe('Agent API idempotency materials', () => {
  it('hashes resolve-project with the normalized project name only', () => {
    expect(resolveProjectIdempotencyKey('  Demo Project  ')).toBe(
      sha256Prefixed('resolve-project:Demo Project'),
    )
  })

  it('uses the caller-computed runFingerprint and artifactHash without rehashing', () => {
    const runFingerprint = `sha256:${'b'.repeat(64)}`
    const artifactHash = `sha256:${'c'.repeat(64)}`

    expect(requireIdempotencyKey(request('POST', runFingerprint), runFingerprint)).toBe(runFingerprint)
    expect(requireIdempotencyKey(request('PUT', artifactHash), artifactHash)).toBe(artifactHash)
  })

  it('hashes exactly the canonical upload identity fields', () => {
    const input = {
      runId: 'run-1',
      targetType: 'panel-frame',
      targetKey: 'frame-001',
      variantIndex: 0,
      contentSha256: `sha256:${'d'.repeat(64)}`,
    }

    expect(uploadIdempotencyKey(input)).toBe(
      sha256Prefixed(
        `{"contentSha256":"sha256:${'d'.repeat(64)}","runId":"run-1","targetKey":"frame-001","targetType":"panel-frame","variantIndex":0}`,
      ),
    )
  })

  it('hashes finalize over canonical JSON so insertion order cannot change the key', () => {
    const first = {
      schemaVersion: 1,
      ruleSetHash: `sha256:${'e'.repeat(64)}`,
      expected: {
        assets: `sha256:${'a'.repeat(64)}`,
        stories: { 'episode-001': `sha256:${'b'.repeat(64)}` },
        screenplays: { 'episode-001': `sha256:${'c'.repeat(64)}` },
        storyboards: { 'episode-001': `sha256:${'d'.repeat(64)}` },
      },
    }
    const second = {
      expected: {
        storyboards: { 'episode-001': `sha256:${'d'.repeat(64)}` },
        screenplays: { 'episode-001': `sha256:${'c'.repeat(64)}` },
        stories: { 'episode-001': `sha256:${'b'.repeat(64)}` },
        assets: `sha256:${'a'.repeat(64)}`,
      },
      ruleSetHash: `sha256:${'e'.repeat(64)}`,
      schemaVersion: 1,
    }

    expect(finalizeIdempotencyKey(first)).toBe(finalizeIdempotencyKey(second))
    expect(finalizeIdempotencyKey(first)).toBe(
      sha256Prefixed(
        `{"expected":{"assets":"sha256:${'a'.repeat(64)}","screenplays":{"episode-001":"sha256:${'c'.repeat(64)}"},"stories":{"episode-001":"sha256:${'b'.repeat(64)}"},"storyboards":{"episode-001":"sha256:${'d'.repeat(64)}"}},"ruleSetHash":"sha256:${'e'.repeat(64)}","schemaVersion":1}`,
      ),
    )
  })
})
