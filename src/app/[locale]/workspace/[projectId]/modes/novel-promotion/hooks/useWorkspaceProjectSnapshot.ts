'use client'

import { useMemo } from 'react'
import type { NovelPromotionWorkspaceProps } from '../types'
import type { CapabilitySelections } from '@/lib/model-config-contract'

function parseCapabilitySelections(raw: unknown): CapabilitySelections {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as CapabilitySelections
  }
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as CapabilitySelections
  } catch {
    return {}
  }
}

export function useWorkspaceProjectSnapshot({
  project,
  episode,
  urlStage,
}: Pick<NovelPromotionWorkspaceProps, 'project' | 'episode' | 'urlStage'>) {
  return useMemo(() => {
    const projectData = project.novelPromotionData
    const capabilityOverrides = parseCapabilitySelections(projectData?.capabilityOverrides)
    return {
      projectData,
      projectCharacters: projectData?.characters || [],
      projectLocations: projectData?.locations || [],
      episodeStoryboards: episode?.storyboards || [],
      currentStage: urlStage === 'editor' ? 'videos' : (urlStage || 'config'),
      globalAssetText: projectData?.globalAssetText || '',
      novelText: episode?.novelText || '',
      analysisModel: projectData?.analysisModel,
      characterModel: projectData?.characterModel,
      locationModel: projectData?.locationModel,
      storyboardModel: projectData?.storyboardModel,
      editModel: projectData?.editModel,
      videoModel: projectData?.videoModel,
      audioModel: projectData?.audioModel,
      videoRatio: projectData?.videoRatio,
      capabilityOverrides,
      ttsRate: projectData?.ttsRate,
      artStyle: projectData?.artStyle,
      localImageWidth: typeof projectData?.localImageWidth === 'number' ? projectData.localImageWidth : 1024,
      localImageHeight: typeof projectData?.localImageHeight === 'number' ? projectData.localImageHeight : 1024,
      localImageSteps: typeof projectData?.localImageSteps === 'number' ? projectData.localImageSteps : 8,
      localT2IWidth: typeof projectData?.localT2IWidth === 'number'
        ? projectData.localT2IWidth
        : (typeof projectData?.localImageWidth === 'number' ? projectData.localImageWidth : 1024),
      localT2IHeight: typeof projectData?.localT2IHeight === 'number'
        ? projectData.localT2IHeight
        : (typeof projectData?.localImageHeight === 'number' ? projectData.localImageHeight : 1024),
      localT2ISteps: typeof projectData?.localT2ISteps === 'number'
        ? projectData.localT2ISteps
        : (typeof projectData?.localImageSteps === 'number' ? projectData.localImageSteps : 8),
      localI2IWidth: typeof projectData?.localI2IWidth === 'number'
        ? projectData.localI2IWidth
        : (typeof projectData?.localImageWidth === 'number' ? projectData.localImageWidth : 1024),
      localI2IHeight: typeof projectData?.localI2IHeight === 'number'
        ? projectData.localI2IHeight
        : (typeof projectData?.localImageHeight === 'number' ? projectData.localImageHeight : 1024),
      localI2ISteps: typeof projectData?.localI2ISteps === 'number'
        ? projectData.localI2ISteps
        : (typeof projectData?.localImageSteps === 'number' ? projectData.localImageSteps : 8),
      localStoryboardPromptRefineEnabled: projectData?.localStoryboardPromptRefineEnabled === true,
      localStoryboardPromptRefineLevel:
        projectData?.localStoryboardPromptRefineLevel === 'conservative'
        || projectData?.localStoryboardPromptRefineLevel === 'simple'
        || projectData?.localStoryboardPromptRefineLevel === 'medium'
          ? projectData.localStoryboardPromptRefineLevel
          : 'medium',
    }
  }, [episode?.novelText, episode?.storyboards, project.novelPromotionData, urlStage])
}
