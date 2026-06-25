import { toDisplayImageUrl } from '@/lib/media/image-url'
import type { MobileEpisodeDetail, MobilePanel, MobilePanelFrame } from './types'

export function displayMediaUrl(value: string | null | undefined): string | null {
  return toDisplayImageUrl(value) || value || null
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function parseNameList(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item: unknown) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') {
          const name = (item as { name?: unknown }).name
          return typeof name === 'string' ? name.trim() : ''
        }
        return ''
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function collectScreenplayText(value: unknown, output: string[]): void {
  if (!value || output.length >= 8) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) output.push(trimmed)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScreenplayText(item, output)
    return
  }
  if (typeof value !== 'object') return
  const record = value as Record<string, unknown>
  for (const key of ['description', 'text', 'lines', 'original_text', 'content']) {
    collectScreenplayText(record[key], output)
  }
  if (typeof record.character === 'string' && typeof record.lines === 'string') {
    output.push(`${record.character}：${record.lines}`)
  }
  collectScreenplayText(record.scenes, output)
}

export function formatClipSummary(screenplay: string | null | undefined, content: string | null | undefined): string | null {
  const rawScreenplay = typeof screenplay === 'string' ? screenplay.trim() : ''
  if (rawScreenplay) {
    try {
      const parsed = JSON.parse(rawScreenplay)
      const parts: string[] = []
      collectScreenplayText(parsed, parts)
      const summary = parts
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(' / ')
      if (summary) return summary
    } catch {
      if (!rawScreenplay.startsWith('{') && !rawScreenplay.startsWith('[')) {
        return rawScreenplay
      }
    }
  }

  const rawContent = typeof content === 'string' ? content.trim() : ''
  return rawContent || null
}

export function getSortedPanels(episode: Pick<MobileEpisodeDetail, 'clips' | 'storyboards'> | null | undefined): MobilePanel[] {
  const storyboards = Array.isArray(episode?.storyboards) ? episode.storyboards : []
  const clipOrder = new Map(
    (Array.isArray(episode?.clips) ? episode.clips : []).map((clip, index) => [clip.id, index]),
  )
  const orderedStoryboards = storyboards
    .map((storyboard, index) => ({ storyboard, index }))
    .sort((left, right) => {
      const leftClipIndex = clipOrder.get(left.storyboard.clipId) ?? Number.MAX_SAFE_INTEGER
      const rightClipIndex = clipOrder.get(right.storyboard.clipId) ?? Number.MAX_SAFE_INTEGER
      if (leftClipIndex !== rightClipIndex) return leftClipIndex - rightClipIndex
      return left.index - right.index
    })

  return orderedStoryboards.flatMap(({ storyboard }) => {
    const panels = Array.isArray(storyboard.panels) ? storyboard.panels : []
    return [...panels].sort((left, right) => {
      const leftIndex = Number.isFinite(left.panelIndex) ? left.panelIndex : 0
      const rightIndex = Number.isFinite(right.panelIndex) ? right.panelIndex : 0
      if (leftIndex !== rightIndex) return leftIndex - rightIndex
      return (left.id || '').localeCompare(right.id || '')
    }).map((panel) => ({ ...panel, storyboardId: storyboard.id }))
  })
}

export interface MobilePanelGroup {
  storyboardId: string
  clipId: string
  clipOrder: number
  title: string
  summary: string | null
  panels: MobilePanel[]
}

export function getSortedPanelGroups(
  episode: Pick<MobileEpisodeDetail, 'clips' | 'storyboards'> | null | undefined,
): MobilePanelGroup[] {
  const storyboards = Array.isArray(episode?.storyboards) ? episode.storyboards : []
  const clips = Array.isArray(episode?.clips) ? episode.clips : []
  const clipOrder = new Map(clips.map((clip, index) => [clip.id, index]))
  const sortedStoryboards = storyboards
    .map((storyboard, index) => ({ storyboard, index }))
    .sort((left, right) => {
      const leftClipIndex = clipOrder.get(left.storyboard.clipId) ?? Number.MAX_SAFE_INTEGER
      const rightClipIndex = clipOrder.get(right.storyboard.clipId) ?? Number.MAX_SAFE_INTEGER
      if (leftClipIndex !== rightClipIndex) return leftClipIndex - rightClipIndex
      return left.index - right.index
    })

  return sortedStoryboards.map(({ storyboard, index }) => {
    const order = clipOrder.get(storyboard.clipId) ?? index
    const panels = (Array.isArray(storyboard.panels) ? storyboard.panels : [])
      .sort((left, right) => {
        const leftIndex = Number.isFinite(left.panelIndex) ? left.panelIndex : 0
        const rightIndex = Number.isFinite(right.panelIndex) ? right.panelIndex : 0
        if (leftIndex !== rightIndex) return leftIndex - rightIndex
        return (left.id || '').localeCompare(right.id || '')
      })
      .map((panel) => ({ ...panel, storyboardId: storyboard.id }))
    const clip = storyboard.clip
    const range = typeof clip?.start === 'number' && typeof clip?.end === 'number'
      ? `${clip.start}-${clip.end}`
      : null
    const summary = formatClipSummary(clip?.screenplay, clip?.content)
    return {
      storyboardId: storyboard.id,
      clipId: storyboard.clipId,
      clipOrder: order,
      title: range ? `片段 ${order + 1} · ${range}` : `片段 ${order + 1}`,
      summary,
      panels,
    }
  })
}

export function getSortedFrames(panel: MobilePanel): MobilePanelFrame[] {
  return Array.isArray(panel.frames)
    ? [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
    : []
}

export function canReferencePreviousPanel(
  panels: Array<Pick<MobilePanel, 'id'>>,
  panelId: string,
): boolean {
  return panels.findIndex((panel) => panel.id === panelId) > 0
}

export function shouldDisplayPanelFrames(frames: Array<{ id: string }>): boolean {
  return frames.length > 0
}

export function resolveSelectedPanelFrameId(
  frames: Array<{ id: string; frameIndex: number }>,
  preferredFrameId: string | null,
): string | null {
  if (preferredFrameId && frames.some((frame) => frame.id === preferredFrameId)) {
    return preferredFrameId
  }
  const firstFrame = [...frames].sort((left, right) => left.frameIndex - right.frameIndex)[0]
  return firstFrame?.id ?? null
}

export function getPanelImageUrl(panel: MobilePanel): string | null {
  const frame = getSortedFrames(panel).find((item) => item.imageUrl || item.imageMedia?.url || item.media?.url)
  return displayMediaUrl(frame?.imageMedia?.url || frame?.media?.url || frame?.imageUrl || panel.imageMedia?.url || panel.media?.url || panel.imageUrl)
}

export function getPanelVideoUrl(panel: MobilePanel): string | null {
  return displayMediaUrl(panel.videoMedia?.url || panel.videoUrl)
}

export function getPanelDuration(panel: MobilePanel): number | null {
  const value = panel.groupDurationSec ?? panel.duration ?? null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function copyText(text: string): Promise<boolean> {
  if (!text.trim()) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
