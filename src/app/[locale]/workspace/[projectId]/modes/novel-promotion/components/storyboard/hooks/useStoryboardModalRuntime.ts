'use client'

import { useMemo } from 'react'
import type { NovelPromotionStoryboard } from '@/types/project'
import type { PanelEditData } from '../../PanelEditForm'
import type { StoryboardPanel } from './useStoryboardState'
import type { SelectedAsset } from './useImageGeneration'
import { useStoryboardAiDataRuntime } from './useStoryboardAiDataRuntime'
import type { PreviousPanelImageOption } from '../PanelCard'

interface AssetPickerPanelRef {
  panelId: string
  type: 'character' | 'location' | 'prop'
}

interface AIDataPanelRef {
  storyboardId: string
  panelIndex: number
}

interface PhotographyPlanMutation {
  mutateAsync: (payload: { storyboardId: string; photographyPlan: string }) => Promise<unknown>
}

interface ActingNotesMutation {
  mutateAsync: (payload: { storyboardId: string; panelIndex: number; actingNotes: string }) => Promise<unknown>
}

interface UseStoryboardModalRuntimeParams {
  projectId: string
  videoRatio: string
  localStoryboards: NovelPromotionStoryboard[]
  sortedStoryboards: NovelPromotionStoryboard[]
  storyboardStartIndex: Record<string, number>
  editingPanel: { storyboardId: string; panelIndex: number } | null
  setEditingPanel: (panel: { storyboardId: string; panelIndex: number } | null) => void
  assetPickerPanel: AssetPickerPanelRef | null
  setAssetPickerPanel: (panel: AssetPickerPanelRef | null) => void
  aiDataPanel: AIDataPanelRef | null
  setAIDataPanel: (panel: AIDataPanelRef | null) => void
  previewImage: string | null
  setPreviewImage: (url: string | null) => void
  getTextPanels: (storyboard: NovelPromotionStoryboard) => StoryboardPanel[]
  getPanelEditData: (panel: StoryboardPanel) => PanelEditData
  updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void
  savePanelWithData: (storyboardId: string, panelIdOrData: string | PanelEditData) => void | Promise<void>
  getDefaultAssetsForClip: (clipId: string) => SelectedAsset[]
  handleEditSubmit: (prompt: string, images: string[], assets: SelectedAsset[]) => Promise<void>
  handleAddCharacter: (characterName: string, appearance: string) => void
  handleSetLocation: (locationName: string) => void
  handleAddProp: (propName: string) => void
  updatePhotographyPlanMutation: PhotographyPlanMutation
  updatePanelActingNotesMutation: ActingNotesMutation
}

interface StoryboardPanelReference {
  storyboardId: string
  panel: StoryboardPanel
}

function findPanelById(
  localStoryboards: NovelPromotionStoryboard[],
  getTextPanels: (storyboard: NovelPromotionStoryboard) => StoryboardPanel[],
  panelId: string,
): StoryboardPanelReference | null {
  for (const storyboard of localStoryboards) {
    const panel = getTextPanels(storyboard).find((candidate) => candidate.id === panelId)
    if (panel) {
      return {
        storyboardId: storyboard.id,
        panel,
      }
    }
  }
  return null
}

