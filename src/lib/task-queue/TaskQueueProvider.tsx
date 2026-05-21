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
import {
  promoteRunnableQueueItems,
  resolveQueueLaneFromTaskType,
  type TaskQueueLane,
} from './scheduler'

type TaskEventListener = (event: SSEEvent) => void

export type TaskQueueContextValue = {
  enabled: boolean
  projectId: string
  queue: QueueItemState[]
  activeItem: QueueItemState | null
  activeItems: QueueItemState[]
  activeTarget: TaskTargetStateQuery | null
  activeTargets: TaskTargetStateQuery[]
  showPopup: boolean
  setShowPopup: (show: boolean) => void
  notice: string | null
  enqueue: (item: QueueItem) => void
  enqueueMany: (items: QueueItem[]) => void
  clearPending: () => void
  cancelCurrent: () => Promise<void>
  cancelByUiKey: (uiKey: string) => Promise<boolean>
}

const TaskQueueContext = createContext<TaskQueueContextValue | null>(null)

export type TaskQueueProviderProps = {
  projectId: string
  enabled: boolean
  allowParallelStoryboardVideo?: boolean
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
  const { projectId, enabled, allowParallelStoryboardVideo = false, subscribeTaskEvents, children } = props
  const [queue, setQueue] = useState<QueueItemState[]>([])
  const [showPopup, setShowPopup] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [externalBusyLanes, setExternalBusyLanes] = useState<TaskQueueLane[]>([])
  const noticeTimerRef = useRef<number | null>(null)
  const submittingItemIdsRef = useRef<Set<string>>(new Set())
  const canceledItemIdsRef = useRef<Set<string>>(new Set())
  // 用 ref 镜像 queue 状态，避免 cancelCurrent 等回调因闭包引用陈旧 queue 导致取不到最新 running 项
  const queueRef = useRef<QueueItemState[]>(queue)
  queueRef.current = queue

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

  const activeItems = useMemo(() => queue.filter(item => item.status === 'running'), [queue])
  const activeItem = activeItems[0] || null
  const activeTargets = useMemo(() => activeItems.map((item) => item.target), [activeItems])
  const activeTarget = activeItem?.target || null

  // 刷新页面后，前端队列会丢失，但后端可能仍有 queued/processing 的任务在执行。
  // 这种情况下不应该允许用户“刷新绕过队列”继续直接提交新任务。
  // 这里轮询后端 active tasks，作为 external busy 闸门：
  // - 分镜/视频可并行时，只阻塞同车道任务；全局任务仍阻塞所有任务
  // - 分镜/视频都走本地模型时，所有任务仍共用 global 车道
  useEffect(() => {
    if (!enabled) {
      setExternalBusyLanes([])
      return
    }

    let cancelled = false
    let timer: number | null = null

    const check = async () => {
      try {
        const search = new URLSearchParams()
        search.set('projectId', projectId)
        search.append('status', 'queued')
        search.append('status', 'processing')
        search.set('limit', '200')
        const res = await apiFetch(`/api/tasks?${search.toString()}`)
        if (!res.ok) return
        const data = await res.json().catch(() => ({}))
        const payload = data && typeof data === 'object' ? data as { tasks?: unknown } : {}
        const tasks = Array.isArray(payload.tasks) ? payload.tasks : []
        const lanes = Array.from(new Set(tasks.map((task) => {
          const taskType = task && typeof task === 'object' && 'type' in task
            ? String((task as { type?: unknown }).type || '')
            : ''
          return resolveQueueLaneFromTaskType(taskType, allowParallelStoryboardVideo)
        })))
        if (!cancelled) setExternalBusyLanes(lanes)
        if (!cancelled && (lanes.length > 0 || queueRef.current.some((item) => item.status === 'pending'))) {
          timer = window.setTimeout(check, 2000)
        }
      } catch {
        // ignore
      }
    }

    void check()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [allowParallelStoryboardVideo, enabled, projectId])

  const startNextIfIdle = useCallback(() => {
    if (!enabled) return
    setQueue((prev) => promoteRunnableQueueItems(prev, {
      allowParallelStoryboardVideo,
      externalBusyLanes,
    }))
  }, [allowParallelStoryboardVideo, enabled, externalBusyLanes])

  useEffect(() => {
    if (!enabled) return
    if (!queue.some((item) => item.status === 'pending')) return
    startNextIfIdle()
  }, [enabled, externalBusyLanes, queue, startNextIfIdle])

  // 当队列中出现 running，但没有 taskId 时，立即 submit。分镜/视频并行时可能同时提交多个车道。
  useEffect(() => {
    if (!enabled) return
    const runnableItems = queue.filter((item) =>
      item.status === 'running' &&
      !item.taskId &&
      !submittingItemIdsRef.current.has(item.id),
    )
    if (runnableItems.length === 0) return

    for (const current of runnableItems) {
      submittingItemIdsRef.current.add(current.id)
      ;(async () => {
        try {
          setShowPopup(true)
          const { taskId } = await current.submit()
          const normalizedTaskId = String(taskId || '').trim()
          if (canceledItemIdsRef.current.has(current.id)) {
            submittingItemIdsRef.current.delete(current.id)
            canceledItemIdsRef.current.delete(current.id)
            if (normalizedTaskId) {
              await apiFetch(`/api/tasks/${encodeURIComponent(normalizedTaskId)}`, { method: 'DELETE' }).catch(() => null)
            }
            startNextIfIdle()
            return
          }
          if (!normalizedTaskId) {
            // 同步完成：不依赖 SSE，直接判定为成功并进入下一项
            setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, status: 'succeeded' } : item))
            try {
              await current.onDone?.('')
            } finally {
              submittingItemIdsRef.current.delete(current.id)
              startNextIfIdle()
            }
            return
          }
          setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, taskId: normalizedTaskId } : item))
          submittingItemIdsRef.current.delete(current.id)
        } catch (err) {
          const message = normalizeError(err)
          setQueue((prev) => prev.map((item) => item.id === current.id ? { ...item, status: 'failed', error: message } : item))
          submittingItemIdsRef.current.delete(current.id)
          try {
            await current.onFail?.('', err)
          } catch {
            // ignore follow-up refresh failures; the queue item itself has already failed
          }
          // 自动继续下一个
          startNextIfIdle()
        }
      })()
    }
  }, [enabled, queue, startNextIfIdle])

  const handleTerminal = useCallback(async (event: SSEEvent) => {
    if (!enabled) return
    if (!isTaskTerminalLifecycle(event)) return
    const taskId = event.taskId
    const isCompleted = isTaskCompleted(event)

    // 使用 setQueue 函数式更新，避免闭包捕获陈旧的 queue 引用。
    // 长时间运行的任务完成时，SSE 事件到达时的 queue 闭包可能已过期，
    // 导致 queue.find() 找不到匹配的 running 项。
    let matchedItem: QueueItemState | null = null
    let hadRunningItem = false
    setQueue((prev) => {
      const found = prev.find(item => item.status === 'running' && item.taskId === taskId) || null
      matchedItem = found
      hadRunningItem = prev.some(item => item.status === 'running')
      if (!matchedItem) return prev

      if (isCompleted) {
        return prev.map((item) => item.id === matchedItem!.id ? { ...item, status: 'succeeded' } : item)
      }
      return prev.map((item) => item.id === matchedItem!.id ? { ...item, status: 'failed', error: 'task failed' } : item)
    })

    // matchedItem 为 null 时，说明这个 terminal 事件没有匹配到队列中的 running 项。
    // 可能原因：队列项已被清理、SSE 重播放了旧事件、或 taskId 不匹配。
    // 此时仍需确保 runningRef 正确重置，否则队列会永久卡死。
    const terminalItem = matchedItem as QueueItemState | null
    if (!terminalItem) {
      if (!hadRunningItem) startNextIfIdle()
      return
    }

    if (isCompleted) {
      try {
        await terminalItem.onDone?.(taskId)
      } finally {
        startNextIfIdle()
      }
      return
    }

    try {
      await terminalItem.onFail?.(taskId, event)
    } finally {
      startNextIfIdle()
    }
  }, [enabled, startNextIfIdle])

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
    const current = queueRef.current.find(item => item.status === 'running') || null
    if (!current?.taskId) return
    try {
      await apiFetch(`/api/tasks/${encodeURIComponent(current.taskId)}`, { method: 'DELETE' })
    } catch {
      // ignore
    }
  }, [])

  const cancelByUiKey = useCallback(async (uiKey: string) => {
    const targetKey = String(uiKey || '').trim()
    if (!targetKey) return false
    const item = queueRef.current.find((candidate) =>
      candidate.uiKey === targetKey && (candidate.status === 'pending' || candidate.status === 'running'),
    ) || null
    if (!item) return false

    canceledItemIdsRef.current.add(item.id)
    submittingItemIdsRef.current.delete(item.id)
    setQueue((prev) => prev.filter((candidate) => candidate.id !== item.id))

    if (item.taskId) {
      await apiFetch(`/api/tasks/${encodeURIComponent(item.taskId)}`, { method: 'DELETE' }).catch(() => null)
    }
    startNextIfIdle()
    return true
  }, [startNextIfIdle])

  const value = useMemo<TaskQueueContextValue>(() => ({
    enabled,
    projectId,
    queue,
    activeItem,
    activeItems,
    activeTarget,
    activeTargets,
    showPopup,
    setShowPopup,
    notice,
    enqueue,
    enqueueMany,
    clearPending,
    cancelCurrent,
    cancelByUiKey,
  }), [
    activeItem,
    activeItems,
    activeTarget,
    activeTargets,
    cancelCurrent,
    cancelByUiKey,
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
