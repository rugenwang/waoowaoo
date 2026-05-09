import { beforeEach, describe, expect, it, vi } from 'vitest'

const getProviderConfigMock = vi.hoisted(() => vi.fn(async () => ({
  id: 'local',
  apiKey: 'local-key',
  baseUrl: 'http://127.0.0.1:7860',
})))

vi.mock('@/lib/api-config', () => ({
  getProviderConfig: getProviderConfigMock,
  getUserModels: vi.fn(),
}))

vi.mock('@/lib/async-submit', () => ({
  queryFalStatus: vi.fn(),
}))

vi.mock('@/lib/async-task-utils', () => ({
  queryGeminiBatchStatus: vi.fn(),
  queryGoogleVideoStatus: vi.fn(),
  querySeedanceVideoStatus: vi.fn(),
}))

import { pollAsyncTask } from '@/lib/async-poll'

const PROVIDER_TOKEN = Buffer.from('local', 'utf8').toString('base64url')

describe('async poll LOCAL task', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    getProviderConfigMock.mockResolvedValue({
      id: 'local',
      apiKey: 'local-key',
      baseUrl: 'http://127.0.0.1:7860',
    })
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
  })

  it('maps local completed video to authenticated content download url', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        task_id: 'vid_1',
        status: 'completed',
        result: {
          content_url: '/api/integrations/waoowaoo/v1/tasks/vid_1/content',
        },
      }),
    })

    const result = await pollAsyncTask(`LOCAL:VIDEO:${PROVIDER_TOKEN}:vid_1`, 'user-1')

    expect(getProviderConfigMock).toHaveBeenCalledWith('user-1', 'local')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:7860/api/integrations/waoowaoo/v1/tasks/vid_1',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer local-key' },
      },
    )
    expect(result).toEqual({
      status: 'completed',
      resultUrl: 'http://127.0.0.1:7860/api/integrations/waoowaoo/v1/tasks/vid_1/content',
      videoUrl: 'http://127.0.0.1:7860/api/integrations/waoowaoo/v1/tasks/vid_1/content',
      downloadHeaders: {
        Authorization: 'Bearer local-key',
      },
    })
  })

  it('accepts local succeeded status and top-level video_url aliases', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        task_id: 'vid_2',
        status: 'succeeded',
        video_url: '/outputs/vid_2.mp4',
      }),
    })

    const result = await pollAsyncTask(`LOCAL:VIDEO:${PROVIDER_TOKEN}:vid_2`, 'user-1')

    expect(result.status).toBe('completed')
    expect(result.videoUrl).toBe('http://127.0.0.1:7860/outputs/vid_2.mp4')
  })
})
