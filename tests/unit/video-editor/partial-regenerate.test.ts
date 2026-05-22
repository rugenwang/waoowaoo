import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoClip } from '@/features/video-editor/types/editor.types'
import {
  createPartialRegeneratedClip,
  insertClipAfter,
  resolvePartialRegenerateFrameRange,
} from '@/features/video-editor/utils/partial-regenerate'

function makeClip(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    id: 'clip-a',
    src: 'video/a.mp4',
    durationInFrames: 90,
    originalDurationInFrames: 180,
    trim: { from: 30, to: 120 },
    metadata: {
      panelId: 'panel-1',
      storyboardId: 'storyboard-1',
      panelIndex: 0,
      description: '原片段',
      videoPrompt: '原提示词',
    },
    ...overrides,
  }
}

describe('video editor partial regeneration helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves first and last source frames from the selected trimmed clip range', () => {
    const range = resolvePartialRegenerateFrameRange(makeClip(), 30)

    expect(range).toEqual({
      trimFrom: 30,
      trimTo: 120,
      durationInFrames: 90,
      firstFrame: 30,
      lastFrame: 119,
      durationSeconds: 3,
    })
  })

  it('creates a regenerated clip with independent prompt metadata and no inherited trim/playback', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456)
    vi.spyOn(Math, 'random').mockReturnValue(0.12345)

    const sourceClip = makeClip({
      playback: { reverse: true },
      transition: { type: 'fade', durationInFrames: 15 },
    })
    const clip = createPartialRegeneratedClip({
      sourceClip,
      videoUrl: 'video/regenerated.mp4',
      durationInFrames: 75,
      prompt: '剪辑页局部重生成提示词',
      frameMode: 'first-last',
    })

    expect(clip.id).not.toBe(sourceClip.id)
    expect(clip.src).toBe('video/regenerated.mp4')
    expect(clip.durationInFrames).toBe(75)
    expect(clip.originalDurationInFrames).toBe(75)
    expect(clip.trim).toBeUndefined()
    expect(clip.playback).toBeUndefined()
    expect(clip.transition).toBeUndefined()
    expect(clip.metadata.videoPrompt).toBe('剪辑页局部重生成提示词')
    expect(clip.metadata.regeneratedFromClipId).toBe(sourceClip.id)
    expect(clip.metadata.regenerationFrameMode).toBe('first-last')
  })

  it('inserts the regenerated clip immediately after the selected clip', () => {
    const clipA = makeClip({ id: 'a' })
    const clipB = makeClip({ id: 'b' })
    const clipC = makeClip({ id: 'c' })
    const regenerated = makeClip({ id: 'regen' })

    const timeline = insertClipAfter([clipA, clipB, clipC], 'b', regenerated)

    expect(timeline.map((clip) => clip.id)).toEqual(['a', 'b', 'regen', 'c'])
  })
})
