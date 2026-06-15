'use client'

import { logError as _ulogError } from '@/lib/logging/core'
import { useState, useCallback, useEffect } from 'react'
import { NovelPromotionStoryboard } from '@/types/project'
import { usePanelCandidates } from './usePanelCandidates'
import { useTaskQueue } from '@/lib/task-queue'
import {
  useClearProjectStoryboardError,
  useRefreshProjectAssets,
  useRefreshEpisodeData,
  useRefreshStoryboards,
  useRegenerateProjectPanelImage,
  useRegenerateProjectPanelFrameImage,
  useUploadProjectPanelImage,
  useUploadProjectPanelFrameImage,
  useModifyProjectStoryboardImage,
  useDownloadProjectImages,
} from '@/lib/query/hooks'
import {
  getStoryboardPanels,
  reconcileModifyingPanelIds,
  reconcileSubmittingPanelImageIds,
} from './image-generation-runtime'
import { usePanelImageRegeneration } from './usePanelImageRegeneration'
import { usePanelImageModification } from './usePanelImageModification'
import { usePanelImageDownload } from './usePanelImageDownload'

export interface SelectedAsset {
  id: string
  name: string
  type: 'character' | 'location' | 'prop'
  imageUrl: string | null
  appearanceId?: number
  appearanceName?: string
}

interface UseStoryboardImageGenerationProps {
  projectId: string
  episodeId?: string
  localStoryboards: NovelPromotionStoryboard[]
  setLocalStoryboards: React.Dispatch<React.SetStateAction<NovelPromotionStoryboard[]>>
}

