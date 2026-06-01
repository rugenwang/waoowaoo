'use client'
import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { useTranslations } from 'next-intl'

import { useCallback } from 'react'
import type { NovelPromotionStoryboard } from '@/types/project'
import { extractErrorMessage } from '@/lib/errors/extract'
import { waitForTaskResult } from '@/lib/task/client'
import { useTaskQueue } from '@/lib/task-queue'
import type { SelectedAsset } from './useImageGeneration'
import {
  StoryboardImageMutationResult,
  getStoryboardPanels,
  isAbortError,
  updatePanelImageUrlInStoryboards,
} from './image-generation-runtime'

interface ModifyPanelMutationLike {
  mutateAsync: (payload: {
    storyboardId: string
    panelIndex: number
    panelId?: string
    modifyPrompt: string
    extraImageUrls: string[]
    selectedAssets: SelectedAsset[]
  }) => Promise<unknown>
}

interface UsePanelImageModificationParams {
  projectId: string
  localStoryboards: NovelPromotionStoryboard[]
  setLocalStoryboards: React.Dispatch<React.SetStateAction<NovelPromotionStoryboard[]>>
  modifyPanelMutation: ModifyPanelMutationLike
  setModifyingPanels: React.Dispatch<React.SetStateAction<Set<string>>>
  onSilentRefresh?: (() => void | Promise<void>) | null
  refreshEpisode: () => void
  refreshStoryboards: () => void
}

export function usePanelImageModification({
  projectId,
  localStoryboards,
  setLocalStoryboards,
  modifyPanelMutation,
  setModifyingPanels,
  onSilentRefresh,
  refreshEpisode,
  refreshStoryboards,
}: UsePanelImageModificationParams) {
  const t = useTranslations('storyboard')
  const taskQueue = useTaskQueue()
  const queueMode = taskQueue.enabled

  const refreshAfterModifyTask = useCallback(async (panelId: string) => {
    try {
      if (onSilentRefresh) {
        await onSilentRefresh()
      }
      refreshEpisode()
      refreshStoryboards()
    } finally {
      setModifyingPanels((previous) => {
        const next = new Set(previous)
        next.delete(panelId)
        return next
      })
    }
  }, [
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    setModifyingPanels,
  ])

  const modifyPanelImage = useCallback(
    async (
      storyboardId: string,
      panelIndex: number,
      prompt: string,
      images: string[],
      assets: SelectedAsset[],
    ) => {
      const storyboard = localStoryboards.find((item) => item.id === storyboardId)
      const panels = storyboard ? getStoryboardPanels(storyboard) : []
      const panel = panels[panelIndex]
      const panelId = panel?.id

      if (!panelId) {
        _ulogError('[modifyPanelImage] Panel not found:', { storyboardId, panelIndex })
        alert(t('messages.panelNotFound'))
        return
      }

      if (queueMode) {
        taskQueue.enqueue({
          id: `storyboard-modify:${panelId}:${Date.now()}`,
          group: 'storyboard',
          projectId,
          target: {
            targetType: 'NovelPromotionPanel',
            targetId: panelId,
            types: ['modify_asset_image'],
          },
          uiKey: `panel-${panelId}`,
          label: `修改分镜：镜头 ${panelId.slice(0, 6)}`,
          submit: async () => {
            const data = await modifyPanelMutation.mutateAsync({
              storyboardId,
              panelIndex,
              panelId,
              modifyPrompt: prompt,
              extraImageUrls: images,
              selectedAssets: assets,
            })
            const result = (data || {}) as StoryboardImageMutationResult
            return { taskId: String(result.taskId || '') }
          },
          onDone: async () => {
            await refreshAfterModifyTask(panelId)
          },
          onFail: async () => {
            await refreshAfterModifyTask(panelId)
          },
        })
        return
      }

      setModifyingPanels((previous) => new Set(previous).add(panelId))
      let isAsync = false
      try {
        const data = await modifyPanelMutation.mutateAsync({
          storyboardId,
          panelIndex,
          panelId,
          modifyPrompt: prompt,
          extraImageUrls: images,
          selectedAssets: assets,
        })
        const result = (data || {}) as StoryboardImageMutationResult

        if (result.async) {
          _ulogInfo(`[Modify Panel] 异步任务已提交: ${panelId}`)
          isAsync = true
          const taskId = String(result.taskId || '').trim()
          if (onSilentRefresh) {
            await onSilentRefresh()
          }
          refreshEpisode()
          refreshStoryboards()
          if (taskId) {
            void waitForTaskResult(taskId)
              .catch((error: unknown) => {
                _ulogError('[modifyPanelImage] async task failed:', error)
              })
              .finally(() => {
                void refreshAfterModifyTask(panelId)
              })
          }
          return
        }

        if (result.imageUrl) {
          setLocalStoryboards((previous) =>
            updatePanelImageUrlInStoryboards(previous, storyboardId, panelIndex, result.imageUrl as string),
          )
        }
      } catch (error: unknown) {
        if (isAbortError(error)) {
          _ulogInfo('请求被中断（可能是页面刷新），后端仍在执行')
          return
        }
        alert(
          t('messages.modifyFailed', {
            error: extractErrorMessage(error, t('common.unknownError')),
          }),
        )
      } finally {
        if (!isAsync) {
          setModifyingPanels((previous) => {
            const next = new Set(previous)
            next.delete(panelId)
            return next
          })
        }
      }
    },
    [
      localStoryboards,
      modifyPanelMutation,
      onSilentRefresh,
      projectId,
      queueMode,
      refreshEpisode,
      refreshAfterModifyTask,
      refreshStoryboards,
      setLocalStoryboards,
      setModifyingPanels,
      taskQueue,
      t,
    ],
  )

  return {
    modifyPanelImage,
  }
}
