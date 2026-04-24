import { NextRequest } from 'next/server'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { getProviderConfig } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const GET = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const { taskId } = await context.params

  const { baseUrl, apiKey } = await getProviderConfig(session.user.id, 'local')
  if (!baseUrl) throw new ApiError('INVALID_PARAMS', { message: 'local.baseUrl is required' })
  if (!apiKey) throw new ApiError('INVALID_PARAMS', { message: 'local.apiKey is required' })

  const abort = request.signal
  const base = normalizeBaseUrl(baseUrl)

  let lastLines: string[] = []
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(encodeSseEvent(event, data)))

      send('hello', { taskId })

      while (!abort.aborted) {
        try {
          // status
          const statusRes = await fetch(`${base}/api/integrations/waoowaoo/v1/tasks/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
            cache: 'no-store',
          })
          if (statusRes.ok) {
            const statusText = await statusRes.text().catch(() => '')
            const statusJson = safeJsonParse(statusText)
            if (statusJson) send('status', statusJson)
          } else {
            const text = await statusRes.text().catch(() => '')
            send('error', { message: `status ${statusRes.status}: ${text.slice(0, 200)}` })
          }

          // logs
          const logsRes = await fetch(
            `${base}/api/integrations/waoowaoo/v1/tasks/${encodeURIComponent(taskId)}/logs?tail=200`,
            {
              method: 'GET',
              headers: { Authorization: `Bearer ${apiKey}` },
              cache: 'no-store',
            },
          )
          if (logsRes.ok) {
            const logsText = await logsRes.text().catch(() => '')
            const logsJson = safeJsonParse(logsText)
            const rawLines = isRecord(logsJson) && Array.isArray(logsJson.lines) ? logsJson.lines : []
            const lines = rawLines.filter((x): x is string => typeof x === 'string')

            // diff append
            let startIdx = 0
            if (lastLines.length > 0) {
              // 找到 lastLines 在新 lines 中的最后匹配位置（简单策略）
              const lastTail = lastLines.slice(-20).join('\n')
              const newJoined = lines.join('\n')
              const pos = lastTail ? newJoined.lastIndexOf(lastTail) : -1
              if (pos >= 0) {
                // 计算匹配尾部的行数
                const prefix = newJoined.slice(0, pos + lastTail.length)
                startIdx = prefix.split('\n').length
              } else {
                // 发生截断或重启：直接全量发送一次（但限制长度）
                startIdx = Math.max(0, lines.length - 200)
              }
            }

            const appended = lines.slice(startIdx)
            for (const line of appended) {
              send('log', line)
            }
            lastLines = lines
          } else {
            const text = await logsRes.text().catch(() => '')
            send('error', { message: `logs ${logsRes.status}: ${text.slice(0, 200)}` })
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e)
          send('error', { message })
        }

        await new Promise((r) => setTimeout(r, 1000))
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  })
})
