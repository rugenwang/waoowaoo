import { describe, expect, it } from 'vitest'
import {
  getPanelRepresentativeFrame,
  getSortedPanelFrames,
  normalizePanelMode,
} from '@/lib/novel-promotion/panel-frames'
import type { NovelPromotionPanel } from '@/types/project'

function panel(overrides: Partial<NovelPromotionPanel> = {}): NovelPromotionPanel {
  return {
    id: 'panel-1',
    storyboardId: 'storyboard-1',
    panelIndex: 0,
    panelNumber: 1,
    shotType: null,
    cameraMove: null,
    description: null,
    location: null,
    characters: null,
    props: null,
    srtSegment: null,
    srtStart: null,
    srtEnd: null,
    duration: null,
    imagePrompt: 'single image prompt',
    imageUrl: 'https://example.com/single.png',
    imageHistory: null,
    videoPrompt: 'single video prompt',
    videoUrl: null,
    photographyRules: null,
    actingNotes: null,
    ...overrides,
  }
}

describe('panel frame compatibility helpers', () => {
  it('builds a virtual frame for legacy single-image panels', () => {
    const frames = getSortedPanelFrames(panel())

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      frameIndex: 0,
      frameTimeSec: 0,
      imagePrompt: 'single image prompt',
      imageUrl: 'https://example.com/single.png',
      virtual: true,
    })
  })

  it('sorts stored frames by frame index and time', () => {
    const frames = getSortedPanelFrames(panel({
      frames: [
        {
          id: 'frame-2',
          panelId: 'panel-1',
          frameIndex: 2,
          frameTimeSec: 8,
          frameRole: 'end',
          dependencyFrameIds: null,
          imagePrompt: null,
          videoPrompt: null,
          promptJson: null,
          referencePolicy: null,
          imageUrl: null,
          generationStatus: null,
          errorMessage: null,
        },
        {
          id: 'frame-1',
          panelId: 'panel-1',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: 'mid',
          dependencyFrameIds: null,
          imagePrompt: null,
          videoPrompt: null,
          promptJson: null,
          referencePolicy: null,
          imageUrl: null,
          generationStatus: null,
          errorMessage: null,
        },
      ],
    }))

    expect(frames.map((frame) => frame.id)).toEqual(['frame-1', 'frame-2'])
  })

  it('treats panels with multiple frames as groups', () => {
    const mode = normalizePanelMode(panel({
      frames: [
        {
          id: 'frame-1',
          panelId: 'panel-1',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: null,
          dependencyFrameIds: null,
          imagePrompt: null,
          videoPrompt: null,
          promptJson: null,
          referencePolicy: null,
          imageUrl: null,
          generationStatus: null,
          errorMessage: null,
        },
        {
          id: 'frame-2',
          panelId: 'panel-1',
          frameIndex: 1,
          frameTimeSec: 4,
          frameRole: null,
          dependencyFrameIds: null,
          imagePrompt: null,
          videoPrompt: null,
          promptJson: null,
          referencePolicy: null,
          imageUrl: null,
          generationStatus: null,
          errorMessage: null,
        },
      ],
    }))

    expect(mode).toBe('group')
  })

  it('uses hero frame as representative when available', () => {
    const representative = getPanelRepresentativeFrame(panel({
      frames: [
        {
          id: 'frame-1',
          panelId: 'panel-1',
          frameIndex: 0,
          frameTimeSec: 0,
          frameRole: 'start',
          dependencyFrameIds: null,
          imagePrompt: null,
          videoPrompt: null,
          promptJson: null,
          referencePolicy: null,
          imageUrl: 'start.png',
          generationStatus: null,
          errorMessage: null,
        },
        {
          id: 'frame-2',
          panelId: 'panel-1',
          frameIndex: 1,
          frameTimeSec: 2,
          frameRole: 'hero',
          dependencyFrameIds: null,
          imagePrompt: null,
          videoPrompt: null,
          promptJson: null,
          referencePolicy: null,
          imageUrl: 'hero.png',
          generationStatus: null,
          errorMessage: null,
        },
      ],
    }))

    expect(representative.id).toBe('frame-2')
  })
})
