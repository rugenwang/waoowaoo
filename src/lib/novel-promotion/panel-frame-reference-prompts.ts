import { prisma } from '@/lib/prisma'
import {
  parsePanelFrameDependencyPlan,
  serializePanelFrameDependencyPlan,
} from './panel-tail-reference'

const FP_LABEL = '上一个连续分镜的尾帧 FP，作为当前分镜的参考图'

type NameRef = {
  name?: unknown
  label?: unknown
  title?: unknown
  appearance?: unknown
  changeReason?: unknown
  variant?: unknown
}

function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value?.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readRefName(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as NameRef
  for (const key of ['name', 'label', 'title'] as const) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

function readRefAppearance(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as NameRef
  for (const key of ['appearance', 'changeReason', 'variant'] as const) {
    const raw = record[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return null
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const label of labels) {
    const clean = label.trim()
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
  }
  return result
}

export function extractPanelFramePromptBody(prompt: string | null | undefined): string {
  const clean = typeof prompt === 'string' ? prompt.trim() : ''
  if (!clean) return ''

  const zhMarker = '；当前画面：'
  const zhIndex = clean.lastIndexOf(zhMarker)
  if (zhIndex >= 0) return clean.slice(zhIndex + zhMarker.length).trim()

  const enMarker = '; current still image:'
  const enIndex = clean.toLowerCase().lastIndexOf(enMarker)
  if (enIndex >= 0) return clean.slice(enIndex + enMarker.length).trim()

  return clean
    .replace(/^参考图F\d+[^；;]*[；;]\s*/u, '')
    .replace(/^无额外输入参考图[；;]\s*/u, '')
    .replace(/^当前画面[：:]\s*/u, '')
    .trim()
}

function parseReferencePolicy(value: string | null | undefined): Record<string, unknown> {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { legacy_policy_value: parsed }
  } catch {
    return { legacy_policy_text: value }
  }
}

function buildReferenceLabels(params: {
  location: string | null
  characters: string | null
  props: string | null
  dependencyFrameIndexes: number[]
  usesPreviousTail: boolean
}) {
  const labels: string[] = []
  if (params.usesPreviousTail) labels.push(FP_LABEL)
  for (const index of params.dependencyFrameIndexes) {
    labels.push(`分镜组第 ${index + 1} 关键帧`)
  }
  const hasContinuityReference = params.usesPreviousTail || params.dependencyFrameIndexes.length > 0
  if (!hasContinuityReference && params.location?.trim()) {
    labels.push(`当前分镜场景图：${params.location.trim()}`)
  }

  for (const character of parseJsonArray(params.characters)) {
    const name = readRefName(character)
    if (!name) continue
    const appearance = readRefAppearance(character)
    labels.push(appearance ? `角色图：${name} · ${appearance}` : `角色图：${name}`)
  }

  for (const prop of parseJsonArray(params.props)) {
    const name = readRefName(prop)
    if (name) labels.push(`道具图：${name}`)
  }

  return uniqueLabels(labels)
}

function buildImagePrompt(prompt: string | null): string | null {
  const body = extractPanelFramePromptBody(prompt)
  return body || null
}

export async function rebuildPanelFrameReferencePrompts(panelId: string) {
  const panel = await prisma.novelPromotionPanel.findUnique({
    where: { id: panelId },
    include: {
      frames: { orderBy: { frameIndex: 'asc' } },
    },
  })
  if (!panel) return { updated: 0, scanned: 0 }

  let updated = 0
  for (const frame of panel.frames) {
    const plan = parsePanelFrameDependencyPlan(frame.dependencyFrameIds)
    const usesPreviousTail = panel.usePreviousPanelTailAsReference && frame.frameIndex === 0
    const nextDependencyFrameIds = serializePanelFrameDependencyPlan({
      previousTail: usesPreviousTail,
      frameIndexes: plan.frameIndexes,
    })
    const labels = buildReferenceLabels({
      location: panel.location,
      characters: panel.characters,
      props: panel.props,
      dependencyFrameIndexes: plan.frameIndexes,
      usesPreviousTail,
    })
    const nextImagePrompt = buildImagePrompt(frame.imagePrompt)
    const nextReferencePolicy = JSON.stringify({
      ...parseReferencePolicy(frame.referencePolicy),
      ordered_references: labels,
    })

    const shouldUpdate =
      nextDependencyFrameIds !== frame.dependencyFrameIds
      || nextImagePrompt !== frame.imagePrompt
      || nextReferencePolicy !== frame.referencePolicy
    if (!shouldUpdate) continue

    await prisma.novelPromotionPanelFrame.update({
      where: { id: frame.id },
      data: {
        dependencyFrameIds: nextDependencyFrameIds,
        imagePrompt: nextImagePrompt,
        referencePolicy: nextReferencePolicy,
      },
    })
    updated += 1
  }

  return { updated, scanned: panel.frames.length }
}
