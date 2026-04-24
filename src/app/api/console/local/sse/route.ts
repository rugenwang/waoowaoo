import { NextRequest } from 'next/server'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { isErrorResponse, requireUserAuth } from '@/lib/api-auth'
import { getProviderConfig } from '@/lib/api-config'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

type LocalTask = {
  task_id?: string
  task_type?: string
  status?: string
  progress?: number
  message?: string
  output_path?: string
  created_at?: number
  updated_at?: number
}

export const GET = apiHandler(async (request: NextRequest) => {
  const authResult = await requireUserAuth()
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const { baseUrl, apiKey } = await getProviderConfig(session.user.id, 'local')
  if (!baseUrl) throw new ApiError('INVALID_PARAMS', { message: 'local.baseUrl is required' })
  if (!apiKey) throw new ApiError('INVALID_PARAMS', { message: 'local.apiKey is required' })

  const abort = request.signal
  const encoder = new TextEncoder()
  const base = normalizeBaseUrl(baseUrl)

  // 记录每个 task 的“已见过的最后 tail 行”，用于 diff（本地 API 目前不支持 offset）
  const lastTailByTask = new Map<string, string[]>()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)))

      send('hello', { ok: true })

      while (!abort.aborted) {
        try {
          // list tasks
          const listRes = await fetch(`${base}/api/integrations/waoowaoo/v1/tasks?limit=50`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
            cache: 'no-store',
          })
          const listText = await listRes.text().catch(() => '')
          if (!listRes.ok) {
            send('error', { message: `list tasks failed: ${listRes.status} ${listText.slice(0, 200)}` })
            await new Promise((r) => setTimeout(r, 1000))
            continue
          }
          const listJson = safeJsonParse(listText)
          const rawItems = isRecord(listJson) && Array.isArray(listJson.items) ? listJson.items : []
          const items: LocalTask[] = rawItems.map((raw) => {
            if (!isRecord(raw)) return {}
            return {
              task_id: toStringOrUndefined(raw.task_id),
              task_type: toStringOrUndefined(raw.task_type),
              status: toStringOrUndefined(raw.status),
              progress: toNumberOrUndefined(raw.progress),
              message: toStringOrUndefined(raw.message),
              output_path: toStringOrUndefined(raw.output_path),
              created_at: toNumberOrUndefined(raw.created_at),
              updated_at: toNumberOrUndefined(raw.updated_at),
            }
          })

          // status summary（直观）
          const running = items.filter((t) => (t.status || '') !== 'completed' && (t.status || '') !== 'failed')
          send('status', {
            ts: new Date().toISOString(),
            total: items.length,
            active: running.length,
            newest: items.slice(0, 10).map((t) => ({
              task_id: t.task_id,
              task_type: t.task_type,
              status: t.status,
              progress: t.progress,
              message: t.message,
            })),
          })

          // logs（按 task 拉取 tail 并 diff）
          for (const t of items) {
            const taskId = typeof t.task_id === 'string' ? t.task_id : ''
            if (!taskId) continue

            const logsRes = await fetch(`${base}/api/integrations/waoowaoo/v1/tasks/${encodeURIComponent(taskId)}/logs?tail=200`, {
              method: 'GET',
              headers: { Authorization: `Bearer ${apiKey}` },
              cache: 'no-store',
            })
            const logsText = await logsRes.text().catch(() => '')
            if (!logsRes.ok) {
              continue
            }
            const logsJson = safeJsonParse(logsText)
            const rawLines = isRecord(logsJson) && Array.isArray(logsJson.lines) ? logsJson.lines : []
            const lines = rawLines.filter((x): x is string => typeof x === 'string')

            const last = lastTailByTask.get(taskId) || []
            let startIdx = 0
            if (last.length > 0 && lines.length > 0) {
              const lastTail = last.slice(-20).join('\n')
              const joined = lines.join('\n')
              const pos = lastTail ? joined.lastIndexOf(lastTail) : -1
              if (pos >= 0) {
                startIdx = joined.slice(0, pos + lastTail.length).split('\n').length
              } else {
                startIdx = Math.max(0, lines.length - 200)
              }
            }

            const appended = lines.slice(startIdx)
            for (const line of appended) {
              send('log', `[${taskId}] ${line}`)
            }

            lastTailByTask.set(taskId, lines)
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
