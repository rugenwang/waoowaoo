import { describe, expect, it } from 'vitest'
import {
  ART_STYLES,
  getArtStylePrompt,
  isArtStyleValue,
  prependAnimeStyleLabel,
} from '@/lib/constants'

describe('art styles', () => {
  it('provides Chinese live-action ancient style for story creation without anime prefixing', () => {
    expect(ART_STYLES).toContainEqual(expect.objectContaining({
      value: 'chinese-ancient',
      label: '中国真人古风',
      preview: '古',
    }))
    expect(isArtStyleValue('chinese-ancient')).toBe(true)
    expect(getArtStylePrompt('chinese-ancient', 'zh')).toContain('中国真人古风')
    expect(getArtStylePrompt('chinese-ancient', 'en')).toContain('Chinese live-action period-drama')
    expect(prependAnimeStyleLabel({
      prompt: '古代庭院中的人物相遇',
      artStyle: 'chinese-ancient',
      locale: 'zh',
    })).toBe('古代庭院中的人物相遇')
  })

  it('provides Chinese mythology style for story creation on PC and mobile without anime prefixing', () => {
    expect(ART_STYLES).toContainEqual(expect.objectContaining({
      value: 'chinese-mythology',
      label: '中国神话风',
      preview: '神',
    }))
    expect(isArtStyleValue('chinese-mythology')).toBe(true)
    expect(getArtStylePrompt('chinese-mythology', 'zh')).toContain('中国神话风')
    expect(getArtStylePrompt('chinese-mythology', 'en')).toContain('Chinese mythology')
    expect(prependAnimeStyleLabel({
      prompt: '昆仑山云海中神明现身',
      artStyle: 'chinese-mythology',
      locale: 'zh',
    })).toBe('昆仑山云海中神明现身')
  })

  it('provides Chinese xianxia style for story creation on PC and mobile without anime prefixing', () => {
    expect(ART_STYLES).toContainEqual(expect.objectContaining({
      value: 'chinese-xianxia',
      label: '中国仙侠风',
      preview: '仙',
    }))
    expect(isArtStyleValue('chinese-xianxia')).toBe(true)
    expect(getArtStylePrompt('chinese-xianxia', 'zh')).toContain('中国仙侠')
    expect(getArtStylePrompt('chinese-xianxia', 'en')).toContain('Chinese xianxia')
    expect(prependAnimeStyleLabel({
      prompt: '云海仙山中白衣剑修御剑而来',
      artStyle: 'chinese-xianxia',
      locale: 'zh',
    })).toBe('云海仙山中白衣剑修御剑而来')
  })
})
