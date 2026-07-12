'use client'

import { logError as _ulogError, logInfo as _ulogInfo } from '@/lib/logging/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api-fetch'
import { queryKeys } from '@/lib/query/keys'
import {
  VideoToolbar,
  type VideoGenerationOptionValue,
  type VideoGenerationOptions,
  type VideoModelOption,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import { AppIcon } from '@/components/ui/icons'
import {
  useDownloadRemoteBlob,
  useListProjectEpisodeVideoUrls,
  useMatchedVoiceLines,
  useUpdateProjectPanelDuration,
  useUpdateProjectPanelLink,
  useUpdateProjectConfig,
} from '@/lib/query/hooks'
import { useUploadProjectPanelVideo } from '@/lib/query/mutations/upload-panel-video'
import { useLipSync } from '@/lib/query/hooks/useStoryboards'
import ImagePreviewModal from '@/components/ui/ImagePreviewModal'
import { ModelCapabilityDropdown } from '@/components/ui/config-modals/ModelCapabilityDropdown'
import VideoTimelinePanel from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/VideoTimelinePanel'
import VideoRenderPanel from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video-stage/VideoRenderPanel'
import type { VideoStageShellProps } from './video-stage-runtime/types'
import {
  type EffectiveVideoCapabilityDefinition,
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'
import { useVideoTaskStates } from './video-stage-runtime/useVideoTaskStates'
import { useVideoPanelsProjection } from './video-stage-runtime/useVideoPanelsProjection'
import { useVideoPromptState } from './video-stage-runtime/useVideoPromptState'
import { useVideoPanelLinking } from './video-stage-runtime/useVideoPanelLinking'
import { shouldBatchLinkAdjacentPanels } from './video-stage-runtime/first-last-frame-link-candidates'
import { useVideoVoiceLines } from './video-stage-runtime/useVideoVoiceLines'
import { useVideoDownloadAll } from './video-stage-runtime/useVideoDownloadAll'
import { useVideoStageUiState } from './video-stage-runtime/useVideoStageUiState'
import { useVideoPanelViewport } from './video-stage-runtime/useVideoPanelViewport'
import { useVideoFirstLastFrameFlow } from './video-stage-runtime/useVideoFirstLastFrameFlow'
import { filterNormalVideoModelOptions } from '@/lib/model-capabilities/video-model-options'
import {
  buildVideoSubmissionKey,
  createVideoSubmissionBaseline,
  shouldResolveVideoSubmissionLock,
  type VideoSubmissionBaseline,
} from './video-stage-runtime/immediate-video-submission'
import { useTaskQueue } from '@/lib/task-queue'

export type { VideoStageShellProps } from './video-stage-runtime/types'

type BatchCapabilityDefinition = EffectiveVideoCapabilityDefinition

interface BatchCapabilityField {
  field: string
  label: string
  labelKey?: string
  unitKey?: string
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

export function useVideoStageRuntime({
  projectId,
  episodeId,
  storyboards,
  clips,
  defaultVideoModel,
  capabilityOverrides,
  videoRatio = '16:9',
  userVideoModels,
  onGenerateVideo,
  onGenerateAllVideos,
  onBack,
  onUpdateVideoPrompt,
  onUpdatePanelVideoModel,
  onOpenAssetLibraryForCharacter,
  onEnterEditor,
}: VideoStageShellProps) {
  const t = useTranslations('video')
  const queryClient = useQueryClient()
  const taskQueue = useTaskQueue()
  const queueMode = taskQueue.enabled

  const {
    panelVideoPreference,
    voiceLinesExpanded,
    previewImage,
    setPreviewImage,
    toggleVoiceLinesExpanded,
    toggleLipSyncVideo,
    closePreviewImage,
  } = useVideoStageUiState()

  const {
    panelRefs,
    highlightedPanelKey,
    locateVoiceLinePanel,
  } = useVideoPanelViewport()

  const lipSyncMutation = useLipSync(projectId, episodeId)
  const uploadVideoMutation = useUploadProjectPanelVideo(projectId, episodeId)
  const listEpisodeVideoUrlsMutation = useListProjectEpisodeVideoUrls(projectId)
  const updatePanelLinkMutation = useUpdateProjectPanelLink(projectId)
  const updatePanelDurationMutation = useUpdateProjectPanelDuration(projectId)
  const updateProjectConfigMutation = useUpdateProjectConfig(projectId)
  const downloadRemoteBlobMutation = useDownloadRemoteBlob()
  const matchedVoiceLinesQuery = useMatchedVoiceLines(projectId, episodeId)

  const handleUpdateVideoCapabilityOverride = useCallback(async (
    modelKey: string,
    field: string,
    rawValue: string,
    sample: VideoGenerationOptionValue,
  ) => {
    // duration 改为分镜级（NovelPromotionPanel.duration），不允许写入 capabilityOverrides，避免影响其它分镜
    if (field === 'duration') return
    const normalizedModelKey = typeof modelKey === 'string' ? modelKey.trim() : ''
    if (!normalizedModelKey) return
    const nextOverrides: Record<string, Record<string, VideoGenerationOptionValue>> = {
      ...(capabilityOverrides as unknown as Record<string, Record<string, VideoGenerationOptionValue>>),
    }

    const prevModelSelection = nextOverrides[normalizedModelKey] && typeof nextOverrides[normalizedModelKey] === 'object'
      ? { ...nextOverrides[normalizedModelKey] }
      : {}

    if (rawValue === '') {
      delete prevModelSelection[field]
    } else {
      const parsed: VideoGenerationOptionValue = (() => {
        if (typeof sample === 'number') return Number(rawValue)
        if (typeof sample === 'boolean') return rawValue === 'true'
        return rawValue
      })()
      prevModelSelection[field] = parsed
    }

    nextOverrides[normalizedModelKey] = prevModelSelection
    try {
      await updateProjectConfigMutation.mutateAsync({
        key: 'capabilityOverrides',
        value: nextOverrides,
      })
    } catch (err) {
      _ulogError('update capabilityOverrides failed:', err)
    }
  }, [capabilityOverrides, updateProjectConfigMutation])

  const handleUpdatePanelDuration = useCallback(async (
    storyboardId: string,
    panelIndex: number,
    duration: number | null,
  ) => {
    const panelKey = `${storyboardId}-${panelIndex}`
    setPanelDurationOverrides((previous) => {
      const next = new Map(previous)
      next.set(panelKey, duration)
      return next
    })
    try {
      await updatePanelDurationMutation.mutateAsync({
        storyboardId,
        panelIndex,
        duration,
      })
    } catch (err) {
      setPanelDurationOverrides((previous) => {
        const next = new Map(previous)
        next.delete(panelKey)
        return next
      })
      _ulogError('update panel duration failed:', err)
    }
  }, [updatePanelDurationMutation])

  const { panelVideoStates, panelLipStates } = useVideoTaskStates({
    projectId,
    storyboards,
  })
  const [panelDurationOverrides, setPanelDurationOverrides] = useState<Map<string, number | null>>(new Map())

  const { allPanels: rawAllPanels } = useVideoPanelsProjection({
    storyboards,
    clips,
    panelVideoStates,
    panelLipStates,
  })

  const allPanels = useMemo(() => {
    if (panelDurationOverrides.size === 0) return rawAllPanels
    return rawAllPanels.map((panel) => {
      const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
      if (!panelDurationOverrides.has(panelKey)) return panel
      const overrideDuration = panelDurationOverrides.get(panelKey)
      return {
        ...panel,
        textPanel: panel.textPanel
          ? {
            ...panel.textPanel,
            duration: overrideDuration ?? undefined,
          }
          : panel.textPanel,
      }
    })
  }, [panelDurationOverrides, rawAllPanels])

  useEffect(() => {
    if (panelDurationOverrides.size === 0) return
    setPanelDurationOverrides((previous) => {
      let changed = false
      const next = new Map(previous)
      for (const [panelKey, overrideDuration] of previous.entries()) {
        const matchedPanel = rawAllPanels.find((panel) => `${panel.storyboardId}-${panel.panelIndex}` === panelKey)
        const persistedDuration =
          typeof matchedPanel?.textPanel?.duration === 'number' && Number.isFinite(matchedPanel.textPanel.duration)
            ? matchedPanel.textPanel.duration
            : null
        if (persistedDuration === overrideDuration) {
          next.delete(panelKey)
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [panelDurationOverrides, rawAllPanels])

  const {
    savingPrompts,
    getLocalPrompt,
    updateLocalPrompt,
    savePrompt,
  } = useVideoPromptState({
    allPanels,
    onUpdateVideoPrompt,
  })

  const { linkedPanels, handleToggleLink, handleSetLinks } = useVideoPanelLinking({
    allPanels,
    updatePanelLinkMutation,
  })
  const [isBatchUpdatingFirstLastFrames, setIsBatchUpdatingFirstLastFrames] = useState(false)

  const firstLastFrameLinkCandidates = useMemo(() => {
    const candidates: Array<{
      panelKey: string
      storyboardId: string
      panelIndex: number
      alreadyLinked: boolean
    }> = []
    for (let index = 0; index < allPanels.length - 1; index += 1) {
      const panel = allPanels[index]
      const nextPanel = allPanels[index + 1]
      if (!shouldBatchLinkAdjacentPanels(
        panel.textPanel?.characters,
        nextPanel.textPanel?.characters,
      )) {
        continue
      }
      const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
      candidates.push({
        panelKey,
        storyboardId: panel.storyboardId,
        panelIndex: panel.panelIndex,
        alreadyLinked: linkedPanels.get(panelKey) === true,
      })
    }
    return candidates
  }, [allPanels, linkedPanels])

  const firstLastFrameUnlinkedCount = useMemo(
    () => firstLastFrameLinkCandidates.filter((candidate) => !candidate.alreadyLinked).length,
    [firstLastFrameLinkCandidates],
  )
  const firstLastFrameLinkedCount = useMemo(
    () => firstLastFrameLinkCandidates.filter((candidate) => candidate.alreadyLinked).length,
    [firstLastFrameLinkCandidates],
  )

  const invalidateFirstLastFrameLinks = useCallback(() => {
    if (!episodeId || !projectId) return
    queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.storyboards.all(episodeId) })
  }, [episodeId, projectId, queryClient])

  const handleLinkAllFirstLastFrames = useCallback(async () => {
    const updates = firstLastFrameLinkCandidates
      .filter((candidate) => !candidate.alreadyLinked)
      .map((candidate) => ({
        panelKey: candidate.panelKey,
        storyboardId: candidate.storyboardId,
        panelIndex: candidate.panelIndex,
        linked: true,
      }))
    if (updates.length === 0) return
    setIsBatchUpdatingFirstLastFrames(true)
    try {
      await handleSetLinks(updates)
      invalidateFirstLastFrameLinks()
    } catch (error) {
      _ulogError('batch link first/last frames failed:', error)
      alert(t('firstLastFrame.batchLinkFailed'))
    } finally {
      setIsBatchUpdatingFirstLastFrames(false)
    }
  }, [
    firstLastFrameLinkCandidates,
    handleSetLinks,
    invalidateFirstLastFrameLinks,
    t,
  ])

  const handleUnlinkAllFirstLastFrames = useCallback(async () => {
    const updates = firstLastFrameLinkCandidates
      .filter((candidate) => candidate.alreadyLinked)
      .map((candidate) => ({
        panelKey: candidate.panelKey,
        storyboardId: candidate.storyboardId,
        panelIndex: candidate.panelIndex,
        linked: false,
      }))
    if (updates.length === 0) return
    setIsBatchUpdatingFirstLastFrames(true)
    try {
      await handleSetLinks(updates)
      invalidateFirstLastFrameLinks()
    } catch (error) {
      _ulogError('batch unlink first/last frames failed:', error)
      alert(t('firstLastFrame.batchUnlinkFailed'))
    } finally {
      setIsBatchUpdatingFirstLastFrames(false)
    }
  }, [
    firstLastFrameLinkCandidates,
    handleSetLinks,
    invalidateFirstLastFrameLinks,
    t,
  ])

  const {
    panelVoiceLines,
    allVoiceLines,
    runningVoiceLineIds,
    reloadVoiceLines,
  } = useVideoVoiceLines({
    projectId,
    matchedVoiceLinesQuery,
  })

  const {
    isDownloading,
    videosWithUrl,
    handleDownloadAllVideos,
  } = useVideoDownloadAll({
    episodeId,
    t: (key) => t(key as never),
    allPanels,
    panelVideoPreference,
    listEpisodeVideoUrlsMutation,
    downloadRemoteBlobMutation,
  })

  const allVideoModelOptions = useMemo(
    () => userVideoModels || [],
    [userVideoModels],
  )
  const normalVideoModelOptions = useMemo(
    () => filterNormalVideoModelOptions(allVideoModelOptions),
    [allVideoModelOptions],
  )

  const safeTranslate = useCallback((key: string | undefined, fallback = ''): string => {
    if (!key) return fallback
    try {
      return t(key as never)
    } catch {
      return fallback
    }
  }, [t])

  const renderCapabilityLabel = useCallback((field: {
    field: string
    label: string
    labelKey?: string
    unitKey?: string
  }): string => {
    const labelText = safeTranslate(field.labelKey, safeTranslate(`capability.${field.field}`, field.label))
    const unitText = safeTranslate(field.unitKey)
    return unitText ? `${labelText} (${unitText})` : labelText
  }, [safeTranslate])

  const [isBatchConfigOpen, setIsBatchConfigOpen] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const [isSubmittingVideoBatch, setIsSubmittingVideoBatch] = useState(false)
  const [submittingVideoPanelKeys, setSubmittingVideoPanelKeys] = useState<Set<string>>(new Set())
  const [submittingVideoBaselines, setSubmittingVideoBaselines] = useState<Map<string, VideoSubmissionBaseline>>(new Map())
  const [batchSelectedModel, setBatchSelectedModel] = useState('')
  const [batchGenerationOptions, setBatchGenerationOptions] = useState<VideoGenerationOptions>({})

  useEffect(() => {
    if (normalVideoModelOptions.length === 0) {
      if (batchSelectedModel) setBatchSelectedModel('')
      return
    }
    if (normalVideoModelOptions.some((model) => model.value === batchSelectedModel)) return

    const nextDefault = normalVideoModelOptions.some((model) => model.value === defaultVideoModel)
      ? defaultVideoModel
      : (normalVideoModelOptions[0]?.value || '')
    setBatchSelectedModel(nextDefault)
  }, [normalVideoModelOptions, batchSelectedModel, defaultVideoModel])

  const selectedBatchModelOption = useMemo<VideoModelOption | undefined>(
    () => normalVideoModelOptions.find((option) => option.value === batchSelectedModel),
    [normalVideoModelOptions, batchSelectedModel],
  )
  const batchPricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedBatchModelOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'normal',
      },
    }),
    [selectedBatchModelOption?.videoPricingTiers],
  )

  const batchCapabilityDefinitions = useMemo<BatchCapabilityDefinition[]>(() => {
    return resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedBatchModelOption?.capabilities?.video,
      pricingTiers: batchPricingTiers,
    })
  }, [batchPricingTiers, selectedBatchModelOption?.capabilities?.video])

  useEffect(() => {
    setBatchGenerationOptions((previous) => {
      return normalizeVideoGenerationSelections({
        definitions: batchCapabilityDefinitions,
        pricingTiers: batchPricingTiers,
        selection: previous,
      })
    })
  }, [batchCapabilityDefinitions, batchPricingTiers])

  const batchEffectiveCapabilityFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: batchCapabilityDefinitions,
      pricingTiers: batchPricingTiers,
      selection: batchGenerationOptions,
    }),
    [batchCapabilityDefinitions, batchGenerationOptions, batchPricingTiers],
  )

  const batchEffectiveFieldMap = useMemo(
    () => new Map(batchEffectiveCapabilityFields.map((field) => [field.field, field])),
    [batchEffectiveCapabilityFields],
  )
  const batchDefinitionFieldMap = useMemo(
    () => new Map(batchCapabilityDefinitions.map((definition) => [definition.field, definition])),
    [batchCapabilityDefinitions],
  )

  const batchCapabilityFields = useMemo<BatchCapabilityField[]>(() => {
    return batchCapabilityDefinitions.map((definition) => {
      const effectiveField = batchEffectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        labelKey: definition.fieldI18n?.labelKey,
        unitKey: definition.fieldI18n?.unitKey,
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
      }
    })
  }, [batchCapabilityDefinitions, batchEffectiveFieldMap])

  const batchMissingCapabilityFields = useMemo(
    () => batchEffectiveCapabilityFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    [batchEffectiveCapabilityFields],
  )

  const setBatchCapabilityValue = useCallback((field: string, rawValue: string) => {
    const capabilityDefinition = batchDefinitionFieldMap.get(field)
    if (!capabilityDefinition || capabilityDefinition.options.length === 0) return
    const sample = capabilityDefinition.options[0]
    const parsedValue =
      typeof sample === 'number'
        ? Number(rawValue)
        : typeof sample === 'boolean'
          ? rawValue === 'true'
          : rawValue
    if (!capabilityDefinition.options.includes(parsedValue)) return
    setBatchGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: batchCapabilityDefinitions,
        pricingTiers: batchPricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
  }, [batchCapabilityDefinitions, batchDefinitionFieldMap, batchPricingTiers])

  const handleLipSync = useCallback(async (
    storyboardId: string,
    panelIndex: number,
    voiceLineId: string,
    panelId?: string,
  ) => {
    try {
      await lipSyncMutation.mutateAsync({
        storyboardId,
        panelIndex,
        voiceLineId,
        panelId,
       })
     } catch (error: unknown) {
       _ulogError('Lip sync error:', error)
      throw error
     }
   }, [lipSyncMutation])

    // 上传成功动画控制
  const [showUploadSuccess, setShowUploadSuccess] = useState<{ show: boolean; animatingOut: boolean; fileName: string; fileSize: number }>({
    show: false,
    animatingOut: false,
    fileName: '',
    fileSize: 0,
     })

  const uploadSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleUploadSuccessLeave = useCallback(() => {
     setShowUploadSuccess((prev) => ({ ...prev, animatingOut: true }))
    setTimeout(() => {
       setShowUploadSuccess({ show: false, animatingOut: false, fileName: '', fileSize: 0 })
       }, 300)
     }, [])

   const handleUploadVideo = useCallback(async (panelId: string, file: File) => {
    try {
      await uploadVideoMutation.mutateAsync({ panelId, file })
       _ulogInfo('[Upload] Video uploaded successfully')
       const fileName = file.name
       const fileSize = file.size
         // 显示上传成功弹窗
      setShowUploadSuccess({ show: true, animatingOut: false, fileName, fileSize })
       // 3.5 秒后自动关闭
      uploadSuccessTimerRef.current = setTimeout(handleUploadSuccessLeave, 3500)
        } catch (error: unknown) {
       _ulogError('Upload video error:', error)
      throw error
         }
        }, [uploadVideoMutation, handleUploadSuccessLeave])

   // 清理计时器
    useEffect(() => {
     return () => {
       if (uploadSuccessTimerRef.current) {
         clearTimeout(uploadSuccessTimerRef.current)
          }
         }
       }, [])

  const panelBySubmissionKey = useMemo(() => {
    const next = new Map<string, (typeof allPanels)[number]>()
    for (const panel of allPanels) {
      next.set(buildVideoSubmissionKey(panel), panel)
    }
    return next
  }, [allPanels])

  const handleGenerateVideoWithImmediateLock = useCallback(async (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: {
      lastFrameStoryboardId: string
      lastFramePanelIndex: number
      flModel: string
      customPrompt?: string
    },
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => {
    const panelKey = buildVideoSubmissionKey({ panelId, storyboardId, panelIndex })
    const currentPanelForOptions = panelBySubmissionKey.get(panelKey)
    const panelDuration = currentPanelForOptions?.textPanel?.duration
    const mergedGenerationOptions: VideoGenerationOptions | undefined = generationOptions
      ? {
        ...generationOptions,
        ...(typeof panelDuration === 'number' && Number.isFinite(panelDuration) ? { duration: panelDuration } : {}),
      }
      : (typeof panelDuration === 'number' && Number.isFinite(panelDuration) ? { duration: panelDuration } : undefined)

    if (queueMode) {
      taskQueue.enqueue({
        id: `video-single:${Date.now()}:${panelKey}`,
        group: 'video',
        projectId,
        target: { targetType: 'NovelPromotionPanel', targetId: String(panelId || ''), types: ['video_panel'] },
        uiKey: panelKey,
        label: `视频：镜头 ${panelIndex + 1}`,
        submit: async () => {
          const response = await apiFetch(`/api/novel-promotion/${encodeURIComponent(projectId)}/generate-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              storyboardId,
              panelIndex,
              panelId,
              videoModel,
              firstLastFrame,
              generationOptions: mergedGenerationOptions,
            }),
          })
          const data = await response.json().catch(() => ({}))
          return { taskId: String((data as any)?.taskId || '') }
        },
        onDone: () => {
          if (episodeId && projectId) {
            queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) })
            queryClient.invalidateQueries({ queryKey: queryKeys.storyboards.all(episodeId) })
          }
        },
      })
      return
    }

    if (isSubmittingVideoBatch) return

    const currentPanel = panelBySubmissionKey.get(panelKey)
    if (currentPanel?.videoTaskRunning || submittingVideoPanelKeys.has(panelKey)) return

    setSubmittingVideoPanelKeys((previous) => {
      if (previous.has(panelKey)) return previous
      const next = new Set(previous)
      next.add(panelKey)
      return next
    })
    if (currentPanel) {
      setSubmittingVideoBaselines((previous) => {
        const next = new Map(previous)
        next.set(panelKey, createVideoSubmissionBaseline(currentPanel))
        return next
      })
    }

    try {
      await onGenerateVideo(storyboardId, panelIndex, videoModel, firstLastFrame, mergedGenerationOptions, panelId)
    } catch (error) {
      setSubmittingVideoPanelKeys((previous) => {
        if (!previous.has(panelKey)) return previous
        const next = new Set(previous)
        next.delete(panelKey)
        return next
      })
      setSubmittingVideoBaselines((previous) => {
        if (!previous.has(panelKey)) return previous
        const next = new Map(previous)
        next.delete(panelKey)
        return next
      })
      throw error
    }
  }, [
    isSubmittingVideoBatch,
    projectId,
    episodeId,
    onGenerateVideo,
    queueMode,
    panelBySubmissionKey,
    submittingVideoPanelKeys,
    taskQueue,
    queryClient,
  ])

  const {
    flModel,
    flModelOptions,
    flGenerationOptions,
    flCapabilityFields,
    flMissingCapabilityFields,
    flCustomPrompts,
    setFlModel,
    setFlCapabilityValue,
    setFlCustomPrompt,
    resetFlCustomPrompt,
    handleGenerateFirstLastFrame,
    getDefaultFlPrompt,
    getNextPanel,
    isLinkedAsLastFrame,
  } = useVideoFirstLastFrameFlow({
    allPanels,
    linkedPanels,
    videoModelOptions: allVideoModelOptions,
    onGenerateVideo: handleGenerateVideoWithImmediateLock,
    t: (key) => t(key as never),
  })

  useEffect(() => {
    if (submittingVideoPanelKeys.size === 0) return

    const now = Date.now()
    setSubmittingVideoPanelKeys((previous) => {
      let changed = false
      const next = new Set(previous)
      for (const key of previous) {
        if (!shouldResolveVideoSubmissionLock(panelBySubmissionKey.get(key), submittingVideoBaselines.get(key), now)) {
          continue
        }
        next.delete(key)
        changed = true
      }
      return changed ? next : previous
    })
    setSubmittingVideoBaselines((previous) => {
      let changed = false
      const next = new Map(previous)
      for (const key of previous.keys()) {
        if (submittingVideoPanelKeys.has(key) && !shouldResolveVideoSubmissionLock(panelBySubmissionKey.get(key), previous.get(key), now)) {
          continue
        }
        next.delete(key)
        changed = true
      }
      return changed ? next : previous
    })
  }, [panelBySubmissionKey, submittingVideoBaselines, submittingVideoPanelKeys])

  useEffect(() => {
    if (!isSubmittingVideoBatch || allPanels.some((panel) => panel.videoTaskRunning)) {
      if (isSubmittingVideoBatch && allPanels.some((panel) => panel.videoTaskRunning)) {
        setIsSubmittingVideoBatch(false)
      }
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsSubmittingVideoBatch(false)
    }, 90_000)
    return () => window.clearTimeout(timeoutId)
  }, [allPanels, isSubmittingVideoBatch])

  const handleGenerateAllVideosWithImmediateLock = useCallback(async (options?: Parameters<typeof onGenerateAllVideos>[0]) => {
    if (isSubmittingVideoBatch) return
    setIsSubmittingVideoBatch(true)
    try {
      await onGenerateAllVideos(options)
    } catch (error) {
      setIsSubmittingVideoBatch(false)
      throw error
    }
  }, [isSubmittingVideoBatch, onGenerateAllVideos])

  const projectedPanels = useMemo(() => (
    allPanels.map((panel) => {
      const panelKey = buildVideoSubmissionKey(panel)
      if (!isSubmittingVideoBatch && !submittingVideoPanelKeys.has(panelKey)) return panel
      return {
        ...panel,
        videoTaskRunning: true,
      }
    })
  ), [allPanels, isSubmittingVideoBatch, submittingVideoPanelKeys])

  const runningCount = projectedPanels.filter((panel) => panel.videoTaskRunning || panel.lipSyncTaskRunning).length
  const failedCount = allPanels.filter((panel) => !!panel.videoErrorMessage || !!panel.lipSyncErrorMessage).length
  const isAnyTaskRunning = runningCount > 0 || isSubmittingVideoBatch
  const canSubmitBatchGenerate = !!batchSelectedModel && batchMissingCapabilityFields.length === 0

  const handleOpenBatchGenerateModal = useCallback(() => {
    if (isAnyTaskRunning && !queueMode) return
    setIsBatchConfigOpen(true)
  }, [isAnyTaskRunning, queueMode])

  const handleCloseBatchGenerateModal = useCallback(() => {
    setIsBatchConfigOpen(false)
  }, [])

  const handleConfirmBatchGenerate = useCallback(async () => {
    if (!canSubmitBatchGenerate || isConfirming) return

    setIsConfirming(true)
    try {
      if (queueMode) {
        const candidates = allPanels.filter((panel) => !panel.videoUrl && !panel.videoTaskRunning)
        const now = Date.now()
        taskQueue.enqueueMany(candidates.map((panel, index) => ({
          id: `video-generate:${now}:${index}:${panel.panelId || panel.panelIndex}`,
          group: 'video',
          projectId,
          target: { targetType: 'NovelPromotionPanel', targetId: String(panel.panelId || ''), types: ['video_panel'] },
          uiKey: buildVideoSubmissionKey(panel),
          label: `视频：镜头 ${panel.panelIndex + 1}`,
          submit: async () => {
            const response = await apiFetch(`/api/novel-promotion/${encodeURIComponent(projectId)}/generate-video`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                storyboardId: panel.storyboardId,
                panelIndex: panel.panelIndex,
                panelId: panel.panelId,
                videoModel: batchSelectedModel,
                generationOptions: {
                  ...batchGenerationOptions,
                  ...(typeof panel.textPanel?.duration === 'number' && Number.isFinite(panel.textPanel.duration)
                    ? { duration: panel.textPanel.duration }
                    : {}),
                },
              }),
            })
            const data = await response.json().catch(() => ({}))
            return { taskId: String((data as any)?.taskId || '') }
          },
          onDone: () => {
            if (episodeId && projectId) {
              queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) })
              queryClient.invalidateQueries({ queryKey: queryKeys.storyboards.all(episodeId) })
            }
          },
        })))
        setIsBatchConfigOpen(false)
      } else {
        await handleGenerateAllVideosWithImmediateLock({
          videoModel: batchSelectedModel,
          generationOptions: batchGenerationOptions,
        })
        setIsBatchConfigOpen(false)
      }
    } finally {
      setIsConfirming(false)
    }
  }, [
    allPanels,
    batchGenerationOptions,
    batchSelectedModel,
    canSubmitBatchGenerate,
    handleGenerateAllVideosWithImmediateLock,
    isConfirming,
    projectId,
    episodeId,
    queueMode,
    taskQueue,
    queryClient,
  ])

  return (
    <div className="space-y-6 pb-20">
      <VideoToolbar
        totalPanels={projectedPanels.length}
        runningCount={runningCount}
        videosWithUrl={videosWithUrl}
        failedCount={failedCount}
        isAnyTaskRunning={isAnyTaskRunning}
        queueModeEnabled={queueMode}
        isDownloading={isDownloading}
        onGenerateAll={handleOpenBatchGenerateModal}
        onLinkAllFirstLastFrames={handleLinkAllFirstLastFrames}
        onUnlinkAllFirstLastFrames={handleUnlinkAllFirstLastFrames}
        firstLastFrameLinkableCount={firstLastFrameLinkCandidates.length}
        firstLastFrameUnlinkedCount={firstLastFrameUnlinkedCount}
        firstLastFrameLinkedCount={firstLastFrameLinkedCount}
        isBatchUpdatingFirstLastFrames={isBatchUpdatingFirstLastFrames}
        onDownloadAll={handleDownloadAllVideos}
        onBack={onBack}
        onEnterEditor={onEnterEditor}
        videosReady={videosWithUrl > 0}
      />

      <VideoTimelinePanel
        projectId={projectId}
        episodeId={episodeId}
        allVoiceLines={allVoiceLines}
        expanded={voiceLinesExpanded}
        onToggleExpanded={toggleVoiceLinesExpanded}
        onReloadVoiceLines={reloadVoiceLines}
        onLocateVoiceLine={locateVoiceLinePanel}
        onOpenAssetLibraryForCharacter={onOpenAssetLibraryForCharacter}
      />

      <VideoRenderPanel
        allPanels={projectedPanels}
        linkedPanels={linkedPanels}
        highlightedPanelKey={highlightedPanelKey}
        panelRefs={panelRefs}
        videoRatio={videoRatio}
        defaultVideoModel={defaultVideoModel}
        capabilityOverrides={capabilityOverrides}
        userVideoModels={normalVideoModelOptions}
        projectId={projectId}
        episodeId={episodeId}
        runningVoiceLineIds={runningVoiceLineIds}
        panelVoiceLines={panelVoiceLines}
        panelVideoPreference={panelVideoPreference}
        savingPrompts={savingPrompts}
        flModel={flModel}
        flModelOptions={flModelOptions}
        flGenerationOptions={flGenerationOptions}
        flCapabilityFields={flCapabilityFields}
        flMissingCapabilityFields={flMissingCapabilityFields}
        flCustomPrompts={flCustomPrompts}
        onGenerateVideo={handleGenerateVideoWithImmediateLock}
        onUpdatePanelVideoModel={onUpdatePanelVideoModel}
        onUpdatePanelDuration={handleUpdatePanelDuration}
        onUpdateVideoCapabilityOverride={handleUpdateVideoCapabilityOverride}
        onLipSync={handleLipSync}
        onToggleLink={handleToggleLink}
        onFlModelChange={setFlModel}
        onFlCapabilityChange={setFlCapabilityValue}
        onFlCustomPromptChange={setFlCustomPrompt}
        onResetFlPrompt={resetFlCustomPrompt}
        onGenerateFirstLastFrame={handleGenerateFirstLastFrame}
        onPreviewImage={setPreviewImage}
        onToggleLipSyncVideo={toggleLipSyncVideo}
        getNextPanel={getNextPanel}
        isLinkedAsLastFrame={isLinkedAsLastFrame}
        getDefaultFlPrompt={getDefaultFlPrompt}
        getLocalPrompt={getLocalPrompt}
        updateLocalPrompt={updateLocalPrompt}
        savePrompt={savePrompt}
        onUploadVideo={handleUploadVideo}
        isUploadingVideo={uploadVideoMutation.isPending}
       />

      {isBatchConfigOpen && (
        <div
          className="fixed inset-0 z-[120] glass-overlay flex items-center justify-center p-4"
          onClick={handleCloseBatchGenerateModal}
        >
          <div
            className="glass-surface-modal w-full max-w-2xl p-5 space-y-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="space-y-1">
              <h3 className="text-lg font-semibold text-[var(--glass-text-primary)]">
                {t('toolbar.batchConfigTitle')}
              </h3>
              <p className="text-sm text-[var(--glass-text-tertiary)]">
                {t('toolbar.batchConfigDesc')}
              </p>
            </div>

            <ModelCapabilityDropdown
              models={normalVideoModelOptions}
              value={batchSelectedModel || undefined}
              onModelChange={setBatchSelectedModel}
              capabilityFields={batchCapabilityFields.map((field) => ({
                field: field.field,
                label: renderCapabilityLabel(field),
                options: field.options,
                disabledOptions: field.disabledOptions,
              }))}
              capabilityOverrides={batchGenerationOptions}
              onCapabilityChange={(field, rawValue) => setBatchCapabilityValue(field, rawValue)}
              placeholder={t('panelCard.selectModel')}
            />

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleCloseBatchGenerateModal}
                className="glass-btn-base glass-btn-secondary px-4 py-2 text-sm font-medium"
              >
                {t('panelCard.cancel')}
              </button>
              <button
                type="button"
                onClick={() => { void handleConfirmBatchGenerate() }}
                disabled={!canSubmitBatchGenerate || isConfirming}
                className="glass-btn-base glass-btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isConfirming ? (
                  <>
                    <AppIcon name="loader" className="animate-spin h-4 w-4" />
                    <span>{t('toolbar.confirming')}</span>
                  </>
                ) : (
                  <span>{t('toolbar.confirmGenerateAll')}</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

          {/* 视频上传成功弹窗 */}
          {showUploadSuccess.show && (
            <div
              className="fixed inset-0 z-[130] glass-overlay flex items-center justify-center p-4"
              style={{
                opacity: showUploadSuccess.animatingOut ? 0 : 1,
                transition: 'opacity 0.3s ease',
                pointerEvents: showUploadSuccess.animatingOut ? 'none' : 'auto',
              }}
              onAnimationEnd={() => {
                if (showUploadSuccess.animatingOut) {
                  setShowUploadSuccess((prev) => ({ ...prev, show: false, animatingOut: false }));
                }
              }}
              onClick={() => setShowUploadSuccess((prev) => ({ ...prev, animatingOut: true }))}
            >
            {/* 注入弹窗专用动画 */}
             <style>{`
               @keyframes modalSlideIn {
                 0% { opacity: 0; transform: scale(0.92) translateY(12px); }
                 100% { opacity: 1; transform: scale(1) translateY(0); }
               }
               @keyframes iconPop {
                 0% { transform: scale(0.4); opacity: 0; }
                 50% { transform: scale(1.15); opacity: 1; }
                 100% { transform: scale(1); opacity: 1; }
               }
               @keyframes checkDraw {
                 0% { stroke-dashoffset: 24; }
                 100% { stroke-dashoffset: 0; }
               }
               @keyframes pulse-ring {
                 0% { transform: scale(1); opacity: 0.6; }
                 100% { transform: scale(1.8); opacity: 0; }
               }
               @keyframes floatBadge {
                 0% { transform: translateY(8px); opacity: 0; }
                 100% { transform: translateY(0); opacity: 1; }
               }
               @keyframes overlayFade {
                 0% { opacity: 0; }
                 100% { opacity: 1; }
               }
               @keyframes opacityOut {
                 0% { opacity: 1; }
                 100% { opacity: 0; }
               }
             `}</style>
            <div
              className="relative rounded-3xl p-6 max-w-sm w-full space-y-4 overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'linear-gradient(135deg, var(--glass-bg-surface-modal) 0%, rgba(255,255,255,0.97) 100%)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                boxShadow: '0 20px 60px rgba(16, 185, 129, 0.15), 0 8px 24px rgba(0,0,0,0.08)',
                animation: 'modalSlideIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
                backdropFilter: 'blur(20px) saturate(120%)',
                WebkitBackdropFilter: 'blur(20px) saturate(120%)',
              }}
            >
              {/* 背景光晕 */}
              <div
                className="absolute -top-8 -right-8 w-32 h-32 rounded-full"
                style={{
                  background: 'radial-gradient(circle, rgba(16,185,129,0.2), transparent 70%)',
                  filter: 'blur(8px)',
                }}
              />
              <div
                className="absolute -bottom-6 -left-6 w-24 h-24 rounded-full"
                style={{
                  background: 'radial-gradient(circle, rgba(47,123,255,0.15), transparent 70%)',
                  filter: 'blur(8px)',
                }}
              />

              {/* 顶部装饰渐变线 */}
              <div
                className="absolute top-0 left-6 right-6 h-px"
                style={{
                  background: 'linear-gradient(90deg, transparent, var(--glass-tone-success-fg), transparent)',
                }}
              />

              {/* 成功图标区域 */}
              <div className="relative flex flex-col items-center space-y-4">
                {/* 脉冲光环 */}
                <div
                  className="absolute w-20 h-20 rounded-full"
                  style={{
                    background: 'rgba(16, 185, 129, 0.12)',
                    animation: 'pulse-ring 2s ease-out infinite',
                    marginTop: '4px',
                    transformOrigin: 'center',
                  }}
                />

                {/* 成功图标 */}
                <div
                  className="relative w-16 h-16 rounded-full flex items-center justify-center"
                  style={{
                    background: 'linear-gradient(135deg, #10b980, #34d399, #4ade80)',
                    boxShadow: '0 0 32px rgba(16, 185, 129, 0.35), inset 0 1px 0 rgba(255,255,255,0.3)',
                    animation: 'iconPop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
                  }}
                >
                  <svg
                    className="w-8 h-8 text-white"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      strokeDasharray: 24,
                      strokeDashoffset: 24,
                      animation: 'checkDraw 0.4s ease-out 0.3s forwards',
                    }}
                  >
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <div className="text-center space-y-1">
                  <h3
                    className="text-xl font-bold tracking-tight"
                    style={{
                      background: 'linear-gradient(135deg, #10b980, #059669)',
                      WebkitBackgroundClip: 'text',
                      WebkitTextFillColor: 'transparent',
                      animation: 'modalSlideIn 0.4s ease-out 0.2s both',
                    }}
                  >
                    视频上传成功
                  </h3>
                  <p className="text-sm" style={{
                    color: 'var(--glass-text-tertiary)',
                    animation: 'floatBadge 0.4s ease-out 0.4s both',
                  }}>
                    已成功添加到当前分镜
                  </p>
                </div>

                {/* 视频信息卡片 */}
                <div
                  className="flex items-center gap-3 w-full p-3.5 rounded-xl"
                  style={{
                    background: 'var(--glass-bg-muted)',
                    border: '1px solid var(--glass-stroke-soft)',
                    animation: 'modalSlideIn 0.35s ease-out 0.5s both',
                    marginTop: '4px',
                  }}
                >
                  <div
                    className="flex-shrink-0 w-11 h-11 rounded-lg flex items-center justify-center"
                    style={{
                      background: 'linear-gradient(135deg, var(--glass-accent-from), var(--glass-accent-to))',
                      boxShadow: '0 4px 12px rgba(47, 123, 255, 0.25)',
                    }}
                  >
                    <AppIcon name="video" className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-[var(--glass-text-primary)] truncate">
                      {showUploadSuccess.fileName}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--glass-text-tertiary)' }}>
                      {(showUploadSuccess.fileSize / 1024 / 1024).toFixed(2)} MB
                    </p>
                  </div>
                  <div className="flex-shrink-0">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{
                      background: 'rgba(16, 185, 129, 0.15)',
                    }}>
                      <AppIcon name="check" className="w-3.5 h-3.5" style={{ color: '#10b980' }} />
                    </div>
                  </div>
                </div>

                {/* 底部按钮 */}
                <button
                  type="button"
                  onClick={() => setShowUploadSuccess((prev) => ({ ...prev, animatingOut: true }))}
                  className="px-6 py-2.5 text-sm font-semibold rounded-xl transition-all duration-200"
                  style={{
                    background: 'linear-gradient(135deg, #10b980, #059669)',
                    color: 'white',
                    boxShadow: '0 2px 12px rgba(16, 185, 129, 0.3)',
                    animation: 'modalSlideIn 0.35s ease-out 0.6s both',
                    marginTop: '4px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = '0 4px 20px rgba(16, 185, 129, 0.45)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = '0 2px 12px rgba(16, 185, 129, 0.3)';
                    e.currentTarget.style.transform = 'translateY(0)';
                  }}
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        )}

       {previewImage && <ImagePreviewModal imageUrl={previewImage} onClose={closePreviewImage} />}
     </div>
   )
}
