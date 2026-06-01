'use client'

import type { PanelEditData } from '../../PanelEditForm'
import {
  useDuplicateProjectPanel,
  useMergeProjectPanelWithNext,
  useRefreshEpisodeData,
  useRefreshProjectAssets,
  useRefreshStoryboards,
  useSplitProjectPanelFrame,
  useUpdateProjectPanelPreviousTailReference,
} from '@/lib/query/hooks'
import { usePanelCrudActions } from './usePanelCrudActions'
import { usePanelInsertActions } from './usePanelInsertActions'
import { useStoryboardGroupActions } from './useStoryboardGroupActions'

interface UsePanelOperationsProps {
  projectId: string
  episodeId: string
  panelEditsRef: React.MutableRefObject<Record<string, PanelEditData>>
}

export function usePanelOperations({
  projectId,
  episodeId,
  panelEditsRef,
}: UsePanelOperationsProps) {
  const onRefresh = useRefreshProjectAssets(projectId)
  const refreshEpisode = useRefreshEpisodeData(projectId, episodeId)
  const refreshStoryboards = useRefreshStoryboards(episodeId)
  const duplicatePanelMutation = useDuplicateProjectPanel(projectId)
  const mergePanelWithNextMutation = useMergeProjectPanelWithNext(projectId)
  const splitPanelFrameMutation = useSplitProjectPanelFrame(projectId)
  const updatePanelPreviousTailReferenceMutation = useUpdateProjectPanelPreviousTailReference(projectId)

  const panelCrud = usePanelCrudActions({
    projectId,
    panelEditsRef,
    onRefresh,
  })

  const groupActions = useStoryboardGroupActions({
    projectId,
    episodeId,
    onRefresh,
  })

  const panelInsert = usePanelInsertActions({
    projectId,
    onRefresh,
  })

  const duplicatePanel = async (panelId: string) => {
    await duplicatePanelMutation.mutateAsync({ panelId })
    await onRefresh()
    refreshEpisode()
    refreshStoryboards()
  }

  const mergePanelWithNext = async (panelId: string) => {
    await mergePanelWithNextMutation.mutateAsync({ panelId })
    await onRefresh()
    refreshEpisode()
    refreshStoryboards()
  }

  const splitPanelFrame = async (frameId: string, placement: 'before' | 'after') => {
    await splitPanelFrameMutation.mutateAsync({ frameId, placement })
    await onRefresh()
    refreshEpisode()
    refreshStoryboards()
  }

  const updatePanelPreviousTailReference = async (payload: {
    panelId: string
    storyboardId: string
    panelIndex: number
    usePreviousPanelTailAsReference: boolean
  }) => {
    await updatePanelPreviousTailReferenceMutation.mutateAsync(payload)
    refreshEpisode()
    refreshStoryboards()
  }

  return {
    savingPanels: panelCrud.savingPanels,
    deletingPanelIds: panelCrud.deletingPanelIds,
    saveStateByPanel: panelCrud.saveStateByPanel,
    hasUnsavedByPanel: panelCrud.hasUnsavedByPanel,
    submittingStoryboardTextIds: groupActions.submittingStoryboardTextIds,
    addingStoryboardGroup: groupActions.addingStoryboardGroup,
    movingClipId: groupActions.movingClipId,
    insertingAfterPanelId: panelInsert.insertingAfterPanelId,

    savePanel: panelCrud.savePanel,
    savePanelWithData: panelCrud.savePanelWithData,
    debouncedSave: panelCrud.debouncedSave,
    retrySave: panelCrud.retrySave,
    addPanel: panelCrud.addPanel,
    deletePanel: panelCrud.deletePanel,
    deleteStoryboard: groupActions.deleteStoryboard,
    regenerateStoryboardText: groupActions.regenerateStoryboardText,
    addStoryboardGroup: groupActions.addStoryboardGroup,
    moveStoryboardGroup: groupActions.moveStoryboardGroup,
    addCharacterToPanel: panelCrud.addCharacterToPanel,
    removeCharacterFromPanel: panelCrud.removeCharacterFromPanel,
    setPanelLocation: panelCrud.setPanelLocation,
    addPropToPanel: panelCrud.addPropToPanel,
    removePropFromPanel: panelCrud.removePropFromPanel,
    insertPanel: panelInsert.insertPanel,
    duplicatePanel,
    mergePanelWithNext,
    splitPanelFrame,
    updatePanelPreviousTailReference,
  }
}
