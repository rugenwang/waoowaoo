import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMock = vi.hoisted(() => ({
  requireAgentRun: vi.fn(async () => ({
    userId: 'user-1',
    projectId: 'project-1',
    runId: 'run-1',
  })),
}))
const serviceMock = vi.hoisted(() => ({
  configuredUploadMaxBytes: vi.fn(() => 16),
  commitGeneratedImageUpload: vi.fn(),
}))

vi.mock('@/lib/agent-api/auth', () => authMock)
vi.mock('@/lib/agent-api/services/upload-service', () => serviceMock)

import { POST } from '@/app/api/agent/v1/runs/[runId]/uploads/route'

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024

function streamRequest(options: {
  chunks: Uint8Array[]
  contentLength?: string
}) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of options.chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const headers: Record<string, string> = {
    authorization: 'Bearer token',
    'x-waoo-user-id': 'user-1',
    'content-type': 'multipart/form-data; boundary=test',
  }
  if (options.contentLength !== undefined) {
    headers['content-length'] = options.contentLength
  }
  return new Request('http://localhost/api/agent/v1/runs/run-1/uploads', {
    method: 'POST',
    headers,
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

async function call(request: Request) {
  const response = await POST(request, {
    params: Promise.resolve({ runId: 'run-1' }),
  })
  return {
    response,
    payload: await response.json(),
  }
}

describe('bounded Agent upload multipart reader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an oversized Content-Length before reading or dispatching', async () => {
    const result = await call(streamRequest({
      chunks: [new Uint8Array([1])],
      contentLength: String(16 + MULTIPART_OVERHEAD_BYTES + 1),
    }))

    expect(result.response.status).toBe(413)
    expect(result.payload.error.code).toBe('UPLOAD_TOO_LARGE')
    expect(serviceMock.commitGeneratedImageUpload).not.toHaveBeenCalled()
  })

  it('bounds a chunked request with no Content-Length', async () => {
    const result = await call(streamRequest({
      chunks: [new Uint8Array(16 + MULTIPART_OVERHEAD_BYTES + 1)],
    }))

    expect(result.response.status).toBe(413)
    expect(result.payload.error.code).toBe('UPLOAD_TOO_LARGE')
    expect(serviceMock.commitGeneratedImageUpload).not.toHaveBeenCalled()
  })

  it('does not trust a forged smaller Content-Length', async () => {
    const result = await call(streamRequest({
      chunks: [
        new Uint8Array(512 * 1024),
        new Uint8Array(512 * 1024 + 17),
      ],
      contentLength: '1',
    }))

    expect(result.response.status).toBe(413)
    expect(result.payload.error.code).toBe('UPLOAD_TOO_LARGE')
    expect(serviceMock.commitGeneratedImageUpload).not.toHaveBeenCalled()
  })
})
