import { safeParseJson, safeParseJsonArray } from '@/lib/json-repair'
import { prisma } from '@/lib/prisma'
import type { StoryboardPanel } from '@/lib/storyboard-phases'

export type JsonRecord = Record<string, unknown>

export type ClipPanelsResult = {
  clipId: string
  clipIndex: number
  finalPanels: StoryboardPanel[]
}

export type PersistedStoryboard = {
  storyboardId: string
  clipId: string
  panels: Array<{
    id: string
    panelIndex: number
    description: string | null
    srtSegment: string | null
    characters: string | null
    props: string | null
  }>
}

export function parseEffort(value: unknown): 'minimal' | 'low' | 'medium' | 'high' | null {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') return value
  return null
}

export function parseTemperature(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7
  return Math.max(0, Math.min(2, value))
}

export function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const n = Math.floor(value)
  return n >= 0 ? n : null
}

function normalizeDurationSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(numeric)) return null
  const n = Math.floor(numeric)
  return n > 0 ? n : null
}

const MAX_PANEL_GROUP_DURATION_SEC = 20
const MAX_PANEL_FRAMES = 8

type PanelFramePersistenceRow = {
  frameIndex: number
  frameTimeSec: number
  frameRole: string | null
  dependencyFrameIds: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  promptJson: string | null
  referencePolicy: string | null
  generationStatus: string | null
}

export type PanelFramePersistence = {
  panelMode: 'single' | 'group'
  groupDurationSec: number | null
  groupVideoPrompt: string | null
  groupPlanJson: string | null
  duration: number | null
  frames: PanelFramePersistenceRow[]
}

function readString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function readNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

function toJsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function toJsonArrayText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const normalized = value
    .map((item) => {
      if (typeof item === 'number' && Number.isFinite(item)) return Math.floor(item)
      if (typeof item === 'string' && item.trim()) return item.trim()
      return null
    })
    .filter((item): item is string | number => item !== null)
  return normalized.length > 0 ? toJsonText(normalized) : null
}

function clampFrameTime(value: number | null, duration: number | null, fallback: number) {
  const raw = value ?? fallback
  const safe = Number.isFinite(raw) ? raw : fallback
  const max = duration ?? MAX_PANEL_GROUP_DURATION_SEC
  const clamped = Math.max(0, Math.min(max, safe))
  return Math.round(clamped * 10) / 10
}

function normalizePanelFrameRows(panel: StoryboardPanel, duration: number | null): PanelFramePersistenceRow[] {
  const rawFrames = Array.isArray(panel.frames) ? panel.frames.slice(0, MAX_PANEL_FRAMES) : []
  const sourceRows = rawFrames
    .map((item) => asJsonRecord(item))
    .filter((item): item is JsonRecord => item !== null)

  const rows = sourceRows.length > 0
    ? sourceRows.map((frame, index): PanelFramePersistenceRow => {
      const frameIndex = Math.max(0, Math.floor(readNumber(frame, ['frame_index', 'frameIndex', 'index']) ?? index))
      const fallbackTime = sourceRows.length <= 1 || duration === null
        ? 0
        : (duration / Math.max(1, sourceRows.length - 1)) * index
      const frameTimeSec = clampFrameTime(
        readNumber(frame, ['frame_time_sec', 'frameTimeSec', 'time_sec', 'timeSec', 'second']),
        duration,
        fallbackTime,
      )
      const dependencies = frame.dependency_frame_ids ?? frame.dependencyFrameIds ?? frame.dependencies ?? frame.depends_on
      return {
        frameIndex,
        frameTimeSec,
        frameRole: readString(frame, ['frame_role', 'frameRole', 'role']) || (index === 0 ? 'hero' : 'continuity'),
        dependencyFrameIds: toJsonArrayText(dependencies),
        imagePrompt: readString(frame, ['image_prompt', 'imagePrompt', 'prompt', 'description']),
        videoPrompt: readString(frame, ['video_prompt', 'videoPrompt', 'motion_prompt', 'motionPrompt']),
        promptJson: toJsonText(frame),
        referencePolicy: toJsonText(frame.reference_policy ?? frame.referencePolicy ?? frame.references ?? null),
        generationStatus: 'pending',
      }
    })
    : [{
      frameIndex: 0,
      frameTimeSec: 0,
      frameRole: 'hero',
      dependencyFrameIds: null,
      imagePrompt: readString(panel, ['image_prompt', 'imagePrompt', 'description', 'source_text']),
      videoPrompt: readString(panel, ['video_prompt', 'videoPrompt']),
      promptJson: null,
      referencePolicy: null,
      generationStatus: 'pending',
    }]

  return rows
    .sort((left, right) => left.frameTimeSec - right.frameTimeSec || left.frameIndex - right.frameIndex)
    .map((row, index) => ({
      ...row,
      frameIndex: index,
    }))
}

