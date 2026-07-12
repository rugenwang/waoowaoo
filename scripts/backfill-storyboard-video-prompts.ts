import { config } from 'dotenv'
config()

import { prisma } from '@/lib/prisma'
import { normalizeStoryboardVideoPrompts } from '@/lib/novel-promotion/storyboard-video-prompt-normalizer'
import type { StoryboardPanel } from '@/lib/storyboard-phases'

const DEFAULT_PROJECT_NAME = '她挖我仙骨那夜，我成了三界禁忌'
const DEFAULT_EPISODE_NAME = '仙骨不是机缘，是锁链'

function parseArgs() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const projectNameArg = args.find((arg) => arg.startsWith('--project-name='))
  const episodeNameArg = args.find((arg) => arg.startsWith('--episode-name='))
  const episodeIdArg = args.find((arg) => arg.startsWith('--episode-id='))
  const allEpisodes = args.includes('--all-episodes')

  return {
    apply,
    allEpisodes,
    episodeId: episodeIdArg ? episodeIdArg.slice('--episode-id='.length).trim() : '',
    episodeName: episodeNameArg
      ? episodeNameArg.slice('--episode-name='.length).trim()
      : DEFAULT_EPISODE_NAME,
    projectName: projectNameArg
      ? projectNameArg.slice('--project-name='.length).trim()
      : DEFAULT_PROJECT_NAME,
  }
}

function isChanged(next: string | null | undefined, previous: string | null | undefined): boolean {
  return (next || '').trim() !== (previous || '').trim()
}

function toPanelInput(panel: {
  panelNumber: number | null
  panelIndex: number
  characters: string | null
  videoPrompt: string | null
  groupVideoPrompt: string | null
  frames: Array<{
    frameIndex: number
    videoPrompt: string | null
  }>
}): StoryboardPanel {
  let characters: unknown = []
  if (panel.characters?.trim()) {
    try {
      const parsed = JSON.parse(panel.characters)
      characters = Array.isArray(parsed) ? parsed : []
    } catch {
      characters = []
    }
  }

  return {
    panel_number: panel.panelNumber || panel.panelIndex + 1,
    characters,
    videoPrompt: panel.videoPrompt || undefined,
    groupVideoPrompt: panel.groupVideoPrompt || undefined,
    frames: panel.frames.map((frame) => ({
      frame_index: frame.frameIndex,
      videoPrompt: frame.videoPrompt || undefined,
    })),
  }
}

async function main() {
  const { apply, allEpisodes, episodeId, episodeName, projectName } = parseArgs()

  const projects = await prisma.project.findMany({
    where: {
      name: { contains: projectName },
      novelPromotionData: { isNot: null },
    },
    select: {
      id: true,
      name: true,
      novelPromotionData: {
        select: {
          id: true,
          characters: {
            select: { name: true },
          },
        },
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

  const episodes = await prisma.novelPromotionEpisode.findMany({
    where: {
      novelPromotionProjectId,
      ...(allEpisodes
        ? {}
        : episodeId
          ? { id: episodeId }
          : { name: { contains: episodeName } }),
    },
    orderBy: { episodeNumber: 'asc' },
    select: {
      id: true,
      episodeNumber: true,
      name: true,
      storyboards: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          clipId: true,
          panels: {
            orderBy: { panelIndex: 'asc' },
            select: {
              id: true,
              panelIndex: true,
              panelNumber: true,
              characters: true,
              videoPrompt: true,
              groupVideoPrompt: true,
              frames: {
                orderBy: { frameIndex: 'asc' },
                select: {
                  id: true,
                  frameIndex: true,
                  videoPrompt: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (episodes.length === 0) {
    throw new Error(`未找到剧集：${episodeId || episodeName}`)
  }
  if (!allEpisodes && !episodeId && episodes.length > 1) {
    console.log('找到多个匹配剧集，请用 --episode-name 或 --episode-id 精确一点：')
    for (const episode of episodes) {
      console.log(`- E${episode.episodeNumber} ${episode.name} (${episode.id})`)
    }
    process.exit(1)
  }

  const characters = project.novelPromotionData?.characters || []
  let scannedPanels = 0
  let scannedFrames = 0
  let changedPanels = 0
  let changedFrames = 0
  const samples: string[] = []

  for (const episode of episodes) {
    for (const storyboard of episode.storyboards) {
      for (const panel of storyboard.panels) {
        scannedPanels += 1
        scannedFrames += panel.frames.length
        const normalized = normalizeStoryboardVideoPrompts([toPanelInput(panel)], characters)[0]
        const nextVideoPrompt = typeof normalized.videoPrompt === 'string' ? normalized.videoPrompt : null
        const nextGroupVideoPrompt = typeof normalized.groupVideoPrompt === 'string' ? normalized.groupVideoPrompt : null
        const panelChanged = isChanged(nextVideoPrompt, panel.videoPrompt)
          || isChanged(nextGroupVideoPrompt, panel.groupVideoPrompt)

        if (panelChanged) {
          changedPanels += 1
          if (samples.length < 10) {
            samples.push(`E${episode.episodeNumber} ${episode.name} / 分镜${panel.panelNumber || panel.panelIndex + 1} / panel=${panel.id}`)
          }
          if (apply) {
            await prisma.novelPromotionPanel.update({
              where: { id: panel.id },
              data: {
                videoPrompt: nextVideoPrompt,
                groupVideoPrompt: nextGroupVideoPrompt,
              },
            })
          }
        }

        const normalizedFrames = Array.isArray(normalized.frames) ? normalized.frames : []
        for (const frame of panel.frames) {
          const normalizedFrame = normalizedFrames.find((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false
            return (item as { frame_index?: unknown }).frame_index === frame.frameIndex
          }) as { videoPrompt?: unknown } | undefined
          const nextFrameVideoPrompt = typeof normalizedFrame?.videoPrompt === 'string'
            ? normalizedFrame.videoPrompt
            : null
          if (!isChanged(nextFrameVideoPrompt, frame.videoPrompt)) continue

          changedFrames += 1
          if (samples.length < 10) {
            samples.push(`E${episode.episodeNumber} ${episode.name} / 分镜${panel.panelNumber || panel.panelIndex + 1} / F${frame.frameIndex + 1} / frame=${frame.id}`)
          }
          if (apply) {
            await prisma.novelPromotionPanelFrame.update({
              where: { id: frame.id },
              data: { videoPrompt: nextFrameVideoPrompt },
            })
          }
        }
      }
    }
  }

  console.log(`项目：${project.name} (${project.id})`)
  console.log(`剧集：${allEpisodes ? '全部剧集' : episodes.map((episode) => `E${episode.episodeNumber} ${episode.name}`).join('、')}`)
  console.log(`模式：${apply ? 'APPLY 已写库' : 'DRY-RUN 未写库'}`)
  console.log(`扫描分镜：${scannedPanels}`)
  console.log(`扫描关键帧：${scannedFrames}`)
  console.log(`需要修正分镜提示词：${changedPanels}`)
  console.log(`需要修正关键帧视频提示词：${changedFrames}`)
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
