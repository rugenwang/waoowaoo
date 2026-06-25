'use client'

import { useMemo } from 'react'
import VideoStage from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/VideoStage'
import type {
  BatchVideoGenerationParams,
  Clip,
  FirstLastFrameParams,
  Storyboard,
  VideoGenerationOptions,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import {
  useUpdateProjectConfig,
  useUpdateProjectPanelVideoPrompt,
} from '@/lib/query/hooks'
import { useBatchGenerateVideos, useGenerateVideo } from '@/lib/query/hooks/useStoryboards'
import { useUserModels } from '@/lib/query/hooks/useUserModels'
import { getMobileProjectSettingsSnapshot } from './mobile-project-settings'
import type { MobileEpisodeDetail, MobileNovelPromotionData } from './types'

interface MobileFullVideoStageProps {
  projectId: string
  episodeId: string
  episode: MobileEpisodeDetail
  projectData: MobileNovelPromotionData | null | undefined
  onBack: () => void
  onOpenAssets: (characterId?: string | null) => void
  onUpdated: () => void
}

export default function MobileFullVideoStage({
  projectId,
  episodeId,
  episode,
  projectData,
  onBack,
  onOpenAssets,
  onUpdated,
}: MobileFullVideoStageProps) {
  const modelsQuery = useUserModels()
  const generateVideo = useGenerateVideo(projectId, episodeId)
  const generateAllVideos = useBatchGenerateVideos(projectId, episodeId)
  const updatePrompt = useUpdateProjectPanelVideoPrompt(projectId)
  const updateConfig = useUpdateProjectConfig(projectId)
  const settings = useMemo(() => getMobileProjectSettingsSnapshot(projectData), [projectData])

  const clips = useMemo<Clip[]>(() => (episode.clips || []).map((clip, index) => ({
    id: clip.id,
    start: clip.start ?? 0,
    end: clip.end ?? 0,
    summary: clip.summary || clip.content || `片段 ${index + 1}`,
  })), [episode.clips])

  return (
    <div className="min-w-0 overflow-x-hidden">
      <VideoStage
        projectId={projectId}
        episodeId={episodeId}
        storyboards={(episode.storyboards || []) as unknown as Storyboard[]}
        clips={clips}
        defaultVideoModel={projectData?.videoModel || ''}
        capabilityOverrides={settings.capabilityOverrides}
        videoRatio={projectData?.videoRatio || '16:9'}
        userVideoModels={modelsQuery.data?.video || []}
        onGenerateVideo={async (
          storyboardId: string,
          panelIndex: number,
          videoModel?: string,
          firstLastFrame?: FirstLastFrameParams,
          generationOptions?: VideoGenerationOptions,
          panelId?: string,
        ) => {
          await generateVideo.mutateAsync({
            storyboardId,
            panelIndex,
            panelId,
            videoModel: videoModel || projectData?.videoModel || '',
            firstLastFrame,
            generationOptions,
          })
          onUpdated()
        }}
        onGenerateAllVideos={async (options?: BatchVideoGenerationParams) => {
          await generateAllVideos.mutateAsync({
            ...options,
            videoModel: options?.videoModel || projectData?.videoModel || '',
          })
          onUpdated()
        }}
        onBack={onBack}
        onUpdateVideoPrompt={async (storyboardId, panelIndex, value, field = 'videoPrompt') => {
          await updatePrompt.mutateAsync({ storyboardId, panelIndex, value, field })
          onUpdated()
        }}
        onUpdatePanelVideoModel={async (_storyboardId, _panelIndex, model) => {
          await updateConfig.mutateAsync({ key: 'videoModel', value: model })
          onUpdated()
        }}
        onOpenAssetLibraryForCharacter={onOpenAssets}
      />
    </div>
  )
}