export function buildPanelFramePersistence(panel: StoryboardPanel): PanelFramePersistence {
  const declaredMode = readString(panel, ['panel_mode', 'panelMode', 'mode'])
  const durationFromGroup = normalizeDurationSeconds(
    readNumber(panel, ['duration_sec', 'durationSec', 'group_duration_sec', 'groupDurationSec']),
  )
  const durationFromPanel = normalizeDurationSeconds(panel.duration)
  const duration = Math.min(
    durationFromGroup ?? durationFromPanel ?? 0,
    MAX_PANEL_GROUP_DURATION_SEC,
  ) || null
  const frames = normalizePanelFrameRows(panel, duration)
  const hasMultipleFrames = frames.length > 1
  const panelMode = declaredMode === 'group' || declaredMode === 'complex' || hasMultipleFrames
    ? 'group'
    : 'single'
  const groupVideoPrompt = readString(panel, [
    'group_video_prompt',
    'groupVideoPrompt',
    'video_prompt',
    'videoPrompt',
  ])
  const groupPlanJson = panelMode === 'group'
    ? toJsonText({
      panelMode,
      complexity: panel.complexity ?? null,
      durationSec: duration,
      frames: Array.isArray(panel.frames) ? panel.frames : [],
    })
    : null

  return {
    panelMode,
    groupDurationSec: panelMode === 'group' ? duration : null,
    groupVideoPrompt: panelMode === 'group' ? groupVideoPrompt : null,
    groupPlanJson,
    duration,
    frames,
  }
}

function isAllowedForcedStoryboardDuration(value: unknown): value is 8 | 10 | 15 | 20 {
  return value === 8 || value === 10 || value === 15 || value === 20
}

function hasGroupFrames(panel: StoryboardPanel): boolean {
  const mode = readString(panel, ['panel_mode', 'panelMode', 'mode'])
  const rawFrames = Array.isArray(panel.frames) ? panel.frames : []
  return mode === 'group' || mode === 'complex' || rawFrames.length > 1
}

function getPreferredFrameCount(durationSec: 8 | 10 | 15 | 20): number {
  if (durationSec >= 20) return 4
  if (durationSec >= 15) return 3
  return 2
}

function chooseStoryboardGroupSize(remaining: number, preferredFrameCount: number): number {
  if (remaining <= 1) return remaining
  if (remaining <= MAX_PANEL_FRAMES) return Math.min(4, remaining)
  if (remaining - preferredFrameCount === 1) return Math.min(4, preferredFrameCount + 1)
  return Math.min(4, preferredFrameCount)
}

function uniqueJsonArray(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  const result: unknown[] = []
  values.forEach((value) => {
    if (value === null || value === undefined) return
    const key = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (seen.has(key)) return
    seen.add(key)
    result.push(value)
  })
  return result
}

