'use client'

import { useCallback } from 'react'
import { VideoClip, VideoEditorProject } from '../types/editor.types'
import { apiFetch } from '@/lib/api-fetch'

interface UseEditorActionsProps {
    projectId: string
    episodeId: string
}

/**
 * 面板数据类型（灵活接受各种格式）
 */
interface PanelData {
    id?: string
    panelIndex?: number
    storyboardId: string
    videoUrl?: string
    lipSyncVideoUrl?: string
    imageUrl?: string
    description?: string
    duration?: number
    groupDurationSec?: number | null
    videoPrompt?: string | null
    groupVideoPrompt?: string | null
    panelMode?: string | null
}

function readPositiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function resolvePanelDurationSeconds(panel: Pick<PanelData, 'duration' | 'groupDurationSec'>): number {
    return readPositiveNumber(panel.duration) ?? readPositiveNumber(panel.groupDurationSec) ?? 3
}

function resolvePanelSourceId(panel: PanelData, index: number): string {
    return panel.id || `${panel.storyboardId}-${panel.panelIndex ?? index}`
}

/**
 * 从已生成的视频面板创建编辑器项目
 */
export function createProjectFromPanels(
    episodeId: string,
    panels: PanelData[],
    voiceLines?: Array<{ id: string; speaker: string; content: string; audioUrl?: string | null }>
): VideoEditorProject {
    // 过滤出有视频的面板
    const videoPanels = panels.filter(p => p.lipSyncVideoUrl || p.videoUrl)

    // 创建视频片段
    const timeline: VideoClip[] = videoPanels.map((panel, index) => {
        // 查找匹配的配音（简单匹配：按索引）
        const matchedVoice = voiceLines?.[index]
        const durationSeconds = resolvePanelDurationSeconds(panel)

        const durationInFrames = Math.max(1, Math.round(durationSeconds * 30))

        return {
            id: `clip_${panel.id || panel.storyboardId}_${panel.panelIndex ?? index}`,
            src: (panel.lipSyncVideoUrl || panel.videoUrl)!,
            durationInFrames,
            originalDurationInFrames: durationInFrames,
            attachment: {
                audio: matchedVoice?.audioUrl ? {
                    src: matchedVoice.audioUrl,
                    volume: 1,
                    voiceLineId: matchedVoice.id
                } : undefined,
                subtitle: matchedVoice ? {
                    text: matchedVoice.content,
                    style: 'default' as const
                } : undefined
            },
            transition: undefined,
            metadata: {
                panelId: resolvePanelSourceId(panel, index),
                storyboardId: panel.storyboardId,
                panelIndex: panel.panelIndex ?? index,
                description: panel.description || undefined,
                videoPrompt: panel.groupVideoPrompt || panel.videoPrompt || undefined,
                promptField: panel.panelMode === 'group' ? 'groupVideoPrompt' : 'videoPrompt',
                imageUrl: panel.imageUrl || undefined,
                durationSeconds,
            }
        }
    })

    return {
        id: `editor_${episodeId}_${Date.now()}`,
        episodeId,
        schemaVersion: '1.0',
        config: {
            fps: 30,
            width: 1920,
            height: 1080
        },
        timeline,
        bgmTrack: []
    }
}

export function reconcileProjectWithPanels(project: VideoEditorProject, panels: PanelData[]): VideoEditorProject {
    const fps = readPositiveNumber(project.config?.fps) ?? 30
    const durationByPanelId = new Map<string, number>()

    panels.forEach((panel, index) => {
        durationByPanelId.set(resolvePanelSourceId(panel, index), resolvePanelDurationSeconds(panel))
    })

    let changed = false
    const timeline = project.timeline.map((clip) => {
        const durationSeconds = durationByPanelId.get(clip.metadata?.panelId)
        if (!durationSeconds) return clip

        // 已分割、裁剪或由编辑器重新生成的片段保留用户剪辑结果，不自动拉长/压缩。
        if (clip.trim || clip.metadata?.regeneratedFromClipId) return clip

        const durationInFrames = Math.max(1, Math.round(durationSeconds * fps))
        if (
            clip.durationInFrames === durationInFrames
            && clip.originalDurationInFrames === durationInFrames
            && clip.metadata?.durationSeconds === durationSeconds
        ) {
            return clip
        }

        changed = true
        return {
            ...clip,
            durationInFrames,
            originalDurationInFrames: durationInFrames,
            metadata: {
                ...clip.metadata,
                durationSeconds,
            },
        }
    })

    return changed ? { ...project, timeline } : project
}

export function useEditorActions({ projectId, episodeId }: UseEditorActionsProps) {
    /**
     * 保存项目到服务器
     */
    const saveProject = useCallback(async (project: VideoEditorProject) => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ episodeId, projectData: project })
        })

        if (!response.ok) {
            throw new Error('Failed to save project')
        }

        return response.json()
    }, [episodeId, projectId])

    /**
     * 加载项目
     */
    const loadProject = useCallback(async (): Promise<VideoEditorProject | null> => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor?episodeId=${episodeId}`)

        if (!response.ok) {
            if (response.status === 404) return null
            throw new Error('Failed to load project')
        }

        const data = await response.json()
        return data.projectData
    }, [projectId, episodeId])

    /**
     * 发起渲染导出
     */
    const startRender = useCallback(async (editorProjectId: string) => {
        const response = await apiFetch(`/api/novel-promotion/${projectId}/editor/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                editorProjectId,
                format: 'mp4',
                quality: 'high'
            })
        })

        if (!response.ok) {
            throw new Error('Failed to start render')
        }

        return response.json()
    }, [projectId])

    /**
     * 获取渲染状态
     */
    const getRenderStatus = useCallback(async (editorProjectId: string) => {
        const response = await apiFetch(
            `/api/novel-promotion/${projectId}/editor/render?id=${editorProjectId}`
        )

        if (!response.ok) {
            throw new Error('Failed to get render status')
        }

        return response.json()
    }, [projectId])

    return {
        saveProject,
        loadProject,
        startRender,
        getRenderStatus
    }
}
