'use client'

import { useTranslations } from 'next-intl'
import type { TaskPresentationState } from '@/lib/task/presentation'
import { AppIcon } from '@/components/ui/icons'

type TaskStatusInlineProps = {
  state: TaskPresentationState | null
  className?: string
}

export default function TaskStatusInline({ state, className }: TaskStatusInlineProps) {
  const t = useTranslations('common')
  if (!state) return null
  if (!state.isRunning && !state.isError && !state.isQueued) return null
  const label = state.labelKey ? t(state.labelKey) : t('loading')

  return (
    <div className={['inline-flex items-center gap-1 text-xs', className || ''].join(' ').trim()}>
      {state.isError ? (
        <span className="text-[var(--glass-tone-danger-fg)]">{label}</span>
      ) : state.isQueued ? (
        <>
          <AppIcon name="clock" className="h-3.5 w-3.5 text-[var(--glass-text-tertiary)]" />
          <span className="text-[var(--glass-text-secondary)]">待执行</span>
        </>
      ) : (
        <>
          <AppIcon name="loader" className="h-3.5 w-3.5 animate-spin text-[var(--glass-tone-info-fg)]" />
          <span className="text-[var(--glass-text-secondary)]">{label}</span>
        </>
      )}
    </div>
  )
}
