import http from 'node:http'

export async function startMockWaooServer(handler) {
  const requests = []
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const entry = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
      json: request.headers['content-type']?.startsWith('application/json') && body.length
        ? JSON.parse(body.toString('utf8'))
        : undefined,
    }
    requests.push(entry)
    try {
      const result = await handler(entry, requests.length)
      if (result?.destroy) {
        request.socket.destroy()
        return
      }
      response.writeHead(result?.status ?? 200, {
        'content-type': 'application/json',
        ...(result?.headers ?? {}),
      })
      response.end(JSON.stringify(result?.body ?? {
        success: true,
        requestId: `request-${requests.length}`,
        data: {},
      }))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: false,
        requestId: `request-${requests.length}`,
        error: { code: 'MOCK_ERROR', message: error.message, retryable: false },
      }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

