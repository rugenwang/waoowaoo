import { config } from 'dotenv'
config()

import { prisma } from '@/lib/prisma'

const DEFAULT_PROJECT_NAME = '她挖我仙骨那夜，我成了三界禁忌'
const FP_LABEL = '上一个连续分镜的尾帧 FP，作为当前分镜的参考图'

type ReferencePolicy = Record<string, unknown>
type NameRef = {
  name?: unknown
  label?: unknown
  title?: unknown
  appearance?: unknown
  changeReason?: unknown
  variant?: unknown
}

function parseArgs() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const projectNameArg = args.find((arg) => arg.startsWith('--project-name='))
  const projectName = projectNameArg
    ? projectNameArg.slice('--project-name='.length).trim()
    : DEFAULT_PROJECT_NAME

  return { apply, projectName }
}

function hasPreviousTailText(value: string | null | undefined): boolean {
  return Boolean(value && /(?:上一(?:个)?(?:连续)?分镜(?:的)?尾帧|上一尾帧|previous\s+panel\s+tail|FP)/i.test(value))
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

function parseDependencyItems(value: string | null | undefined): Array<string | number> {
  const raw = parseJsonArray(value)
  return raw
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

function buildCanonicalLabels(params: {
  location: string | null
  characters: string | null
  props: string | null
  dependencyFrameIds: string | null
  frameIndex: number
  usePreviousPanelTailAsReference: boolean
}): string[] {
  const dependencyItems = parseDependencyItems(params.dependencyFrameIds)
  const dependencies = params.usePreviousPanelTailAsReference && params.frameIndex === 0
    ? ['FP', ...dependencyItems.filter((item) => !(typeof item === 'string' && item.toUpperCase() === 'FP'))]
    : dependencyItems
  const labels: string[] = []

  for (const item of dependencies) {
    if (typeof item === 'string' && item.toUpperCase() === 'FP') {
      labels.push(FP_LABEL)
    } else if (typeof item === 'number') {
      labels.push(`分镜组第 ${item + 1} 关键帧`)
    }
  }

  if (dependencies.length === 0 && params.location?.trim()) {
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

function splitPromptBody(prompt: string | null | undefined): string {
  const clean = typeof prompt === 'string' ? prompt.trim() : ''
  if (!clean) return ''

  const zhMarker = '；当前画面：'
  const zhIndex = clean.lastIndexOf(zhMarker)
  if (zhIndex >= 0) return clean.slice(zhIndex + zhMarker.length).trim()

  const enMarker = '; current still image:'
  const enIndex = clean.toLowerCase().lastIndexOf(enMarker)
  if (enIndex >= 0) return clean.slice(enIndex + enMarker.length).trim()

  return clean
}

function extractReferenceLabels(prompt: string | null | undefined): string[] {
  const clean = typeof prompt === 'string' ? prompt.trim() : ''
  if (!clean) return []
  const markerIndex = clean.indexOf('；当前画面：')
  const intro = markerIndex >= 0 ? clean.slice(0, markerIndex) : clean
  const labels: string[] = []
  const pattern = /参考图F\d+为([^，；;]+)/g
  let match: RegExpExecArray | null = null
  while ((match = pattern.exec(intro))) {
    const label = match[1]?.trim()
    if (label) labels.push(label)
  }
  return labels
}

function parseReferencePolicy(value: string | null | undefined): ReferencePolicy {
  if (!value?.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ReferencePolicy
    }
    return { legacy_policy_value: parsed }
  } catch {
    return { legacy_policy_text: value }
  }
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const label of labels) {
    const clean = label.trim()
    if (!clean) continue
    const key = clean === FP_LABEL || hasPreviousTailText(clean) ? 'FP' : clean
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key === 'FP' ? FP_LABEL : clean)
  }
  return result
}

function buildNextPrompt(prompt: string | null | undefined): string {
  const body = splitPromptBody(prompt)
  return body
}

function buildNextReferencePolicy(referencePolicy: string | null | undefined, prompt: string | null | undefined, labels: string[]): string {
  const parsed = parseReferencePolicy(referencePolicy)
  const existing = Array.isArray(parsed.ordered_references)
    ? parsed.ordered_references.map((item) => String(item))
    : extractReferenceLabels(prompt)
  const orderedReferences = labels.length > 0 ? labels : uniqueLabels(existing)
  return JSON.stringify({
    ...parsed,
    ordered_references: orderedReferences,
  })
}

async function main() {
  const { apply, projectName } = parseArgs()

  const projects = await prisma.project.findMany({
    where: {
      name: { contains: projectName },
      novelPromotionData: { isNot: null },
    },
    select: {
      id: true,
      name: true,
      novelPromotionData: {
        select: { id: true },
      },
    },
  })

  if (projects.length === 0) {
    throw new Error(`未找到项目：${projectName}`)
  }
  if (projects.length > 1) {
    console.log('找到多个匹配项目，请用 --project-name 精确一点：')
    for (const project of projects) {
      console.log(`- ${project.name} (${project.id})`)
    }
    process.exit(1)
  }

  const project = projects[0]
  const novelPromotionProjectId = project.novelPromotionData?.id
  if (!novelPromotionProjectId) throw new Error(`项目缺少 novelPromotionData：${project.name}`)

  const panels = await prisma.novelPromotionPanel.findMany({
    where: {
      storyboard: {
        episode: {
          novelPromotionProjectId,
        },
      },
    },
    select: {
      id: true,
      panelIndex: true,
      panelNumber: true,
      location: true,
      characters: true,
      props: true,
      usePreviousPanelTailAsReference: true,
      frames: {
        orderBy: { frameIndex: 'asc' },
        select: {
          id: true,
          frameIndex: true,
          dependencyFrameIds: true,
          imagePrompt: true,
          referencePolicy: true,
        },
      },
      storyboard: {
        select: {
          episode: {
            select: {
              episodeNumber: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: [
      { storyboard: { episode: { episodeNumber: 'asc' } } },
      { panelIndex: 'asc' },
    ],
  })

  let changed = 0
  let alreadyOk = 0
  let skippedNoFrame = 0
  let scannedFrames = 0
  const samples: Array<string> = []

  for (const panel of panels) {
    if (panel.frames.length === 0) {
      skippedNoFrame += 1
      continue
    }

    for (const frame of panel.frames) {
      scannedFrames += 1
      const labels = buildCanonicalLabels({
        location: panel.location,
        characters: panel.characters,
        props: panel.props,
        dependencyFrameIds: frame.dependencyFrameIds,
        frameIndex: frame.frameIndex,
        usePreviousPanelTailAsReference: panel.usePreviousPanelTailAsReference,
      })
      const nextPrompt = buildNextPrompt(frame.imagePrompt)
      const nextReferencePolicy = buildNextReferencePolicy(frame.referencePolicy, frame.imagePrompt, labels)
      const promptChanged = nextPrompt !== (frame.imagePrompt ?? '').trim()
      const policyChanged = nextReferencePolicy !== (frame.referencePolicy ?? '').trim()

      if (!promptChanged && !policyChanged) {
        alreadyOk += 1
        continue
      }

      changed += 1
      if (samples.length < 8) {
        samples.push(
          `E${panel.storyboard.episode.episodeNumber} ${panel.storyboard.episode.name} / 分镜${panel.panelNumber ?? panel.panelIndex + 1} / F${frame.frameIndex + 1} / ${panel.location ?? '无场景'} / frame=${frame.id}`,
        )
      }

      if (apply) {
        await prisma.novelPromotionPanelFrame.update({
          where: { id: frame.id },
          data: {
            imagePrompt: nextPrompt,
            referencePolicy: nextReferencePolicy,
          },
        })
      }
    }
  }

  console.log(`项目：${project.name} (${project.id})`)
  console.log(`模式：${apply ? 'APPLY 已写库' : 'DRY-RUN 未写库'}`)
  console.log(`扫描大分镜：${panels.length}`)
  console.log(`扫描关键帧：${scannedFrames}`)
  console.log(`需要清理关键帧提示词/引用策略：${changed}`)
  console.log(`已是最新格式：${alreadyOk}`)
  console.log(`缺少关键帧记录跳过：${skippedNoFrame}`)
  if (samples.length) {
    console.log('样例：')
    for (const sample of samples) console.log(`- ${sample}`)
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
