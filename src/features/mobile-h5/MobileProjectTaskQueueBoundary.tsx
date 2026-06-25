'use client'

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import {
  TaskQueueProvider,
  useTaskQueue,
  type TaskQueueContextValue,
} from '@/lib/task-queue'
import { useSSE } from '@/lib/query/hooks/useSSE'
import { TASK_EVENT_TYPE, TASK_SSE_EVENT_TYPE, type SSEEvent } from '@/lib/task/types'
import type { MobileNovelPromotionData } from './types'
import { getMobileTaskQueueConfig } from './mobile-task-queue'

type TaskEventListener = (event: SSEEvent) => void
type MobileQueueChildren = ReactNode | ((taskQueue: TaskQueueContextValue) => ReactNode)

function MobileProjectQueueConsumer({ children }: { children: MobileQueueChildren }) {
  const taskQueue = useTaskQueue()
  return <>{typeof children === 'function' ? children(taskQueue) : children}</>
}

export default function MobileProjectTaskQueueBoundary({
  projectId,
  episodeId,
  projectData,
  onTaskTerminal,
  children,
}: {
  projectId: string
  episodeId?: string | null
  projectData?: MobileNovelPromotionData | null
  onTaskTerminal?: (event: SSEEvent) => void | Promise<void>
  children: MobileQueueChildren
}) {
  const listenersRef = useRef(new Set<TaskEventListener>())
  const onTaskTerminalRef = useRef(onTaskTerminal)
  const queueConfig = getMobileTaskQueueConfig(projectData)

  useEffect(() => {
    onTaskTerminalRef.current = onTaskTerminal
  }, [onTaskTerminal])

  const subscribeTaskEvents = useCallback((listener: TaskEventListener) => {
    listenersRef.current.add(listener)
    return () => listenersRef.current.delete(listener)
  }, [])

  const handleTaskEvent = useCallback((event: SSEEvent) => {
    const lifecycleType = event.type === TASK_SSE_EVENT_TYPE.LIFECYCLE
      ? event.payload?.lifecycleType
      : null
    if (lifecycleType === TASK_EVENT_TYPE.COMPLETED || lifecycleType === TASK_EVENT_TYPE.FAILED) {
      void onTaskTerminalRef.current?.(event)
    }
    for (const listener of listenersRef.current) listener(event)
  }, [])

  useSSE({
    projectId,
    episodeId,
    enabled: !!projectId,
    onEvent: handleTaskEvent,
    invalidateMode: queueConfig.enabled ? 'minimal' : 'default',
  })

  return (
    <TaskQueueProvider
      projectId={projectId}
      enabled={queueConfig.enabled}
      allowParallelStoryboardVideo={queueConfig.allowParallelStoryboardVideo}
      subscribeTaskEvents={subscribeTaskEvents}
    >
      <MobileProjectQueueConsumer>{children}</MobileProjectQueueConsumer>
    </TaskQueueProvider>
  )
}
