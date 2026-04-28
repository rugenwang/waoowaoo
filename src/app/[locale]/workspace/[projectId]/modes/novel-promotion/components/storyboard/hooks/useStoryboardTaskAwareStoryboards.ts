'use client'

import { useMemo } from 'react'
import { NovelPromotionStoryboard } from '@/types/project'
import { useStoryboardTaskPresentation } from '@/lib/query/hooks/useTaskPresentation'
import { useTaskQueue } from '@/lib/task-queue'

interface TaskTarget {
  key: string
  targetType: string
  targetId: string
  types: string[]
  resource: 'text' | 'image' | 'video'
  hasOutput: boolean
}

interface UseStoryboardTaskAwareStoryboardsProps {
  projectId: string
  initialStoryboards: NovelPromotionStoryboard[]
  isRunningPhase: (phase: string | null | undefined) => boolean
}

function buildStoryboardTextTargets(storyboards: NovelPromotionStoryboard[]): TaskTarget[] {
  const targets: TaskTarget[] = []

  for (const storyboard of storyboards) {
    targets.push({
      key: `storyboard:${storyboard.id}`,
      targetType: 'NovelPromotionStoryboard',
      targetId: storyboard.id,
      types: ['regenerate_storyboard_text', 'insert_panel'],
      resource: 'text',
      hasOutput: !!(storyboard.panels || []).length,
    })
    if (storyboard.episodeId) {
      targets.push({
        key: `episode:${storyboard.episodeId}`,
        targetType: 'NovelPromotionEpisode',
        targetId: storyboard.episodeId,
        types: ['regenerate_storyboard_text', 'insert_panel'],
        resource: 'text',
        hasOutput: !!(storyboard.panels || []).length,
      })
    }
  }

  return targets
}

function buildPanelTargets(storyboards: NovelPromotionStoryboard[], type: 'image' | 'video' | 'lip-sync'): TaskTarget[] {
  const targets: TaskTarget[] = []

  for (const storyboard of storyboards) {
    for (const panel of storyboard.panels || []) {
      if (type === 'image') {
        targets.push({
          key: `panel-image:${panel.id}`,
          targetType: 'NovelPromotionPanel',
          targetId: panel.id,
          types: ['image_panel', 'panel_variant', 'modify_asset_image'],
          resource: 'image',
          hasOutput: !!panel.imageUrl,
        })
      } else if (type === 'video') {
        targets.push({
          key: `panel-video:${panel.id}`,
          targetType: 'NovelPromotionPanel',
          targetId: panel.id,
          types: ['video_panel'],
          resource: 'video',
          hasOutput: !!panel.videoUrl,
        })
      } else {
        targets.push({
          key: `panel-lip:${panel.id}`,
          targetType: 'NovelPromotionPanel',
          targetId: panel.id,
          types: ['lip_sync'],
          resource: 'video',
          hasOutput: !!panel.lipSyncVideoUrl,
        })
      }
    }
  }

  return targets
}

export function useStoryboardTaskAwareStoryboards({
  projectId,
  initialStoryboards,
  isRunningPhase,
}: UseStoryboardTaskAwareStoryboardsProps) {
  const taskQueue = useTaskQueue()
  const queueMode = taskQueue.enabled
  const activeTarget = taskQueue.activeTarget

  const storyboardTextTargets = useMemo(
    () => buildStoryboardTextTargets(initialStoryboards),
    [initialStoryboards],
  )
  const panelTargetsByType = useMemo(() => {
    if (!queueMode) {
      return {
        image: buildPanelTargets(initialStoryboards, 'image'),
        video: buildPanelTargets(initialStoryboards, 'video'),
        lip: buildPanelTargets(initialStoryboards, 'lip-sync'),
      }
    }
    if (!activeTarget || activeTarget.targetType !== 'NovelPromotionPanel') {
      return { image: [] as TaskTarget[], video: [] as TaskTarget[], lip: [] as TaskTarget[] }
    }
    const isVideo = (activeTarget.types || []).includes('video_panel')
    const isLip = (activeTarget.types || []).includes('lip_sync')
    const panelId = activeTarget.targetId
    const makeOne = (type: 'image' | 'video' | 'lip-sync'): TaskTarget[] => {
      if (type === 'image') {
        return [{
          key: `panel-image:${panelId}`,
          targetType: 'NovelPromotionPanel',
          targetId: panelId,
          types: ['image_panel', 'panel_variant', 'modify_asset_image'],
          resource: 'image',
          hasOutput: true,
        }]
      }
      if (type === 'video') {
        return [{
          key: `panel-video:${panelId}`,
          targetType: 'NovelPromotionPanel',
          targetId: panelId,
          types: ['video_panel'],
          resource: 'video',
          hasOutput: true,
        }]
      }
      return [{
        key: `panel-lip:${panelId}`,
        targetType: 'NovelPromotionPanel',
        targetId: panelId,
        types: ['lip_sync'],
        resource: 'video',
        hasOutput: true,
      }]
    }
    return {
      image: (!isVideo && !isLip) ? makeOne('image') : [],
      video: isVideo ? makeOne('video') : [],
      lip: isLip ? makeOne('lip-sync') : [],
    }
  }, [activeTarget, initialStoryboards, queueMode])

  const storyboardTextStates = useStoryboardTaskPresentation(
    projectId,
    storyboardTextTargets,
    !!projectId && storyboardTextTargets.length > 0,
  )
  const panelImageStates = useStoryboardTaskPresentation(
    projectId,
    panelTargetsByType.image,
    !!projectId && panelTargetsByType.image.length > 0,
  )
  const panelVideoStates = useStoryboardTaskPresentation(
    projectId,
    panelTargetsByType.video,
    !!projectId && panelTargetsByType.video.length > 0,
  )
  const panelLipSyncStates = useStoryboardTaskPresentation(
    projectId,
    panelTargetsByType.lip,
    !!projectId && panelTargetsByType.lip.length > 0,
  )

  const taskAwareStoryboards = useMemo(() => {
    return initialStoryboards.map((storyboard) => ({
      ...storyboard,
      storyboardTaskRunning:
        isRunningPhase(storyboardTextStates.getTaskState(`storyboard:${storyboard.id}`)?.phase) ||
        isRunningPhase(storyboardTextStates.getTaskState(`episode:${storyboard.episodeId}`)?.phase),
      panels: (storyboard.panels || []).map((panel) => {
        const panelImageTaskState = panelImageStates.getTaskState(`panel-image:${panel.id}`)
        const panelImageRunning = isRunningPhase(panelImageTaskState?.phase)
        return {
          ...panel,
          imageTaskRunning: panelImageRunning,
          imageTaskIntent: panelImageTaskState?.intent,
          videoTaskRunning: isRunningPhase(panelVideoStates.getTaskState(`panel-video:${panel.id}`)?.phase),
          lipSyncTaskRunning: isRunningPhase(panelLipSyncStates.getTaskState(`panel-lip:${panel.id}`)?.phase),
        }
      }),
    }))
  }, [
    initialStoryboards,
    isRunningPhase,
    panelImageStates,
    panelLipSyncStates,
    panelVideoStates,
    storyboardTextStates,
  ])

  return {
    taskAwareStoryboards,
  }
}
