import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../keys'
import {
    invalidateQueryTemplates,
    requestJsonWithError,
} from './mutation-shared'

export function useUploadProjectPanelVideo(projectId: string, episodeId: string | null) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            file,
            panelId,
          }: {
            file: File
            panelId: string
          }) => {
            const formData = new FormData()
            formData.append('file', file)
            formData.append('panelId', panelId)

            return await requestJsonWithError(`/api/novel-promotion/${projectId}/upload-panel-video`, {
                method: 'POST',
                body: formData,
              }, '上传视频失败')
          },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
            invalidateQueryTemplates(queryClient, [queryKeys.storyboards.all(episodeId || '')])
            if (episodeId) {
                queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) })
            }
         },
        onSuccess: (_data, variables) => {
            invalidateQueryTemplates(queryClient, [
                queryKeys.projectAssets.all(projectId),
                queryKeys.projectData(projectId),
            ])
            if (episodeId) {
                 queryClient.invalidateQueries({ queryKey: queryKeys.storyboards.all(episodeId) })
                 queryClient.invalidateQueries({ queryKey: queryKeys.episodeData(projectId, episodeId) })
              }
         },
      })
}
