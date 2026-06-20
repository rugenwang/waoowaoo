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
const MAX_PANEL_FRAMES = 20

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

export function cleanVideoPromptText(value: string | null): string | null {
  if (!value) return null
  const cleaned = value
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]\s*/g, '')
    .replace(/(?:[（(]\s*)?(?:主运镜|辅助运镜)(?:\s*[）)])?/g, '')
    .replace(/【对话】\s*(?:无台词|无明确台词|暂无台词|没有台词)\s*[；;。]?/g, '')
    .replace(/台词：\s*(?:无台词|无明确台词|暂无台词|没有台词)\s*[；;。]?/g, '')
    .replace(/[ \t]+([，。；：])/g, '$1')
    .replace(/；{2,}/g, '；')
    .trim()
  return cleaned || null
}

function stripReferenceIntro(value: string): string {
  return value
    .replace(/^参考图F\d+[^；;]*[；;]\s*/u, '')
    .replace(/^参考图F\d+(?:[-~到至]F\d+)?[^；;]*[；;]\s*/u, '')
    .replace(/^Input references?\s+F\d+(?:[-~]\s*F\d+)?[^;]*;\s*/iu, '')
    .replace(/^无额外输入参考图[；;]\s*/u, '')
    .replace(/^当前画面[：:]\s*/u, '')
    .replace(/^current still image[：:]\s*/iu, '')
    .trim()
}

function looksLikeVideoPrompt(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  const hasTimeline = /\b\d{2}:\d{2}\s*-\s*\d{2}:\d{2}[：:]/.test(text)
  const hasVideoMarkers = text.includes('背景音乐为')
    || text.includes('【对话】')
    || text.includes('【旁白】')
    || text.includes('无画面闪烁')
    || text.includes('电影级质感')
  return hasTimeline || (text.length > 180 && hasVideoMarkers)
}

export function cleanPanelDescriptionText(panel: StoryboardPanel): string | null {
  const rawDescription = typeof panel.description === 'string' ? panel.description.trim() : ''
  if (rawDescription && !looksLikeVideoPrompt(rawDescription)) return rawDescription

  const frames = Array.isArray(panel.frames) ? panel.frames : []
  for (const frame of frames) {
    const record = asJsonRecord(frame)
    const framePrompt = record ? readString(record, ['image_prompt', 'imagePrompt', 'prompt']) : null
    if (framePrompt) {
      const cleaned = stripReferenceIntro(framePrompt)
      if (cleaned && !looksLikeVideoPrompt(cleaned)) return cleaned
    }
  }

  const sourceText = typeof panel.source_text === 'string' ? panel.source_text.trim() : ''
  if (sourceText && !looksLikeVideoPrompt(sourceText)) return sourceText

  return rawDescription ? stripReferenceIntro(rawDescription).slice(0, 160) : null
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

function readNameFromReference(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  const record = asJsonRecord(value)
  if (!record) return null
  return readString(record, ['name', 'label', 'title'])
}

function readAppearanceFromReference(value: unknown): string | null {
  const record = asJsonRecord(value)
  if (!record) return null
  return readString(record, ['appearance', 'changeReason', 'variant'])
}

function normalizeDependencyItems(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string' && item.trim()) {
        const trimmed = item.trim()
        if (trimmed.toUpperCase() === 'FP') return 'FP'
        const numeric = Number(trimmed)
        return Number.isFinite(numeric) ? Math.floor(numeric) : trimmed
      }
      if (typeof item === 'number' && Number.isFinite(item)) return Math.floor(item)
      return null
    })
    .filter((item): item is string | number => item !== null)
}

function removeModelPlannedPreviousTailDependency(value: unknown): Array<string | number> {
  return normalizeDependencyItems(value).filter((item) => !(typeof item === 'string' && item.toUpperCase() === 'FP'))
}

