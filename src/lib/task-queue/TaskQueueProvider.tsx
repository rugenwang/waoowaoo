'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { apiFetch } from '@/lib/api-fetch'
import type { SSEEvent } from '@/lib/task/types'
import { TASK_EVENT_TYPE, TASK_SSE_EVENT_TYPE } from '@/lib/task/types'
import type { TaskTargetStateQuery } from '@/lib/query/hooks/useTaskTargetStateMap'
import type { QueueItem, QueueItemState } from './types'

type TaskEventListener = (event: SSEEvent) => void

export type TaskQueueContextValue = {
  enabled: boolean
  projectId: string
  queue: QueueItemState[]
  activeItem: QueueItemState | null
  activeTarget: TaskTargetStateQuery | null
  showPopup: boolean
  setShowPopup: (show: boolean) => void
  notice: string | null
  enqueue: (item: QueueItem) => void
  enqueueMany: (items: QueueItem[]) => void
  clearPending: () => void
  cancelCurrent: () => Promise<void>
}

const TaskQueueContext = createContext<TaskQueueContextValue | null>(null)

export type TaskQueueProviderProps = {
  projectId: string
  enabled: boolean
  subscribeTaskEvents: (listener: TaskEventListener) => () => void
  children: ReactNode
}

function normalizeError(err: unknown): string {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || 'error'
  try {
    return JSON.stringify(err)
  } catch {
    return 'error'
  }
}

function isTaskTerminalLifecycle(event: SSEEvent) {
  if (event.type !== TASK_SSE_EVENT_TYPE.LIFECYCLE) return false
  const lifecycleType = typeof event.payload?.lifecycleType === 'string' ? event.payload.lifecycleType : null
  return lifecycleType === TASK_EVENT_TYPE.COMPLETED || lifecycleType === TASK_EVENT_TYPE.FAILED
}

function isTaskCompleted(event: SSEEvent) {
  if (event.type !== TASK_SSE_EVENT_TYPE.LIFECYCLE) return false
  const lifecycleType = typeof event.payload?.lifecycleType === 'string' ? event.payload.lifecycleType : null
  return lifecycleType === TASK_EVENT_TYPE.COMPLETED
}

function buildDedupeKey(item: QueueItem) {
  return String(item.dedupeKey || `${item.projectId}:${item.target.targetType}:${item.target.targetId}:${item.uiKey || ''}`)
}

