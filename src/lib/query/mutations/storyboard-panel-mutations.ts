import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../keys'
import { resolveTaskResponse } from '@/lib/task/client'
import { resolveTaskErrorMessage } from '@/lib/task/error-message'
import { apiFetch } from '@/lib/api-fetch'
import {
    clearTaskTargetOverlay,
    upsertTaskTargetOverlay,
} from '../task-target-overlay'
import {
    invalidateQueryTemplates,
    requestJsonWithError,
    requestTaskResponseWithError,
} from './mutation-shared'

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

export function useRegenerateProjectPanelImage(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            panelId,
            count,
            usePreviousPanelTailAsReference,
        }: {
            panelId: string
            count?: number
            usePreviousPanelTailAsReference?: boolean
        }) => {
            const res = await apiFetch(`/api/novel-promotion/${projectId}/regenerate-panel-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    panelId,
                    count: count ?? 1,
                    ...(typeof usePreviousPanelTailAsReference === 'boolean'
                        ? { usePreviousPanelTailAsReference }
                        : {}),
                }),
            })
            if (!res.ok) {
                const error = await res.json().catch(() => ({}))
                if (res.status === 402) throw new Error('余额不足，请充值后继续使用')
                if (res.status === 400 && String(error?.error || '').includes('敏感')) {
                    throw new Error(resolveTaskErrorMessage(error, '提示词包含敏感内容'))
                }
                if (res.status === 429 || error?.code === 'RATE_LIMIT') {
                    const retryAfter = error?.retryAfter || 60
                    throw new Error(`API 配额超限，请等待 ${retryAfter} 秒后重试`)
                }
                throw new Error(resolveTaskErrorMessage(error, '重新生成失败'))
            }
            return res.json()
        },
        onMutate: ({ panelId }) => {
            upsertTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanel',
                targetId: panelId,
                intent: 'regenerate',
            })
        },
        onSuccess: (data, { panelId }) => {
            const result = data as { async?: boolean; taskId?: unknown; status?: unknown }
            const taskId = typeof result?.taskId === 'string' ? result.taskId.trim() : ''
            if (!result?.async || !taskId) return
            upsertTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanel',
                targetId: panelId,
                phase: result.status === 'processing' ? 'processing' : 'queued',
                runningTaskId: taskId,
                runningTaskType: 'image_panel',
                intent: 'regenerate',
            })
        },
        onError: (_error, { panelId }) => {
            clearTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanel',
                targetId: panelId,
            })
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

export function useUploadProjectPanelImage(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            file,
            panelId,
            sourceImageUrl,
        }: {
            file?: File
            panelId: string
            sourceImageUrl?: string
        }) => {
            if (sourceImageUrl) {
                return await requestJsonWithError(`/api/novel-promotion/${projectId}/upload-panel-image`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ panelId, sourceImageUrl }),
                }, '上传分镜图失败')
            }
            if (!file) throw new Error('缺少上传图片')
            const formData = new FormData()
            formData.append('file', file)
            formData.append('panelId', panelId)

            return await requestJsonWithError(`/api/novel-promotion/${projectId}/upload-panel-image`, {
                method: 'POST',
                body: formData,
            }, '上传分镜图失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

export function useUploadProjectPanelFrameImage(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            file,
            frameId,
            sourceImageUrl,
        }: {
            file?: File
            frameId: string
            sourceImageUrl?: string
        }) => {
            if (sourceImageUrl) {
                return await requestJsonWithError(`/api/novel-promotion/${projectId}/upload-panel-frame-image`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ frameId, sourceImageUrl }),
                }, '上传关键帧图片失败')
            }
            if (!file) throw new Error('缺少上传图片')
            const formData = new FormData()
            formData.append('file', file)
            formData.append('frameId', frameId)

            return await requestJsonWithError(`/api/novel-promotion/${projectId}/upload-panel-frame-image`, {
                method: 'POST',
                body: formData,
            }, '上传关键帧图片失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

export function useRegenerateProjectPanelFrameImage(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            panelId,
            frameId,
            usePreviousPanelTailAsReference,
        }: {
            panelId: string
            frameId: string
            usePreviousPanelTailAsReference?: boolean
        }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/regenerate-panel-frame-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    panelId,
                    frameId,
                    count: 1,
                    ...(typeof usePreviousPanelTailAsReference === 'boolean'
                        ? { usePreviousPanelTailAsReference }
                        : {}),
                }),
            }, '重新生成关键帧失败')
        },
        onMutate: ({ frameId }) => {
            upsertTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanelFrame',
                targetId: frameId,
                intent: 'regenerate',
            })
        },
        onSuccess: (data, { frameId }) => {
            const result = data as { async?: boolean; taskId?: unknown; status?: unknown }
            const taskId = typeof result?.taskId === 'string' ? result.taskId.trim() : ''
            if (!result?.async || !taskId) return
            upsertTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanelFrame',
                targetId: frameId,
                phase: result.status === 'processing' ? 'processing' : 'queued',
                runningTaskId: taskId,
                runningTaskType: 'image_panel',
                intent: 'regenerate',
            })
        },
        onError: (_error, { frameId }) => {
            clearTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanelFrame',
                targetId: frameId,
            })
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

export function useUpdateProjectPanelFrameTime(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            frameId,
            frameTimeSec,
        }: {
            frameId: string
            frameTimeSec: number
        }) => {
            return await requestJsonWithError<{
                success: boolean
                frameId: string
                panelId: string
                frameIndex: number
                frameTimeSec: number
                imagePrompt: string | null
                videoPrompt: string | null
            }>(`/api/novel-promotion/${projectId}/panel-frame`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frameId, frameTimeSec }),
            }, '更新关键帧时间失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
            await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

export function useUpdateProjectPanelFramePrompt(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({
            frameId,
            imagePrompt,
        }: {
            frameId: string
            imagePrompt: string
        }) => {
            return await requestJsonWithError<{
                success: boolean
                frameId: string
                panelId: string
                frameIndex: number
                frameTimeSec: number
                imagePrompt: string | null
                videoPrompt: string | null
            }>(`/api/novel-promotion/${projectId}/panel-frame`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frameId, imagePrompt }),
            }, '更新关键帧提示词失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
            await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

export function useDeleteProjectPanelFrame(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({ frameId }: { frameId: string }) => {
            return await requestJsonWithError<{
                success: boolean
                deletedFrameId: string
                panelId: string
                panelMode: 'single' | 'group'
                imageUrl: string | null
                groupDurationSec: number | null
                groupVideoPrompt: string | null
                groupPlanJson: string | null
                frames: Array<{
                    id: string
                    panelId: string
                    frameIndex: number
                    frameTimeSec: number
                    frameRole: string | null
                    dependencyFrameIds: string | null
                    imagePrompt: string | null
                    videoPrompt: string | null
                    promptJson: string | null
                    referencePolicy: string | null
                    imageUrl: string | null
                    imageMediaId: string | null
                    generationStatus: string | null
                    errorMessage: string | null
                    createdAt?: string
                    updatedAt?: string
                }>
            }>(`/api/novel-promotion/${projectId}/panel-frame`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frameId }),
            }, '删除关键帧失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
            await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

export function useInsertProjectPanelFrame(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: {
            panelId?: string
            frameId?: string
            placement?: 'before' | 'after'
            imagePrompt?: string
        }) => {
            return await requestJsonWithError<{
                success: boolean
                panelId: string
                panelMode: 'single' | 'group'
                imageUrl: string | null
                groupDurationSec: number | null
                groupVideoPrompt: string | null
                groupPlanJson: string | null
                frames: Array<{
                    id: string
                    panelId: string
                    frameIndex: number
                    frameTimeSec: number
                    frameRole: string | null
                    dependencyFrameIds: string | null
                    imagePrompt: string | null
                    videoPrompt: string | null
                    promptJson: string | null
                    referencePolicy: string | null
                    imageUrl: string | null
                    imageMediaId: string | null
                    generationStatus: string | null
                    errorMessage: string | null
                    createdAt?: string
                    updatedAt?: string
                }>
            }>(`/api/novel-promotion/${projectId}/panel-frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '插入关键帧失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
            await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

export function useSplitProjectPanelFrame(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: { frameId: string; placement: 'before' | 'after' }) => {
            return await requestJsonWithError<{
                success: boolean
                panelId: string
                sourcePanelId: string
                placement: 'before' | 'after'
            }>(`/api/novel-promotion/${projectId}/split-panel-frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '拆出关键帧失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
            await invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
            await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

export function useMergeProjectPanelWithNext(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: { panelId: string }) => {
            return await requestJsonWithError<{
                success: boolean
                panelId: string
                mergedPanelId: string
                storyboardId: string
                panelCount: number
                frameCount: number
            }>(`/api/novel-promotion/${projectId}/merge-panels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '合并分镜失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectData(projectId)])
            await invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
            await queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

/**
 * 修改镜头图片（storyboard）
 */

export function useModifyProjectStoryboardImage(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: {
            storyboardId: string
            panelIndex: number
            panelId?: string
            modifyPrompt: string
            extraImageUrls: string[]
            selectedAssets: Array<{
                id: string
                name: string
                type: 'character' | 'location' | 'prop'
                imageUrl: string | null
                appearanceId?: number
                appearanceName?: string
            }>
        }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/modify-storyboard-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '修改失败')
        },
        onMutate: (payload) => {
            if (!payload.panelId) return
            upsertTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanel',
                targetId: payload.panelId,
                runningTaskType: 'modify_asset_image',
                intent: 'modify',
            })
        },
        onSuccess: (data, payload) => {
            if (!payload.panelId) return
            const result = data as { async?: boolean; taskId?: unknown; status?: unknown }
            const taskId = typeof result?.taskId === 'string' ? result.taskId.trim() : ''
            if (!result?.async || !taskId) return
            upsertTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanel',
                targetId: payload.panelId,
                phase: result.status === 'processing' ? 'processing' : 'queued',
                runningTaskId: taskId,
                runningTaskType: 'modify_asset_image',
                intent: 'modify',
            })
        },
        onError: (_error, payload) => {
            if (!payload.panelId) return
            clearTaskTargetOverlay(queryClient, {
                projectId,
                targetType: 'NovelPromotionPanel',
                targetId: payload.panelId,
            })
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 下载剧集全部图片（zip）
 */

export function useDownloadProjectImages(projectId: string) {
    return useMutation({
        mutationFn: async ({ episodeId }: { episodeId: string }) => {
            const response = await apiFetch(`/api/novel-promotion/${projectId}/download-images?episodeId=${episodeId}`)
            if (!response.ok) {
                const error = await response.json().catch(() => ({}))
                throw new Error(resolveTaskErrorMessage(error, '下载失败'))
            }
            return response.blob()
        },
    })
}

/**
 * 更新分镜 panel
 */

export function useUpdateProjectPanel(projectId: string) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (payload: Record<string, unknown>) =>
            await requestJsonWithError(
                `/api/novel-promotion/${projectId}/panel`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                '保存失败',
            ),
        onMutate: (payload: Record<string, unknown>) => {
            const storyboardId = typeof payload.storyboardId === 'string' ? payload.storyboardId : ''
            const panelIndex = typeof payload.panelIndex === 'number' ? payload.panelIndex : Number(payload.panelIndex)
            if (!storyboardId || !Number.isFinite(panelIndex)) return
            const patch = { ...payload }
            delete patch.storyboardId
            delete patch.panelIndex
            delete patch.id
            patchEpisodePanelsCache(queryClient, projectId, {
                storyboardId,
                panelIndex,
                patch,
            })
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
            void queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

export function useUpdateProjectPanelPreviousTailReference(projectId: string) {
    const queryClient = useQueryClient()

    return useMutation({
        mutationFn: async (payload: {
            panelId: string
            storyboardId: string
            panelIndex: number
            usePreviousPanelTailAsReference: boolean
        }) =>
            await requestJsonWithError(
                `/api/novel-promotion/${projectId}/panel`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        panelId: payload.panelId,
                        usePreviousPanelTailAsReference: payload.usePreviousPanelTailAsReference,
                    }),
                },
                '更新沿用上一分镜尾帧开关失败',
            ),
        onMutate: (payload) => {
            patchEpisodePanelsCache(queryClient, projectId, {
                storyboardId: payload.storyboardId,
                panelIndex: payload.panelIndex,
                patch: {
                    usePreviousPanelTailAsReference: payload.usePreviousPanelTailAsReference,
                },
            })
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
            void queryClient.invalidateQueries({ queryKey: ['episode-data', projectId], exact: false })
        },
    })
}

