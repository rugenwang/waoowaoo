import { describe, expect, it } from 'vitest'

import {
  findCharacterIdentity,
  findImageAssetIdentity,
  normalizeAssetIdentityText,
  normalizeAssetGender,
  parseStoredAliases,
  parseStoredGender,
} from '@/lib/agent-api/asset-identity'

describe('asset identity normalization', () => {
  it('uses NFC, trims, collapses whitespace, and lowercases ASCII only', () => {
    expect(normalizeAssetIdentityText('  E\u0301LLa \t SMITH \n')).toBe('Élla smith')
    expect(normalizeAssetIdentityText('ÄBC')).toBe('Äbc')
  })

  it('does not lowercase Unicode or apply pinyin, synonyms, or fuzzy matching', () => {
    expect(normalizeAssetIdentityText('ΣABC')).toBe('Σabc')
    expect(normalizeAssetIdentityText('林晓')).toBe('林晓')
    expect(normalizeAssetIdentityText('lin xiao')).toBe('lin xiao')
    expect(normalizeAssetIdentityText('colour')).not.toBe(normalizeAssetIdentityText('color'))
  })

  it.each([
    [null, []],
    ['{broken', []],
    [JSON.stringify('alias'), []],
    [JSON.stringify(['阿晓', 42]), []],
  ])('treats invalid stored aliases %j as empty and warns', (raw, aliases) => {
    expect(parseStoredAliases(raw)).toEqual({
      aliases,
      warning: true,
    })
  })

  it('parses only valid string arrays and preserves normalized unique aliases', () => {
    expect(parseStoredAliases(JSON.stringify([' 阿晓 ', 'A  B', 'a b', '']))).toEqual({
      aliases: ['阿晓', 'a b'],
      warning: false,
    })
  })

  it('matches a character when any requested name/alias intersects any stored name/alias', () => {
    const result = findCharacterIdentity(
      { name: '林晓', aliases: ['小林'] },
      [{
        id: 'character-1',
        name: 'Lynn',
        aliases: JSON.stringify([' 小林 ']),
        profileData: JSON.stringify({ gender: '女' }),
      }],
      'female',
    )
    expect(result).toMatchObject({
      match: expect.objectContaining({ id: 'character-1' }),
      warnings: [],
    })
  })

  it('reports a deterministic conflict when identity intersects multiple rows', () => {
    expect(() => findCharacterIdentity(
      { name: '林晓', aliases: ['小林'] },
      [
        { id: 'one', name: '林晓', aliases: '[]', profileData: null },
        { id: 'two', name: '小林', aliases: '[]', profileData: null },
      ],
      'unknown',
    )).toThrowError(expect.objectContaining({ code: 'ASSET_IDENTITY_CONFLICT' }))
  })
})

describe('stored gender identity', () => {
  it.each([
    ['男', 'male'],
    ['male', 'male'],
    ['M', 'male'],
    ['男性', 'male'],
    ['女', 'female'],
    ['female', 'female'],
    ['F', 'female'],
    ['女性', 'female'],
    ['非二元', 'nonbinary'],
    ['nonbinary', 'nonbinary'],
    ['non-binary', 'nonbinary'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['anything else', 'unknown'],
  ] as const)('normalizes %j to %s', (raw, expected) => {
    expect(normalizeAssetGender(raw)).toBe(expected)
  })

  it.each([
    [null],
    ['{broken'],
    [JSON.stringify({})],
    [JSON.stringify({ gender: 'unrecognized' })],
  ])('treats invalid or unknown stored profile gender %j as unknown and warns', (raw) => {
    expect(parseStoredGender(raw)).toEqual({
      gender: 'unknown',
      warning: true,
    })
  })

  it('conflicts only when both request and stored gender are known and differ', () => {
    const existing = [{
      id: 'character-1',
      name: '林晓',
      aliases: '[]',
      profileData: JSON.stringify({ gender: 'male', ageRange: '60' }),
    }]
    expect(() => findCharacterIdentity(
      { name: '林晓', aliases: [] },
      existing,
      'female',
    )).toThrowError(expect.objectContaining({ code: 'ASSET_IDENTITY_CONFLICT' }))
    expect(findCharacterIdentity(
      { name: '林晓', aliases: [] },
      existing,
      'unknown',
    ).match?.id).toBe('character-1')
    expect(findCharacterIdentity(
      { name: '林晓', aliases: [] },
      [{ ...existing[0], profileData: null }],
      'female',
    ).match?.id).toBe('character-1')
  })
})

describe('location and prop identity', () => {
  const existing = [
    { id: 'location-1', name: ' 怀表 ', assetKind: 'location' },
    { id: 'prop-1', name: '怀表', assetKind: 'prop' },
  ]

  it('matches normalized main name within the requested asset kind', () => {
    expect(findImageAssetIdentity('怀表', 'location', existing)?.id).toBe('location-1')
    expect(findImageAssetIdentity('怀表', 'prop', existing)?.id).toBe('prop-1')
  })

  it('keeps location and prop identities separate and conflicts on a wrong existing kind', () => {
    expect(findImageAssetIdentity('新场景', 'location', existing)).toBeUndefined()
    expect(() => findImageAssetIdentity(
      '怀表',
      'location',
      [{ id: 'wrong', name: '怀表', assetKind: 'prop' }],
    )).toThrowError(expect.objectContaining({ code: 'ASSET_IDENTITY_CONFLICT' }))
  })
})
