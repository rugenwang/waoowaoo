'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AppIcon } from '@/components/ui/icons'
import { usePathname } from 'next/navigation'

type Project = { id: string; name?: string | null }

type SSEEvent = {
  id?: string
  type: string
  taskId?: string
  projectId?: string
  payload?: unknown
  ts?: string
}

type ConsoleLine = {
  ts?: string
  level?: 'INFO' | 'WARN' | 'ERROR'
  text: string
}

type LocalTaskRow = {
  task_id?: string
  task_type?: string
  status?: string
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

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function guessProjectIdFromPath(pathname: string): string | null {
  if (!pathname) return null
  if (pathname.includes('/workspace/asset-hub')) return 'global-asset-hub'
  const m = pathname.match(/\/workspace\/([^/]+)/)
  if (!m) return null
  const id = m[1]
  if (!id || id === 'workspace') return null
  return decodeURIComponent(id)
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function formatAsTerminalLine(e: SSEEvent): ConsoleLine[] {
  const ts = e.ts || ''
  const taskId = e.taskId ? String(e.taskId) : ''
  const taskPrefix = taskId ? `[${taskId}] ` : ''
  // 我们在 worker 里写的 stream 事件 payload.kind 更适合“直观日志”
  const payloadObj = isRecord(e.payload) ? e.payload : null
  const kind = payloadObj ? payloadObj.kind : null
  if (typeof kind === 'string' && kind) {
    const lvl: ConsoleLine['level'] =
      kind.includes('error') || payloadObj?.ok === false ? 'ERROR'
        : kind.includes('warning') ? 'WARN'
          : 'INFO'
    const headline = `[${ts}] ${taskPrefix}${kind}`
    const details = e.payload ? formatJson(e.payload) : ''
    return [{ ts, level: lvl, text: `${headline}\n${details}` }]
  }

  // lifecycle/status：保持简洁
  if (e.type === 'task.lifecycle') {
    const stage = payloadObj?.stageLabel || payloadObj?.stage || payloadObj?.lifecycleType || ''
    const progress = payloadObj?.progress ?? ''
    return [{ ts, level: 'INFO', text: `[${ts}] ${taskPrefix}lifecycle ${stage} ${progress !== '' ? `(${progress}%)` : ''}`.trim() }]
  }
  if (e.type === 'task.status') {
    const msg = payloadObj?.message || ''
    const progress = payloadObj?.progress ?? ''
    return [{ ts, level: 'INFO', text: `[${ts}] ${taskPrefix}status ${progress !== '' ? `${progress}%` : ''} ${msg}`.trim() }]
  }

  // 兜底
  return [{ ts, level: 'INFO', text: `[${ts}] ${taskPrefix}${e.type}\n${formatJson(e.payload ?? {})}` }]
}

function TerminalView(props: {
  title: string
  lines: ConsoleLine[]
  onClear?: () => void
}) {
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!autoScroll || paused) return
    const el = boxRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [props.lines, autoScroll, paused])

  const displayLines = paused ? [] : props.lines

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 pb-2">
        <div className="text-xs text-[var(--glass-text-tertiary)]">{props.title}</div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            className="rounded-md border border-[var(--glass-stroke-base)] px-2 py-1 hover:bg-[var(--glass-bg-muted)]"
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? '继续' : '暂停'}
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--glass-stroke-base)] px-2 py-1 hover:bg-[var(--glass-bg-muted)]"
            onClick={() => setAutoScroll((v) => !v)}
          >
            {autoScroll ? '自动滚动:开' : '自动滚动:关'}
          </button>
          {props.onClear ? (
            <button
              type="button"
              className="rounded-md border border-[var(--glass-stroke-base)] px-2 py-1 hover:bg-[var(--glass-bg-muted)]"
              onClick={props.onClear}
            >
              清空
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={boxRef}
        className="flex-1 overflow-auto rounded-xl border border-[var(--glass-stroke-base)] bg-black/90 p-3 font-mono text-[12px] leading-5 text-white"
      >
        {displayLines.map((l, idx) => {
          const color = l.level === 'ERROR'
            ? 'text-red-300'
            : l.level === 'WARN'
              ? 'text-yellow-200'
              : 'text-green-200'
          return (
            <div key={idx} className="whitespace-pre-wrap">
              <span className={color}>{l.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function ConsoleOverlayButton() {
  const [open, setOpen] = useState(false)
  const pathname = usePathname() || ''
  const defaultProjectId = useMemo(() => guessProjectIdFromPath(pathname), [pathname])

  return (
    <>
      <button
        type="button"
        className="text-sm text-[var(--glass-text-secondary)] hover:text-[var(--glass-text-primary)] font-medium transition-colors flex items-center gap-1"
        onClick={() => setOpen(true)}
        title="控制台"
      >
        <AppIcon name="fileText" className="w-4 h-4" />
        控制台
      </button>
      {open ? <ConsoleOverlay defaultProjectId={defaultProjectId} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ConsoleOverlay(props: { defaultProjectId: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<'waoowaoo' | 'ltx'>('waoowaoo')
  return (
    <div className="fixed inset-0 z-[100]">
      <div className="absolute inset-0 bg-black/40" onClick={props.onClose} />
      <div className="absolute left-1/2 top-16 w-[min(1200px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--glass-stroke-base)]">
          <div className="flex items-center gap-2">
            <AppIcon name="fileText" className="w-5 h-5" />
            <div className="font-semibold">执行控制台</div>
            <div className="ml-3 inline-flex rounded-full border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-1 text-xs">
              <button
                className={`px-2 py-1 rounded-full ${tab === 'waoowaoo' ? 'bg-white/10 text-[var(--glass-text-primary)]' : 'text-[var(--glass-text-secondary)]'}`}
                onClick={() => setTab('waoowaoo')}
              >
                waoowaoo
              </button>
              <button
                className={`px-2 py-1 rounded-full ${tab === 'ltx' ? 'bg-white/10 text-[var(--glass-text-primary)]' : 'text-[var(--glass-text-secondary)]'}`}
                onClick={() => setTab('ltx')}
              >
                ltx(local)
              </button>
            </div>
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-[var(--glass-text-tertiary)] hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)]"
            onClick={props.onClose}
            aria-label="关闭控制台"
          >
            <AppIcon name="close" className="w-5 h-5" />
          </button>
        </div>

        <div className="h-[min(72vh,720px)] overflow-hidden">
          {tab === 'waoowaoo'
            ? <WaoowaooConsole defaultProjectId={props.defaultProjectId} />
            : <LtxConsole />}
        </div>
      </div>
    </div>
  )
}

function WaoowaooConsole(props: { defaultProjectId: string | null }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string>(props.defaultProjectId || 'global-asset-hub')
  const [terminalLines, setTerminalLines] = useState<ConsoleLine[]>([])
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/projects', { cache: 'no-store' })
      if (!res.ok) return
      const text = await res.text().catch(() => '')
      const json = safeJsonParse(text)
      const items = isRecord(json) && Array.isArray(json.projects) ? json.projects : []
      setProjects(items
        .filter(isRecord)
        .map((p) => ({ id: String(p.id ?? ''), name: asString(p.name) })))
    })()
  }, [])

  // 不区分任务：不再拉取任务列表/不需要选择任务

  useEffect(() => {
    // SSE（项目级）
    esRef.current?.close()
    const es = new EventSource(`/api/sse?projectId=${encodeURIComponent(projectId)}`)
    esRef.current = es
    const onLifecycle = (ev: MessageEvent) => {
      const parsed = JSON.parse(ev.data) as SSEEvent
      setTerminalLines((prev) => [...prev.slice(-1999), ...formatAsTerminalLine(parsed)].slice(-2000))
    }
    es.addEventListener('task.lifecycle', onLifecycle)
    es.addEventListener('task.stream', (ev: MessageEvent) => {
      const parsed = JSON.parse(ev.data) as SSEEvent
      setTerminalLines((prev) => [...prev.slice(-1999), ...formatAsTerminalLine(parsed)].slice(-2000))
    })
    es.addEventListener('task.status', (ev: MessageEvent) => {
      const parsed = JSON.parse(ev.data) as SSEEvent
      setTerminalLines((prev) => [...prev.slice(-1999), ...formatAsTerminalLine(parsed)].slice(-2000))
    })
    es.addEventListener('error', () => {})
    return () => es.close()
  }, [projectId])

  const filteredLines = useMemo(() => {
    return terminalLines.slice(-1200)
  }, [terminalLines])

  return (
    <div className="grid grid-cols-12 h-full">
      <div className="col-span-4 border-r border-[var(--glass-stroke-base)] h-full overflow-auto">
        <div className="p-3">
          <div className="text-xs text-[var(--glass-text-tertiary)]">项目</div>
          <select
            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-2 py-1 text-sm"
            value={projectId}
            onChange={(e) => { setProjectId(e.target.value); setTerminalLines([]) }}
          >
            <option value="global-asset-hub">global-asset-hub</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name ? `${p.name} (${p.id})` : p.id}</option>
            ))}
          </select>
          <div className="mt-3 text-xs text-[var(--glass-text-tertiary)]">说明</div>
          <div className="mt-1 text-xs text-[var(--glass-text-secondary)] leading-5">
            不区分任务：黑窗口会混合输出该项目下所有任务日志（每条前缀会带 taskId）。
          </div>
        </div>
      </div>

      <div className="col-span-8 h-full overflow-hidden p-3">
        <TerminalView
          title="waoowaoo 实时日志（黑窗口，混合输出）"
          lines={filteredLines}
          onClear={() => setTerminalLines([])}
        />
      </div>
    </div>
  )
}

function LtxConsole() {
  const [tasks, setTasks] = useState<LocalTaskRow[]>([])
  const [lines, setLines] = useState<string[]>([])
  const terminalLines = useMemo<ConsoleLine[]>(
    () => lines.map((t) => ({ level: 'INFO', text: t })),
    [lines],
  )
  const [status, setStatus] = useState<unknown>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/console/local/tasks?limit=50', { cache: 'no-store' })
      if (!res.ok) return
      const text = await res.text().catch(() => '')
      const json = safeJsonParse(text)
      const rawItems = isRecord(json) && Array.isArray(json.items) ? json.items : []
      const items: LocalTaskRow[] = rawItems
        .filter(isRecord)
        .map((it) => ({
          task_id: asString(it.task_id) ?? undefined,
          task_type: asString(it.task_type) ?? undefined,
          status: asString(it.status) ?? undefined,
        }))
      setTasks(items)
    })()
  }, [])

  useEffect(() => {
    esRef.current?.close()
    setLines([])
    setStatus(null)
    // 不区分任务：使用聚合 SSE（由 waoowaoo 服务端代理，避免浏览器 EventSource 不能带 Authorization）
    const es = new EventSource('/api/console/local/sse')
    esRef.current = es
    es.addEventListener('status', (ev: MessageEvent) => {
      setStatus(safeJsonParse(ev.data))
    })
    es.addEventListener('log', (ev: MessageEvent) => {
      const parsed = safeJsonParse(ev.data)
      const line = typeof parsed === 'string' ? parsed : ev.data
      setLines((prev) => [...prev.slice(-1999), line])
    })
    // 既处理网络断开，也处理后端主动发送的 `event: error`
    es.addEventListener('error', (ev: Event) => {
      const maybe = ev as unknown as { data?: unknown }
      const data = maybe?.data
      if (typeof data === 'string' && data.trim()) {
        const parsed = safeJsonParse(data)
        const msg =
          isRecord(parsed) && typeof parsed.message === 'string'
            ? parsed.message
            : data
        setLines((prev) => [...prev.slice(-1999), `[ltx-proxy] ${msg}`])
        return
      }
      setLines((prev) => [...prev.slice(-1999), '[ltx-proxy] EventSource 连接异常，正在自动重连...'])
    })
    return () => es.close()
  }, [])

  return (
    <div className="grid grid-cols-12 h-full">
      <div className="col-span-4 border-r border-[var(--glass-stroke-base)] h-full overflow-auto">
        <div className="px-3 py-3">
          <div className="text-xs text-[var(--glass-text-tertiary)] mb-2">ltx 任务（最近 50 条）</div>
          <div className="space-y-2">
            {tasks.map((t) => {
              const id = String(t.task_id || '')
              return (
                <button
                  key={id}
                  className="w-full text-left rounded-xl border px-3 py-2 transition-colors border-[var(--glass-stroke-base)] hover:bg-[var(--glass-bg-muted)]"
                  onClick={() => {}}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">{String(t.task_type || 'task')}</div>
                    <div className="text-xs text-[var(--glass-text-tertiary)]">{String(t.status || '')}</div>
                  </div>
                  <div className="text-xs text-[var(--glass-text-tertiary)] break-all">{id}</div>
                </button>
              )
            })}
          </div>
          <div className="mt-3 text-xs text-[var(--glass-text-secondary)] leading-5">
            右侧黑窗口为“全任务聚合”输出（每行前缀带 taskId），无需选择任务。
          </div>
        </div>
      </div>

      <div className="col-span-8 h-full overflow-hidden p-3">
        <div className="text-xs text-[var(--glass-text-tertiary)]">状态</div>
        <pre className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[var(--glass-text-primary)] max-h-[140px] overflow-auto">{status ? formatJson(status) : '...'}</pre>
        <div className="mt-3 h-[calc(100%-180px)]">
          <TerminalView
            title="ltx 实时日志（黑窗口）"
            lines={terminalLines}
            onClear={() => setLines([])}
          />
        </div>
      </div>
    </div>
  )
}
