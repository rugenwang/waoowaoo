import { useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '../keys'
import { resolveTaskResponse } from '@/lib/task/client'
import {
  invalidateQueryTemplates,
  requestJsonWithError,
  requestTaskResponseWithError,
} from './mutation-shared'

export function useAiModifyProjectShotPrompt(projectId: string) {
    return useMutation({
        mutationFn: async (payload: {
            currentPrompt: string
            currentVideoPrompt?: string
            modifyInstruction: string
            referencedAssets: Array<{
                id: string
                name: string
                description: string
                type: 'character' | 'location'
            }>
        }) => {
            const response = await requestTaskResponseWithError(
                `/api/novel-promotion/${projectId}/ai-modify-shot-prompt`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                'Failed to modify shot prompt',
            )
            return await resolveTaskResponse<{
                modifiedImagePrompt: string
                modifiedVideoPrompt?: string
                referencedAssets?: Array<{
                    id: string
                    name: string
                    description: string
                    type: 'character' | 'location'
                }>
            }>(response)
        },
    })
}

export function useRefineProjectStoryboardPrompt(projectId: string) {
    return useMutation({
        mutationFn: async (payload: {
            panelId: string
            locale?: 'zh' | 'en'
            draft?: {
                shotType?: string | null
                cameraMove?: string | null
                description?: string | null
                imagePrompt?: string | null
                videoPrompt?: string | null
                location?: string | null
                characters?: Array<{ name: string; appearance: string; slot?: string }>
                props?: string[]
                sourceText?: string | null
                photographyRules?: string | null
                actingNotes?: string | null
            }
        }) => await requestJsonWithError<{
            prompt: string
            refinedPrompt: string
            source: 'description' | 'storyboard'
            strength: 'conservative' | 'medium' | 'simple'
        }>(
            `/api/novel-promotion/${projectId}/refine-storyboard-prompt`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
            'Failed to refine storyboard prompt',
        ),
    })
}

export function useRegenerateProjectVideoPrompt(projectId: string) {
    return useMutation({
        mutationFn: async (payload: {
            panelId?: string
            storyboardId?: string
            panelIndex?: number
            field?: 'videoPrompt' | 'groupVideoPrompt' | 'firstLastFramePrompt'
            additionalRequirement?: string
            locale?: 'zh' | 'en'
        }) => await requestJsonWithError<{
            success: boolean
            prompt: string
            field: 'videoPrompt' | 'groupVideoPrompt' | 'firstLastFramePrompt'
            panelId: string
            storyboardId: string
            panelIndex: number
        }>(
            `/api/novel-promotion/${projectId}/regenerate-video-prompt`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            },
            '重新生成视频提示词失败',
        ),
    })
}

/**
 * 设计音色（项目）
 */

export function useAnalyzeProjectShotVariants(projectId: string) {
    return useMutation({
        mutationFn: async (payload: { panelId: string }) => {
            const response = await requestTaskResponseWithError(
                `/api/novel-promotion/${projectId}/analyze-shot-variants`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                '分析失败',
            )
            return await resolveTaskResponse<{
                success: boolean
                suggestions: Array<{
                    id: number
                    title: string
                    description: string
                    shot_type: string
                    camera_move: string
                    video_prompt: string
                    creative_score: number
                }>
                panelInfo?: {
                    panelNumber?: string | number | null
                    imageUrl?: string | null
                    description?: string | null
                }
            }>(response)
        },
    })
}

/**
 * 更新摄影规则（项目）
 */

export function useUpdateProjectPhotographyPlan(projectId: string) {
    return useMutation({
        mutationFn: async (payload: {
            storyboardId: string
            photographyPlan: string
        }) =>
            await requestJsonWithError(
                `/api/novel-promotion/${projectId}/photography-plan`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                '保存摄影规则失败',
            ),
    })
}

/**
 * 更新镜头演技指导（项目）
 */

export function useUpdateProjectPanelActingNotes(projectId: string) {
    return useMutation({
        mutationFn: async (payload: {
            storyboardId: string
            panelIndex: number
            actingNotes: string
        }) =>
            await requestJsonWithError(
                `/api/novel-promotion/${projectId}/panel`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                '保存演技指导失败',
            ),
    })
}

/**
 * 选择/取消镜头候选图（项目）
 */

export function useSelectProjectPanelCandidate(projectId: string) {
    const queryClient = useQueryClient()
    const invalidateProjectAssets = () =>
        invalidateQueryTemplates(queryClient, [queryKeys.projectAssets.all(projectId)])

    return useMutation({
        mutationFn: async (payload: {
            panelId: string
            action: 'select' | 'cancel'
            selectedImageUrl?: string
        }) =>
            await requestJsonWithError(
                `/api/novel-promotion/${projectId}/panel/select-candidate`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                },
                'Failed to select panel candidate',
            ),
        onSuccess: invalidateProjectAssets,
    })
}
