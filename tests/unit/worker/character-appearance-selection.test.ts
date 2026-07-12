import { describe, expect, it } from 'vitest'
import { selectCharacterAppearance } from '@/lib/workers/handlers/image-task-handler-shared'

describe('selectCharacterAppearance', () => {
  const appearances = [
    { changeReason: '初登场' },
    { changeReason: '战损形象' },
  ]

  it('精确选择明确指定的形象', () => {
    expect(selectCharacterAppearance('林晚', appearances, '战损形象')).toBe(appearances[1])
  })

  it('默认形象别名仍选择第一项', () => {
    expect(selectCharacterAppearance('林晚', appearances, '初始形象')).toBe(appearances[0])
  })

  it('明确形象不存在时给出错误而不是静默回退', () => {
    expect(() => selectCharacterAppearance('林晚', appearances, '礼服形象')).toThrow(
      '角色“林晚”没有形象“礼服形象”',
    )
  })
})