function buildOrderedReferenceLabels(panel: StoryboardPanel, dependencies: unknown): string[] {
  const labels: string[] = []
  for (const item of normalizeDependencyItems(dependencies)) {
    if (typeof item === 'string' && item.toUpperCase() === 'FP') {
      labels.push('上一个连续分镜的尾帧 FP，作为当前分镜的参考图')
    } else if (typeof item === 'number') {
      labels.push(`分镜组已生成关键帧 F${item + 1}`)
    }
  }

  const location = readString(panel, ['location'])
  if (location) {
    labels.push(`当前分镜场景图：${location}`)
  }

  const characters = Array.isArray(panel.characters) ? panel.characters : []
  for (const character of characters) {
    const name = readNameFromReference(character)
    if (!name) continue
    const appearance = readAppearanceFromReference(character)
    labels.push(appearance ? `角色图：${name} · ${appearance}` : `角色图：${name}`)
  }

  const props = Array.isArray(panel.props) ? panel.props : []
  for (const prop of props) {
    const name = readNameFromReference(prop)
    if (name) labels.push(`道具图：${name}`)
  }

  return labels
}

function hasReferenceIntro(prompt: string | null): boolean {
  return Boolean(prompt && /(?:参考图|输入参考图)\s*F\d+|Input reference\s+F\d+/i.test(prompt))
}

function containsPreviousTailReference(prompt: string): boolean {
  return /(?:上一(?:个)?(?:连续)?分镜(?:的)?尾帧|上一尾帧|previous(?:\s+\w+){0,4}\s+tail|previous\s+panel\s+tail|FP)/i.test(prompt)
}

function dependencyIncludesPreviousTail(dependencies: unknown): boolean {
  return normalizeDependencyItems(dependencies).some((item) => typeof item === 'string' && item.toUpperCase() === 'FP')
}

function ensureFramePromptReferenceIntro(
  prompt: string | null,
  panel: StoryboardPanel,
  dependencies: unknown,
): string | null {
  const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : ''
  if (!cleanPrompt) return null
  if (hasReferenceIntro(cleanPrompt) && (!containsPreviousTailReference(cleanPrompt) || dependencyIncludesPreviousTail(dependencies))) {
    return cleanPrompt
  }
  const promptBody = hasReferenceIntro(cleanPrompt) ? stripReferenceIntro(cleanPrompt) : cleanPrompt
  const labels = buildOrderedReferenceLabels(panel, dependencies)
  if (labels.length === 0) {
    return `无额外输入参考图；当前画面：${promptBody}`
  }
  const referenceIntro = labels
    .map((label, index) => `参考图F${index + 1}为${label}`)
    .join('，')
  return `${referenceIntro}；当前画面：${promptBody}`
}

