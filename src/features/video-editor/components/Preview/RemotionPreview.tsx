'use client'

import React, { useMemo, useRef, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Player, PlayerRef } from '@remotion/player'
import { prefetch } from 'remotion'
import { AppIcon } from '@/components/ui/icons'
import { isMediaPlayInterruptedError } from '@/lib/media/safe-play'
import { VideoComposition } from '../../remotion/VideoComposition'
import { VideoEditorProject } from '../../types/editor.types'
import { calculateTimelineDuration } from '../../utils/time-utils'

interface RemotionPreviewProps {
    project: VideoEditorProject
    currentFrame: number
    playing: boolean
    onFrameChange?: (frame: number) => void
    onPlayingChange?: (playing: boolean) => void
}

/**
 * Remotion Player 预览封装
 * 支持双向同步：timelineState ↔ Player
 */
export const RemotionPreview: React.FC<RemotionPreviewProps> = ({
    project,
    currentFrame,
    playing,
    onFrameChange,
    onPlayingChange
}) => {
    const t = useTranslations('video')
    const playerRef = useRef<PlayerRef>(null)
    const lastSyncedFrame = useRef<number>(0)
    const lastReportedFrame = useRef<number>(-1)
    const lastReportedAt = useRef<number>(0)
    const onFrameChangeRef = useRef(onFrameChange)
    const playingRef = useRef(playing)
    const currentFrameRef = useRef(currentFrame)
    const externalSeekTargetRef = useRef<number | null>(null)
    const previewContainerRef = useRef<HTMLDivElement | null>(null)
    const [isFullscreen, setIsFullscreen] = useState(false)

    const totalDuration = useMemo(
        () => calculateTimelineDuration(project.timeline),
        [project.timeline]
    )
    const playerInputProps = useMemo(() => ({
        clips: project.timeline,
        bgmTrack: project.bgmTrack,
        config: project.config
    }), [project.bgmTrack, project.config, project.timeline])
    const preloadSources = useMemo(() => {
        return Array.from(new Set(project.timeline.flatMap((clip) => [
            clip.src,
            clip.attachment?.audio?.src,
        ]).filter((src): src is string => typeof src === 'string' && src.length > 0)))
    }, [project.timeline])

    useEffect(() => {
        if (preloadSources.length === 0) return
        const handles = preloadSources.map((src) => prefetch(src, { logLevel: 'warn' }))
        handles.forEach((handle) => {
            handle.waitUntilDone().catch(() => {
                // 预加载失败不阻塞预览，播放器仍会按原始 URL 播放。
            })
        })
        return () => {
            handles.forEach((handle) => handle.free())
        }
    }, [preloadSources])

    useEffect(() => {
        onFrameChangeRef.current = onFrameChange
    }, [onFrameChange])

    useEffect(() => {
        playingRef.current = playing
    }, [playing])

    useEffect(() => {
        currentFrameRef.current = currentFrame
    }, [currentFrame])

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(document.fullscreenElement === previewContainerRef.current)
        }
        document.addEventListener('fullscreenchange', handleFullscreenChange)
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }, [])

    const toggleFullscreen = async () => {
        const container = previewContainerRef.current
        if (!container) return
        if (document.fullscreenElement === container) {
            await document.exitFullscreen()
            return
        }
        await container.requestFullscreen()
    }

    // 当 currentFrame 从外部改变时，同步到 Player
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        // 外部拖动时间轴/选帧滑杆时需要精确 seek 到每一帧；循环由 externalSeekTargetRef 和暂停态过滤保护。
        if (Math.abs(currentFrame - lastSyncedFrame.current) >= 1) {
            externalSeekTargetRef.current = currentFrame
            player.seekTo(currentFrame)
            lastSyncedFrame.current = currentFrame
            lastReportedFrame.current = currentFrame
        }
    }, [currentFrame])

    // 当 playing 状态改变时，控制 Player 播放/暂停
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        if (playing) {
            void Promise.resolve(player.play()).catch((error) => {
                if (!isMediaPlayInterruptedError(error)) {
                    onPlayingChange?.(false)
                }
            })
        } else {
            player.pause()
        }
    }, [playing])

    // 监听 Player 的帧变化，同步到 timelineState
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        const handleFrameUpdate = () => {
            const frame = player.getCurrentFrame()
            lastSyncedFrame.current = frame

            const externalSeekTarget = externalSeekTargetRef.current
            if (externalSeekTarget !== null && Math.abs(frame - externalSeekTarget) <= 1) {
                externalSeekTargetRef.current = null
                return
            }

            // 暂停或拖动时间轴时，currentFrame 已由时间轴自身更新。
            // 此时如果再接收 Player 的 frameupdate，容易形成 seek -> frameupdate -> setState -> seek 的循环。
            if (!playingRef.current) return

            const now = performance.now()
            const shouldReport =
                Math.abs(frame - lastReportedFrame.current) >= 4
                || now - lastReportedAt.current >= 120

            if (!shouldReport) return
            if (Math.abs(frame - currentFrameRef.current) < 1) return
            lastReportedFrame.current = frame
            lastReportedAt.current = now
            onFrameChangeRef.current?.(frame)
        }

        // Remotion Player 触发 timeupdate 事件
        player.addEventListener('frameupdate', handleFrameUpdate)

        return () => {
            player.removeEventListener('frameupdate', handleFrameUpdate)
        }
    }, [])

    // 监听 Player 播放状态变化
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        const handlePlay = () => onPlayingChange?.(true)
        const handlePause = () => onPlayingChange?.(false)
        const handleEnded = () => onPlayingChange?.(false)

        player.addEventListener('play', handlePlay)
        player.addEventListener('pause', handlePause)
        player.addEventListener('ended', handleEnded)

        return () => {
            player.removeEventListener('play', handlePlay)
            player.removeEventListener('pause', handlePause)
            player.removeEventListener('ended', handleEnded)
        }
    }, [onPlayingChange])

    // 如果没有片段，显示占位
    if (project.timeline.length === 0) {
        return (
            <div style={{
                width: '100%',
                aspectRatio: `${project.config.width} / ${project.config.height}`,
                maxHeight: '100%',
                background: 'var(--glass-bg-surface)',
                border: '1px solid var(--glass-stroke-base)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
                color: 'var(--glass-text-tertiary)'
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'center' }}>
                        <AppIcon name="image" className="w-12 h-12" />
                    </div>
                    <span>{t('editor.preview.emptyStartEditing')}</span>
                </div>
            </div>
        )
    }

    return (
        <div
            ref={previewContainerRef}
            style={{
                position: 'relative',
                width: '100%',
                aspectRatio: isFullscreen ? undefined : `${project.config.width} / ${project.config.height}`,
                height: isFullscreen ? '100vh' : undefined,
                maxHeight: isFullscreen ? '100vh' : '100%',
                background: 'var(--glass-overlay-strong)',
                borderRadius: isFullscreen ? 0 : '8px',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Player
                ref={playerRef}
                component={VideoComposition}
                inputProps={playerInputProps}
                durationInFrames={Math.max(1, totalDuration)}
                fps={project.config.fps}
                compositionWidth={project.config.width}
                compositionHeight={project.config.height}
                style={{
                    width: '100%',
                    height: '100%',
                    maxWidth: isFullscreen ? '100vw' : undefined,
                    maxHeight: isFullscreen ? '100vh' : undefined,
                }}
                controls={false}  // 使用自定义控制
                loop={false}
                clickToPlay={false}  // 禁用点击播放，由外部控制
            />
            <button
                type="button"
                onClick={() => { void toggleFullscreen() }}
                title={isFullscreen ? '退出全屏' : '全屏播放'}
                style={{
                    position: 'absolute',
                    right: 12,
                    bottom: 12,
                    width: 38,
                    height: 38,
                    borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.28)',
                    background: 'rgba(0,0,0,0.58)',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
                }}
            >
                <AppIcon name={isFullscreen ? 'minimize' : 'maximize'} className="h-4 w-4" />
            </button>
        </div>
    )
}

export default RemotionPreview
