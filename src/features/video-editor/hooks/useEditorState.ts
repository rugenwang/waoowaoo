'use client'

import { useState, useCallback } from 'react'
import {
    VideoEditorProject,
    VideoClip,
    BgmClip,
    TimelineState,
    createDefaultProject,
    generateClipId
} from '../index'

interface UseEditorStateProps {
    episodeId: string
    initialProject?: VideoEditorProject
}

type ProjectUpdater = VideoEditorProject | ((previous: VideoEditorProject) => VideoEditorProject)

const MAX_HISTORY_LENGTH = 100

function normalizeClipForEditing(clip: VideoClip): VideoClip {
    const originalDurationInFrames = Math.max(
        1,
        Math.round(clip.originalDurationInFrames || clip.trim?.to || clip.durationInFrames || 1)
    )
    const trim = clip.trim
        ? {
            from: Math.max(0, Math.min(originalDurationInFrames - 1, Math.round(clip.trim.from))),
            to: Math.max(1, Math.min(originalDurationInFrames, Math.round(clip.trim.to))),
        }
        : undefined
    return {
        ...clip,
        durationInFrames: Math.max(1, Math.round(clip.durationInFrames || Math.max(1, (trim?.to || originalDurationInFrames) - (trim?.from || 0)))),
        originalDurationInFrames,
        trim,
    }
}

function resolveProjectUpdater(previous: VideoEditorProject, updater: ProjectUpdater): VideoEditorProject {
    return typeof updater === 'function' ? updater(previous) : updater
}

