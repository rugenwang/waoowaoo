import type { VideoClip } from '../types/editor.types'

export type PartialRegenerateFrameMode = 'first' | 'first-last'

export interface PartialRegenerateFrameRange {
    trimFrom: number
    trimTo: number
    durationInFrames: number
    firstFrame: number
    lastFrame: number
    durationSeconds: number
}

export function resolvePartialRegenerateFrameRange(
    clip: Pick<VideoClip, 'durationInFrames' | 'originalDurationInFrames' | 'trim'>,
    fps: number,
): PartialRegenerateFrameRange {
    const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
    const originalDuration = Math.max(
        1,
        Math.round(clip.originalDurationInFrames || clip.trim?.to || clip.durationInFrames || 1),
    )
    const trimFrom = Math.max(0, Math.min(originalDuration - 1, Math.round(clip.trim?.from ?? 0)))
    const rawTrimTo = clip.trim?.to ?? trimFrom + Math.max(1, Math.round(clip.durationInFrames || 1))
    const trimTo = Math.max(trimFrom + 1, Math.min(originalDuration, Math.round(rawTrimTo)))
    const durationInFrames = Math.max(1, trimTo - trimFrom)

    return {
        trimFrom,
        trimTo,
        durationInFrames,
        firstFrame: trimFrom,
        lastFrame: Math.max(trimFrom, trimTo - 1),
        durationSeconds: Math.max(0.1, durationInFrames / safeFps),
    }
}

export function createPartialRegeneratedClip(params: {
    sourceClip: VideoClip
    videoUrl: string
    durationInFrames?: number
    prompt: string
    frameMode: PartialRegenerateFrameMode
}): VideoClip {
    const durationInFrames = Math.max(
        1,
        Math.round(params.durationInFrames || params.sourceClip.durationInFrames || 1),
    )
    return {
        ...params.sourceClip,
        id: `${params.sourceClip.id}_regen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        src: params.videoUrl,
        durationInFrames,
        originalDurationInFrames: durationInFrames,
        trim: undefined,
        transition: undefined,
        playback: undefined,
        attachment: undefined,
        metadata: {
            ...params.sourceClip.metadata,
            description: params.sourceClip.metadata.description
                ? `${params.sourceClip.metadata.description}（局部重生成）`
                : '局部重生成片段',
            videoPrompt: params.prompt,
            durationSeconds: undefined,
            regeneratedFromClipId: params.sourceClip.id,
            regenerationFrameMode: params.frameMode,
        },
    }
}

export function insertClipAfter(
    timeline: VideoClip[],
    afterClipId: string,
    newClip: VideoClip,
): VideoClip[] {
    const index = timeline.findIndex((clip) => clip.id === afterClipId)
    if (index < 0) return [...timeline, newClip]
    const next = [...timeline]
    next.splice(index + 1, 0, newClip)
    return next
}
