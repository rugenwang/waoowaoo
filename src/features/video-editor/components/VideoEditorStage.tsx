'use client'
import { logError as _ulogError } from '@/lib/logging/core'
import { useTranslations } from 'next-intl'

import React, { useEffect, useMemo, useState } from 'react'
import { AppIcon } from '@/components/ui/icons'
import { useEditorState } from '../hooks/useEditorState'
import { createProjectFromPanels, useEditorActions } from '../hooks/useEditorActions'
import type { VideoEditorProject } from '../types/editor.types'
import { calculateTimelineDuration, framesToTime } from '../utils/time-utils'
import { RemotionPreview } from './Preview'
import { Timeline } from './Timeline'
import { TransitionPicker, TransitionType } from './TransitionPicker'

type EditorToneMode = 'soft' | 'light' | 'dark'

interface VideoEditorStageProps {
    projectId: string
    episodeId: string
    initialProject?: VideoEditorProject
    onBack?: () => void
    sourcePanels?: Array<{
        id?: string
        storyboardId: string
        panelIndex?: number
        description?: string | null
        duration?: number | null
        groupDurationSec?: number | null
        videoUrl?: string | null
        lipSyncVideoUrl?: string | null
        imageUrl?: string | null
        videoPrompt?: string | null
        groupVideoPrompt?: string | null
        panelMode?: string | null
    }>
    defaultVideoModel?: string
    onUpdateVideoPrompt?: (
        storyboardId: string,
        panelIndex: number,
        value: string,
        field?: 'videoPrompt' | 'groupVideoPrompt',
    ) => Promise<void>
    onGenerateVideo?: (
        storyboardId: string,
        panelIndex: number,
        model?: string,
        firstLastFrame?: undefined,
        generationOptions?: undefined,
        panelId?: string,
    ) => Promise<void>
}

/**
 * 视频编辑器主页面
 * 
 * 布局:
 * ┌──────────────────────────────────────────────────────────┐
 * │ Toolbar (返回 | 保存 | 导出)                              │
 * ├──────────────┬───────────────────────────────────────────┤
 * │  素材库       │       Preview (Remotion Player)           │
 * │              │                                           │
 * │              ├───────────────────────────────────────────┤
 * │              │       Properties Panel                    │
 * ├──────────────┴───────────────────────────────────────────┤
 * │                      Timeline                            │
 * └──────────────────────────────────────────────────────────┘
 */
