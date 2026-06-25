'use client'

import { useState } from 'react'
import { AppIcon } from '@/components/ui/icons'
import { useTaskQueue } from '@/lib/task-queue'

export default function MobileGenerationQueueBar() {
  const taskQueue = useTaskQueue()
  const [cancelling, setCancelling] = useState(false)

  if (!taskQueue.enabled) return null

  const pendingCount = taskQueue.queue.filter((item) => item.status === 'pending').length
  const current = taskQueue.activeItem
  const latestFailure = [...taskQueue.queue].reverse().find((item) => item.status === 'failed') || null

  const cancelCurrent = async () => {
    if (!current?.taskId || cancelling) return
    setCancelling(true)
    try {
      await taskQueue.cancelCurrent()
    } finally {
      setCancelling(false)
    }
  }

  return (
    <section className="rounded-[22px] bg-white p-3 shadow-sm ring-1 ring-slate-200/80">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className={`h-2 w-2 rounded-full ${current ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`} />
            当前任务
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">
            {current?.label || '队列空闲'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
          等待 {pendingCount}
        </span>
      </div>
      {taskQueue.notice ? (
        <div className="mt-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-700">{taskQueue.notice}</div>
      ) : null}
      {latestFailure?.error ? (
        <div className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
          <span className="font-semibold">提交失败：</span>{latestFailure.error}
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!current?.taskId || cancelling}
          onClick={() => void cancelCurrent()}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl bg-amber-50 px-3 text-sm font-semibold text-amber-700 disabled:opacity-40"
        >
          <AppIcon name="close" className="h-4 w-4" />
          {cancelling ? '取消中' : '取消当前'}
        </button>
        <button
          type="button"
          disabled={pendingCount === 0}
          onClick={taskQueue.clearPending}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl bg-slate-100 px-3 text-sm font-semibold text-slate-700 disabled:opacity-40"
        >
          <AppIcon name="trash" className="h-4 w-4" />
          清空未开始
        </button>
      </div>
    </section>
  )
}
