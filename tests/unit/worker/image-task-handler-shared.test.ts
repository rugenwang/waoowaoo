import { describe, expect, it, vi } from 'vitest'

const utilsMock = vi.hoisted(() => ({
  assertTaskActive: vi.fn(async () => undefined),
  resolveImageSourceFromGeneration: vi.fn(),
  toSignedUrlIfCos: vi.fn((value: string | null | undefined) => value ? `signed:${value}` : null),
  uploadImageSourceToCos: vi.fn(),
  withLabelBar: vi.fn((prompt: string) => prompt),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    novelPromotionProject: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock('@/lib/workers/utils', () => utilsMock)

import { collectPanelReferenceImages } from '@/lib/workers/handlers/image-task-handler-shared'

describe('worker image-task-handler-shared collectPanelReferenceImages', () => {
  it('skips location asset when includeLocationReference is false but keeps sketch, character, and prop refs', async () => {
    const projectData = {
      characters: [
        {
          name: 'Hero',
          appearances: [
            {
              changeReason: 'default',
              imageUrls: JSON.stringify(['cos/hero-default.png']),
              imageUrl: 'cos/hero-default.png',
              selectedIndex: 0,
            },
          ],
        },
      ],
      locations: [
        {
          name: 'Old Town',
          images: [
            {
              isSelected: true,
              imageUrl: 'cos/old-town.png',
            },
          ],
        },
        {
          name: '咖啡杯',
          assetKind: 'prop',
          images: [
            {
              isSelected: true,
              imageUrl: 'cos/coffee-cup.png',
            },
          ],
        },
      ],
    }

    const panel = {
      sketchImageUrl: 'cos/sketch.png',
      location: 'Old Town',
      characters: JSON.stringify([{ name: 'Hero', appearance: 'default' }]),
      props: JSON.stringify([{ name: '咖啡杯' }]),
    }

    const refs = await collectPanelReferenceImages(projectData, panel, { includeLocationReference: false })

    expect(refs).toEqual([
      'signed:cos/sketch.png',
      'signed:cos/hero-default.png',
      'signed:cos/coffee-cup.png',
    ])
    expect(refs).not.toContain('signed:cos/old-town.png')
  })
})