export function useStoryboardModalRuntime({
  projectId,
  videoRatio,
  localStoryboards,
  sortedStoryboards,
  storyboardStartIndex,
  editingPanel,
  setEditingPanel,
  assetPickerPanel,
  setAssetPickerPanel,
  aiDataPanel,
  setAIDataPanel,
  previewImage,
  setPreviewImage,
  getTextPanels,
  getPanelEditData,
  updatePanelEdit,
  savePanelWithData,
  getDefaultAssetsForClip,
  handleEditSubmit,
  handleAddCharacter,
  handleSetLocation,
  handleAddProp,
  updatePhotographyPlanMutation,
  updatePanelActingNotesMutation,
}: UseStoryboardModalRuntimeParams) {
  const imageEditDefaults = useMemo(() => {
    if (!editingPanel) return []
    const clipId = localStoryboards.find((storyboard) => storyboard.id === editingPanel.storyboardId)?.clipId || ''
    return getDefaultAssetsForClip(clipId)
  }, [editingPanel, getDefaultAssetsForClip, localStoryboards])

  const imageEditPreviousPanelImageOptions = useMemo<PreviousPanelImageOption[]>(() => {
    if (!editingPanel) return []

    let previousOptions: PreviousPanelImageOption[] = []
    const resolveImageUrl = (value: {
      imageUrl?: string | null
      imageMedia?: { url?: string | null; publicId?: string | null; storageKey?: string | null } | null
      media?: { url?: string | null; publicId?: string | null; storageKey?: string | null } | null
    }) => {
      const imageUrl = typeof value.imageUrl === 'string' ? value.imageUrl.trim() : ''
      if (imageUrl) return imageUrl
      const imageMediaUrl = typeof value.imageMedia?.url === 'string' ? value.imageMedia.url.trim() : ''
      if (imageMediaUrl) return imageMediaUrl
      const imageMediaPublicId = typeof value.imageMedia?.publicId === 'string' ? value.imageMedia.publicId.trim() : ''
      if (imageMediaPublicId) return imageMediaPublicId
      const imageMediaStorageKey = typeof value.imageMedia?.storageKey === 'string' ? value.imageMedia.storageKey.trim() : ''
      if (imageMediaStorageKey) return imageMediaStorageKey
      const mediaUrl = typeof value.media?.url === 'string' ? value.media.url.trim() : ''
      if (mediaUrl) return mediaUrl
      const mediaPublicId = typeof value.media?.publicId === 'string' ? value.media.publicId.trim() : ''
      if (mediaPublicId) return mediaPublicId
      const mediaStorageKey = typeof value.media?.storageKey === 'string' ? value.media.storageKey.trim() : ''
      return mediaStorageKey
    }
    const collectPanelImages = (panel: StoryboardPanel, globalPanelNumber: number): PreviousPanelImageOption[] => {
      const frames = Array.isArray(panel.frames)
        ? [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
        : []
      const frameOptions = frames
        .map((frame) => {
          const imageUrl = resolveImageUrl(frame)
          if (!imageUrl) return null
          return {
            id: `${panel.id}:frame:${frame.id}`,
            label: `分镜 ${globalPanelNumber} · F${frame.frameIndex + 1}${frame.frameRole ? ` · ${frame.frameRole}` : ''}`,
            imageUrl,
          }
        })
        .filter((option): option is PreviousPanelImageOption => option !== null)
      if (frameOptions.length > 0) return frameOptions

      const imageUrl = resolveImageUrl(panel)
      if (!imageUrl) return []
      return [{
        id: `${panel.id}:panel`,
        label: `分镜 ${globalPanelNumber} · 主图`,
        imageUrl,
      }]
    }

    for (const storyboard of sortedStoryboards) {
      const panels = getTextPanels(storyboard)
      const startIndex = storyboardStartIndex[storyboard.id] || 0
      for (let index = 0; index < panels.length; index += 1) {
        const panel = panels[index]
        if (storyboard.id === editingPanel.storyboardId && index === editingPanel.panelIndex) {
          return previousOptions
        }
        const options = collectPanelImages(panel, startIndex + index + 1)
        if (options.length > 0) {
          previousOptions = options
        }
      }
    }
    return []
  }, [editingPanel, getTextPanels, sortedStoryboards, storyboardStartIndex])

  const { aiDataRuntime, handleSaveAIData } = useStoryboardAiDataRuntime({
    aiDataPanel,
    localStoryboards,
    getTextPanels,
    getPanelEditData,
    updatePanelEdit,
    savePanelWithData,
    updatePhotographyPlanMutation,
    updatePanelActingNotesMutation,
  })

  const pickerPanelRuntime = useMemo(() => {
    if (!assetPickerPanel) return null
    return findPanelById(localStoryboards, getTextPanels, assetPickerPanel.panelId)
  }, [assetPickerPanel, getTextPanels, localStoryboards])

  return {
    projectId,
    videoRatio,
    editingPanel,
    imageEditDefaults,
    imageEditPreviousPanelImageOptions,
    handleEditSubmit,
    closeImageEditModal: () => setEditingPanel(null),

    aiDataPanel,
    aiDataRuntime,
    closeAIDataModal: () => setAIDataPanel(null),
    handleSaveAIData,

    previewImage,
    closePreviewImage: () => setPreviewImage(null),

    assetPickerPanel,
    pickerPanelRuntime,
    closeAssetPicker: () => setAssetPickerPanel(null),
    handleAddCharacter,
    handleSetLocation,
    handleAddProp,
    hasCharacterPicker: assetPickerPanel?.type === 'character',
    hasLocationPicker: assetPickerPanel?.type === 'location',
    hasPropPicker: assetPickerPanel?.type === 'prop',
  }
}
