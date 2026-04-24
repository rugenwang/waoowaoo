import { describe, expect, it, vi } from 'vitest'
import { LocalImageGenerator } from '@/lib/generators/local'

const apiConfigMock = vi.hoisted(() => ({
  getProviderConfig: vi.fn(async () => ({
    baseUrl: 'http://127.0.0.1:5566',
    apiKey: 'token-1',
  })),
}))

const outboundImageMock = vi.hoisted(() => ({
  normalizeReferenceImagesForGeneration: vi.fn(async () => ['data:image/png;base64,AAAA']),
}))

vi.mock('@/lib/api-config', () => apiConfigMock)
vi.mock('@/lib/media/outbound-image', () => outboundImageMock)

describe('LocalImageGenerator request contract', () => {
  it('forces random_seed=true when calling ltx image integration API', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(body) as Record<string, unknown>

      expect(parsed.random_seed).toBe(true)
      // 应该不再传入固定 seed（由后端随机生成）
      expect('seed' in parsed).toBe(false)

      return new Response(JSON.stringify({ task_id: 'img_test_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    vi.stubGlobal('fetch', fetchMock)

    const gen = new LocalImageGenerator(undefined, 'local')
    const result = await gen.generate({
      userId: 'user-1',
      prompt: 'a test prompt',
      referenceImages: ['https://example.com/a.png'],
      options: {
        // 即使用户显式传 seed，也应被忽略（random_seed 固定 true）
        seed: 123,
      },
    })

    expect(result.success).toBe(true)
    expect(result.async).toBe(true)
    expect(typeof result.externalId).toBe('string')
  })
})

