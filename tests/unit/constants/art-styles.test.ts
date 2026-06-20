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
})