function buildReferencePolicyWithOrderedReferences(
  policy: unknown,
  panel: StoryboardPanel,
  dependencies: unknown,
): JsonRecord {
  const base = asJsonRecord(policy) || {}
  const labels = buildOrderedReferenceLabels(panel, dependencies)
  return {
    ...base,
    ordered_references: labels,
  }
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
      const safeDependencies = removeModelPlannedPreviousTailDependency(dependencies)
      const imagePrompt = readString(frame, ['image_prompt', 'imagePrompt', 'prompt', 'description'])
      const referencePolicy = frame.reference_policy ?? frame.referencePolicy ?? frame.references ?? null
      return {
        frameIndex,
        frameTimeSec,
        frameRole: readString(frame, ['frame_role', 'frameRole', 'role']) || (index === 0 ? 'hero' : 'continuity'),
        dependencyFrameIds: toJsonArrayText(safeDependencies),
        imagePrompt: ensureFramePromptReferenceIntro(imagePrompt, panel, safeDependencies),
        videoPrompt: cleanVideoPromptText(readString(frame, ['video_prompt', 'videoPrompt', 'motion_prompt', 'motionPrompt'])),
        promptJson: toJsonText(frame),
        referencePolicy: toJsonText(buildReferencePolicyWithOrderedReferences(referencePolicy, panel, safeDependencies)),
        generationStatus: 'pending',
      }
    })
    : [{
      frameIndex: 0,
      frameTimeSec: 0,
      frameRole: 'hero',
      dependencyFrameIds: null,
      imagePrompt: ensureFramePromptReferenceIntro(
        readString(panel, ['image_prompt', 'imagePrompt', 'description', 'source_text']),
        panel,
        [],
      ),
      videoPrompt: cleanVideoPromptText(readString(panel, ['video_prompt', 'videoPrompt'])),
      promptJson: null,
      referencePolicy: toJsonText(buildReferencePolicyWithOrderedReferences(null, panel, [])),
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
  const cleanedGroupVideoPrompt = cleanVideoPromptText(groupVideoPrompt)
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
    groupVideoPrompt: panelMode === 'group' ? cleanedGroupVideoPrompt : null,
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

const ACTION_DENSITY_KEYWORDS = [
  '走', '跑', '冲', '追', '躲', '扑', '撞', '推', '拉', '抬手', '挥', '砍', '打',
  '踢', '抓', '转身', '回头', '跪', '站起', '坐下', '倒下', '扶起', '递', '拿起',
  '放下', '打开', '关上', '穿过', '靠近', '后退', '拔剑', '出手',
]

const TRANSITION_DENSITY_KEYWORDS = [
  '转场', '切到', '切换', '闪回', '回忆', '梦境', '来到', '进入', '离开', '穿过',
  '从', '到', '突然', '随后', '接着', '同时', '另一边',
]

const CAMERA_DENSITY_KEYWORDS = [
  '推镜', '拉镜', '摇镜', '移镜', '跟镜', '固定镜', '俯拍', '仰拍', '平视', '斜角拍',
  '环绕', '俯冲', '升降', '甩镜', '变焦', '旋转', '穿梭', '手持', '特写', '近景',
  '中景', '远景', '全景',
]

const ULTRA_HIGH_DENSITY_KEYWORDS = [
  '连续打斗', '混战', '近身搏斗', '高速追逐', '追车', '连击', '闪避', '翻滚', '格挡',
  '爆炸', '坠落', '跳跃', '飞跃', '快速切换', '连续转场', '密集运镜', '快节奏',
  '一秒一帧', '每秒', '逐秒',
]

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0)
}

