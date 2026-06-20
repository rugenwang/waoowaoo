import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const prismaMock = vi.hoisted(() => ({
  novelPromotionEpisode: {
    findUnique: vi.fn(),
  },
  novelPromotionProject: {
    findFirst: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: vi.fn(async () => ({ project: { name: '测试项目' } })),
  isErrorResponse: vi.fn(() => false),
}))

describe('video download manifest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('includes panel dubbing audio beside downloadable videos', async () => {
    prismaMock.novelPromotionEpisode.findUnique.mockResolvedValueOnce({
      clips: [{ id: 'clip-1' }],
      storyboards: [{
        id: 'storyboard-1',
        clipId: 'clip-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        panels: [{
          id: 'panel-1',
          panelIndex: 0,
          description: '开场镜头',
          videoUrl: 'video/panel-1.mp4',
          lipSyncVideoUrl: null,
          dubbingAudioUrl: 'voice/panel-1.wav',
        }],
      }],
    })

    const { POST } = await import('@/app/api/novel-promotion/[projectId]/video-urls/route')
    const request = new NextRequest('http://localhost/api/novel-promotion/project-1/video-urls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ episodeId: 'episode-1', panelPreferences: {} }),
    })
    const response = await POST(request, {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      videos: [{ index: 1, fileName: '001_开场镜头.mp4' }],
      audios: [{
        index: 1,
        fileName: 'audio/001_开场镜头_配音.wav',
        audioUrl: '/api/novel-promotion/project-1/panel-dubbing/audio?panelId=panel-1',
      }],
    })
  })
})