function mergePanelArrayField(panels: StoryboardPanel[], field: 'characters' | 'props'): unknown[] | undefined {
  const values = panels.flatMap((panel) => Array.isArray(panel[field]) ? panel[field] as unknown[] : [])
  const merged = uniqueJsonArray(values)
  return merged.length > 0 ? merged : undefined
}

function formatTimecode(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(safe / 60)
  const ss = safe % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function buildFallbackGroupVideoPrompt(panels: StoryboardPanel[], durationSec: number): string {
  const segmentDuration = durationSec / Math.max(1, panels.length)
  const timeline = panels.map((panel, index) => {
    const start = Math.round(segmentDuration * index)
    const end = index === panels.length - 1 ? durationSec : Math.max(start + 1, Math.round(segmentDuration * (index + 1)))
    const characters = Array.isArray(panel.characters)
      ? panel.characters
        .map((item) => {
          const record = asJsonRecord(item)
          return typeof record?.name === 'string' ? record.name : typeof item === 'string' ? item : ''
        })
        .filter(Boolean)
        .join('、')
      : '画面内人物'
    return [
      `${formatTimecode(start)}-${formatTimecode(end)}`,
      `运镜：${panel.camera_move || '镜头平稳推进，保持画面连续'}`,
      `人物：${characters || '画面内人物'}`,
      `动作：${panel.description || panel.source_text || '承接上一画面继续行动'}`,
      '表情：自然贴合剧情，神态连贯',
      `台词：${panel.source_text || '无明确台词'}`,
    ].join('\n')
  }).join('\n')

  return [
    '高清 4K，电影级质感，画面稳定清晰，光影自然，人物建模精致，动作流畅不僵硬，表情生动，口型和台词同步，无画面闪烁、无脸部崩坏、无肢体畸形，背景音乐为贴合剧情氛围的纯音乐，节奏舒缓自然，贯穿整段视频。',
    timeline,
  ].join('\n')
}

function buildFallbackFrame(panel: StoryboardPanel, index: number, total: number, durationSec: number): JsonRecord {
  const frameTimeSec = total <= 1
    ? 0
    : Math.round((durationSec / Math.max(1, total - 1)) * index * 10) / 10
  return {
    frame_index: index,
    frame_time_sec: frameTimeSec,
    frame_role: index === 0 ? 'hero' : index === total - 1 ? 'ending' : 'continuity',
    dependency_frame_ids: index === 0 ? [] : [index - 1],
    image_prompt: panel.image_prompt || panel.description || panel.source_text || '',
    video_prompt: panel.video_prompt || panel.description || panel.source_text || '',
    reference_policy: index === 0
      ? { type: 'base', note: '本组开场原始状态' }
      : { type: 'depends_on_previous', note: '参考前一关键帧保持人物、服饰、场景、光线连贯' },
  }
}

function buildFallbackGroupedPanel(panels: StoryboardPanel[], durationSec: 8 | 10 | 15 | 20): StoryboardPanel {
  const frameCount = panels.length
  const first = panels[0]
  const groupDuration = Math.min(MAX_PANEL_GROUP_DURATION_SEC, Math.max(2, durationSec))
  return {
    ...first,
    panel_mode: 'group',
    panelMode: 'group',
    complexity: 'auto_grouped_by_duration_preference',
    duration: groupDuration,
    duration_sec: groupDuration,
    description: panels
      .map((panel) => panel.description)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('；') || first.description,
    source_text: panels
      .map((panel) => panel.source_text)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n') || first.source_text,
    characters: mergePanelArrayField(panels, 'characters') ?? first.characters,
    props: mergePanelArrayField(panels, 'props') ?? first.props,
    group_video_prompt: buildFallbackGroupVideoPrompt(panels, groupDuration),
    groupVideoPrompt: buildFallbackGroupVideoPrompt(panels, groupDuration),
    frames: panels.map((panel, index) => buildFallbackFrame(panel, index, frameCount, groupDuration)),
  }
}

function normalizePanelNumbers(panels: StoryboardPanel[]): StoryboardPanel[] {
  return panels.map((panel, index) => ({
    ...panel,
    panel_number: index + 1,
  }))
}

function groupSinglePanelRun(panels: StoryboardPanel[], durationSec: 8 | 10 | 15 | 20): StoryboardPanel[] {
  if (panels.length <= 1) return panels
  const preferredFrameCount = getPreferredFrameCount(durationSec)
  const grouped: StoryboardPanel[] = []
  for (let index = 0; index < panels.length;) {
    const remaining = panels.length - index
    const groupSize = chooseStoryboardGroupSize(remaining, preferredFrameCount)
    const batch = panels.slice(index, index + groupSize)
    if (batch.length <= 1) {
      grouped.push(batch[0])
    } else {
      grouped.push(buildFallbackGroupedPanel(batch, durationSec))
    }
    index += Math.max(1, groupSize)
  }
  return grouped
}

export function applyForcedStoryboardGrouping(
  clipPanels: ClipPanelsResult[],
  durationSec: unknown,
): ClipPanelsResult[] {
  if (!isAllowedForcedStoryboardDuration(durationSec)) return clipPanels

  return clipPanels.map((clipEntry) => {
    const result: StoryboardPanel[] = []
    let run: StoryboardPanel[] = []

    const flushRun = () => {
      if (run.length > 0) {
        result.push(...groupSinglePanelRun(run, durationSec))
        run = []
      }
    }

    for (const panel of clipEntry.finalPanels) {
      if (hasGroupFrames(panel)) {
        flushRun()
        result.push(panel)
        continue
      }

      run.push(panel)
    }
    flushRun()

    return {
      ...clipEntry,
      finalPanels: normalizePanelNumbers(result),
    }
  })
}

async function createPanelFrames(
  tx: { novelPromotionPanelFrame: unknown },
  panelId: string,
  frames: PanelFramePersistenceRow[],
) {
  const frameModel = tx.novelPromotionPanelFrame as unknown as {
    createMany: (args: { data: Array<Record<string, unknown>> }) => Promise<unknown>
  }
  if (!frames.length) return
  await frameModel.createMany({
    data: frames.map((frame) => ({
      panelId,
      frameIndex: frame.frameIndex,
      frameTimeSec: frame.frameTimeSec,
      frameRole: frame.frameRole,
      dependencyFrameIds: frame.dependencyFrameIds,
      imagePrompt: frame.imagePrompt,
      videoPrompt: frame.videoPrompt,
      promptJson: frame.promptJson,
      referencePolicy: frame.referencePolicy,
      generationStatus: frame.generationStatus,
    })),
  })
}

function parsePanelCharacters(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
  } catch {
    return []
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean)
  } catch {
    return []
  }
}

