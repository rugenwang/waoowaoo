'use client'

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'
import { useTaskQueue } from '@/lib/task-queue'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'
import { useActiveTasks } from '@/lib/query/hooks/useTaskStatus'
import { useCancelTask } from '@/lib/query/mutations'
import type { QueueItemState } from '@/lib/task-queue/types'

function resolveGroupLabel(group: QueueItemState['group']) {
  if (group === 'assets') return '资产库'
  if (group === 'storyboard') return '分镜'
  if (group === 'video') return '视频'
  return '其他'
}

export default function QueueProgressPopup() {
  const {
    enabled,
    projectId,
    queue,
    activeItem,
    activeItems,
    activeTargets,
    showPopup,
    setShowPopup,
    clearPending,
    cancelCurrent,
    notice,
  } = useTaskQueue()
  const [dismissRecovered, setDismissRecovered] = useState(false)
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
  } | null>(null)

  const cancelTask = useCancelTask(projectId)
  // 刷新页面后，前端内存队列会清空，但后端任务仍会继续执行。
  // 这里补一个“恢复显示”：当 queue 为空时，从服务端拉取 active tasks 用于展示/取消。
  const recovered = useActiveTasks({
    projectId,
    enabled: enabled && queue.length === 0,
  })
  const recoveredTasks = recovered.data || []

  // 注意：Hooks 不能在条件分支里调用。
  // 这里先无条件调用 useTaskTargetStateMap，再根据 enabled/queue.length 决定是否渲染。

  const total = queue.length
  const doneCount = queue.filter((i) => i.status === 'succeeded' || i.status === 'failed').length
  const runningCount = activeItems.length
  const runningIndex = runningCount > 0 ? doneCount + runningCount : doneCount
  const currentLabel = activeItems.map((item) => item.label).join('、')
  const activeTarget = activeTargets[0] || null

  // 仅订阅 overlay（不开启服务端轮询），进度由 SSE 写入 overlay
  const { getState } = useTaskTargetStateMap(
    projectId,
    activeTarget ? [activeTarget] : [],
    { enabled: false },
  )
  const state = activeTarget ? getState(activeTarget.targetType, activeTarget.targetId) : null
  const progress = typeof state?.progress === 'number' ? state.progress : null
  const stageLabel = typeof state?.stageLabel === 'string' ? state.stageLabel : null

  // 当恢复态任务消失/或本地队列重新出现时，自动解除 dismiss，避免状态卡死
  useEffect(() => {
    if (queue.length > 0) setDismissRecovered(false)
    if (recoveredTasks.length === 0) setDismissRecovered(false)
  }, [queue.length, recoveredTasks.length])

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button,a,input,textarea,select,[role="button"],[data-no-drag="true"]')) return

    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    setFloatingPosition({ left: rect.left, top: rect.top })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [])

  const moveDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const margin = 8
    const width = event.currentTarget.offsetWidth
    const height = event.currentTarget.offsetHeight
    const maxLeft = Math.max(margin, window.innerWidth - width - margin)
    const maxTop = Math.max(margin, window.innerHeight - height - margin)
    const nextLeft = Math.min(maxLeft, Math.max(margin, event.clientX - drag.offsetX))
    const nextTop = Math.min(maxTop, Math.max(margin, event.clientY - drag.offsetY))
    setFloatingPosition({ left: nextLeft, top: nextTop })
  }, [])

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const renderFloating = (children: ReactNode) => (
    <div
      className="fixed bottom-8 right-8 z-[9999] animate-slide-up cursor-grab select-none touch-none active:cursor-grabbing"
      style={floatingPosition ? {
        left: floatingPosition.left,
        top: floatingPosition.top,
        right: 'auto',
        bottom: 'auto',
      } : undefined}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title="拖动可移动队列浮条"
    >
      {children}
    </div>
  )

  if (!enabled) return null
  if (queue.length === 0 && recoveredTasks.length === 0) return null

  const grouped = {
    assets: queue.filter((i) => i.group === 'assets'),
    storyboard: queue.filter((i) => i.group === 'storyboard'),
    video: queue.filter((i) => i.group === 'video'),
    other: queue.filter((i) => !i.group),
  }

  const hasRunningOrPending = queue.some((i) => i.status === 'running' || i.status === 'pending')
  const hasRecoveredActive = queue.length === 0 && recoveredTasks.length > 0 && !dismissRecovered

  const runningState = resolveTaskPresentationState({
    phase: 'processing',
    intent: 'generate',
    resource: 'image',
    hasOutput: true,
  })

  const body = (
    <div className="glass-surface-modal min-w-[320px] max-w-[90vw] p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">
          <TaskStatusInline state={runningState} className="[&>span]:sr-only" />
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold text-(--glass-text-primary)">
              {hasRecoveredActive ? '后台任务进行中（刷新后恢复）' : `任务队列进度（${runningIndex}/${total}）`}
            </div>
            <button
              type="button"
              className="glass-btn-base glass-btn-secondary rounded-md px-2 py-1 text-xs"
              onClick={() => {
                // 恢复态默认强制展示（避免“后台还在跑但用户看不见”），但用户点击关闭后应能隐藏
                if (queue.length === 0 && recoveredTasks.length > 0) setDismissRecovered(true)
                setShowPopup(false)
              }}
            >
              关闭
            </button>
          </div>
          {!hasRecoveredActive && currentLabel && (
            <div className="mt-1 text-sm text-(--glass-text-secondary)">
              {activeItems.length > 1
                ? `正在并行处理：${currentLabel}`
                : `正在处理（${resolveGroupLabel(activeItem?.group)}）：${currentLabel}`}
            </div>
          )}
          {stageLabel && (
            <div className="mt-1 text-xs text-(--glass-text-tertiary)">
              {stageLabel}{progress !== null ? `（${progress}%）` : ''}
            </div>
          )}

          {!hasRecoveredActive && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="glass-btn-base glass-btn-secondary rounded-md px-3 py-1 text-xs"
                onClick={() => void cancelCurrent()}
                disabled={!activeItem?.taskId}
              >
                取消当前
              </button>
              <button
                type="button"
                className="glass-btn-base glass-btn-secondary rounded-md px-3 py-1 text-xs"
                onClick={() => clearPending()}
              >
                清空未开始
              </button>
            </div>
          )}
        </div>
      </div>

      {!hasRecoveredActive && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-(--glass-bg-muted)">
          <div
            className="h-1.5 rounded-full bg-(--glass-accent-from)"
            style={{
              width: `${Math.min(100, Math.max(0, Math.round(((doneCount + (progress ? progress / 100 : 0)) / total) * 100)))}%`,
            }}
          />
        </div>
      )}

      {hasRecoveredActive ? (
        <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-(--glass-text-tertiary)">
          <div className="mb-1 font-medium text-(--glass-text-secondary)">
            执行中任务（{recoveredTasks.length}）
          </div>
          <div className="grid grid-cols-1 gap-1">
            {recoveredTasks.slice(0, 8).map((task) => (
              <div key={task.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-(--glass-text-secondary)">
                    {task.targetType}:{task.targetId}
                  </div>
                  <div className="truncate">
                    {task.type} · {task.status}
                  </div>
                </div>
                <button
                  type="button"
                  className="glass-btn-base glass-btn-tone-danger rounded-md px-2 py-1 text-[10px]"
                  onClick={() => cancelTask.mutate(task.id)}
                  disabled={cancelTask.isPending}
                >
                  取消
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-1 text-xs text-(--glass-text-tertiary)">
          {(['assets', 'storyboard', 'video', 'other'] as const).map((groupKey) => {
            const items = grouped[groupKey]
            if (!items || items.length === 0) return null
            return (
              <div key={groupKey} className="mt-1">
                <div className="mb-1 font-medium text-(--glass-text-secondary)">
                  {resolveGroupLabel(groupKey === 'other' ? undefined : groupKey)}
                </div>
                <div className="grid grid-cols-1 gap-1">
                  {items.slice(-4).map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2">
                      <div className="truncate">{item.label}</div>
                      <div className="shrink-0">
                        {item.status === 'pending' && '待处理'}
                        {item.status === 'running' && '进行中'}
                        {item.status === 'succeeded' && '完成'}
                        {item.status === 'failed' && '失败'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  const toast = notice ? (
    <div className="mb-2 w-fit max-w-[90vw] rounded-md bg-(--glass-bg) px-3 py-2 text-sm text-(--glass-text-primary) shadow-lg">
      {notice}
    </div>
  ) : null

  if (showPopup || hasRecoveredActive) {
    return renderFloating(
      <>
        {toast}
        {body}
      </>,
    )
  }

  // 被用户关闭的恢复态：显示一个最小化入口
  if (dismissRecovered && queue.length === 0 && recoveredTasks.length > 0) {
    return renderFloating(
      <>
        {toast}
        <button
          type="button"
          className="glass-surface-modal px-3 py-2 text-sm text-(--glass-text-primary)"
          onClick={() => setDismissRecovered(false)}
        >
          后台任务 {recoveredTasks.length}
        </button>
      </>,
    )
  }

  if (!hasRunningOrPending && !hasRecoveredActive) {
    // 没有正在执行/待执行：展示一个“完成”角标（醒目）
    return renderFloating(
      <>
        {toast}
        <div className="glass-surface-modal px-3 py-2 text-sm text-(--glass-tone-success-fg) flex items-center gap-2">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-(--glass-tone-success-bg)">
            <span className="text-(--glass-tone-success-fg) text-sm leading-none">✓</span>
          </span>
          <span>队列空闲（{doneCount}/{total}）</span>
          <button
            type="button"
            className="ml-2 text-xs text-(--glass-text-tertiary) hover:text-(--glass-tone-info-fg)"
            onClick={() => clearPending()}
            title="清空未开始任务"
          >
            清空
          </button>
        </div>
      </>,
    )
  }
  return renderFloating(
    <>
      {toast}
      <button
        type="button"
        className="glass-surface-modal px-3 py-2 text-sm text-(--glass-text-primary)"
        onClick={() => setShowPopup(true)}
      >
        队列进度 {runningIndex}/{total}
      </button>
    </>,
  )
}