export function useEditorState({ episodeId, initialProject }: UseEditorStateProps) {
    // 项目数据
    const [project, setProject] = useState<VideoEditorProject>(
        initialProject || createDefaultProject(episodeId)
    )

    // 时间轴 UI 状态
    const [timelineState, setTimelineState] = useState<TimelineState>({
        currentFrame: 0,
        playing: false,
        selectedClipId: null,
        zoom: 1
    })

    // 是否有未保存的更改
    const [isDirty, setIsDirty] = useState(false)
    const [pastProjects, setPastProjects] = useState<VideoEditorProject[]>([])
    const [futureProjects, setFutureProjects] = useState<VideoEditorProject[]>([])

    const commitProject = useCallback((updater: ProjectUpdater, options?: { dirty?: boolean }) => {
        setProject(prev => {
            const normalizedPrevious = {
                ...prev,
                timeline: prev.timeline.map(normalizeClipForEditing),
            }
            const nextProject = resolveProjectUpdater(normalizedPrevious, updater)
            if (nextProject === prev) return prev
            setPastProjects(history => [...history.slice(-(MAX_HISTORY_LENGTH - 1)), normalizedPrevious])
            setFutureProjects([])
            if (options?.dirty !== false) setIsDirty(true)
            return {
                ...nextProject,
                timeline: nextProject.timeline.map(normalizeClipForEditing),
            }
        })
    }, [])

    // ========================================
    // 时间轴片段操作
    // ========================================

    const addClip = useCallback((clip: Omit<VideoClip, 'id'>) => {
        const newClip: VideoClip = {
            ...clip,
            id: generateClipId()
        }
        commitProject(prev => ({
            ...prev,
            timeline: [...prev.timeline, newClip]
        }))
        return newClip.id
    }, [commitProject])

    const removeClip = useCallback((clipId: string) => {
        commitProject(prev => ({
            ...prev,
            timeline: prev.timeline.filter(c => c.id !== clipId)
        }))
    }, [commitProject])

    const updateClip = useCallback((clipId: string, updates: Partial<VideoClip>) => {
        commitProject(prev => ({
            ...prev,
            timeline: prev.timeline.map(c =>
                c.id === clipId ? { ...c, ...updates } : c
            )
        }))
    }, [commitProject])

    const reorderClips = useCallback((fromIndex: number, toIndex: number) => {
        commitProject(prev => {
            const newTimeline = [...prev.timeline]
            const [removed] = newTimeline.splice(fromIndex, 1)
            newTimeline.splice(toIndex, 0, removed)
            return { ...prev, timeline: newTimeline }
        })
    }, [commitProject])

    const splitClipAtFrame = useCallback((clipId: string, localFrame: number, minFrames = 6) => {
        const rightClipId = generateClipId()
        let didSplit = false
        commitProject(prev => {
            const clipIndex = prev.timeline.findIndex(clip => clip.id === clipId)
            if (clipIndex < 0) return prev
            const clip = normalizeClipForEditing(prev.timeline[clipIndex])
            const splitFrame = Math.round(localFrame)
            if (splitFrame < minFrames || clip.durationInFrames - splitFrame < minFrames) return prev

            const trimFrom = clip.trim?.from || 0
            const trimTo = clip.trim?.to || trimFrom + clip.durationInFrames
            const splitSourceFrame = Math.max(trimFrom + minFrames, Math.min(trimTo - minFrames, trimFrom + splitFrame))
            const leftDuration = splitSourceFrame - trimFrom
            const rightDuration = trimTo - splitSourceFrame
            if (leftDuration < minFrames || rightDuration < minFrames) return prev

            const leftClip: VideoClip = {
                ...clip,
                durationInFrames: leftDuration,
                trim: { from: trimFrom, to: splitSourceFrame },
                originalDurationInFrames: clip.originalDurationInFrames || trimTo,
                transition: undefined,
            }
            const rightClip: VideoClip = {
                ...clip,
                id: rightClipId,
                durationInFrames: rightDuration,
                trim: { from: splitSourceFrame, to: trimTo },
                originalDurationInFrames: clip.originalDurationInFrames || trimTo,
                transition: clip.transition,
                metadata: {
                    ...clip.metadata,
                    description: clip.metadata.description ? `${clip.metadata.description}（分割片段）` : clip.metadata.description,
                },
            }
            didSplit = true
            const timeline = [...prev.timeline]
            timeline.splice(clipIndex, 1, leftClip, rightClip)
            return { ...prev, timeline }
        })
        return didSplit ? rightClipId : null
    }, [commitProject])

    const restoreClipTrim = useCallback((clipId: string) => {
        commitProject(prev => ({
            ...prev,
            timeline: prev.timeline.map((clip) => {
                if (clip.id !== clipId) return clip
                const normalized = normalizeClipForEditing(clip)
                const originalDurationInFrames = normalized.originalDurationInFrames || normalized.durationInFrames
                return {
                    ...normalized,
                    durationInFrames: originalDurationInFrames,
                    trim: undefined,
                    originalDurationInFrames,
                }
            })
        }))
    }, [commitProject])

    // ========================================
    // BGM 操作
    // ========================================

    const addBgm = useCallback((bgm: Omit<BgmClip, 'id'>) => {
        const newBgm: BgmClip = {
            ...bgm,
            id: `bgm_${Date.now()}`
        }
        commitProject(prev => ({
            ...prev,
            bgmTrack: [...prev.bgmTrack, newBgm]
        }))
    }, [commitProject])

    const removeBgm = useCallback((bgmId: string) => {
        commitProject(prev => ({
            ...prev,
            bgmTrack: prev.bgmTrack.filter(b => b.id !== bgmId)
        }))
    }, [commitProject])

    // ========================================
    // 播放控制
    // ========================================

    const play = useCallback(() => {
        setTimelineState(prev => ({ ...prev, playing: true }))
    }, [])

    const pause = useCallback(() => {
        setTimelineState(prev => ({ ...prev, playing: false }))
    }, [])

    const seek = useCallback((frame: number) => {
        setTimelineState(prev => (
            prev.currentFrame === frame ? prev : { ...prev, currentFrame: frame }
        ))
    }, [])

    const selectClip = useCallback((clipId: string | null) => {
        setTimelineState(prev => ({ ...prev, selectedClipId: clipId }))
    }, [])

    const setZoom = useCallback((zoom: number) => {
        setTimelineState(prev => ({ ...prev, zoom: Math.max(0.1, Math.min(5, zoom)) }))
    }, [])

    // ========================================
    // 项目操作
    // ========================================

    const resetProject = useCallback(() => {
        setProject(createDefaultProject(episodeId))
        setPastProjects([])
        setFutureProjects([])
        setIsDirty(false)
    }, [episodeId])

    const loadProject = useCallback((data: VideoEditorProject) => {
        setProject({
            ...data,
            timeline: data.timeline.map(normalizeClipForEditing),
        })
        setPastProjects([])
        setFutureProjects([])
        setIsDirty(false)
    }, [])

    const markSaved = useCallback(() => {
        setIsDirty(false)
    }, [])

    const undo = useCallback(() => {
        setPastProjects((previousPast) => {
            if (previousPast.length === 0) return previousPast
            const restoredProject = previousPast[previousPast.length - 1]
            const nextPast = previousPast.slice(0, -1)
            setProject((currentProject) => {
                setFutureProjects((previousFuture) => [currentProject, ...previousFuture].slice(0, MAX_HISTORY_LENGTH))
                return restoredProject
            })
            setIsDirty(true)
            return nextPast
        })
    }, [])

    const redo = useCallback(() => {
        setFutureProjects((previousFuture) => {
            if (previousFuture.length === 0) return previousFuture
            const restoredProject = previousFuture[0]
            const nextFuture = previousFuture.slice(1)
            setProject((currentProject) => {
                setPastProjects((previousPast) => [...previousPast.slice(-(MAX_HISTORY_LENGTH - 1)), currentProject])
                return restoredProject
            })
            setIsDirty(true)
            return nextFuture
        })
    }, [])

    return {
        // State
        project,
        timelineState,
        isDirty,
        canUndo: pastProjects.length > 0,
        canRedo: futureProjects.length > 0,

        // Clip actions
        addClip,
        removeClip,
        updateClip,
        reorderClips,
        splitClipAtFrame,
        restoreClipTrim,

        // BGM actions
        addBgm,
        removeBgm,

        // Playback
        play,
        pause,
        seek,
        selectClip,
        setZoom,

        // Project
        resetProject,
        loadProject,
        markSaved,
        setProject: commitProject,
        undo,
        redo,
    }
}
