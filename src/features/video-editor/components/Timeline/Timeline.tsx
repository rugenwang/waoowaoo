'use client'

import React from 'react'
import { useTranslations } from 'next-intl'
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    DragEndEvent
} from '@dnd-kit/core'
import {
    SortableContext,
    sortableKeyboardCoordinates,
    horizontalListSortingStrategy,
    useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { VideoClip, TimelineState, EditorConfig } from '../../types/editor.types'
import { framesToTime } from '../../utils/time-utils'

interface TimelineProps {
    clips: VideoClip[]
    timelineState: TimelineState
    config: EditorConfig
    onReorder: (fromIndex: number, toIndex: number) => void
    onSelectClip: (clipId: string | null) => void
    onZoomChange: (zoom: number) => void
    onSeek?: (frame: number) => void
}

/**
 * 时间轴主组件
 * 使用 dnd-kit 实现拖拽排序
 */
export const Timeline: React.FC<TimelineProps> = ({
    clips,
    timelineState,
    config,
    onReorder,
    onSelectClip,
    onZoomChange,
    onSeek
}) => {
    const t = useTranslations('video')
    const progressScrollRef = React.useRef<HTMLDivElement | null>(null)
    const videoScrollRef = React.useRef<HTMLDivElement | null>(null)
    const audioScrollRef = React.useRef<HTMLDivElement | null>(null)
    const bgmScrollRef = React.useRef<HTMLDivElement | null>(null)
    const [isScrubbing, setIsScrubbing] = React.useState(false)

    const labelWidth = 70
    const clipGap = 4
    const pxPerFrame = timelineState.zoom * 2

    // 计算总时长和播放头位置。这里的“视觉宽度”与视频轨道使用同一套宽度，
    // 避免进度条按容器百分比走、轨道按片段像素走导致不匹配。
    const totalDuration = React.useMemo(
        () => clips.reduce((sum, clip) => sum + clip.durationInFrames, 0),
        [clips],
    )
    const clipWidths = React.useMemo(
        () => clips.map((clip) => Math.max(60, clip.durationInFrames * pxPerFrame)),
        [clips, pxPerFrame],
    )
    const totalTrackWidth = React.useMemo(
        () => Math.max(
            1,
            clipWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, clips.length - 1) * clipGap,
        ),
        [clipWidths, clips.length],
    )

    const frameToVisualPx = React.useCallback((frame: number): number => {
        if (clips.length === 0 || totalDuration <= 0) return 0
        const clampedFrame = Math.max(0, Math.min(totalDuration, frame))
        let frameCursor = 0
        let pxCursor = 0

        for (let index = 0; index < clips.length; index += 1) {
            const clip = clips[index]
            const width = clipWidths[index]
            const nextFrameCursor = frameCursor + clip.durationInFrames
            if (clampedFrame <= nextFrameCursor || index === clips.length - 1) {
                const localFrame = Math.max(0, clampedFrame - frameCursor)
                const ratio = clip.durationInFrames > 0 ? localFrame / clip.durationInFrames : 0
                return Math.max(0, Math.min(totalTrackWidth, pxCursor + ratio * width))
            }
            frameCursor = nextFrameCursor
            pxCursor += width + clipGap
        }
        return totalTrackWidth
    }, [clipWidths, clips, totalDuration, totalTrackWidth])

    const visualPxToFrame = React.useCallback((visualPx: number): number => {
        if (clips.length === 0 || totalTrackWidth <= 0) return 0
        const clampedPx = Math.max(0, Math.min(totalTrackWidth, visualPx))
        let frameCursor = 0
        let pxCursor = 0

        for (let index = 0; index < clips.length; index += 1) {
            const clip = clips[index]
            const width = clipWidths[index]
            const nextPxCursor = pxCursor + width
            if (clampedPx <= nextPxCursor || index === clips.length - 1) {
                const localPx = Math.max(0, clampedPx - pxCursor)
                const ratio = width > 0 ? localPx / width : 0
                return Math.round(frameCursor + ratio * clip.durationInFrames)
            }
            frameCursor += clip.durationInFrames
            pxCursor = nextPxCursor + clipGap
            if (clampedPx < pxCursor) return frameCursor
        }
        return totalDuration
    }, [clipWidths, clips, totalDuration, totalTrackWidth])

    const playheadPositionPx = frameToVisualPx(timelineState.currentFrame)

    const seekByPointer = React.useCallback((event: React.PointerEvent<HTMLDivElement>, element: HTMLDivElement) => {
        if (!onSeek || totalDuration === 0) return
        const rect = element.getBoundingClientRect()
        const visualPx = event.clientX - rect.left
        onSeek(Math.max(0, Math.min(totalDuration, visualPxToFrame(visualPx))))
    }, [onSeek, totalDuration, visualPxToFrame])

    const syncScroll = (source: HTMLDivElement, targets: Array<React.RefObject<HTMLDivElement | null>>) => {
        for (const ref of targets) {
            const target = ref.current
            if (!target || target === source || target.scrollLeft === source.scrollLeft) continue
            target.scrollLeft = source.scrollLeft
        }
    }

    const setSyncedScrollLeft = React.useCallback((scrollLeft: number) => {
        const targets = [progressScrollRef, videoScrollRef, audioScrollRef, bgmScrollRef]
        for (const ref of targets) {
            const target = ref.current
            if (!target) continue
            const maxScrollLeft = Math.max(0, target.scrollWidth - target.clientWidth)
            const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, scrollLeft))
            if (Math.abs(target.scrollLeft - nextScrollLeft) < 1) continue
            target.scrollLeft = nextScrollLeft
        }
    }, [])

    React.useEffect(() => {
        const track = videoScrollRef.current || progressScrollRef.current
        if (!track || totalTrackWidth <= track.clientWidth) return

        const leftGuard = track.clientWidth * 0.18
        const rightGuard = track.clientWidth * 0.78
        const visiblePlayheadX = playheadPositionPx - track.scrollLeft

        if (visiblePlayheadX > rightGuard) {
            setSyncedScrollLeft(playheadPositionPx - rightGuard)
            return
        }

        if (visiblePlayheadX < leftGuard) {
            setSyncedScrollLeft(playheadPositionPx - leftGuard)
        }
    }, [
        playheadPositionPx,
        setSyncedScrollLeft,
        timelineState.playing,
        totalTrackWidth,
    ])

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5 // 5px 移动才开始拖拽
            }
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates
        })
    )

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event

        if (over && active.id !== over.id) {
            const oldIndex = clips.findIndex(c => c.id === active.id)
            const newIndex = clips.findIndex(c => c.id === over.id)
            onReorder(oldIndex, newIndex)
        }
    }

    const getClipStartFrame = React.useCallback((targetIndex: number) => {
        return clips.slice(0, targetIndex).reduce((sum, clip) => sum + clip.durationInFrames, 0)
    }, [clips])

    return (
        <div className="timeline" style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '12px',
            background: 'var(--glass-bg-surface)',
            borderRadius: '12px',
            border: '1px solid var(--glass-stroke-base)',
            height: '100%'
        }}>
            {/* 缩放控制 */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
            }}>
                <span style={{ fontSize: '12px', color: 'var(--glass-text-secondary)' }}>{t('editor.timeline.zoomLabel')}</span>
                <input
                    type="range"
                    min="0.5"
                    max="3"
                    step="0.1"
                    value={timelineState.zoom}
                    onChange={(e) => onZoomChange(parseFloat(e.target.value))}
                    style={{ width: '100px' }}
                />
                <span style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                    {Math.round(timelineState.zoom * 100)}%
                </span>
            </div>

            {/* 进度条 + 播放头 */}
            <div style={{ display: 'flex', alignItems: 'center', minHeight: '24px' }}>
                <span style={{ width: labelWidth, flexShrink: 0 }} />
                <div
                    ref={progressScrollRef}
                    onScroll={(event) => syncScroll(event.currentTarget, [videoScrollRef, audioScrollRef, bgmScrollRef])}
                    style={{
                        flex: 1,
                        overflowX: 'auto',
                        scrollbarWidth: 'none',
                    }}
                >
                    <div
                        style={{
                            position: 'relative',
                            width: `${totalTrackWidth}px`,
                            height: '24px',
                            background: 'var(--glass-bg-muted)',
                            border: '1px solid var(--glass-stroke-base)',
                            borderRadius: '4px',
                            cursor: isScrubbing ? 'grabbing' : 'grab',
                            touchAction: 'none',
                        }}
                        onPointerDown={(event) => {
                            event.preventDefault()
                            event.currentTarget.setPointerCapture(event.pointerId)
                            setIsScrubbing(true)
                            seekByPointer(event, event.currentTarget)
                        }}
                        onPointerMove={(event) => {
                            if (!isScrubbing) return
                            seekByPointer(event, event.currentTarget)
                        }}
                        onPointerUp={(event) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                event.currentTarget.releasePointerCapture(event.pointerId)
                            }
                            setIsScrubbing(false)
                            seekByPointer(event, event.currentTarget)
                        }}
                        onPointerCancel={(event) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                event.currentTarget.releasePointerCapture(event.pointerId)
                            }
                            setIsScrubbing(false)
                        }}
                    >
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                backgroundImage: 'linear-gradient(90deg, var(--glass-stroke-base) 1px, transparent 1px)',
                                backgroundSize: `${Math.max(24, config.fps * pxPerFrame)}px 100%`,
                                opacity: 0.45,
                                pointerEvents: 'none',
                            }}
                        />
                        {/* 已播放部分 */}
                        <div style={{
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            height: '100%',
                            width: `${playheadPositionPx}px`,
                            background: 'linear-gradient(90deg, var(--glass-accent-from) 0%, var(--glass-accent-to) 100%)',
                            borderRadius: '4px 0 0 4px',
                            transition: timelineState.playing ? 'none' : 'width 0.1s'
                        }} />
                        {/* 播放头指示器 */}
                        <div style={{
                            position: 'absolute',
                            left: `${playheadPositionPx}px`,
                            top: '-4px',
                            bottom: '-4px',
                            width: '3px',
                            background: 'var(--glass-accent-to)',
                            borderRadius: '2px',
                            boxShadow: '0 0 8px var(--glass-accent-shadow-strong)',
                            transform: 'translateX(-50%)',
                            transition: timelineState.playing ? 'none' : 'left 0.1s'
                        }}>
                            <span
                                style={{
                                    position: 'absolute',
                                    top: '-5px',
                                    left: '50%',
                                    width: '13px',
                                    height: '13px',
                                    borderRadius: 999,
                                    background: 'var(--glass-accent-to)',
                                    border: '2px solid white',
                                    boxShadow: '0 2px 8px var(--glass-accent-shadow-strong)',
                                    transform: 'translateX(-50%)',
                                }}
                            />
                        </div>
                        {/* 时间标记 */}
                        <div style={{
                            position: 'sticky',
                            right: '8px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            marginLeft: 'auto',
                            width: 'max-content',
                            fontSize: '10px',
                            color: 'var(--glass-text-tertiary)'
                        }}>
                            {framesToTime(timelineState.currentFrame, config.fps)} / {framesToTime(totalDuration, config.fps)}
                        </div>
                    </div>
                </div>
            </div>

            {/* 视频轨道 */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                height: '56px',
                background: 'var(--glass-bg-surface-strong)',
                border: '1px solid var(--glass-stroke-base)',
                borderRadius: '6px',
                padding: '0 12px'
            }}>
                <span style={{
                    fontSize: '12px',
                    color: 'var(--glass-text-secondary)',
                    width: `${labelWidth}px`,
                    flexShrink: 0
                }}>
                    {t('editor.timeline.videoTrack')}
                </span>

                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={clips.map(c => c.id)}
                        strategy={horizontalListSortingStrategy}
                    >
                        <div style={{
                            display: 'flex',
                            gap: `${clipGap}px`,
                            flex: 1,
                            overflowX: 'auto',
                            paddingRight: '12px'
                        }}
                            ref={videoScrollRef}
                            onScroll={(event) => syncScroll(event.currentTarget, [progressScrollRef, audioScrollRef, bgmScrollRef])}
                        >
                            {clips.map((clip, index) => (
                                <SortableClip
                                    key={clip.id}
                                    clip={clip}
                                    index={index}
                                    isSelected={timelineState.selectedClipId === clip.id}
                                    width={clipWidths[index]}
                                    fps={config.fps}
                                    onClick={() => {
                                        onSelectClip(clip.id)
                                        onSeek?.(getClipStartFrame(index))
                                    }}
                                />
                            ))}
                            {clips.length === 0 && (
                                <span style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                                    {t('editor.timeline.emptyHint')}
                                </span>
                            )}
                        </div>
                    </SortableContext>
                </DndContext>
            </div>

            {/* 配音轨道 (显示附属音频) */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                height: '40px',
                background: 'var(--glass-bg-surface-strong)',
                border: '1px solid var(--glass-stroke-base)',
                borderRadius: '6px',
                padding: '0 12px'
            }}>
                <span style={{
                    fontSize: '12px',
                    color: 'var(--glass-text-secondary)',
                    width: `${labelWidth}px`,
                    flexShrink: 0
                }}>
                    {t('editor.timeline.audioTrack')}
                </span>
                <div
                    ref={audioScrollRef}
                    onScroll={(event) => syncScroll(event.currentTarget, [progressScrollRef, videoScrollRef, bgmScrollRef])}
                    style={{ display: 'flex', gap: `${clipGap}px`, flex: 1, overflowX: 'auto', paddingRight: '12px' }}
                >
                    {clips.map((clip, index) => (
                        <div
                            key={`audio-${clip.id}`}
                            style={{
                                width: `${clipWidths[index]}px`,
                                height: '28px',
                                background: clip.attachment?.audio ? 'var(--glass-tone-success-bg)' : 'transparent',
                                borderRadius: '4px',
                                fontSize: '10px',
                                color: 'var(--glass-tone-success-fg)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0
                            }}
                        >
                            {clip.attachment?.audio ? t('editor.timeline.audioBadge') : null}
                        </div>
                    ))}
                </div>
            </div>

            {/* BGM 轨道 */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                height: '40px',
                background: 'var(--glass-bg-surface-strong)',
                border: '1px solid var(--glass-stroke-base)',
                borderRadius: '6px',
                padding: '0 12px'
            }}>
                <span style={{
                    fontSize: '12px',
                    color: 'var(--glass-text-secondary)',
                    width: `${labelWidth}px`,
                    flexShrink: 0
                }}>
                    BGM
                </span>
                <div
                    ref={bgmScrollRef}
                    onScroll={(event) => syncScroll(event.currentTarget, [progressScrollRef, videoScrollRef, audioScrollRef])}
                    style={{ flex: 1, overflowX: 'auto', paddingRight: '12px' }}
                >
                    <div style={{ width: `${totalTrackWidth}px`, height: 1 }} />
                </div>
            </div>
        </div>
    )
}

