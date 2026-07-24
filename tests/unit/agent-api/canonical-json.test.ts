import { describe, expect, expectTypeOf, it } from 'vitest'

import hashVectors from '../../fixtures/agent-api/hash-vectors.json'
import {
  buildRunFingerprint,
  canonicalJson,
  hashArtifact,
  hashSourceText,
  normalizeSourceText,
  sha256Prefixed,
  type RunFingerprintInput,
} from '@/lib/agent-api/canonical-json'

describe('canonicalJson', () => {
  it.each(hashVectors.canonical)(
    '$name',
    ({ input, canonical }) => {
      expect(canonicalJson(input)).toBe(canonical)
    },
  )

  it('preserves array order', () => {
    expect(canonicalJson({ values: [3, 1, 2] })).toBe('{"values":[3,1,2]}')
  })

  it('rejects undefined at every depth', () => {
    expect(() => canonicalJson(undefined)).toThrow(/undefined/i)
    expect(() => canonicalJson({ nested: { missing: undefined } })).toThrow(/undefined/i)
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined/i)
    expect(() => canonicalJson([1, , 3])).toThrow(/undefined/i)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite number %s',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(/finite/i)
    },
  )

  it.each([
    BigInt(1),
    Symbol('unsupported'),
    () => 'unsupported',
    new Date('2026-07-24T00:00:00.000Z'),
  ])('rejects unsupported value %s', (value) => {
    expect(() => canonicalJson({ value })).toThrow(/unsupported/i)
  })

  it('produces identical hashes for objects with different insertion order', () => {
    const first = { z: 2, nested: { b: 2, a: 1 }, a: 1 }
    const second = { a: 1, nested: { a: 1, b: 2 }, z: 2 }

    expect(hashArtifact(first)).toBe(hashArtifact(second))
  })
})

describe('hash helpers', () => {
  it('normalizes CRLF and CR to LF before trimming source text', () => {
    expect(normalizeSourceText(hashVectors.source.input)).toBe(hashVectors.source.normalized)
    expect(hashSourceText(hashVectors.source.input)).toBe(hashVectors.source.hash)
  })

  it('returns a prefixed lowercase SHA-256 digest', () => {
    expectTypeOf(sha256Prefixed).parameter(0).toEqualTypeOf<string | Buffer>()
    expect(sha256Prefixed('hello')).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(sha256Prefixed(Buffer.from('hello'))).toBe(sha256Prefixed('hello'))
  })

  it('hashes artifacts using the shared canonical JSON vectors', () => {
    expect(hashArtifact(hashVectors.canonical[0].input)).toBe(hashVectors.canonical[0].hash)
    expect(hashArtifact(hashVectors.definition.episodes)).toBe(hashVectors.definition.hash)
  })

  it('uses exactly the normalized run fingerprint materials', () => {
    const input = hashVectors.runFingerprint.input as RunFingerprintInput

    expect(buildRunFingerprint(input)).toBe(
      hashVectors.runFingerprint.hash,
    )

    expect(buildRunFingerprint({
      ...input,
      locale: 'en',
    })).not.toBe(hashVectors.runFingerprint.hash)
  })
})