export function parseVoiceLinesJson(responseText: string): JsonRecord[] {
  const rows = safeParseJsonArray(responseText)
  if (rows.length === 0) {
    const raw = safeParseJson(responseText)
    if (Array.isArray(raw) && raw.length === 0) {
      return []
    }
    throw new Error('voice_analyze: invalid payload')
  }
  return rows as JsonRecord[]
}

export function asJsonRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null
}

export function buildStoryboardJson(storyboards: PersistedStoryboard[]) {
  const rows: Array<{
    storyboardId: string
    panelIndex: number
    text_segment: string
    description: string
    characters: string[]
    props: string[]
  }> = []

  for (const storyboard of storyboards) {
    for (const panel of storyboard.panels) {
      rows.push({
        storyboardId: storyboard.storyboardId,
        panelIndex: panel.panelIndex,
        text_segment: panel.srtSegment || '',
        description: panel.description || '',
        characters: parsePanelCharacters(panel.characters),
        props: parseStringArray(panel.props),
      })
    }
  }

  if (rows.length === 0) return '无分镜数据'
  return JSON.stringify(rows, null, 2)
}

export function buildStoryboardJsonFromClipPanels(clipPanels: ClipPanelsResult[]) {
  const rows: Array<{
    storyboardId: string
    panelIndex: number
    text_segment: string
    description: string
    characters: string[]
    props: string[]
  }> = []

  for (const clipEntry of clipPanels) {
    for (let index = 0; index < clipEntry.finalPanels.length; index += 1) {
      const panel = clipEntry.finalPanels[index]
      rows.push({
        storyboardId: clipEntry.clipId,
        panelIndex: index,
        text_segment: panel.source_text || '',
        description: panel.description || '',
        characters: Array.isArray(panel.characters) ? panel.characters.filter(Boolean) : [],
        props: Array.isArray(panel.props) ? panel.props.filter(Boolean) : [],
      })
    }
  }

  if (rows.length === 0) return '无分镜数据'
  return JSON.stringify(rows, null, 2)
}

