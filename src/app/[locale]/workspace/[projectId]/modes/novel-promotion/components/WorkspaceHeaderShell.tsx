'use client'

import { CapsuleNav, EpisodeSelector } from '@/components/ui/CapsuleNav'
import { SettingsModal, WorldContextModal } from '@/components/ui/ConfigModals'
import WorkspaceTopActions from './WorkspaceTopActions'
import type { NovelPromotionPanel } from '@/types/project'
import type { CapabilitySelections, ModelCapabilities } from '@/lib/model-config-contract'
import { resolveEpisodeStageArtifacts } from '@/lib/novel-promotion/stage-readiness'
import { apiFetch } from '@/lib/api-fetch'

interface EpisodeSummary {
  id: string
  name: string
  episodeNumber?: number
  description?: string | null
  clips?: unknown[]
  storyboards?: Array<{
    panels?: NovelPromotionPanel[] | null
  }>
}

interface UserModelOption {
  value: string
  label: string
  provider?: string
  providerName?: string
  capabilities?: ModelCapabilities
}

interface UserModelsPayload {
  llm: UserModelOption[]
  image: UserModelOption[]
  video: UserModelOption[]
  audio: UserModelOption[]
}

interface WorkspaceHeaderShellProps {
  isSettingsModalOpen: boolean
  isWorldContextModalOpen: boolean
  onCloseSettingsModal: () => void
  onCloseWorldContextModal: () => void
  availableModels?: UserModelsPayload
  modelsLoaded: boolean
  artStyle: string | null | undefined
  analysisModel: string | null | undefined
  characterModel: string | null | undefined
  locationModel: string | null | undefined
  storyboardModel: string | null | undefined
  editModel: string | null | undefined
  videoModel: string | null | undefined
  audioModel: string | null | undefined
  capabilityOverrides: CapabilitySelections
  videoRatio: string | null | undefined
  ttsRate: string | null | undefined
  // 本地 local 图片模型（wo -> ltx）配置
  localImageWidth: number
  localImageHeight: number
  localImageSteps: number
  localT2IWidth: number
  localT2IHeight: number
  localT2ISteps: number
  localI2IWidth: number
  localI2IHeight: number
  localI2ISteps: number
  localStoryboardPromptRefineEnabled: boolean
  localStoryboardPromptRefineLevel: 'conservative' | 'medium' | 'simple'
  localStoryboardUsePanelDescriptionEnabled: boolean
  progressPopupEnabled: boolean
  forcedStoryboardDurationSec: 8 | 10 | 15 | 20 | null
  onUpdateConfig: (key: string, value: unknown) => Promise<void>
  globalAssetText: string
  projectName: string
  episodes: EpisodeSummary[]
  currentEpisodeId?: string
  onEpisodeSelect?: (episodeId: string) => void
  onEpisodeCreate?: () => void
  onEpisodeRename?: (episodeId: string, newName: string) => void
  onEpisodeDelete?: (episodeId: string) => void
  capsuleNavItems: Array<{
    id: string
    icon: string
    label: string
    status: 'empty' | 'active' | 'processing' | 'ready'
    disabled?: boolean
    disabledLabel?: string
  }>
  currentStage: string
  onStageChange: (stage: string) => void
  projectId: string
  episodeId?: string
  onOpenAssetLibrary: () => void
  onOpenSettingsModal: () => void
  onRefresh: () => void
  assetLibraryLabel: string
  settingsLabel: string
  refreshTitle: string
}