/**
 * 可拖拽的片段组件
 */
interface SortableClipProps {
    clip: VideoClip
    index: number
    isSelected: boolean
    width: number
    fps: number
    onClick: () => void
}

const SortableClip: React.FC<SortableClipProps> = ({
    clip,
    index,
    isSelected,
    width,
    fps,
    onClick
}) => {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging
    } = useSortable({ id: clip.id })

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        width: `${width}px`,
        height: '40px',
        background: isSelected
            ? 'var(--glass-accent-from)'
            : isDragging
                ? 'var(--glass-bg-muted)'
                : 'var(--glass-bg-surface)',
        borderRadius: '4px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        color: isSelected ? 'var(--glass-text-on-accent)' : 'var(--glass-text-primary)',
        cursor: isDragging ? 'grabbing' : 'grab',
        flexShrink: 0,
        border: isSelected ? '2px solid var(--glass-stroke-focus)' : '1px solid var(--glass-stroke-base)',
        opacity: isDragging ? 0.8 : 1,
        zIndex: isDragging ? 100 : 1,
        position: 'relative'
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            onClick={onClick}
            {...attributes}
            {...listeners}
        >
            <span style={{ fontWeight: 'bold' }}>{index + 1}</span>
            <span style={{
                position: 'absolute',
                bottom: '2px',
                fontSize: '9px',
                color: isSelected ? 'rgba(255, 255, 255, 0.8)' : 'var(--glass-text-tertiary)'
            }}>
                {framesToTime(clip.durationInFrames, fps)}
            </span>
            {clip.trim && (
                <span style={{
                    position: 'absolute',
                    top: '2px',
                    right: '4px',
                    maxWidth: '70%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: '8px',
                    color: isSelected ? 'rgba(255, 255, 255, 0.85)' : 'var(--glass-tone-info-fg)'
                }}>
                    {framesToTime(clip.trim.from, fps)}-{framesToTime(clip.trim.to, fps)}
                </span>
            )}
            {(clip.playback?.reverse || clip.playback?.muted) && (
                <span style={{
                    position: 'absolute',
                    top: '2px',
                    left: '4px',
                    display: 'inline-flex',
                    gap: '3px',
                    fontSize: '8px',
                    color: isSelected ? 'rgba(255, 255, 255, 0.9)' : 'var(--glass-text-secondary)'
                }}>
                    {clip.playback.reverse ? <span>倒</span> : null}
                    {clip.playback.muted ? <span>静</span> : null}
                </span>
            )}

            {/* 转场指示器 */}
            {clip.transition && clip.transition.type !== 'none' && (
                <div style={{
                    position: 'absolute',
                    right: '-6px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: '12px',
                    height: '12px',
                    background: 'var(--glass-tone-warning-fg)',
                    borderRadius: '50%',
                    fontSize: '8px',
                    color: 'var(--glass-text-on-accent)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10
                }}>
                    T
                </div>
            )}
        </div>
    )
}

export default Timeline