/**
 * 选择/取消镜头候选图（项目）
 */

export function useCreateProjectPanel(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: Record<string, unknown>) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/panel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '添加失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 删除 panel
 */

export function useDeleteProjectPanel(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({ panelId }: { panelId: string }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/panel?panelId=${panelId}`, {
                method: 'DELETE',
            }, '删除失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 删除 storyboard group
 */

export function useDeleteProjectStoryboardGroup(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({ storyboardId }: { storyboardId: string }) => {
            return await requestJsonWithError(
                `/api/novel-promotion/${projectId}/storyboard-group?storyboardId=${storyboardId}`,
                { method: 'DELETE' },
                '删除失败',
            )
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 异步重生成文字分镜
 */

export function useRegenerateProjectStoryboardText(projectId: string) {
    return useMutation({
        mutationFn: async ({ storyboardId }: { storyboardId: string }) => {
            const response = await requestTaskResponseWithError(
                `/api/novel-promotion/${projectId}/regenerate-storyboard-text`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ storyboardId, async: true }),
                },
                'regenerate storyboard text failed',
            )
            return resolveTaskResponse(response)
        },
    })
}

/**
 * 新增 storyboard group
 */

export function useCreateProjectStoryboardGroup(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: { episodeId: string; insertIndex: number }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/storyboard-group`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '添加失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 移动 storyboard group
 */

export function useMoveProjectStoryboardGroup(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: { episodeId: string; clipId: string; direction: 'up' | 'down' }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/storyboard-group`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '移动失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 插入 panel（异步）
 */

export function useInsertProjectPanel(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: { storyboardId: string; insertAfterPanelId: string; userInput: string }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/insert-panel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '插入分镜失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 复制 panel 到下一分镜（同步）
 */

export function useDuplicateProjectPanel(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: { panelId: string }) => {
            return await requestJsonWithError(`/api/novel-promotion/${projectId}/duplicate-panel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '复制分镜失败')
        },
        onSettled: async () => {
            await invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 生成镜头变体（异步）
 */

export function useCreateProjectPanelVariant(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async (payload: {
            storyboardId: string
            insertAfterPanelId: string
            sourcePanelId: string
            variant: {
                title: string
                description: string
                shot_type: string
                camera_move: string
                video_prompt: string
            }
            includeCharacterAssets: boolean
            includeLocationAsset: boolean
        }) => {
            return await requestJsonWithError<{ panelId: string }>(`/api/novel-promotion/${projectId}/panel-variant`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }, '生成变体失败')
        },
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}

/**
 * 清除 storyboard 错误
 */
export function useClearProjectStoryboardError(projectId: string) {
    const queryClient = useQueryClient()
    return useMutation({
        mutationFn: async ({ storyboardId }: { storyboardId: string }) =>
            await requestJsonWithError(
                `/api/novel-promotion/${projectId}/storyboards`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ storyboardId }),
                },
                '清除分镜错误失败',
            ),
        onSettled: () => {
            invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])
        },
    })
}