export default function WorkspaceHeaderShell({
  isSettingsModalOpen,
  isWorldContextModalOpen,
  onCloseSettingsModal,
  onCloseWorldContextModal,
  availableModels,
  modelsLoaded,
  artStyle,
  analysisModel,
  characterModel,
  locationModel,
  storyboardModel,
  editModel,
  videoModel,
  audioModel,
  capabilityOverrides,
  videoRatio,
  ttsRate,
  localImageWidth,
  localImageHeight,
  localImageSteps,
  localT2IWidth,
  localT2IHeight,
  localT2ISteps,
  localI2IWidth,
  localI2IHeight,
  localI2ISteps,
  localStoryboardPromptRefineEnabled,
  localStoryboardPromptRefineLevel,
  localStoryboardUsePanelDescriptionEnabled,
  progressPopupEnabled,
  forcedStoryboardDurationSec,
  onUpdateConfig,
  globalAssetText,
  projectName,
  episodes,
  currentEpisodeId,
  onEpisodeSelect,
  onEpisodeCreate,
  onEpisodeRename,
  onEpisodeDelete,
  capsuleNavItems,
  currentStage,
  onStageChange,
  projectId,
  episodeId,
  onOpenAssetLibrary,
  onOpenSettingsModal,
  onRefresh,
  assetLibraryLabel,
  settingsLabel,
  refreshTitle,
}: WorkspaceHeaderShellProps) {
  return (
    <>
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={onCloseSettingsModal}
        availableModels={availableModels}
        modelsLoaded={modelsLoaded}
        artStyle={artStyle ?? undefined}
        analysisModel={analysisModel ?? undefined}
        characterModel={characterModel ?? undefined}
        locationModel={locationModel ?? undefined}
        imageModel={storyboardModel ?? undefined}
        editModel={editModel ?? undefined}
        videoModel={videoModel ?? undefined}
        audioModel={audioModel ?? undefined}
        videoRatio={videoRatio ?? undefined}
        capabilityOverrides={capabilityOverrides}
        ttsRate={ttsRate ?? undefined}
        localImageWidth={localImageWidth}
        localImageHeight={localImageHeight}
        localImageSteps={localImageSteps}
        localT2IWidth={localT2IWidth}
        localT2IHeight={localT2IHeight}
        localT2ISteps={localT2ISteps}
        localI2IWidth={localI2IWidth}
        localI2IHeight={localI2IHeight}
        localI2ISteps={localI2ISteps}
        localStoryboardPromptRefineEnabled={localStoryboardPromptRefineEnabled}
        localStoryboardPromptRefineLevel={localStoryboardPromptRefineLevel}
        localStoryboardUsePanelDescriptionEnabled={localStoryboardUsePanelDescriptionEnabled}
        progressPopupEnabled={progressPopupEnabled}
        forcedStoryboardDurationSec={forcedStoryboardDurationSec}
        onArtStyleChange={(value) => { onUpdateConfig('artStyle', value) }}
        onAnalysisModelChange={(value) => { onUpdateConfig('analysisModel', value) }}
        onCharacterModelChange={(value) => { onUpdateConfig('characterModel', value) }}
        onLocationModelChange={(value) => { onUpdateConfig('locationModel', value) }}
        onImageModelChange={(value) => { onUpdateConfig('storyboardModel', value) }}
        onEditModelChange={(value) => { onUpdateConfig('editModel', value) }}
        onVideoModelChange={(value) => { onUpdateConfig('videoModel', value) }}
        onAudioModelChange={(value) => { onUpdateConfig('audioModel', value) }}
        onVideoRatioChange={(value) => { onUpdateConfig('videoRatio', value) }}
        onCapabilityOverridesChange={(value) => { onUpdateConfig('capabilityOverrides', value) }}
        onTTSRateChange={(value) => { onUpdateConfig('ttsRate', value) }}
        onLocalImageWidthChange={(value) => { onUpdateConfig('localImageWidth', value) }}
        onLocalImageHeightChange={(value) => { onUpdateConfig('localImageHeight', value) }}
        onLocalImageStepsChange={(value) => { onUpdateConfig('localImageSteps', value) }}
        onLocalT2IWidthChange={(value) => { onUpdateConfig('localT2IWidth', value) }}
        onLocalT2IHeightChange={(value) => { onUpdateConfig('localT2IHeight', value) }}
        onLocalT2IStepsChange={(value) => { onUpdateConfig('localT2ISteps', value) }}
        onLocalI2IWidthChange={(value) => { onUpdateConfig('localI2IWidth', value) }}
        onLocalI2IHeightChange={(value) => { onUpdateConfig('localI2IHeight', value) }}
        onLocalI2IStepsChange={(value) => { onUpdateConfig('localI2ISteps', value) }}
        onLocalStoryboardPromptRefineEnabledChange={(value) => { onUpdateConfig('localStoryboardPromptRefineEnabled', value) }}
        onLocalStoryboardPromptRefineLevelChange={(value) => { onUpdateConfig('localStoryboardPromptRefineLevel', value) }}
        onLocalStoryboardUsePanelDescriptionEnabledChange={(value) => { onUpdateConfig('localStoryboardUsePanelDescriptionEnabled', value) }}
        onProgressPopupEnabledChange={(value) => {
          onUpdateConfig('progressPopupEnabled', value)
          // 同步到用户偏好：让全局资产库也能复用该开关
          void apiFetch('/api/user-preference', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ progressPopupEnabled: value }),
          })
        }}
        onForcedStoryboardDurationSecChange={(value) => { onUpdateConfig('forcedStoryboardDurationSec', value) }}
      />

      <WorldContextModal
        isOpen={isWorldContextModalOpen}
        onClose={onCloseWorldContextModal}
        text={globalAssetText}
        onChange={(value) => { onUpdateConfig('globalAssetText', value) }}
      />
      {episodes.length > 0 && currentEpisodeId && (() => {
        const getNum = (name: string) => { const m = name.match(/\d+/); return m ? parseInt(m[0], 10) : Infinity }
        const sorted = [...episodes].sort((a, b) => {
          const d = getNum(a.name) - getNum(b.name)
          return d !== 0 ? d : a.name.localeCompare(b.name, 'zh')
        })
        return (
          <EpisodeSelector
            projectName={projectName}
            episodes={sorted.map((ep) => {
              const stageArtifacts = resolveEpisodeStageArtifacts({
                novelText: null,
                clips: ep.clips || [],
                storyboards: ep.storyboards || [],
                voiceLines: [],
              })
              return {
                id: ep.id,
                title: ep.name,
                summary: ep.description ?? undefined,
                status: {
                  script: stageArtifacts.hasScript ? 'ready' as const : 'empty' as const,
                  visual: stageArtifacts.hasVideo ? 'ready' as const : 'empty' as const,
                },
              }
            })}
            currentId={currentEpisodeId}
            onSelect={(id) => onEpisodeSelect?.(id)}
            onAdd={onEpisodeCreate}
            onRename={(id, newName) => onEpisodeRename?.(id, newName)}
            onDelete={onEpisodeDelete}
          />
        )
      })()}



      <CapsuleNav
        items={capsuleNavItems}
        activeId={currentStage}
        onItemClick={onStageChange}
        projectId={projectId}
        episodeId={episodeId}
      />

      <WorkspaceTopActions
        onOpenAssetLibrary={onOpenAssetLibrary}
        onOpenSettings={onOpenSettingsModal}
        onRefresh={onRefresh}
        assetLibraryLabel={assetLibraryLabel}
        settingsLabel={settingsLabel}
        refreshTitle={refreshTitle}
      />
    </>
  )
}