export function TaskQueueProvider(props: TaskQueueProviderProps) {
  const { projectId, enabled, subscribeTaskEvents, children } = props
  const [queue, setQueue] = useState<QueueItemState[]>([])
  const [showPopup, setShowPopup] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const runningRef = useRef(false)

  const flashNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current)
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null)
      noticeTimerRef.current = null
    }, 1800)
  }, [])

  const activeItem = useMemo(() => queue.find(item => item.status === 'running') || null, [queue])
  const activeTarget = activeItem?.target || null

  const startNextIfIdle = useCallback(() => {
    if (!enabled) return
    if (runningRef.current) return
    runningRef.current = true

    setQueue((prev) => {
      const next = [...prev]
      const idx = next.findIndex(item => item.status === 'pending')
      if (idx === -1) {
        runningRef.current = false
        return prev
      }
      next[idx] = { ...next[idx], status: 'running', error: null }
      return next
    })
  }, [enabled])

  // 当队列中出现 running，但没有 taskId 时，立即 submit
  useEffect(() => {
    if (!enabled) return
    const current = queue.find(item => item.status === 'running') || null
    if (!current) {
      runningRef.current = false
      // 若还有 pending，继续尝试
      if (queue.some(i => i.status === 'pending')) startNextIfIdle()
      return
    }
    if (current.taskId) return

    let cancelled = false
    ;(async () => {
      try {
        setShowPopup(true)
        const { taskId } = await current.submit()
        if (cancelled) return
        const normalizedTaskId = String(taskId || '').trim()
        if (!normalizedTaskId) {
          // 同步完成：不依赖 SSE，直接判定为成功并进入下一项
          setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, status: 'succeeded' } : item))
          try {
            await current.onDone?.('')
          } finally {
            runningRef.current = false
            startNextIfIdle()
          }
          return
        }
        setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, taskId: normalizedTaskId } : item))
      } catch (err) {
        if (cancelled) return
        const message = normalizeError(err)
        setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, status: 'failed', error: message } : item))
        runningRef.current = false
        // 自动继续下一个
        startNextIfIdle()
      }
    })()
    return () => { cancelled = true }
  }, [enabled, queue, startNextIfIdle])

  const handleTerminal = useCallback(async (event: SSEEvent) => {
    if (!enabled) return
    if (!isTaskTerminalLifecycle(event)) return
    const taskId = event.taskId

    const current = queue.find(item => item.status === 'running' && item.taskId === taskId) || null
    if (!current) return

    if (isTaskCompleted(event)) {
      setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, status: 'succeeded' } : item))
      try {
        await current.onDone?.(taskId)
      } finally {
        runningRef.current = false
        startNextIfIdle()
      }
      return
    }

    setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, status: 'failed', error: 'task failed' } : item))
    try {
      await current.onFail?.(taskId, event)
    } finally {
      runningRef.current = false
      startNextIfIdle()
    }
  }, [enabled, queue, startNextIfIdle])

  useEffect(() => {
    if (!enabled) return
    const unsubscribe = subscribeTaskEvents((event) => {
      // 只关心 terminal，progress/stage 由 overlay 负责
      void handleTerminal(event)
    })
    return unsubscribe
  }, [enabled, subscribeTaskEvents, handleTerminal])

  const enqueue = useCallback((item: QueueItem) => {
    if (!enabled) return
    const dedupeKey = buildDedupeKey(item)
    setQueue((prev) => {
      const exists = prev.some((q) =>
        buildDedupeKey(q) === dedupeKey && (q.status === 'pending' || q.status === 'running'),
      )
      if (exists) {
        flashNotice(`已在队列中：${item.label}`)
        setShowPopup(true)
        return prev
      }
      flashNotice(`已加入队列：${item.label}`)
      setShowPopup(true)
      return [
        ...prev,
        {
          ...item,
          dedupeKey,
          status: 'pending',
          taskId: null,
          error: null,
        },
      ]
    })
    startNextIfIdle()
  }, [enabled, flashNotice, startNextIfIdle])

  const enqueueMany = useCallback((items: QueueItem[]) => {
    if (!enabled) return
    if (!items || items.length === 0) return
    setQueue((prev) => {
      const existingKeys = new Set(
        prev
          .filter((q) => q.status === 'pending' || q.status === 'running')
          .map((q) => buildDedupeKey(q)),
      )
      const addedInBatch = new Set<string>()
      const filtered = items.filter((item) => {
        const key = buildDedupeKey(item)
        if (existingKeys.has(key)) return false
        if (addedInBatch.has(key)) return false
        addedInBatch.add(key)
        return true
      })
      if (filtered.length === 0) {
        flashNotice('这些任务已在队列中')
        setShowPopup(true)
        return prev
      }
      flashNotice(`已加入队列：${filtered.length} 个任务`)
      setShowPopup(true)
      return [
        ...prev,
        ...filtered.map((item) => ({
          ...item,
          dedupeKey: buildDedupeKey(item),
          status: 'pending' as const,
          taskId: null,
          error: null,
        })),
      ]
    })
    startNextIfIdle()
  }, [enabled, flashNotice, startNextIfIdle])

  const clearPending = useCallback(() => {
    setQueue((prev) => prev.filter(item => item.status !== 'pending'))
  }, [])

  const cancelCurrent = useCallback(async () => {
    const current = queue.find(item => item.status === 'running') || null
    if (!current?.taskId) return
    try {
      await apiFetch(`/api/tasks/${encodeURIComponent(current.taskId)}`, { method: 'DELETE' })
    } catch {
      // ignore
    }
  }, [queue])

  const value = useMemo<TaskQueueContextValue>(() => ({
    enabled,
    projectId,
    queue,
    activeItem,
    activeTarget,
    showPopup,
    setShowPopup,
    notice,
    enqueue,
    enqueueMany,
    clearPending,
    cancelCurrent,
  }), [
    activeItem,
    activeTarget,
    cancelCurrent,
    clearPending,
    enqueue,
    enqueueMany,
    enabled,
    notice,
    projectId,
    queue,
    showPopup,
  ])

  return <TaskQueueContext.Provider value={value}>{children}</TaskQueueContext.Provider>
}

export function useTaskQueue() {
  const ctx = useContext(TaskQueueContext)
  if (!ctx) throw new Error('useTaskQueue must be used within TaskQueueProvider')
  return ctx
}
