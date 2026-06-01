import { describe, expect, it } from 'vitest'
import {
  parsePanelFrameDependencyPlan,
  resolvePreviousPanelTailImageUrl,
  withPreviousTailDependency,
} from '@/lib/novel-promotion/panel-tail-reference'

describe('panel-tail-reference helpers', () => {
  it('resolves previous panel tail from the last available group frame', () => {
    expect(resolvePreviousPanelTailImageUrl({
      panelMode: 'group',
      imageUrl: 'cos/group-cover.png',
      frames: [
        { frameIndex: 0, imageUrl: 'cos/group-f1.png' },
        { frameIndex: 1, imageUrl: 'cos/group-f2.png' },
      ],
    })).toBe('cos/group-f2.png')

    expect(resolvePreviousPanelTailImageUrl({
      panelMode: 'group',
      imageUrl: 'cos/group-cover.png',
      frames: [
        { frameIndex: 0, imageUrl: 'cos/group-f1.png' },
        { frameIndex: 1, imageUrl: null },
      ],
    })).toBe('cos/group-f1.png')
  })

  it('recognizes media urls when frame imageUrl is not populated', () => {
    expect(resolvePreviousPanelTailImageUrl({
      panelMode: 'group',
      imageUrl: null,
      frames: [
        { frameIndex: 0, imageUrl: 'cos/group-f1.png' },
        { frameIndex: 1, imageUrl: null, imageMedia: { url: 'https://cdn.example.com/group-f2.png' } },
      ],
    })).toBe('https://cdn.example.com/group-f2.png')
  })

  it('falls back to panel image for single panels', () => {
    expect(resolvePreviousPanelTailImageUrl({
      panelMode: 'single',
      imageUrl: 'cos/panel-main.png',
      frames: [],
    })).toBe('cos/panel-main.png')
  })

  it('injects FP only for the first frame', () => {
    expect(parsePanelFrameDependencyPlan(withPreviousTailDependency(null, true, 0))).toEqual({
      frameIndexes: [],
      previousTail: true,
    })
    expect(parsePanelFrameDependencyPlan(withPreviousTailDependency('[0]', true, 0))).toEqual({
      frameIndexes: [0],
      previousTail: true,
    })
    expect(parsePanelFrameDependencyPlan(withPreviousTailDependency('[0]', true, 1))).toEqual({
      frameIndexes: [0],
      previousTail: false,
    })
  })
})
