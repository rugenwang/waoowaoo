import type { NovelPromotionPanel, NovelPromotionPanelFrame } from '@/types/project'

export const PANEL_MODE = {
  SINGLE: 'single',
  GROUP: 'group',
} as const

export type PanelMode = (typeof PANEL_MODE)[keyof typeof PANEL_MODE]

export function normalizePanelMode(panel: Pick<NovelPromotionPanel, 'panelMode' | 'frames'>): PanelMode {
  if (panel.panelMode === PANEL_MODE.GROUP) return PANEL_MODE.GROUP
  if (Array.isArray(panel.frames) && panel.frames.length > 1) return PANEL_MODE.GROUP
  return PANEL_MODE.SINGLE
}

export function getSortedPanelFrames(panel: NovelPromotionPanel): NovelPromotionPanelFrame[] {
  const frames = Array.isArray(panel.frames) ? panel.frames : []
  if (frames.length > 0) {
    return [...frames].sort((left, right) => {
      const byIndex = (left.frameIndex || 0) - (right.frameIndex || 0)
      if (byIndex !== 0) return byIndex
      return (left.frameTimeSec || 0) - (right.frameTimeSec || 0)
    })
  }

  return [{
    id: `${panel.id}:virtual-frame-0`,
    panelId: panel.id,
    frameIndex: 0,
    frameTimeSec: 0,
    frameRole: 'main',
    dependencyFrameIds: null,
    imagePrompt: panel.imagePrompt,
    videoPrompt: panel.videoPrompt,
    promptJson: null,
    referencePolicy: null,
    imageUrl: panel.imageUrl,
    imageMedia: panel.media || null,
    media: panel.media || null,
    generationStatus: panel.imageUrl ? 'completed' : null,
    errorMessage: panel.imageErrorMessage || null,
    virtual: true,
  }]
}

export function getPanelRepresentativeFrame(panel: NovelPromotionPanel): NovelPromotionPanelFrame {
  const frames = getSortedPanelFrames(panel)
  return frames.find((frame) => frame.frameRole === 'hero') || frames[0]
}

export function getPanelRepresentativeImageUrl(panel: NovelPromotionPanel): string | null {
  return getPanelRepresentativeFrame(panel)?.imageUrl || panel.imageUrl || null
}
