import type { Job } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'
import type { TaskJobData } from '@/lib/task/types'

const publisherMock = vi.hoisted(() => ({
  publishTaskStreamEvent: vi.fn(async () => undefined),
}))

const generatorApiMock = vi.hoisted(() => ({
  generateImage: vi.fn(async () => ({
    success: true,
    imageUrl: 'https://example.com/out.png',
  })),
  generateVideo: vi.fn(),
}))

const configServiceMock = vi.hoisted(() => ({
  resolveProjectModelCapabilityGenerationOptions: vi.fn(async () => ({})),
  getProjectModelConfig: vi.fn(),
  getUserModelConfig: vi.fn(),
}))

const prismaMock = vi.hoisted(() => ({
  prisma: {
    task: {
      findUnique: vi.fn(async () => ({ externalId: null })),
    },
  },
}))

const modelContractMock = vi.hoisted(() => ({
  parseModelKeyStrict: vi.fn(() => ({
    provider: 'local',
    modelId: 'ltx-2-mlx',
    modelKey: 'local:ltx-2-mlx',
  })),
}))

vi.mock('@/lib/task/publisher', () => publisherMock)
vi.mock('@/lib/generator-api', () => generatorApiMock)
vi.mock('@/lib/config-service', () => configServiceMock)
vi.mock('@/lib/prisma', () => prismaMock)
vi.mock('@/lib/model-config-contract', () => modelContractMock)

describe('worker utils task stream', () => {
  it('emits task stream events for image generation request', async () => {
    const { resolveImageSourceFromGeneration } = await import('@/lib/workers/utils')

    const job = {
      data: {
        taskId: 'task-1',
        type: 'image_panel',
        projectId: 'project-1',
        userId: 'user-1',
        locale: 'zh',
        targetType: 'NovelPromotionPanel',
        targetId: 'panel-1',
        episodeId: null,
        payload: {},
      } satisfies TaskJobData,
    } as unknown as Job<TaskJobData>

    const url = await resolveImageSourceFromGeneration(job, {
      userId: 'user-1',
      modelId: 'local:ltx-2-mlx',
      prompt: 'hello',
      options: {},
      allowTaskExternalIdResume: false,
    })

    expect(url).toBe('https://example.com/out.png')
    expect(publisherMock.publishTaskStreamEvent).toHaveBeenCalled()
    expect(publisherMock.publishTaskStreamEvent).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      payload: expect.objectContaining({
        kind: 'generator_request',
        mediaType: 'image',
      }),
    }))
  })
})