export function useStoryboardImageGeneration({
  projectId,
  episodeId,
  localStoryboards,
  setLocalStoryboards,
}: UseStoryboardImageGenerationProps) {
  const onSilentRefresh = useRefreshProjectAssets(projectId)
  const refreshEpisode = useRefreshEpisodeData(projectId, episodeId ?? null)
  const refreshStoryboards = useRefreshStoryboards(episodeId ?? null)
  const regeneratePanelMutation = useRegenerateProjectPanelImage(projectId)
  const regeneratePanelFrameMutation = useRegenerateProjectPanelFrameImage(projectId)
  const uploadPanelImageMutation = useUploadProjectPanelImage(projectId)
  const uploadPanelFrameImageMutation = useUploadProjectPanelFrameImage(projectId)
  const modifyPanelMutation = useModifyProjectStoryboardImage(projectId)
  const downloadImagesMutation = useDownloadProjectImages(projectId)
  const clearStoryboardErrorMutation = useClearProjectStoryboardError(projectId)

  const submittingStoryboardIds = new Set<string>(
    localStoryboards
      .filter((storyboard) => storyboard.storyboardTaskRunning)
      .map((storyboard) => storyboard.id),
  )

  const [submittingPanelImageIds, setSubmittingPanelImageIds] = useState<Set<string>>(new Set())
  const [selectingCandidateIds] = useState<Set<string>>(new Set())
  const [editingPanel, setEditingPanel] = useState<{ storyboardId: string; panelIndex: number } | null>(null)
  const [modifyingPanels, setModifyingPanels] = useState<Set<string>>(new Set())
  const [isDownloadingImages, setIsDownloadingImages] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const taskQueue = useTaskQueue()

  const {
    panelCandidateIndex,
    setPanelCandidateIndex,
    getPanelCandidates,
    ensurePanelCandidatesInitialized,
    selectPanelCandidateIndex,
    confirmPanelCandidate,
    cancelPanelCandidate,
  } = usePanelCandidates({
    projectId,
    episodeId,
    onConfirmed: (panelId, confirmedImageUrl) => {
      setLocalStoryboards((previousStoryboards) =>
        previousStoryboards.map((storyboard) => {
          const panels = getStoryboardPanels(storyboard)
          let changed = false
          const updatedPanels = panels.map((panel) => {
            if (panel.id !== panelId) return panel
            changed = true
            return {
              ...panel,
              imageUrl: confirmedImageUrl ?? panel.imageUrl,
              candidateImages: null,
              imageTaskRunning: false,
            }
          })
          return changed ? { ...storyboard, panels: updatedPanels } : storyboard
        }),
      )
    },
  })

  useEffect(() => {
    localStoryboards.forEach((storyboard) => {
      getStoryboardPanels(storyboard).forEach((panel) => {
        ensurePanelCandidatesInitialized(panel)
      })
    })
  }, [ensurePanelCandidatesInitialized, localStoryboards])

  useEffect(() => {
    if (submittingPanelImageIds.size === 0) return
    setSubmittingPanelImageIds((previousIds) =>
      reconcileSubmittingPanelImageIds(previousIds, localStoryboards),
    )
  }, [localStoryboards, submittingPanelImageIds.size])

  useEffect(() => {
    if (modifyingPanels.size === 0) return
    setModifyingPanels((previousIds) => reconcileModifyingPanelIds(previousIds, localStoryboards))
  }, [localStoryboards, modifyingPanels.size])

  const { regeneratePanelImage, regenerateAllPanelsIndividually } = usePanelImageRegeneration({
    projectId,
    localStoryboards,
    setLocalStoryboards,
    submittingPanelImageIds,
    setSubmittingPanelImageIds,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    regeneratePanelMutation,
    selectPanelCandidateIndex,
  })

  const { modifyPanelImage } = usePanelImageModification({
    projectId,
    localStoryboards,
    setLocalStoryboards,
    modifyPanelMutation,
    setModifyingPanels,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
  })

  const { downloadAllImages } = usePanelImageDownload({
    localStoryboards,
    downloadImagesMutation,
    setIsDownloadingImages,
  })

  const clearStoryboardError = useCallback(async (storyboardId: string) => {
    let snapshot: NovelPromotionStoryboard[] | null = null
    setLocalStoryboards((previousStoryboards) =>
      {
        snapshot = previousStoryboards
        return previousStoryboards.map((storyboard) =>
        storyboard.id === storyboardId ? { ...storyboard, lastError: null } : storyboard,
      )
      },
    )

    try {
      await clearStoryboardErrorMutation.mutateAsync({ storyboardId })
      if (onSilentRefresh) {
        await onSilentRefresh()
      }
      refreshEpisode()
      refreshStoryboards()
    } catch (error: unknown) {
      if (snapshot) {
        setLocalStoryboards(snapshot)
      }
      _ulogError('[clearStoryboardError] persist failed:', error)
    }
  }, [
    clearStoryboardErrorMutation,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    setLocalStoryboards,
  ])

  const applyUploadedPanelImageResult = useCallback((
    panelId: string,
    result: {
      imageUrl?: string | null
      frameId?: string | null
      frameImageUpdated?: boolean
    },
  ) => {
    if (result?.imageUrl) {
      setLocalStoryboards((previousStoryboards) =>
        previousStoryboards.map((storyboard) => {
          const panels = getStoryboardPanels(storyboard)
          let changed = false
          const updatedPanels = panels.map((panel) => {
            if (panel.id !== panelId) return panel
            changed = true
            const frames = Array.isArray(panel.frames) ? panel.frames : []
            const shouldPatchFirstFrame = result.frameImageUpdated !== false
            const updatedFrames = shouldPatchFirstFrame
              ? frames.map((frame, index) => {
                const isFirstFrame = result.frameId ? frame.id === result.frameId : index === 0
                if (!isFirstFrame) return frame
                return {
                  ...frame,
                  imageUrl: result.imageUrl ?? frame.imageUrl,
                  generationStatus: 'completed',
                  errorMessage: null,
                }
              })
              : frames
            return {
              ...panel,
              previousImageUrl: panel.imageUrl ?? null,
              imageUrl: result.imageUrl ?? panel.imageUrl,
              candidateImages: null,
              imageTaskRunning: false,
              ...(updatedFrames !== frames ? { frames: updatedFrames } : {}),
            }
          })
          return changed ? { ...storyboard, panels: updatedPanels } : storyboard
        }),
      )
    }
  }, [setLocalStoryboards])

  const uploadPanelImage = useCallback(async (panelId: string, file: File) => {
    const result = await uploadPanelImageMutation.mutateAsync({ panelId, file }) as {
      imageUrl?: string | null
      frameId?: string | null
      frameImageUpdated?: boolean
    }
    applyUploadedPanelImageResult(panelId, result)
    if (onSilentRefresh) {
      await onSilentRefresh()
    }
    refreshEpisode()
    refreshStoryboards()
  }, [
    applyUploadedPanelImageResult,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    uploadPanelImageMutation,
  ])

  const uploadPanelImageFromSource = useCallback(async (panelId: string, sourceImageUrl: string) => {
    const result = await uploadPanelImageMutation.mutateAsync({ panelId, sourceImageUrl }) as {
      imageUrl?: string | null
      frameId?: string | null
      frameImageUpdated?: boolean
    }
    applyUploadedPanelImageResult(panelId, result)
    if (onSilentRefresh) {
      await onSilentRefresh()
    }
    refreshEpisode()
    refreshStoryboards()
  }, [
    applyUploadedPanelImageResult,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    uploadPanelImageMutation,
  ])

  useEffect(() => {
    const hasProcessingFrame = localStoryboards.some((storyboard) =>
      getStoryboardPanels(storyboard).some((panel) =>
        Array.isArray(panel.frames)
        && panel.frames.some((frame) => frame.generationStatus === 'processing'),
      ),
    )
    if (!hasProcessingFrame && submittingPanelImageIds.size === 0) return
    const timer = window.setInterval(() => {
      refreshEpisode()
      refreshStoryboards()
    }, 2500)
    return () => window.clearInterval(timer)
  }, [localStoryboards, refreshEpisode, refreshStoryboards, submittingPanelImageIds.size])

  const applyUploadedPanelFrameImageResult = useCallback((result: {
      frameId?: string
      panelId?: string
      frameIndex?: number
      imageUrl?: string | null
      panelImageUpdated?: boolean
    }) => {
    const nextImageUrl = result?.imageUrl || null

    if (result?.frameId && nextImageUrl) {
      setLocalStoryboards((previousStoryboards) =>
        previousStoryboards.map((storyboard) => {
          const panels = getStoryboardPanels(storyboard)
          let storyboardChanged = false
          const updatedPanels = panels.map((panel) => {
            const frames = Array.isArray(panel.frames) ? panel.frames : []
            let frameChanged = false
            const updatedFrames = frames.map((frame) => {
              if (frame.id !== result.frameId) return frame
              frameChanged = true
              return {
                ...frame,
                imageUrl: nextImageUrl,
                generationStatus: 'completed',
                errorMessage: null,
              }
            })
            const shouldUpdatePanelImage =
              Boolean(result.panelImageUpdated) &&
              (!result.panelId || panel.id === result.panelId)

            if (!frameChanged && !shouldUpdatePanelImage) return panel

            storyboardChanged = true
            return {
              ...panel,
              ...(frameChanged ? { frames: updatedFrames } : {}),
              ...(shouldUpdatePanelImage
                ? {
                  previousImageUrl: panel.imageUrl ?? null,
                  imageUrl: nextImageUrl,
                  candidateImages: null,
                  imageTaskRunning: false,
                }
                : {}),
            }
          })
          return storyboardChanged ? { ...storyboard, panels: updatedPanels } : storyboard
        }),
      )
    }
  }, [setLocalStoryboards])

  const uploadPanelFrameImage = useCallback(async (frameId: string, file: File) => {
    const result = await uploadPanelFrameImageMutation.mutateAsync({ frameId, file }) as {
      frameId?: string
      panelId?: string
      frameIndex?: number
      imageUrl?: string | null
      panelImageUpdated?: boolean
    }
    applyUploadedPanelFrameImageResult(result)

    if (onSilentRefresh) {
      await onSilentRefresh()
    }
    refreshEpisode()
    refreshStoryboards()
  }, [
    applyUploadedPanelFrameImageResult,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    uploadPanelFrameImageMutation,
  ])

  const uploadPanelFrameImageFromSource = useCallback(async (frameId: string, sourceImageUrl: string) => {
    const result = await uploadPanelFrameImageMutation.mutateAsync({ frameId, sourceImageUrl }) as {
      frameId?: string
      panelId?: string
      frameIndex?: number
      imageUrl?: string | null
      panelImageUpdated?: boolean
    }
    applyUploadedPanelFrameImageResult(result)

    if (onSilentRefresh) {
      await onSilentRefresh()
    }
    refreshEpisode()
    refreshStoryboards()
  }, [
    applyUploadedPanelFrameImageResult,
    onSilentRefresh,
    refreshEpisode,
    refreshStoryboards,
    uploadPanelFrameImageMutation,
  ])

  const markPanelFrameGenerationState = useCallback((
    panelId: string,
    frameId: string,
    state: 'processing' | 'failed',
    errorMessage: string | null = null,
  ) => {
    setLocalStoryboards((previousStoryboards) =>
      previousStoryboards.map((storyboard) => {
        const panels = getStoryboardPanels(storyboard)
        let storyboardChanged = false
        const updatedPanels = panels.map((panel) => {
          if (panel.id !== panelId) return panel
          const frames = Array.isArray(panel.frames) ? panel.frames : []
          let frameChanged = false
          const updatedFrames = frames.map((frame) => {
            if (frame.id !== frameId) return frame
            frameChanged = true
            return {
              ...frame,
              generationStatus: state,
              errorMessage,
              updatedAt: new Date().toISOString(),
            }
          })
          if (!frameChanged) return panel
          storyboardChanged = true
          return {
            ...panel,
            frames: updatedFrames,
          }
        })
        return storyboardChanged ? { ...storyboard, panels: updatedPanels } : storyboard
      }),
    )
  }, [setLocalStoryboards])

  const regeneratePanelFrameImage = useCallback(async (panelId: string, frameId: string) => {
    const panel = localStoryboards
      .flatMap((storyboard) => getStoryboardPanels(storyboard))
      .find((item) => item.id === panelId)
    const usePreviousPanelTailAsReference =
      typeof panel?.usePreviousPanelTailAsReference === 'boolean'
        ? panel.usePreviousPanelTailAsReference
        : undefined

    if (taskQueue.enabled) {
      taskQueue.enqueue({
        id: `storyboard-frame:${frameId}:${Date.now()}`,
        group: 'storyboard',
        projectId,
        target: {
          targetType: 'NovelPromotionPanelFrame',
          targetId: frameId,
          types: ['image_panel', 'panel_variant', 'modify_asset_image'],
        },
        uiKey: `panel-frame-${frameId}`,
        label: `关键帧：${frameId.slice(0, 6)}`,
        submit: async () => {
          markPanelFrameGenerationState(panelId, frameId, 'processing')
          const data = await regeneratePanelFrameMutation.mutateAsync({
            panelId,
            frameId,
            usePreviousPanelTailAsReference,
          }) as { taskId?: string }
          return { taskId: String(data?.taskId || '') }
        },
        onDone: async () => {
          await Promise.all([
            onSilentRefresh ? onSilentRefresh() : Promise.resolve(),
            refreshEpisode(),
            refreshStoryboards(),
          ])
        },
        onFail: async () => {
          markPanelFrameGenerationState(panelId, frameId, 'failed')
          await Promise.all([
            onSilentRefresh ? onSilentRefresh() : Promise.resolve(),
            refreshEpisode(),
            refreshStoryboards(),
          ])
        },
      })
      return null
    }

    markPanelFrameGenerationState(panelId, frameId, 'processing')

    try {
      const result = await regeneratePanelFrameMutation.mutateAsync({
        panelId,
        frameId,
        usePreviousPanelTailAsReference,
      }) as { async?: boolean; taskId?: string }
      if (result?.async) {
        if (onSilentRefresh) await onSilentRefresh()
        refreshEpisode()
        refreshStoryboards()
        return result.taskId ? { taskId: String(result.taskId) } : null
      }
      if (onSilentRefresh) await onSilentRefresh()
      refreshEpisode()
      refreshStoryboards()
      return null
    } catch (error: unknown) {
      markPanelFrameGenerationState(
        panelId,
        frameId,
        'failed',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }, [
    markPanelFrameGenerationState,
    localStoryboards,
    onSilentRefresh,
    projectId,
    refreshEpisode,
    refreshStoryboards,
    regeneratePanelFrameMutation,
    taskQueue,
  ])

  return {
    submittingStoryboardIds,
    submittingPanelImageIds,
    selectingCandidateIds,
    panelCandidateIndex,
    setPanelCandidateIndex,
    editingPanel,
    setEditingPanel,
    modifyingPanels,
    isDownloadingImages,
    previewImage,
    setPreviewImage,
    regeneratePanelImage,
    regenerateAllPanelsIndividually,
    selectPanelCandidate: confirmPanelCandidate,
    selectPanelCandidateIndex,
    cancelPanelCandidate,
    getPanelCandidates,
    modifyPanelImage,
    uploadPanelImage,
    uploadPanelImageFromSource,
    uploadPanelFrameImage,
    uploadPanelFrameImageFromSource,
    regeneratePanelFrameImage,
    downloadAllImages,
    clearStoryboardError,
  }
}
