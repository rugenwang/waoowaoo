'use client'

import { createPortal } from 'react-dom'
import { AppIcon } from '@/components/ui/icons'

interface RegenerateVideoPromptModalProps {
  open: boolean
  title?: string
  description?: string
  value: string
  currentPrompt: string
  candidatePrompt?: string | null
  isSubmitting?: boolean
  isSaving?: boolean
  onChange: (value: string) => void
  onClose: () => void
  onGenerate: () => void
  onUseCandidate: () => void
}

export default function RegenerateVideoPromptModal({
  open,
  title = '重新生成视频提示词',
  description = '可补充本次希望加强的要求，会叠加到原有视频提示词规则中。',
  value,
  currentPrompt,
  candidatePrompt = null,
  isSubmitting = false,
  isSaving = false,
  onChange,
  onClose,
  onGenerate,
  onUseCandidate,
}: RegenerateVideoPromptModalProps) {
  if (!open || typeof document === 'undefined') return null
  const isBusy = isSubmitting || isSaving

  return createPortal(
    <div
      className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={isBusy ? undefined : onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold text-[var(--glass-text-primary)]">{title}</div>
            <p className="mt-1 text-sm leading-6 text-[var(--glass-text-secondary)]">{description}</p>
          </div>
          <button
            type="button"
            disabled={isBusy}
            className="rounded-full p-2 text-[var(--glass-text-tertiary)] transition hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClose}
          >
            <AppIcon name="close" className="h-4 w-4" />
          </button>
        </div>
        <textarea
          value={value}
          disabled={isBusy}
          rows={4}
          className="w-full resize-y rounded-lg border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-muted)] px-3 py-2 text-sm leading-6 text-[var(--glass-text-secondary)] outline-none transition focus:border-[var(--glass-tone-info-fg)] disabled:opacity-70"
          placeholder="例如：加强压迫感、背景音乐用古风悲情婉转二胡、动作不要夸张、台词声音低沉克制..."
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
          <div className="min-h-0 rounded-lg border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-muted)]">
            <div className="border-b border-[var(--glass-stroke-subtle)] px-3 py-2 text-xs font-semibold text-[var(--glass-text-secondary)]">
              当前版本
            </div>
            <div className="max-h-[42vh] overflow-y-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-[var(--glass-text-secondary)]">
              {currentPrompt.trim() || <span className="text-[var(--glass-text-tertiary)]">暂无当前提示词</span>}
            </div>
          </div>
          <div className="min-h-0 rounded-lg border border-[var(--glass-tone-info-fg)]/40 bg-[var(--glass-bg-surface-strong)]">
            <div className="border-b border-[var(--glass-stroke-subtle)] px-3 py-2 text-xs font-semibold text-[var(--glass-tone-info-fg)]">
              新生成版本
            </div>
            <div className="max-h-[42vh] overflow-y-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-[var(--glass-text-primary)]">
              {candidatePrompt?.trim() || (
                <span className="text-[var(--glass-text-tertiary)]">
                  点击“生成候选”后会显示新版本，不会自动覆盖当前提示词。
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={isBusy}
            className="rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] px-4 py-2 text-sm text-[var(--glass-text-secondary)] transition hover:bg-[var(--glass-bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={isBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface-strong)] px-4 py-2 text-sm font-medium text-[var(--glass-text-primary)] transition hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onGenerate}
          >
            {isSubmitting ? <AppIcon name="refresh" className="h-4 w-4 animate-spin" /> : <AppIcon name="sparklesAlt" className="h-4 w-4" />}
            {isSubmitting ? '生成中...' : candidatePrompt ? '重新生成候选' : '生成候选'}
          </button>
          <button
            type="button"
            disabled={isBusy || !candidatePrompt?.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--glass-tone-info-fg)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onUseCandidate}
          >
            {isSaving ? <AppIcon name="refresh" className="h-4 w-4 animate-spin" /> : <AppIcon name="check" className="h-4 w-4" />}
            {isSaving ? '保存中...' : '使用新版本'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
