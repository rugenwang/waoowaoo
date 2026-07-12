import { describe, expect, it } from 'vitest'
import {
  NARRATION_VISUAL_GUARD,
  normalizeStoryboardVideoPrompts,
} from '@/lib/novel-promotion/storyboard-video-prompt-normalizer'

describe('normalizeStoryboardVideoPrompts', () => {
  it('只在对白外给未引用角色增加镜头外前缀', () => {
    const [panel] = normalizeStoryboardVideoPrompts([
      {
        panel_number: 1,
        characters: [{ name: '林晚' }],
        video_prompt: '周明在门外回应；【对白】周明说：「等等我。」',
      },
    ], [{ name: '林晚' }, { name: '周明' }])

    expect(panel.video_prompt).toContain('镜头外角色周明在门外回应')
    expect(panel.video_prompt).toContain('【对白】周明说')
    expect(panel.video_prompt).not.toContain('【对白】镜头外角色周明')
  })

  it('在每个旁白标记前增加完整的嘴唇静止约束且不重复', () => {
    const [panel] = normalizeStoryboardVideoPrompts([
      {
        panel_number: 1,
        characters: [],
        video_prompt: `${NARRATION_VISUAL_GUARD}【旁白】命运从这里开始。`,
      },
    ], [])

    expect(panel.video_prompt).toBe(`${NARRATION_VISUAL_GUARD}【旁白】命运从这里开始。`)
  })
})
