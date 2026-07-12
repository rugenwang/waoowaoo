import { prisma } from '@/lib/prisma'
import { resolvePreviousPanelTailImageUrl } from './panel-tail-reference'

interface PreviousTailPanel {
  id: string
  panelIndex: number
  panelMode: string | null
  location: string | null
  imageUrl: string | null
  imageMedia: {
    storageKey: string | null
  } | null
  storyboard: {
    id: string
    clip: {
      id: string
      createdAt: Date
    }
  }
  frames: Array<{
    frameIndex: number
    imageUrl: string | null
    imageMedia: {
      storageKey: string | null
    } | null
  }>
}

function comparePanelsByEpisodeOrder(left: PreviousTailPanel, right: PreviousTailPanel): number {
  const leftClipTime = left.storyboard.clip.createdAt.getTime()
  const rightClipTime = right.storyboard.clip.createdAt.getTime()
  if (leftClipTime !== rightClipTime) return leftClipTime - rightClipTime

  const clipOrder = left.storyboard.clip.id.localeCompare(right.storyboard.clip.id)
  if (clipOrder !== 0) return clipOrder

  if (left.panelIndex !== right.panelIndex) return left.panelIndex - right.panelIndex
  return left.id.localeCompare(right.id)
}

export async function loadPreviousPanelTailImageUrl(params: {
  storyboardId: string
  panelIndex: number
}): Promise<string | null> {
  const result = await loadPreviousPanelTailImageInfo(params)
  return result.imageUrl
}

export async function loadPreviousPanelTailImageInfo(params: {
  storyboardId: string
  panelIndex: number
}): Promise<{
  imageUrl: string | null
  previousPanelId: string | null
  previousPanelExists: boolean
  previousPanelLocation: string | null
}> {
  const currentPanel = await prisma.novelPromotionPanel.findFirst({
    where: {
      storyboardId: params.storyboardId,
      panelIndex: params.panelIndex,
    },
    select: {
      id: true,
      storyboard: {
        select: {
          episodeId: true,
        },
      },
    },
  })
  const episodeId = currentPanel?.storyboard.episodeId
  if (!currentPanel || !episodeId) {
    return {
      imageUrl: null,
      previousPanelId: null,
      previousPanelExists: false,
      previousPanelLocation: null,
    }
  }

  const panels = await prisma.novelPromotionPanel.findMany({
    where: {
      storyboard: {
        episodeId,
      },
    },
    select: {
      id: true,
      panelIndex: true,
      panelMode: true,
      location: true,
      imageUrl: true,
      imageMedia: {
        select: {
          storageKey: true,
        },
      },
      storyboard: {
        select: {
          id: true,
          clip: {
            select: {
              id: true,
              createdAt: true,
            },
          },
        },
      },
      frames: {
        orderBy: { frameIndex: 'asc' },
        select: {
          frameIndex: true,
          imageUrl: true,
          imageMedia: {
            select: {
              storageKey: true,
            },
          },
        },
      },
    },
  })

  const orderedPanels = panels.sort(comparePanelsByEpisodeOrder)
  const currentIndex = orderedPanels.findIndex((panel) => panel.id === currentPanel.id)
  if (currentIndex <= 0) {
    return {
      imageUrl: null,
      previousPanelId: null,
      previousPanelExists: false,
      previousPanelLocation: null,
    }
  }

  const previousPanel = orderedPanels[currentIndex - 1]
  return {
    imageUrl: resolvePreviousPanelTailImageUrl(previousPanel),
    previousPanelId: previousPanel.id,
    previousPanelExists: true,
    previousPanelLocation: previousPanel.location,
  }
}