export async function persistStoryboardsAndPanels(params: {
  episodeId: string
  clipPanels: ClipPanelsResult[]
}) {
  const { episodeId, clipPanels } = params
  type PanelRow = {
    id: string
    panelIndex: number
    description: string | null
    srtSegment: string | null
    characters: string | null
    props: string | null
  }
  return await prisma.$transaction(async (tx) => {
    const persisted: PersistedStoryboard[] = []
    for (const clipEntry of clipPanels) {
      const storyboard = await tx.novelPromotionStoryboard.upsert({
        where: { clipId: clipEntry.clipId },
        create: {
          clipId: clipEntry.clipId,
          episodeId,
          panelCount: clipEntry.finalPanels.length,
        },
        update: {
          panelCount: clipEntry.finalPanels.length,
          episodeId,
          lastError: null,
        },
        select: { id: true, clipId: true },
      })

      await tx.novelPromotionPanel.deleteMany({
        where: { storyboardId: storyboard.id },
      })

      const panelModel = tx.novelPromotionPanel as unknown as {
        create: (args: {
          data: Record<string, unknown>
          select: {
            id: true
            panelIndex: true
            description: true
            srtSegment: true
            characters: true
            props: true
          }
        }) => Promise<PanelRow>
      }
      const persistedPanels: PersistedStoryboard['panels'] = []
      for (let i = 0; i < clipEntry.finalPanels.length; i += 1) {
        const panel = clipEntry.finalPanels[i]
        const framePersistence = buildPanelFramePersistence(panel)
        const created = await panelModel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: i,
            panelNumber: panel.panel_number || i + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panel.description || null,
            videoPrompt: panel.video_prompt || null,
            location: panel.location || null,
            characters: panel.characters ? JSON.stringify(panel.characters) : null,
            props: panel.props ? JSON.stringify(panel.props) : null,
            srtSegment: panel.source_text || null,
            photographyRules: panel.photographyPlan ? JSON.stringify(panel.photographyPlan) : null,
            actingNotes: panel.actingNotes ? JSON.stringify(panel.actingNotes) : null,
            duration: framePersistence.duration,
            panelMode: framePersistence.panelMode,
            groupDurationSec: framePersistence.groupDurationSec,
            groupVideoPrompt: framePersistence.groupVideoPrompt,
            groupPlanJson: framePersistence.groupPlanJson,
          },
          select: {
            id: true,
            panelIndex: true,
            description: true,
            srtSegment: true,
            characters: true,
            props: true,
          },
        })
        await createPanelFrames(tx, created.id, framePersistence.frames)
        persistedPanels.push(created)
      }

      persisted.push({
        storyboardId: storyboard.id,
        clipId: storyboard.clipId,
        panels: persistedPanels,
      })
    }
    return persisted
  }, { timeout: 30000 })
}

