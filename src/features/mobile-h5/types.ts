import type { MediaRef } from '@/types/project'

export interface MobileProjectSummary {
  id: string
  name: string
  description: string | null
  createdAt: string
  updatedAt: string
  stats?: {
    episodes?: number
    panels?: number
    images?: number
    videos?: number
    firstEpisodePreview?: string | null
  } | null
}

export interface MobileEpisodeSummary {
  id: string
  episodeNumber?: number
  name: string
  description?: string | null
  novelText?: string | null
  createdAt?: string
}

export interface MobileProjectDetail {
  id: string
  name: string
  description: string | null
  novelPromotionData?: {
    videoModel?: string | null
    episodes?: MobileEpisodeSummary[]
  } | null
}

export interface MobilePanelFrame {
  id: string
  frameIndex: number
  frameTimeSec: number
  frameRole: string | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  imageUrl: string | null
  imageMedia?: MediaRef | null
  media?: MediaRef | null
  generationStatus?: string | null
}

export interface MobilePanel {
  id: string
  storyboardId?: string | null
  panelIndex: number
  panelNumber?: number | null
  panelMode?: string | null
  shotType?: string | null
  cameraMove?: string | null
  description?: string | null
  location?: string | null
  characters?: string | null
  props?: string | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  groupVideoPrompt?: string | null
  firstLastFramePrompt?: string | null
  duration?: number | null
  groupDurationSec?: number | null
  imageUrl?: string | null
  media?: MediaRef | null
  imageMedia?: MediaRef | null
  videoUrl?: string | null
  videoMedia?: MediaRef | null
  frames?: MobilePanelFrame[]
  imageTaskRunning?: boolean
  videoTaskRunning?: boolean
  usePreviousPanelTailAsReference?: boolean | null
  videoModel?: string | null
  imageErrorMessage?: string | null
  videoErrorMessage?: string | null
}

export interface MobileStoryboard {
  id: string
  clipId: string
  panels?: MobilePanel[]
  clip?: {
    id: string
    start?: number | null
    end?: number | null
    content?: string | null
    screenplay?: string | null
    createdAt?: string
  } | null
}

export interface MobileEpisodeDetail extends MobileEpisodeSummary {
  clips?: Array<{
    id: string
    createdAt?: string
  }>
  storyboards?: MobileStoryboard[]
}

export interface MobileTask {
  id: string
  projectId?: string | null
  episodeId?: string | null
  type: string
  status: string
  targetType?: string | null
  targetId?: string | null
  errorMessage?: string | null
  error?: {
    message?: string | null
  } | null
  createdAt?: string
  updatedAt?: string
}
