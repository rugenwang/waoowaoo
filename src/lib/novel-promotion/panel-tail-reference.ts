export interface PanelFrameDependencyPlan {
  frameIndexes: number[]
  previousTail: boolean
}

interface PanelTailFrameLike {
  frameIndex: number
  imageUrl?: string | null
  imageMedia?: {
    url?: string | null
    storageKey?: string | null
  } | null
}

interface PanelTailPanelLike {
  panelMode?: string | null
  imageUrl?: string | null
  imageMedia?: {
    url?: string | null
    storageKey?: string | null
  } | null
  frames?: PanelTailFrameLike[] | null
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function uniqueNumbers(values: number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || seen.has(value)) continue
    seen.add(value)
    result.push(Math.floor(value))
  }
  return result
}

export function parsePanelFrameDependencyPlan(raw: string | null | undefined): PanelFrameDependencyPlan {
  if (!raw) return { frameIndexes: [], previousTail: false }
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { frameIndexes: [], previousTail: false }
    const frameIndexes: number[] = []
    let previousTail = false
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim().toUpperCase() === 'FP') {
        previousTail = true
        continue
      }
      const value = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN
      if (Number.isFinite(value) && value >= 0) {
        frameIndexes.push(Math.floor(value))
      }
    }
    return {
      frameIndexes: uniqueNumbers(frameIndexes),
      previousTail,
    }
  } catch {
    return { frameIndexes: [], previousTail: false }
  }
}

export function serializePanelFrameDependencyPlan(plan: PanelFrameDependencyPlan): string | null {
  const frameIndexes = uniqueNumbers(plan.frameIndexes)
  const values: Array<string | number> = []
  if (plan.previousTail) values.push('FP')
  values.push(...frameIndexes)
  return values.length > 0 ? JSON.stringify(values) : null
}

export function withPreviousTailDependency(
  raw: string | null | undefined,
  enabled: boolean,
  frameIndex: number,
): string | null {
  if (!enabled || frameIndex !== 0) {
    const normalized = parsePanelFrameDependencyPlan(raw)
    return serializePanelFrameDependencyPlan(normalized)
  }
  const plan = parsePanelFrameDependencyPlan(raw)
  return serializePanelFrameDependencyPlan({
    frameIndexes: plan.frameIndexes,
    previousTail: true,
  })
}

export function resolvePreviousPanelTailImageUrl(panel: PanelTailPanelLike | null | undefined): string | null {
  if (!panel) return null
  const frames = Array.isArray(panel.frames)
    ? [...panel.frames].sort((left, right) => left.frameIndex - right.frameIndex)
    : []
  const lastFrameImageUrl = [...frames]
    .reverse()
    .map((frame) => cleanText(frame.imageUrl) || cleanText(frame.imageMedia?.storageKey) || cleanText(frame.imageMedia?.url))
    .find((value): value is string => Boolean(value))
    || null
  const isGroup = panel.panelMode === 'group' || frames.length > 1
  const panelImageUrl = cleanText(panel.imageUrl) || cleanText(panel.imageMedia?.storageKey) || cleanText(panel.imageMedia?.url)
  if (isGroup) return lastFrameImageUrl || panelImageUrl
  return lastFrameImageUrl || panelImageUrl
}