function collectDensityText(panel: StoryboardPanel): string {
  return [
    panel.description,
    panel.source_text,
    panel.video_prompt,
    panel.camera_move,
    panel.shot_type,
    panel.scene_type,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join(' ')
}

function getDurationBaseFrameCount(durationSec: 8 | 10 | 15 | 20): number {
  if (durationSec >= 20) return 5
  if (durationSec >= 15) return 4
  if (durationSec >= 10) return 3
  return 2
}

function getPreferredFrameCount(durationSec: 8 | 10 | 15 | 20, panels: StoryboardPanel[]): number {
  const text = panels.map(collectDensityText).join(' ')
  const actionHits = countKeywordHits(text, ACTION_DENSITY_KEYWORDS)
  const transitionHits = countKeywordHits(text, TRANSITION_DENSITY_KEYWORDS)
  const cameraHits = countKeywordHits(text, CAMERA_DENSITY_KEYWORDS)
  const dialogueTurns = (text.match(/[「“"][^」”"]+[」”"]/g) || []).length
  const sceneTypeBonus = panels.some((panel) => panel.scene_type === 'action' || panel.scene_type === 'suspense') ? 1 : 0
  const ultraHits = countKeywordHits(text, ULTRA_HIGH_DENSITY_KEYWORDS)
  const hasUltraHighDensity = ultraHits >= 1
    || (durationSec >= 15 && actionHits >= 7 && cameraHits >= 3)
    || (durationSec >= 15 && actionHits >= 5 && transitionHits >= 4)
    || (durationSec >= 20 && actionHits >= 5 && panels.some((panel) => panel.scene_type === 'action'))
  if (hasUltraHighDensity) return Math.max(2, Math.min(MAX_PANEL_FRAMES, durationSec))

  const densityScore = actionHits + transitionHits + Math.min(3, cameraHits) + Math.min(2, dialogueTurns) + sceneTypeBonus
  const densityBonus = densityScore >= 9 ? 3 : densityScore >= 5 ? 2 : densityScore >= 2 ? 1 : 0
  return Math.max(2, Math.min(MAX_PANEL_FRAMES, getDurationBaseFrameCount(durationSec) + densityBonus))
}

function chooseStoryboardGroupSize(remaining: number, preferredFrameCount: number): number {
  if (remaining <= 1) return remaining
  const target = Math.max(2, Math.min(MAX_PANEL_FRAMES, preferredFrameCount, remaining))
  if (remaining > target && remaining - target === 1 && target < MAX_PANEL_FRAMES) return target + 1
  return target
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

function selectFallbackMusic(sceneType: unknown): string {
  if (sceneType === 'action') return '急促鼓点战斗配乐'
  if (sceneType === 'epic') return '史诗恢弘交响乐'
  if (sceneType === 'suspense') return '紧张悬疑大片配乐'
  if (sceneType === 'emotion') return '伤感催泪抒情纯音乐'
  return '氛围感沉浸式背景音乐'
}

function normalizeFallbackCameraMove(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return '推镜'
  if (text.includes('俯冲')) return '俯冲'
  if (text.includes('升')) return '升降镜'
  if (text.includes('环绕')) return '环绕镜'
  if (text.includes('摇')) return '摇镜'
  if (text.includes('跟')) return '跟镜'
  if (text.includes('拉')) return '拉镜'
  if (text.includes('移') || text.includes('平移')) return '移镜'
  if (text.includes('固定') || text.includes('定格')) return '固定镜'
  if (text.includes('俯拍')) return '俯拍'
  if (text.includes('仰拍')) return '仰拍'
  return text
}

function buildNaturalFallbackCameraPhrase(cameraMove: string): string {
  switch (cameraMove) {
    case '固定镜':
      return '平视中景固定镜，稳定呈现画面内人物与场景关系'
    case '俯冲':
      return '远景俯冲镜头，从高处缓缓压向人物所在空间'
    case '升降镜':
      return '中景升降镜头，顺着人物动作自然起落'
    case '环绕镜':
      return '中景环绕镜头，围绕人物站位与情绪关系缓慢移动'
    case '摇镜':
      return '中景摇镜，从环境细节自然摇向人物方向'
    case '跟镜':
      return '平稳跟镜，跟随人物行动节奏向前移动'
    case '拉镜':
      return '中景拉镜，从人物身前缓缓拉开交代环境'
    case '移镜':
      return '平移镜头，沿人物行动方向横向移动'
    case '俯拍':
      return '轻微俯拍中景，呈现人物与环境的空间关系'
    case '仰拍':
      return '轻微仰拍近景，强化人物气场和压迫感'
    default:
      return `平视中景${cameraMove}，围绕画面内人物与场景关系自然展开`
  }
}

function formatFallbackSpeech(sourceText: unknown): string {
  const text = typeof sourceText === 'string' ? sourceText.trim() : ''
  if (!text) return ''

  const normalized = text.replace(/["“”]/g, '「')
  const looksLikeDialogue = /[：:]\s*「|[：:]\s*[^。！？!?]{1,40}[。！？!?]?/.test(text)
  if (looksLikeDialogue) {
    return `；【对话】角色声音自然清晰，语气贴合当前情绪，表情随剧情变化地说：「${normalized}」`
  }

  return `；【旁白】旁白声音自然清晰，语气贴合当前情绪，低声叙述：「${normalized}」`
}

function buildFallbackGroupVideoPrompt(panels: StoryboardPanel[], durationSec: number): string {
  const segmentDuration = durationSec / Math.max(1, panels.length)
  const music = selectFallbackMusic(panels[0]?.scene_type)
  const timeline = panels.map((panel, index) => {
    const start = Math.round(segmentDuration * index)
    const end = index === panels.length - 1 ? durationSec : Math.max(start + 1, Math.round(segmentDuration * (index + 1)))
    const mainMove = normalizeFallbackCameraMove(panel.camera_move)
    const cameraPhrase = buildNaturalFallbackCameraPhrase(mainMove)
    const actionText = panel.description || panel.source_text || '承接上一画面继续行动'
    const dialogueText = formatFallbackSpeech(panel.source_text)
    return `${formatTimecode(start)}-${formatTimecode(end)}：${cameraPhrase}，人物站位清晰，动作承接上一段，${actionText}；近景固定镜，聚焦关键道具、手部动作或环境细节，强化画面质感与剧情信息；表情特写，捕捉人物眼神、眉眼、嘴角和呼吸变化，神态自然连贯${dialogueText}；背景音中环境声与${music}同步铺开。`
  }).join('\n')

  return [
    `高清4K，电影级质感，画面稳定清晰，光影自然，人物建模精致，多人物同镜时年龄段、性别、服饰、发型、身形、气质和站位清晰区分，镜头中不要出现形象、相貌一样的人，动作流畅不僵硬，表情生动，无画面闪烁、无脸部崩坏、无肢体畸形，背景音乐为${music}，贯穿整段视频。`,
    timeline,
  ].join('\n')
}

function buildFallbackFrame(panel: StoryboardPanel, index: number, total: number, durationSec: number): JsonRecord {
  const frameTimeSec = total <= 1
    ? 0
    : Math.round((durationSec / Math.max(1, total - 1)) * index * 10) / 10
  const dependencyFrameIds = index === 0 ? [] : [index - 1]
  const baseImagePrompt = panel.image_prompt || panel.description || panel.source_text || ''
  const referencePolicy = index === 0
    ? { type: 'base', note: '本组开场原始状态' }
    : { type: 'depends_on_previous', note: '参考前一关键帧保持人物、服饰、场景、光线连贯' }
  return {
    frame_index: index,
    frame_time_sec: frameTimeSec,
    frame_role: index === 0 ? 'hero' : index === total - 1 ? 'ending' : 'continuity',
    dependency_frame_ids: dependencyFrameIds,
    image_prompt: ensureFramePromptReferenceIntro(String(baseImagePrompt), panel, dependencyFrameIds),
    video_prompt: panel.video_prompt || panel.description || panel.source_text || '',
    reference_policy: buildReferencePolicyWithOrderedReferences(referencePolicy, panel, dependencyFrameIds),
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
  const grouped: StoryboardPanel[] = []
  for (let index = 0; index < panels.length;) {
    const remaining = panels.length - index
    const densityWindow = panels.slice(index, index + Math.min(MAX_PANEL_FRAMES, remaining))
    const preferredFrameCount = getPreferredFrameCount(durationSec, densityWindow)
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

export async function createPanelFrames(
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
        description: cleanPanelDescriptionText(panel) || '',
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
        const panelVideoPrompt = cleanVideoPromptText(panel.video_prompt || null)
        const panelDescription = cleanPanelDescriptionText(panel)
        const created = await panelModel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: i,
            panelNumber: panel.panel_number || i + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panelDescription,
            videoPrompt: panelVideoPrompt,
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
        const panelVideoPrompt = cleanVideoPromptText(panel.video_prompt || null)
        const panelDescription = cleanPanelDescriptionText(panel)
        const created = await panelModel.create({
          data: {
            storyboardId: storyboard.id,
            panelIndex: i,
            panelNumber: panel.panel_number || i + 1,
            shotType: panel.shot_type || '中景',
            cameraMove: panel.camera_move || '固定',
            description: panelDescription,
            videoPrompt: panelVideoPrompt,
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
