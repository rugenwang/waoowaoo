'use client'

import { useCallback } from 'react'
import { Character, Location, NovelPromotionClip, NovelPromotionStoryboard, Prop } from '@/types/project'
import { PanelEditData } from '../../PanelEditForm'
import { SelectedAsset } from './useImageGeneration'
import { StoryboardPanel } from './useStoryboardState'
import { buildDefaultAssetsForClip } from './storyboard-panel-asset-utils'
import { useStoryboardBatchPanelGeneration } from './useStoryboardBatchPanelGeneration'

interface UseStoryboardPanelAssetActionsProps {
  clips: NovelPromotionClip[]
  characters: Character[]
  locations: Location[]
  props: Prop[]
  localStoryboards: NovelPromotionStoryboard[]
  sortedStoryboards: NovelPromotionStoryboard[]
  submittingPanelImageIds: Set<string>
  editingPanel: { storyboardId: string; panelIndex: number } | null
  setEditingPanel: (panel: { storyboardId: string; panelIndex: number } | null) => void
  setIsEpisodeBatchSubmitting: (value: boolean) => void
  getTextPanels: (storyboard: NovelPromotionStoryboard) => StoryboardPanel[]
  getPanelEditData: (panel: StoryboardPanel) => PanelEditData
  updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void
  debouncedSave: (panelId: string, storyboardId: string) => void
  regeneratePanelImage: (
    panelId: string,
    count?: number,
    force?: boolean,
    options?: { handoffRefreshOnSubmit?: boolean },
  ) => Promise<{ taskId?: string } | null>
  modifyPanelImage: (
    storyboardId: string,
    panelIndex: number,
    prompt: string,
    images: string[],
    assets: SelectedAsset[],
  ) => Promise<void>
  addCharacterToPanel: (
    panel: StoryboardPanel,
    characterName: string,
    appearance: string,
    storyboardId: string,
    getPanelEditData: (panel: StoryboardPanel) => PanelEditData,
    updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void,
  ) => void
  removeCharacterFromPanel: (
    panel: StoryboardPanel,
    index: number,
    storyboardId: string,
    getPanelEditData: (panel: StoryboardPanel) => PanelEditData,
    updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void,
  ) => void
  setPanelLocation: (
    panel: StoryboardPanel,
    locationName: string | null,
    storyboardId: string,
    updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void,
  ) => void
  addPropToPanel: (
    panel: StoryboardPanel,
    propName: string,
    storyboardId: string,
    getPanelEditData: (panel: StoryboardPanel) => PanelEditData,
    updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void,
  ) => void
  removePropFromPanel: (
    panel: StoryboardPanel,
    index: number,
    storyboardId: string,
    getPanelEditData: (panel: StoryboardPanel) => PanelEditData,
    updatePanelEdit: (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => void,
  ) => void
  assetPickerPanel: {
    panelId: string
    type: 'character' | 'location' | 'prop'
  } | null
  setAssetPickerPanel: (panel: { panelId: string; type: 'character' | 'location' | 'prop' } | null) => void
}

export function useStoryboardPanelAssetActions({
  clips,
  characters,
  locations,
  props,
  localStoryboards,
  sortedStoryboards,
  submittingPanelImageIds,
  editingPanel,
  setEditingPanel,
  setIsEpisodeBatchSubmitting,
  getTextPanels,
  getPanelEditData,
  updatePanelEdit,
  debouncedSave,
  regeneratePanelImage,
  modifyPanelImage,
  addCharacterToPanel,
  removeCharacterFromPanel,
  setPanelLocation,
  addPropToPanel,
  removePropFromPanel,
  assetPickerPanel,
  setAssetPickerPanel,
}: UseStoryboardPanelAssetActionsProps) {
  const getDefaultAssetsForClip = useCallback(
    (clipId: string): SelectedAsset[] =>
      buildDefaultAssetsForClip({ clipId, clips, characters, locations, props }),
    [characters, clips, locations, props],
  )

  const handleEditSubmit = useCallback(
    async (prompt: string, images: string[], assets: SelectedAsset[]) => {
      if (!editingPanel) return
      const { storyboardId, panelIndex } = editingPanel
      setEditingPanel(null)
      await modifyPanelImage(storyboardId, panelIndex, prompt, images, assets)
    },
    [editingPanel, modifyPanelImage, setEditingPanel],
  )

  const handlePanelUpdate = useCallback(
    (panelId: string, panel: StoryboardPanel, updates: Partial<PanelEditData>) => {
      updatePanelEdit(panelId, panel, updates)
      const storyboard = localStoryboards.find((item) => getTextPanels(item).some((itemPanel) => itemPanel.id === panelId))
      if (storyboard) {
        debouncedSave(panelId, storyboard.id)
      }
    },
    [debouncedSave, getTextPanels, localStoryboards, updatePanelEdit],
  )

  const handleAddCharacter = useCallback(
    (characterName: string, appearance: string) => {
      if (!assetPickerPanel || assetPickerPanel.type !== 'character') return

      const storyboard = localStoryboards.find((item) =>
        getTextPanels(item).some((panel) => panel.id === assetPickerPanel.panelId),
      )
      const panel = storyboard
        ? getTextPanels(storyboard).find((item) => item.id === assetPickerPanel.panelId)
        : null

      if (storyboard && panel) {
        addCharacterToPanel(panel, characterName, appearance, storyboard.id, getPanelEditData, updatePanelEdit)
      }
      setAssetPickerPanel(null)
    },
    [
      addCharacterToPanel,
      assetPickerPanel,
      getPanelEditData,
      getTextPanels,
      localStoryboards,
      setAssetPickerPanel,
      updatePanelEdit,
    ],
  )

  const handleSetLocation = useCallback(
    (locationName: string) => {
      if (!assetPickerPanel || assetPickerPanel.type !== 'location') return

      const storyboard = localStoryboards.find((item) =>
        getTextPanels(item).some((panel) => panel.id === assetPickerPanel.panelId),
      )
      const panel = storyboard
        ? getTextPanels(storyboard).find((item) => item.id === assetPickerPanel.panelId)
        : null

      if (storyboard && panel) {
        setPanelLocation(panel, locationName, storyboard.id, updatePanelEdit)
      }
      setAssetPickerPanel(null)
    },
    [assetPickerPanel, getTextPanels, localStoryboards, setAssetPickerPanel, setPanelLocation, updatePanelEdit],
  )

  const handleAddProp = useCallback(
    (propName: string) => {
      if (!assetPickerPanel || assetPickerPanel.type !== 'prop') return

      const storyboard = localStoryboards.find((item) =>
        getTextPanels(item).some((panel) => panel.id === assetPickerPanel.panelId),
      )
      const panel = storyboard
        ? getTextPanels(storyboard).find((item) => item.id === assetPickerPanel.panelId)
        : null

      if (storyboard && panel) {
        addPropToPanel(panel, propName, storyboard.id, getPanelEditData, updatePanelEdit)
      }
      setAssetPickerPanel(null)
    },
    [
      addPropToPanel,
      assetPickerPanel,
      getPanelEditData,
      getTextPanels,
      localStoryboards,
      setAssetPickerPanel,
      updatePanelEdit,
    ],
  )

  const handleRemoveCharacter = useCallback(
    (panel: StoryboardPanel, index: number, storyboardId: string) => {
      removeCharacterFromPanel(panel, index, storyboardId, getPanelEditData, updatePanelEdit)
    },
    [getPanelEditData, removeCharacterFromPanel, updatePanelEdit],
  )

  const handleRemoveLocation = useCallback(
    (panel: StoryboardPanel, storyboardId: string) => {
      setPanelLocation(panel, null, storyboardId, updatePanelEdit)
    },
    [setPanelLocation, updatePanelEdit],
  )

  const handleRemoveProp = useCallback(
    (panel: StoryboardPanel, index: number, storyboardId: string) => {
      removePropFromPanel(panel, index, storyboardId, getPanelEditData, updatePanelEdit)
    },
    [getPanelEditData, removePropFromPanel, updatePanelEdit],
  )
  const { queueMode, runningCount, pendingPanelCount, handleGenerateAllPanels } =
    useStoryboardBatchPanelGeneration({
      sortedStoryboards,
      submittingPanelImageIds,
      getTextPanels,
      regeneratePanelImage,
      setIsEpisodeBatchSubmitting,
    })

  return {
    getDefaultAssetsForClip,
    handleEditSubmit,
    handlePanelUpdate,
    handleAddCharacter,
    handleSetLocation,
    handleAddProp,
    handleRemoveCharacter,
    handleRemoveLocation,
    handleRemoveProp,
    queueMode,
    runningCount,
    pendingPanelCount,
    handleGenerateAllPanels,
  }
}
