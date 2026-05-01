import type { VideoPanel, MatchedVoiceLine, VideoModelOption, FirstLastFrameParams, VideoGenerationOptions } from '../types'
import type { CapabilitySelections, CapabilityValue } from '@/lib/model-config-contract'

export interface VideoPanelCardShellProps {
  panel: VideoPanel
  panelIndex: number
  defaultVideoModel: string
  capabilityOverrides: CapabilitySelections
  videoRatio?: string
  userVideoModels?: VideoModelOption[]
  projectId: string
  episodeId?: string
  runningVoiceLineIds?: Set<string>
  matchedVoiceLines?: MatchedVoiceLine[]
  onLipSync?: (storyboardId: string, panelIndex: number, voiceLineId: string, panelId?: string) => Promise<void>
  showLipSyncVideo: boolean
  onToggleLipSyncVideo: (panelKey: string, value: boolean) => void
  isLinked: boolean
  isLastFrame: boolean
  nextPanel: VideoPanel | null
  prevPanel: VideoPanel | null
  hasNext: boolean
  flModel: string
  flModelOptions: VideoModelOption[]
  flGenerationOptions: VideoGenerationOptions
  flCapabilityFields: Array<{
    field: string
    label: string
    options: CapabilityValue[]
    disabledOptions?: CapabilityValue[]
    value: CapabilityValue | undefined
  }>
  flMissingCapabilityFields: string[]
  flCustomPrompt: string
  defaultFlPrompt: string
  localPrompt: string
  isSavingPrompt: boolean
  onUpdateLocalPrompt: (value: string) => void
  onSavePrompt: (value: string) => Promise<void>
  onGenerateVideo: (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: FirstLastFrameParams,
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => void
  onUpdatePanelVideoModel: (storyboardId: string, panelIndex: number, model: string) => void
  /**
   * 仅更新当前分镜的“成片时长（秒）”，对应 NovelPromotionPanel.duration。
   * 该字段用于当前分镜的视频生成时长，不应写入 capabilityOverrides（避免联动其它分镜）。
   */
  onUpdatePanelDuration: (storyboardId: string, panelIndex: number, duration: number | null) => void
  /**
   * 持久化保存视频生成能力参数（如 duration/fps/resolution 等）到项目 capabilityOverrides。
   * 注意：这里保存的是「模型能力参数」，不是分镜的 panel.duration。
   */
  onUpdateVideoCapabilityOverride: (
    modelKey: string,
    field: string,
    rawValue: string,
    sample: CapabilityValue,
  ) => void
  onToggleLink: (panelKey: string, storyboardId: string, panelIndex: number) => void
  onFlModelChange: (model: string) => void
  onFlCapabilityChange: (field: string, rawValue: string) => void
  onFlCustomPromptChange: (panelKey: string, value: string) => void
  onResetFlPrompt: (panelKey: string) => void
  onGenerateFirstLastFrame: (
    firstStoryboardId: string,
    firstPanelIndex: number,
    lastStoryboardId: string,
    lastPanelIndex: number,
    panelKey: string,
    generationOptions?: VideoGenerationOptions,
    firstPanelId?: string,
  ) => void
  onPreviewImage?: (imageUrl: string) => void
}
