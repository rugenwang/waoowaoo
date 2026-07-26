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

export function parseMultipartRequest(request) {
  const contentType = request.headers['content-type'] ?? ''
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1]?.replace(/^"|"$/g, '')
  if (!boundary) throw new Error('multipart boundary is missing')
  const separator = Buffer.from(`--${boundary}`)
  const fields = {}
  let file
  let cursor = 0
  while (cursor < request.body.length) {
    const start = request.body.indexOf(separator, cursor)
    if (start < 0) break
    const headerStart = start + separator.length + 2
    const headerEnd = request.body.indexOf(Buffer.from('\r\n\r\n'), headerStart)
    if (headerEnd < 0) break
    const headers = request.body.subarray(headerStart, headerEnd).toString('utf8')
    const next = request.body.indexOf(separator, headerEnd + 4)
    if (next < 0) break
    const content = request.body.subarray(headerEnd + 4, next - 2)
    const name = /name="([^"]+)"/i.exec(headers)?.[1]
    const filename = /filename="([^"]+)"/i.exec(headers)?.[1]
    if (name && filename) file = { name, filename, bytes: content, headers }
    else if (name) fields[name] = content.toString('utf8')
    cursor = next
  }
  return { fields, file }
}
