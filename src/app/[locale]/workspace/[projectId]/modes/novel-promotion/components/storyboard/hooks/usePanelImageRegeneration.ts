'use client'
import { logInfo as _ulogInfo, logWarn as _ulogWarn } from '@/lib/logging/core'

import { useCallback } from 'react'
import type { NovelPromotionStoryboard } from '@/types/project'
import { useTaskQueue } from '@/lib/task-queue'
import {
  StoryboardImageMutationResult,
  getStoryboardPanels,
  isAbortError,
} from './image-generation-runtime'

interface RegeneratePanelMutationLike {
  mutateAsync: (payload: { panelId: string; count: number }) => Promise<unknown>
}

interface UsePanelImageRegenerationParams {
  projectId: string
  localStoryboards: NovelPromotionStoryboard[]
  setLocalStoryboards: React.Dispatch<React.SetStateAction<NovelPromotionStoryboard[]>>
  submittingPanelImageIds: Set<string>
  setSubmittingPanelImageIds: React.Dispatch<React.SetStateAction<Set<string>>>
  onSilentRefresh?: (() => void | Promise<void>) | null
  refreshEpisode: () => void
  refreshStoryboards: () => void
  regeneratePanelMutation: RegeneratePanelMutationLike
  selectPanelCandidateIndex: (panelId: string, index: number) => void
}

export function usePanelImageRegeneration({
  projectId,
  localStoryboards,
  submittingPanelImageIds,
  setSubmittingPanelImageIds,
  onSilentRefresh,
  refreshEpisode,
  refreshStoryboards,
  regeneratePanelMutation,
  selectPanelCandidateIndex,
}: UsePanelImageRegenerationParams) {
  const taskQueue = useTaskQueue()
  const queueMode = taskQueue.enabled

  const regeneratePanelImage = useCallback(
    async (
      panelId: string,
      count: number = 1,
      force: boolean = false,
      options?: { handoffRefreshOnSubmit?: boolean },
    ): Promise<{ taskId?: string } | null> => {
      if (queueMode) {
        taskQueue.enqueue({
          id: `storyboard-single:${panelId}:${Date.now()}`,
          group: 'storyboard',
          projectId,
          target: { targetType: 'NovelPromotionPanel', targetId: panelId, types: ['image_panel', 'panel_variant', 'modify_asset_image'] },
          uiKey: `panel-${panelId}`,
          label: `分镜：镜头 ${panelId.slice(0, 6)}`,
          submit: async () => {
            const data = await regeneratePanelMutation.mutateAsync({ panelId, count }) as any
            const taskId = String((data as any)?.taskId || '')
            return { taskId }
          },
          onDone: async () => {
            if (onSilentRefresh) await onSilentRefresh()
            refreshEpisode()
            refreshStoryboards()
          },
          onFail: async () => {
            if (onSilentRefresh) await onSilentRefresh()
            refreshEpisode()
            refreshStoryboards()
          },
        })
        return null
      }

      if (!force && submittingPanelImageIds.has(panelId)) return null

      setSubmittingPanelImageIds((previous) => new Set(previous).add(panelId))

      let handoffToTaskState = false
      try {
        const data = await regeneratePanelMutation.mutateAsync({ panelId, count })
        const result = (data || {}) as StoryboardImageMutationResult

        if (result.async) {
          _ulogInfo(`[regeneratePanelImage] async submitted: ${panelId}`)
          handoffToTaskState = true
          if (options?.handoffRefreshOnSubmit !== false) {
            if (onSilentRefresh) {
              await onSilentRefresh()
            }
            refreshEpisode()
            refreshStoryboards()
          }
          return result.taskId ? { taskId: String(result.taskId) } : null
        }

        if (onSilentRefresh) {
          await onSilentRefresh()
        }
        refreshEpisode()
        refreshStoryboards()
        selectPanelCandidateIndex(panelId, 0)
        return null
      } catch (error: unknown) {
        if (isAbortError(error)) return null
        // Mutation errors (e.g. network failure, API 500) are transient.
        // The task was never created in the database, so we log and let user retry.
        _ulogWarn(`[regeneratePanelImage] mutation failed for panel ${panelId}:`, error)
        return null
      } finally {
        if (handoffToTaskState) return null
        setSubmittingPanelImageIds((previous) => {
          const next = new Set(previous)
          next.delete(panelId)
          return next
        })
      }
    },
    [
      projectId,
      queueMode,
      onSilentRefresh,
      refreshEpisode,
      refreshStoryboards,
      regeneratePanelMutation,
      selectPanelCandidateIndex,
      setSubmittingPanelImageIds,
      submittingPanelImageIds,
      taskQueue,
    ],
  )

  const regenerateAllPanelsIndividually = useCallback(async (storyboardId: string) => {
    const storyboard = localStoryboards.find((item) => item.id === storyboardId)
    if (!storyboard) return

    const panels = getStoryboardPanels(storyboard)
    if (panels.length === 0) return

    const panelsToGenerate = panels.filter(
      (panel) => !panel.imageUrl && !panel.imageTaskRunning && !submittingPanelImageIds.has(panel.id),
    )
    if (panelsToGenerate.length === 0) return

    await Promise.all(panelsToGenerate.map((panel) => regeneratePanelImage(panel.id)))
  }, [localStoryboards, regeneratePanelImage, submittingPanelImageIds])

  return {
    regeneratePanelImage,
    regenerateAllPanelsIndividually,
  }
}
