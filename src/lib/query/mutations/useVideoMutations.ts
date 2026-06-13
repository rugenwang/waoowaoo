import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../keys'
import { invalidateQueryTemplates, requestJsonWithError } from './mutation-shared'

type EpisodeDataWithStoryboards = {
  storyboards?: Array<{
    id?: string
    panels?: Array<Record<string, unknown>>
  }>
} & Record<string, unknown>

function patchEpisodePanelsCache(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  payload: {
    storyboardId: string
    panelIndex: number
    patch: Record<string, unknown>
  },
) {
  const queries = queryClient.getQueriesData<EpisodeDataWithStoryboards>({
    queryKey: ['episode-data', projectId],
  })

  for (const [queryKey, data] of queries) {
    if (!data?.storyboards) continue
    const nextStoryboards = data.storyboards.map((storyboard) => {
      if (storyboard.id !== payload.storyboardId || !Array.isArray(storyboard.panels)) return storyboard
      const nextPanels = storyboard.panels.map((panel, index) =>
        index === payload.panelIndex ? { ...panel, ...payload.patch } : panel,
      )
      return { ...storyboard, panels: nextPanels }
    })
    queryClient.setQueryData(queryKey, { ...data, storyboards: nextStoryboards })
  }
}

/**
 * 获取剧集可下载视频列表（项目）
 */
export function useListProjectEpisodeVideoUrls(projectId: string) {
  return useMutation({
    mutationFn: async (payload: {
      episodeId: string
      panelPreferences: Record<string, boolean>
    }) =>
      await requestJsonWithError(
        `/api/novel-promotion/${projectId}/video-urls`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '获取视频列表失败',
      ),
  })
}

/**
 * 更新 panel 首尾帧链接状态（项目）
 */
export function useUpdateProjectPanelLink(projectId: string) {
  return useMutation({
    mutationFn: async (payload: {
      storyboardId: string
      panelIndex: number
      linked: boolean
    }) =>
      await requestJsonWithError(
        `/api/novel-promotion/${projectId}/panel-link`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '保存链接状态失败',
      ),
  })
}

/**
 * 更新 Panel 视频提示词
 */
export function useUpdateProjectPanelVideoPrompt(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      storyboardId,
      panelIndex,
      value,
      field = 'videoPrompt',
    }: {
      storyboardId: string
      panelIndex: number
      value: string
      field?: 'videoPrompt' | 'groupVideoPrompt' | 'firstLastFramePrompt'
    }) =>
      await requestJsonWithError(
        `/api/novel-promotion/${projectId}/panel`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId,
            panelIndex,
            ...(field === 'firstLastFramePrompt'
              ? { firstLastFramePrompt: value }
              : field === 'groupVideoPrompt'
                ? { groupVideoPrompt: value }
                : { videoPrompt: value }),
          }),
        },
        'update failed',
      ),
    onMutate: ({ storyboardId, panelIndex, value, field = 'videoPrompt' }) => {
      patchEpisodePanelsCache(queryClient, projectId, {
        storyboardId,
        panelIndex,
        patch: field === 'firstLastFramePrompt'
          ? { firstLastFramePrompt: value }
          : field === 'groupVideoPrompt'
            ? { groupVideoPrompt: value }
            : { videoPrompt: value },
      })
    },
    onSettled: async () => {
      await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
      await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
    },
  })
}

/**
 * 更新 Panel 镜头时长（秒）
 */
export function useUpdateProjectPanelDuration(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      storyboardId,
      panelIndex,
      duration,
    }: {
      storyboardId: string
      panelIndex: number
      duration: number | null
    }) =>
      await requestJsonWithError(
        `/api/novel-promotion/${projectId}/panel`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storyboardId,
            panelIndex,
            duration,
          }),
        },
        'update failed',
      ),
    onMutate: ({ storyboardId, panelIndex, duration }) => {
      patchEpisodePanelsCache(queryClient, projectId, {
        storyboardId,
        panelIndex,
        patch: { duration },
      })
    },
    onSettled: async () => {
      await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
      await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
    },
  })
}

export function useExtractProjectPanelVocals(projectId: string) {
  return useMutation({
    mutationFn: async (payload: {
      panelId: string
      startSec: number
      endSec: number
    }) =>
      await requestJsonWithError<{
        success: boolean
        audioKey: string
        audioUrl: string
        mediaId: string
        dialogueTaskId?: string
        startSec: number
        endSec: number
      }>(
        `/api/novel-promotion/${projectId}/panel-dubbing/extract-vocals`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '提取人声失败',
      ),
  })
}

export function useCloneProjectPanelDubbing(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (payload: {
      panelId: string
      mode: 'video-vocal' | 'character-voice'
      text: string
      promptText?: string
      sourceAudioKey?: string
      characterId?: string
      syncPromptToCharacter?: boolean
    }) =>
      await requestJsonWithError<{
        success: boolean
        audioKey: string
        audioUrl: string
        mediaId: string
        sourceType: string
        meta?: Record<string, unknown>
      }>(
        `/api/novel-promotion/${projectId}/panel-dubbing/clone`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        '视频配音失败',
      ),
    onSettled: async (_data, _error, payload) => {
      await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
      await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
      if (payload?.syncPromptToCharacter) {
        await invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
      }
    },
  })
}
