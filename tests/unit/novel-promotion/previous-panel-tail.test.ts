import { describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { loadPreviousPanelTailImageUrl } from '@/lib/novel-promotion/previous-panel-tail'

describe('previous panel tail lookup', () => {
  it('resolves the previous panel tail by episode global clip order across storyboards', async () => {
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce({
      id: 'panel-current',
      storyboard: { episodeId: 'episode-1' },
    })
    prismaMock.novelPromotionPanel.findMany.mockResolvedValueOnce([
      {
        id: 'panel-current',
        panelIndex: 0,
        panelMode: 'single',
        imageUrl: 'cos/current.png',
        storyboard: {
          id: 'storyboard-current',
          clip: { id: 'clip-2', createdAt: new Date('2026-01-01T00:01:00Z') },
        },
        frames: [],
      },
      {
        id: 'panel-prev',
        panelIndex: 1,
        panelMode: 'group',
        imageUrl: 'cos/prev-cover.png',
        storyboard: {
          id: 'storyboard-prev',
          clip: { id: 'clip-1', createdAt: new Date('2026-01-01T00:00:00Z') },
        },
        frames: [
          { frameIndex: 0, imageUrl: 'cos/prev-f1.png' },
          { frameIndex: 1, imageUrl: 'cos/prev-tail.png' },
        ],
      },
    ])

    await expect(loadPreviousPanelTailImageUrl({
      storyboardId: 'storyboard-current',
      panelIndex: 0,
    })).resolves.toBe('cos/prev-tail.png')
  })
})