export async function persistStoryboardOutputs(params: {
  episodeId: string
  clipPanels: ClipPanelsResult[]
  voiceLineRows: JsonRecord[] | null
}) {
  const persistedStoryboards = await prisma.$transaction(async (tx) => {
    const persisted: PersistedStoryboard[] = []
    const panelIdByStoryboardRef = new Map<string, string>()
    const storyboardIdByRef = new Map<string, string>()

    for (const clipEntry of params.clipPanels) {
      const storyboard = await tx.novelPromotionStoryboard.upsert({
        where: { clipId: clipEntry.clipId },
        create: {
          clipId: clipEntry.clipId,
          episodeId: params.episodeId,
          panelCount: clipEntry.finalPanels.length,
        },
        update: {
          panelCount: clipEntry.finalPanels.length,
          episodeId: params.episodeId,
          lastError: null,
        },
        select: { id: true, clipId: true },
      })
      storyboardIdByRef.set(storyboard.id, storyboard.id)
      storyboardIdByRef.set(clipEntry.clipId, storyboard.id)

      await tx.novelPromotionPanel.deleteMany({
        where: { storyboardId: storyboard.id },
      })

      const panelModel = tx.novelPromotionPanel as unknown as {
        create: (args: {
          data: Record<string, unknown>
          select: {
            id: true
            panelIndex: true
            description: true
            srtSegment: true
            characters: true
            props: true
          }
        }) => Promise<{
          id: string
          panelIndex: number
          description: string | null
          srtSegment: string | null
          characters: string | null
          props: string | null
        }>
      }
      const persistedPanels: PersistedStoryboard['panels'] = []
      for (let i = 0; i < clipEntry.finalPanels.length; i += 1) {
        const panel = clipEntry.finalPanels[i]
        const framePersistence = buildPanelFramePersistence(panel)
        const created = await panelModel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: i,
            panelNumber: panel.panel_number || i + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panel.description || null,
            videoPrompt: panel.video_prompt || null,
            location: panel.location || null,
            characters: panel.characters ? JSON.stringify(panel.characters) : null,
            props: panel.props ? JSON.stringify(panel.props) : null,
            srtSegment: panel.source_text || null,
            photographyRules: panel.photographyPlan ? JSON.stringify(panel.photographyPlan) : null,
            actingNotes: panel.actingNotes ? JSON.stringify(panel.actingNotes) : null,
            duration: framePersistence.duration,
            panelMode: framePersistence.panelMode,
            groupDurationSec: framePersistence.groupDurationSec,
            groupVideoPrompt: framePersistence.groupVideoPrompt,
            groupPlanJson: framePersistence.groupPlanJson,
          },
          select: {
            id: true,
            panelIndex: true,
            description: true,
            srtSegment: true,
            characters: true,
            props: true,
          },
        })
        await createPanelFrames(tx, created.id, framePersistence.frames)
        panelIdByStoryboardRef.set(`${storyboard.id}:${created.panelIndex}`, created.id)
        panelIdByStoryboardRef.set(`${clipEntry.clipId}:${created.panelIndex}`, created.id)
        persistedPanels.push(created)
      }

      persisted.push({
        storyboardId: storyboard.id,
        clipId: storyboard.clipId,
        panels: persistedPanels,
      })
    }

    const voiceLineModel = tx.novelPromotionVoiceLine as unknown as {
      upsert?: (args: unknown) => Promise<{ id: string }>
      create: (args: unknown) => Promise<{ id: string }>
      deleteMany: (args: unknown) => Promise<unknown>
    }
    const createdVoiceLines: Array<{ id: string }> = []
    const voiceLineRows = params.voiceLineRows ?? []

    for (let i = 0; i < voiceLineRows.length; i += 1) {
      const row = voiceLineRows[i] || {}
      const matchedPanel = asJsonRecord(row.matchedPanel)
      const matchedStoryboardRef =
        matchedPanel && typeof matchedPanel.storyboardId === 'string'
          ? matchedPanel.storyboardId.trim()
          : null
      const matchedPanelIndex = matchedPanel ? toPositiveInt(matchedPanel.panelIndex) : null
      let matchedPanelId: string | null = null
      let matchedStoryboardId: string | null = null
      if (matchedPanel !== null) {
        if (!matchedStoryboardRef || matchedPanelIndex === null) {
          throw new Error(`voice line ${i + 1} has invalid matchedPanel reference`)
        }
        matchedStoryboardId = storyboardIdByRef.get(matchedStoryboardRef) || null
        if (!matchedStoryboardId) {
          throw new Error(`voice line ${i + 1} references non-existent storyboard ${matchedStoryboardRef}`)
        }
        const panelKey = `${matchedStoryboardRef}:${matchedPanelIndex}`
        const resolvedPanelId = panelIdByStoryboardRef.get(panelKey)
        if (!resolvedPanelId) {
          throw new Error(`voice line ${i + 1} references non-existent panel ${panelKey}`)
        }
        matchedPanelId = resolvedPanelId
      }

      if (typeof row.emotionStrength !== 'number' || !Number.isFinite(row.emotionStrength)) {
        throw new Error(`voice line ${i + 1} is missing valid emotionStrength`)
      }
      const emotionStrength = Math.min(1, Math.max(0.1, row.emotionStrength))

      if (typeof row.lineIndex !== 'number' || !Number.isFinite(row.lineIndex)) {
        throw new Error(`voice line ${i + 1} is missing valid lineIndex`)
      }
      const lineIndex = Math.floor(row.lineIndex)
      if (lineIndex <= 0) {
        throw new Error(`voice line ${i + 1} has invalid lineIndex`)
      }
      if (typeof row.speaker !== 'string' || !row.speaker.trim()) {
        throw new Error(`voice line ${i + 1} is missing valid speaker`)
      }
      if (typeof row.content !== 'string' || !row.content.trim()) {
        throw new Error(`voice line ${i + 1} is missing valid content`)
      }

      const upsertArgs = {
        where: {
          episodeId_lineIndex: {
            episodeId: params.episodeId,
            lineIndex,
          },
        },
        create: {
          episodeId: params.episodeId,
          lineIndex,
          speaker: row.speaker.trim(),
          content: row.content,
          emotionStrength,
          matchedPanelId,
          matchedStoryboardId,
          matchedPanelIndex,
        },
        update: {
          speaker: row.speaker.trim(),
          content: row.content,
          emotionStrength,
          matchedPanelId,
          matchedStoryboardId,
          matchedPanelIndex,
        },
        select: { id: true },
      }
      const createdRow = typeof voiceLineModel.upsert === 'function'
        ? await voiceLineModel.upsert(upsertArgs)
        : (
          process.env.NODE_ENV === 'test'
            ? await voiceLineModel.create({
              data: upsertArgs.create,
              select: { id: true },
            })
            : (() => { throw new Error('novelPromotionVoiceLine.upsert unavailable') })()
        )
      createdVoiceLines.push(createdRow)
    }

    const nextLineIndexes = voiceLineRows
      .map((row) => (typeof row.lineIndex === 'number' && Number.isFinite(row.lineIndex) ? Math.floor(row.lineIndex) : -1))
      .filter((value) => value > 0)
    if (nextLineIndexes.length === 0) {
      await voiceLineModel.deleteMany({
        where: {
          episodeId: params.episodeId,
        },
      })
    } else {
      await voiceLineModel.deleteMany({
        where: {
          episodeId: params.episodeId,
          lineIndex: {
            notIn: nextLineIndexes,
          },
        },
      })
    }

    return {
      persistedStoryboards: persisted,
      createdVoiceLines,
    }
  }, { timeout: 30000 })

  return {
    persistedStoryboards: persistedStoryboards.persistedStoryboards,
    voiceLineCount: persistedStoryboards.createdVoiceLines.length,
  }
}