export function VideoEditorStage({
    projectId,
    episodeId,
    initialProject,
    onBack,
    sourcePanels = [],
    defaultVideoModel,
    onUpdateVideoPrompt,
    onGenerateVideo,
}: VideoEditorStageProps) {
    const t = useTranslations('video')
    const {
        project,
        timelineState,
        isDirty,
        removeClip,
        updateClip,
        reorderClips,
        play,
        pause,
        seek,
        selectClip,
        setZoom,
        markSaved,
        setProject,
    } = useEditorState({ episodeId, initialProject })

    const { saveProject } = useEditorActions({ projectId, episodeId })
    const [promptDraft, setPromptDraft] = useState('')
    const [statusMessage, setStatusMessage] = useState('')
    const [isExporting, setIsExporting] = useState(false)
    const [isLibraryOpen, setIsLibraryOpen] = useState(false)
    const [toneMode, setToneMode] = useState<EditorToneMode>('soft')

    const totalDuration = calculateTimelineDuration(project.timeline)
    const totalTime = framesToTime(totalDuration, project.config.fps)
    const currentTime = framesToTime(timelineState.currentFrame, project.config.fps)
    const selectedClip = project.timeline.find(c => c.id === timelineState.selectedClipId)
    const generatedSourceCount = useMemo(
        () => sourcePanels.filter((panel) => panel.lipSyncVideoUrl || panel.videoUrl).length,
        [sourcePanels],
    )
    const toneStyles = useMemo<React.CSSProperties>(() => {
        if (toneMode === 'dark') {
            return {
                '--glass-bg-canvas': '#111827',
                '--glass-bg-surface': 'rgba(17, 24, 39, 0.92)',
                '--glass-bg-surface-strong': 'rgba(15, 23, 42, 0.96)',
                '--glass-bg-muted': 'rgba(31, 41, 55, 0.9)',
                '--glass-bg-surface-modal': 'rgba(17, 24, 39, 0.98)',
                '--glass-text-primary': '#f8fafc',
                '--glass-text-secondary': '#d1d5db',
                '--glass-text-tertiary': '#9ca3af',
                '--glass-stroke-base': 'rgba(148, 163, 184, 0.28)',
                '--glass-stroke-strong': 'rgba(148, 163, 184, 0.42)',
                '--glass-overlay-strong': 'rgba(2, 6, 23, 0.72)',
            } as React.CSSProperties
        }
        if (toneMode === 'soft') {
            return {
                '--glass-bg-canvas': '#e8ebf0',
                '--glass-bg-surface': 'rgba(242, 244, 248, 0.9)',
                '--glass-bg-surface-strong': 'rgba(232, 236, 244, 0.94)',
                '--glass-bg-muted': 'rgba(226, 232, 240, 0.82)',
                '--glass-bg-surface-modal': 'rgba(242, 244, 248, 0.98)',
                '--glass-stroke-soft': 'rgba(148, 163, 184, 0.18)',
                '--glass-stroke-base': 'rgba(100, 116, 139, 0.26)',
            } as React.CSSProperties
        }
        return {}
    }, [toneMode])

    useEffect(() => {
        setPromptDraft(selectedClip?.metadata.videoPrompt || '')
    }, [selectedClip?.id, selectedClip?.metadata.videoPrompt])

    const handleSave = async () => {
        try {
            await saveProject(project)
            markSaved()
            alert(t('editor.alert.saveSuccess'))
        } catch (error) {
            _ulogError('Save failed:', error)
            alert(t('editor.alert.saveFailed'))
        }
    }

    const handleRebuildTimeline = () => {
        const nextProject = createProjectFromPanels(episodeId, sourcePanels.map((panel) => ({
            ...panel,
            videoUrl: panel.videoUrl || undefined,
            lipSyncVideoUrl: panel.lipSyncVideoUrl || undefined,
            imageUrl: panel.imageUrl || undefined,
            description: panel.description || undefined,
            duration: panel.duration ?? undefined,
            groupDurationSec: panel.groupDurationSec ?? undefined,
            videoPrompt: panel.videoPrompt || undefined,
            groupVideoPrompt: panel.groupVideoPrompt || undefined,
        })))
        setProject((previous) => ({
            ...nextProject,
            id: previous.id || nextProject.id,
            bgmTrack: previous.bgmTrack,
        }))
        setStatusMessage(`已按成片顺序生成 ${nextProject.timeline.length} 个片段`)
    }

    const handleSavePrompt = async () => {
        if (!selectedClip || !onUpdateVideoPrompt) return
        const panelIndex = selectedClip.metadata.panelIndex ?? 0
        const field = selectedClip.metadata.promptField || 'videoPrompt'
        await onUpdateVideoPrompt(selectedClip.metadata.storyboardId, panelIndex, promptDraft, field)
        updateClip(selectedClip.id, {
            metadata: {
                ...selectedClip.metadata,
                videoPrompt: promptDraft,
            },
        })
        setStatusMessage('视频提示词已保存到对应分镜')
    }

    const handleRegenerateSelected = async () => {
        if (!selectedClip || !onGenerateVideo) return
        await handleSavePrompt()
        await onGenerateVideo(
            selectedClip.metadata.storyboardId,
            selectedClip.metadata.panelIndex ?? 0,
            defaultVideoModel,
            undefined,
            undefined,
            selectedClip.metadata.panelId,
        )
        setStatusMessage('已提交该片段重新生成，完成后可点击“同步成片片段”刷新时间线素材')
    }

    const downloadResponseBlob = async (response: Response, fallbackName: string) => {
        if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(text || '导出失败')
        }
        const blob = await response.blob()
        const disposition = response.headers.get('content-disposition') || ''
        const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
        const filename = match?.[1] ? decodeURIComponent(match[1]) : fallbackName
        const url = window.URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.URL.revokeObjectURL(url)
    }

    const handleExportJoinedVideo = async () => {
        setIsExporting(true)
        try {
            const response = await fetch(`/api/novel-promotion/${projectId}/editor/export-video`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ episodeId, projectData: project }),
            })
            await downloadResponseBlob(response, 'waoo-editor.mp4')
            setStatusMessage('已导出拼接视频')
        } catch (error) {
            _ulogError('Export failed:', error)
            alert(error instanceof Error ? error.message : t('editor.alert.exportFailed'))
        } finally {
            setIsExporting(false)
        }
    }

    const handleExportJianying = async () => {
        setIsExporting(true)
        try {
            const response = await fetch(`/api/novel-promotion/${projectId}/editor/export-jianying`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ episodeId, projectData: project }),
            })
            await downloadResponseBlob(response, 'waoo-jianying-draft.zip')
            setStatusMessage('已导出剪映草稿包')
        } catch (error) {
            _ulogError('Jianying export failed:', error)
            alert(error instanceof Error ? error.message : '剪映草稿包导出失败')
        } finally {
            setIsExporting(false)
        }
    }

    return (
        <div className="video-editor-stage" style={{
            display: 'flex',
            flexDirection: 'column',
            minHeight: 'calc(100vh - 96px)',
            background: 'var(--glass-bg-canvas)',
            color: 'var(--glass-text-primary)',
            ...toneStyles,
        }}>
            {/* Toolbar */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                borderBottom: '1px solid var(--glass-stroke-base)',
                background: 'var(--glass-bg-surface)'
            }}>
                <button
                    onClick={onBack}
                    className="glass-btn-base glass-btn-secondary px-4 py-2"
                >
                    {t('editor.toolbar.back')}
                </button>

                <button
                    type="button"
                    onClick={() => setIsLibraryOpen((value) => !value)}
                    className="glass-btn-base glass-btn-secondary flex items-center gap-2 px-4 py-2"
                >
                    <AppIcon name={isLibraryOpen ? 'chevronUp' : 'chevronDown'} className="h-4 w-4" />
                    <span>{t('editor.left.title')} {generatedSourceCount}/{sourcePanels.length}</span>
                </button>

                <div style={{ flex: 1 }} />

                <span style={{ color: 'var(--glass-text-secondary)', fontSize: '14px' }}>
                    {currentTime} / {totalTime}
                </span>

                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: 3,
                        borderRadius: 999,
                        border: '1px solid var(--glass-stroke-base)',
                        background: 'var(--glass-bg-muted)',
                    }}
                >
                    {[
                        { id: 'soft' as const, label: '柔和' },
                        { id: 'light' as const, label: '亮' },
                        { id: 'dark' as const, label: '暗' },
                    ].map((item) => (
                        <button
                            type="button"
                            key={item.id}
                            onClick={() => setToneMode(item.id)}
                            style={{
                                minWidth: 42,
                                padding: '5px 10px',
                                borderRadius: 999,
                                border: 'none',
                                background: toneMode === item.id ? 'var(--glass-accent-from)' : 'transparent',
                                color: toneMode === item.id ? 'white' : 'var(--glass-text-secondary)',
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: 'pointer',
                            }}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <button
                    onClick={handleSave}
                    className={`glass-btn-base px-4 py-2 ${isDirty ? 'glass-btn-primary text-white' : 'glass-btn-secondary'}`}
                >
                    {isDirty ? t('editor.toolbar.saveDirty') : t('editor.toolbar.saved')}
                </button>

                <button
                    onClick={handleRebuildTimeline}
                    className="glass-btn-base glass-btn-secondary px-4 py-2"
                >
                    同步成片片段 {generatedSourceCount}
                </button>

                <button
                    onClick={handleExportJoinedVideo}
                    disabled={isExporting || project.timeline.length === 0}
                    className="glass-btn-base glass-btn-tone-success px-4 py-2"
                >
                    拼接导出
                </button>

                <button
                    onClick={handleExportJianying}
                    disabled={isExporting || project.timeline.length === 0}
                    className="glass-btn-base glass-btn-tone-info px-4 py-2"
                >
                    剪映草稿包
                </button>
            </div>

            {isLibraryOpen && (
                <div
                    style={{
                        borderBottom: '1px solid var(--glass-stroke-base)',
                        background: 'var(--glass-bg-surface-strong)',
                        padding: '10px 16px 12px',
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            overflowX: 'auto',
                            paddingBottom: 2,
                        }}
                    >
                        {sourcePanels.map((panel, index) => {
                            const hasVideo = !!(panel.lipSyncVideoUrl || panel.videoUrl)
                            return (
                                <button
                                    type="button"
                                    key={panel.id || `${panel.storyboardId}-${panel.panelIndex ?? index}`}
                                    onClick={() => {
                                        const matchedClip = project.timeline.find((clip) => clip.metadata.panelId === panel.id)
                                        if (matchedClip) selectClip(matchedClip.id)
                                    }}
                                    style={{
                                        width: 132,
                                        minWidth: 132,
                                        padding: '8px 10px',
                                        borderRadius: 8,
                                        border: '1px solid var(--glass-stroke-base)',
                                        background: hasVideo ? 'var(--glass-bg-surface)' : 'var(--glass-bg-muted)',
                                        opacity: hasVideo ? 1 : 0.55,
                                        textAlign: 'left',
                                        cursor: hasVideo ? 'pointer' : 'default',
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                        <span style={{ fontSize: 12, fontWeight: 700 }}>镜头 {index + 1}</span>
                                        <span
                                            style={{
                                                width: 7,
                                                height: 7,
                                                borderRadius: 999,
                                                background: hasVideo ? 'var(--glass-tone-success-fg)' : 'var(--glass-text-tertiary)',
                                                flexShrink: 0,
                                            }}
                                        />
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 4,
                                            fontSize: 11,
                                            color: 'var(--glass-text-tertiary)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {hasVideo ? (panel.description || '已生成视频') : '暂无视频'}
                                    </div>
                                </button>
                            )
                        })}
                        {sourcePanels.length === 0 && (
                            <p style={{ margin: 0, fontSize: 12, color: 'var(--glass-text-tertiary)' }}>
                                {t('editor.left.description')}
                            </p>
                        )}
                    </div>
                </div>
            )}

            {/* Main Content */}
            <div style={{
                display: 'flex',
                flex: 1,
                overflow: 'hidden'
            }}>
                {/* Center - Preview + Properties */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Preview */}
                    <div style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--glass-bg-muted)',
                        padding: '20px'
                    }}>
                        <RemotionPreview
                            project={project}
                            currentFrame={timelineState.currentFrame}
                            playing={timelineState.playing}
                            onFrameChange={seek}
                            onPlayingChange={(playing) => playing ? play() : pause()}
                        />
                    </div>

                    {/* Playback Controls */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '16px',
                        padding: '12px',
                        background: 'var(--glass-bg-surface-strong)',
                        borderTop: '1px solid var(--glass-stroke-base)'
                    }}>
                        <button
                            onClick={() => seek(0)}
                            className="glass-btn-base glass-btn-ghost px-3 py-1.5"
                        >
                            <AppIcon name="chevronLeft" className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => timelineState.playing ? pause() : play()}
                            style={{
                                background: 'var(--glass-accent-from)',
                                border: 'none',
                                color: 'var(--glass-text-on-accent)',
                                cursor: 'pointer',
                                width: '40px',
                                height: '40px',
                                borderRadius: '50%',
                                fontSize: '18px'
                            }}
                        >
                            {timelineState.playing
                                ? <AppIcon name="pause" className="w-4 h-4" />
                                : <AppIcon name="play" className="w-4 h-4" />}
                        </button>
                        <button
                            onClick={() => seek(totalDuration)}
                            className="glass-btn-base glass-btn-ghost px-3 py-1.5"
                        >
                            <AppIcon name="chevronRight" className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Right Panel - Properties */}
                <div style={{
                    width: '280px',
                    borderLeft: '1px solid var(--glass-stroke-base)',
                    padding: '12px',
                    background: 'var(--glass-bg-surface-strong)',
                    overflowY: 'auto'
                }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--glass-text-secondary)' }}>
                        {t('editor.right.title')}
                    </h3>
                    {selectedClip ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {/* 基础信息 */}
                            <div style={{ fontSize: '12px' }}>
                                <p style={{ margin: '0 0 8px 0' }}>
                                    <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.clipLabel')}</span> {selectedClip.metadata?.description || t('editor.right.clipFallback', { index: project.timeline.findIndex(c => c.id === selectedClip.id) + 1 })}
                                </p>
                                <p style={{ margin: '0 0 8px 0' }}>
                                    <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.durationLabel')}</span> {framesToTime(selectedClip.durationInFrames, project.config.fps)}
                                </p>
                            </div>

                            <div>
                                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--glass-text-secondary)' }}>
                                    视频提示词
                                </h4>
                                <textarea
                                    value={promptDraft}
                                    onChange={(event) => setPromptDraft(event.target.value)}
                                    placeholder="编辑该片段的视频提示词..."
                                    style={{
                                        width: '100%',
                                        minHeight: 180,
                                        resize: 'vertical',
                                        padding: 10,
                                        borderRadius: 8,
                                        border: '1px solid var(--glass-stroke-base)',
                                        background: 'var(--glass-bg-surface)',
                                        color: 'var(--glass-text-primary)',
                                        fontSize: 12,
                                        lineHeight: 1.6,
                                    }}
                                />
                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                    <button
                                        onClick={() => { void handleSavePrompt() }}
                                        disabled={!onUpdateVideoPrompt}
                                        className="glass-btn-base glass-btn-primary px-3 py-2 text-xs disabled:opacity-50"
                                    >
                                        保存提示词
                                    </button>
                                    <button
                                        onClick={() => { void handleRegenerateSelected() }}
                                        disabled={!onGenerateVideo || !defaultVideoModel}
                                        className="glass-btn-base glass-btn-tone-warning px-3 py-2 text-xs disabled:opacity-50"
                                    >
                                        重新生成视频
                                    </button>
                                </div>
                            </div>

                            {/* 转场设置 */}
                            <div>
                                <h4 style={{ margin: '0 0 8px 0', fontSize: '13px', color: 'var(--glass-text-secondary)' }}>
                                    {t('editor.right.transitionLabel')}
                                </h4>
                                <TransitionPicker
                                    value={(selectedClip.transition?.type as TransitionType) || 'none'}
                                    duration={selectedClip.transition?.durationInFrames || 15}
                                    onChange={(type, duration) => {
                                        updateClip(selectedClip.id, {
                                            transition: type === 'none' ? undefined : { type, durationInFrames: duration }
                                        })
                                    }}
                                />
                            </div>

                            {/* 删除按钮 */}
                            <button
                                onClick={() => {
                                    if (confirm(t('editor.right.deleteConfirm'))) {
                                        removeClip(selectedClip.id)
                                        selectClip(null)
                                    }
                                }}
                                className="glass-btn-base glass-btn-tone-danger mt-2 px-3 py-2 text-xs"
                            >
                                {t('editor.right.deleteClip')}
                            </button>
                        </div>
                    ) : (
                        <p style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                            {t('editor.right.selectClipHint')}
                        </p>
                    )}
                </div>
            </div>

            {/* Timeline */}
            <div style={{
                height: '220px',
                borderTop: '1px solid var(--glass-stroke-base)'
            }}>
                {statusMessage && (
                    <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--glass-tone-success-fg)' }}>
                        {statusMessage}
                    </div>
                )}
                <Timeline
                    clips={project.timeline}
                    timelineState={timelineState}
                    config={project.config}
                    onReorder={reorderClips}
                    onSelectClip={selectClip}
                    onZoomChange={setZoom}
                    onSeek={seek}
                />
            </div>
        </div>
    )
}

export default VideoEditorStage
