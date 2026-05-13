'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import PanelEditForm, { PanelEditData } from '../PanelEditForm'
import ImageSection from './ImageSection'
import PanelActionButtons from './PanelActionButtons'
import { StoryboardPanel } from './hooks/useStoryboardState'
import { GlassSurface } from '@/components/ui/primitives'
import { AppIcon } from '@/components/ui/icons'
import { useRefineProjectStoryboardPrompt } from '@/lib/query/hooks'
import { shouldShowError } from '@/lib/error-utils'
import { extractErrorMessage } from '@/lib/errors/extract'
import type { NovelPromotionPanelFrame } from '@/types/project'

interface PanelCandidateData {
  candidates: string[]
  selectedIndex: number
}

interface PanelCardProps {
  projectId: string
  panel: StoryboardPanel
  panelData: PanelEditData
  imageUrl: string | null
  globalPanelNumber: number
  storyboardId: string
  videoRatio: string
  isSaving: boolean
  hasUnsavedChanges?: boolean
  saveErrorMessage?: string | null
  isDeleting: boolean
  isModifying: boolean
  isSubmittingPanelImageTask: boolean
  isQueued?: boolean
  failedError: string | null
  candidateData: PanelCandidateData | null
  previousImageUrl?: string | null  // 支持撤回
  onUpdate: (updates: Partial<PanelEditData>) => void
  onDelete: () => void
  onOpenCharacterPicker: () => void
  onOpenLocationPicker: () => void
  onRetrySave?: () => void
  onRemoveCharacter: (index: number) => void
  onRemoveLocation: () => void
  onRegeneratePanelImage: (panelId: string, count?: number, force?: boolean) => void
  onUploadImage?: (panelId: string, file: File) => void | Promise<void>
  onUploadFrameImage?: (frameId: string, file: File) => void | Promise<void>
  onRegenerateFrameImage?: (panelId: string, frameId: string) => void | Promise<void>
  onUpdateFrameTime?: (frameId: string, frameTimeSec: number) => void | Promise<void>
  onUpdateFramePrompt?: (frameId: string, imagePrompt: string) => void | Promise<void>
  onDeleteFrame?: (panelId: string, frameId: string) => void | Promise<void>
  onOpenEditModal: () => void
  onOpenAIDataModal: () => void
  onSelectCandidateIndex: (panelId: string, index: number) => void
  onConfirmCandidate: (panelId: string, imageUrl: string) => Promise<void>
  onCancelCandidate: (panelId: string) => void
  onClearError: () => void
  onUndo?: (panelId: string) => void  // 撤回到上一版本
  onPreviewImage?: (url: string) => void  // 放大预览图片
  onInsertAfter?: () => void  // 在此镜头后插入
  onDuplicatePanel?: () => void | Promise<void> // 复制到下一分镜
  onVariant?: () => void  // 生成镜头变体
  isInsertDisabled?: boolean  // 插入按钮是否禁用
}

function PanelFrameGrid({
  panelId,
  frames,
  onPreviewImage,
  onUploadFrameImage,
  onRegenerateFrameImage,
  onUpdateFrameTime,
  onUpdateFramePrompt,
  onDeleteFrame,
}: {
  panelId: string
  frames: NovelPromotionPanelFrame[]
  onPreviewImage?: (url: string) => void
  onUploadFrameImage?: (frameId: string, file: File) => void | Promise<void>
  onRegenerateFrameImage?: (panelId: string, frameId: string) => void | Promise<void>
  onUpdateFrameTime?: (frameId: string, frameTimeSec: number) => void | Promise<void>
  onUpdateFramePrompt?: (frameId: string, imagePrompt: string) => void | Promise<void>
  onDeleteFrame?: (panelId: string, frameId: string) => void | Promise<void>
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [frameTimeDrafts, setFrameTimeDrafts] = useState<Record<string, string>>({})
  const [framePromptDrafts, setFramePromptDrafts] = useState<Record<string, string>>({})
  const [savingFrameTimeIds, setSavingFrameTimeIds] = useState<Set<string>>(new Set())
  const [savingFramePromptIds, setSavingFramePromptIds] = useState<Set<string>>(new Set())
  if (frames.length <= 1) return null

  const parseDependencies = (raw: string | null | undefined): number[] => {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .map((item) => {
          const value = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN
          return Number.isFinite(value) ? Math.floor(value) : null
        })
        .filter((item): item is number => item !== null && item >= 0)
    } catch {
      return []
    }
  }

  const getRelationText = (frame: NovelPromotionPanelFrame) => {
    const dependencyIndexes = parseDependencies(frame.dependencyFrameIds)
    if (dependencyIndexes.length > 0) {
      return `参考 ${dependencyIndexes.map((index) => `F${index + 1}`).join('、')}`
    }
    return frame.frameIndex === 0 ? '基础帧' : `承接 F${frame.frameIndex}`
  }

  const flowItems = frames.map((frame) => ({
    id: frame.id,
    label: `F${frame.frameIndex + 1}`,
    time: `${frame.frameTimeSec}s`,
    relation: getRelationText(frame),
  }))

  const handleFrameUpload = (frameId: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || !onUploadFrameImage) return
    void Promise.resolve(onUploadFrameImage(frameId, file)).catch((error: unknown) => {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '上传关键帧图片失败'))
      }
    })
  }

  const hasFrameImage = (frame: NovelPromotionPanelFrame | undefined) => {
    return Boolean(typeof frame?.imageUrl === 'string' && frame.imageUrl.trim())
  }

  const isStaleFrameProcessing = (frame: NovelPromotionPanelFrame) => {
    if (frame.generationStatus !== 'processing') return false
    const updatedAt = frame.updatedAt ? new Date(frame.updatedAt).getTime() : 0
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
    return Date.now() - updatedAt > 5 * 60 * 1000
  }

  const handleRegenerateFrame = (frame: NovelPromotionPanelFrame) => {
    if (!onRegenerateFrameImage) return
    const missingDependencyIndexes = parseDependencies(frame.dependencyFrameIds)
      .filter((dependencyIndex) => !hasFrameImage(frames.find((item) => item.frameIndex === dependencyIndex)))
    if (missingDependencyIndexes.length > 0) {
      alert(`请先生成关联帧 ${missingDependencyIndexes.map((index) => `F${index + 1}`).join('、')}，再重新生成 F${frame.frameIndex + 1}`)
      return
    }
    void Promise.resolve(onRegenerateFrameImage(panelId, frame.id)).catch((error: unknown) => {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '重新生成关键帧失败'))
      }
    })
  }

  const handleDeleteFrame = (frame: NovelPromotionPanelFrame) => {
    if (!onDeleteFrame) return
    if (frames.length <= 1) {
      alert('至少需要保留 1 张关键帧')
      return
    }
    const confirmed = window.confirm(`确定删除 F${frame.frameIndex + 1} 吗？删除后会自动重排后续关键帧编号和依赖关系。`)
    if (!confirmed) return
    void Promise.resolve(onDeleteFrame(panelId, frame.id)).catch((error: unknown) => {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '删除关键帧失败'))
      }
    })
  }

  const getFramePrompt = (frame: NovelPromotionPanelFrame) => frame.imagePrompt || frame.videoPrompt || ''

  const getFramePromptDraft = (frame: NovelPromotionPanelFrame) => {
    return framePromptDrafts[frame.id] ?? getFramePrompt(frame)
  }

  const setFramePromptDraft = (frameId: string, value: string) => {
    setFramePromptDrafts((prev) => ({ ...prev, [frameId]: value }))
  }

  const handleCopyFramePrompt = async (frame: NovelPromotionPanelFrame) => {
    const prompt = getFramePromptDraft(frame).trim() || getFramePrompt(frame).trim()
    if (!prompt) {
      alert('暂无提示词可复制')
      return
    }
    try {
      await navigator.clipboard.writeText(prompt)
    } catch {
      const input = document.createElement('textarea')
      input.value = prompt
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      document.body.removeChild(input)
    }
  }

  const saveFramePrompt = async (frame: NovelPromotionPanelFrame) => {
    if (!onUpdateFramePrompt) return
    const nextPrompt = getFramePromptDraft(frame).trim()
    const currentPrompt = String(frame.imagePrompt || '').trim()
    if (nextPrompt === currentPrompt) return
    setSavingFramePromptIds((prev) => new Set(prev).add(frame.id))
    try {
      await Promise.resolve(onUpdateFramePrompt(frame.id, nextPrompt))
      setFramePromptDraft(frame.id, nextPrompt)
    } catch (error: unknown) {
      setFramePromptDraft(frame.id, getFramePrompt(frame))
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '更新关键帧提示词失败'))
      }
    } finally {
      setSavingFramePromptIds((prev) => {
        const next = new Set(prev)
        next.delete(frame.id)
        return next
      })
    }
  }

  const getFrameTimeDraft = (frame: NovelPromotionPanelFrame) => {
    return frameTimeDrafts[frame.id] ?? String(frame.frameTimeSec)
  }

  const setFrameTimeDraft = (frameId: string, value: string) => {
    setFrameTimeDrafts((prev) => ({ ...prev, [frameId]: value }))
  }

  const commitFrameTime = async (frame: NovelPromotionPanelFrame) => {
    if (!onUpdateFrameTime || frame.frameIndex === 0) return
    const raw = getFrameTimeDraft(frame).trim()
    const nextValue = Number(raw)
    if (!Number.isFinite(nextValue) || nextValue <= 0) {
      alert('F1 之后的关键帧起始时间必须大于 0 秒')
      setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
      return
    }
    const normalized = Math.round(nextValue * 100) / 100
    if (normalized === frame.frameTimeSec) {
      setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
      return
    }
    setSavingFrameTimeIds((prev) => new Set(prev).add(frame.id))
    try {
      await Promise.resolve(onUpdateFrameTime(frame.id, normalized))
      setFrameTimeDraft(frame.id, String(normalized))
    } catch (error: unknown) {
      setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '更新关键帧时间失败'))
      }
    } finally {
      setSavingFrameTimeIds((prev) => {
        const next = new Set(prev)
        next.delete(frame.id)
        return next
      })
    }
  }

  const renderFrameTimeControl = (frame: NovelPromotionPanelFrame, compact = false) => {
    if (!onUpdateFrameTime || frame.frameIndex === 0) {
      return (
        <span className="shrink-0 rounded-full bg-[var(--glass-bg-muted)] px-1.5 py-0.5 text-[10px] text-[var(--glass-text-tertiary)]">
          {frame.frameTimeSec}s
        </span>
      )
    }
    const isSaving = savingFrameTimeIds.has(frame.id)
    return (
      <label className={`shrink-0 rounded-full border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-muted)] text-[10px] text-[var(--glass-text-secondary)] ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}>
        <span className="sr-only">F{frame.frameIndex + 1} 起始时间</span>
        <input
          type="number"
          min="0.1"
          step="0.1"
          value={getFrameTimeDraft(frame)}
          disabled={isSaving}
          className={`${compact ? 'w-10' : 'w-12'} bg-transparent text-right text-[10px] font-medium outline-none disabled:opacity-60`}
          onChange={(event) => setFrameTimeDraft(frame.id, event.currentTarget.value)}
          onBlur={() => void commitFrameTime(frame)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              setFrameTimeDraft(frame.id, String(frame.frameTimeSec))
              event.currentTarget.blur()
            }
          }}
        />
        <span className="ml-0.5">s</span>
      </label>
    )
  }

  return (
    <div className="border-t border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-surface)] px-3 py-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-[var(--glass-text-secondary)]">
          分镜组关键帧 · {frames.length} 帧
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-[var(--glass-stroke-subtle)] px-2 py-1 text-[11px] text-[var(--glass-text-secondary)] hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)]"
            onClick={() => setIsExpanded(true)}
          >
            <AppIcon name="externalLink" size={12} />
            展开查看
          </button>
          <div className="flex items-center gap-1 text-[11px] text-[var(--glass-text-tertiary)]">
            <AppIcon name="link" size={12} />
            连贯参考链
          </div>
        </div>
      </div>
      <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
        {flowItems.map((item, index) => (
          <div key={item.id} className="flex shrink-0 items-center gap-1.5">
            <div
              className="rounded-full border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-surface-strong)] px-2 py-1 shadow-sm"
              title={`${item.label} · ${item.relation}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-[var(--glass-text-primary)]">{item.label}</span>
                <span className="h-1 w-1 rounded-full bg-[var(--glass-text-tertiary)]" />
                <span className="text-[10px] text-[var(--glass-text-tertiary)]">{item.time}</span>
              </div>
            </div>
            {index < flowItems.length - 1 ? (
              <AppIcon name="arrowRight" size={13} className="text-[var(--glass-text-tertiary)]" />
            ) : null}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {frames.map((frame) => {
          const imageUrl = frame.imageUrl || ''
          const relationText = getRelationText(frame)
          const isFrameStaleProcessing = isStaleFrameProcessing(frame)
          const isFrameBusy = frame.generationStatus === 'processing' && !isFrameStaleProcessing
          return (
            <div
              key={frame.id}
              className="group/frame overflow-hidden rounded-[var(--glass-radius-md)] border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-surface-strong)] text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--glass-tone-info-fg)] hover:shadow-md"
              title={frame.imagePrompt || frame.videoPrompt || undefined}
            >
              <div className="relative aspect-video bg-[var(--glass-bg-muted)]">
                <button
                  type="button"
                  className="absolute inset-0 h-full w-full text-left"
                  onClick={() => {
                    if (imageUrl) onPreviewImage?.(imageUrl)
                  }}
                  aria-label={`预览关键帧 F${frame.frameIndex + 1}`}
                >
                  {imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl}
                      alt={`frame ${frame.frameIndex + 1}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-1 text-xs text-[var(--glass-text-tertiary)]">
                      <span>待生成</span>
                      {isFrameStaleProcessing ? (
                        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-600">可重试</span>
                      ) : null}
                    </div>
                  )}
                </button>
                <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/55 to-transparent p-2">
                  <div className="rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-semibold text-slate-900 shadow-sm">
                    F{frame.frameIndex + 1}
                  </div>
                  <div className="flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                    <AppIcon name="clock" size={10} />
                    {frame.frameTimeSec}s
                  </div>
                </div>
                <div className="absolute bottom-2 right-2 flex items-center gap-1 opacity-90 transition sm:opacity-0 sm:group-hover/frame:opacity-100">
                  {onRegenerateFrameImage ? (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/45 bg-black/55 text-white shadow-sm backdrop-blur transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-60"
                      title={`重新生成 F${frame.frameIndex + 1}${parseDependencies(frame.dependencyFrameIds).length > 0 ? '，会参考已生成的关联帧' : ''}`}
                      aria-label={`重新生成 F${frame.frameIndex + 1}`}
                      disabled={isFrameBusy}
                      onClick={() => handleRegenerateFrame(frame)}
                    >
                      <AppIcon name="refresh" size={13} className={isFrameBusy ? 'animate-spin' : undefined} />
                    </button>
                  ) : null}
                  {onUploadFrameImage ? (
                    <label
                      className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/45 bg-black/55 text-white shadow-sm backdrop-blur transition hover:bg-black/70"
                      title={`上传替换 F${frame.frameIndex + 1}`}
                      aria-label={`上传替换 F${frame.frameIndex + 1}`}
                    >
                      <AppIcon name="upload" size={13} />
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => handleFrameUpload(frame.id, event)}
                      />
                    </label>
                  ) : null}
                  {onDeleteFrame ? (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/45 bg-red-600/80 text-white shadow-sm backdrop-blur transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                      title={`删除 F${frame.frameIndex + 1}`}
                      aria-label={`删除 F${frame.frameIndex + 1}`}
                      disabled={isFrameBusy || frames.length <= 1}
                      onClick={() => handleDeleteFrame(frame)}
                    >
                      <AppIcon name="trash" size={13} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="space-y-1.5 p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-[11px] font-medium text-[var(--glass-text-secondary)]">
                    {frame.frameRole || '关键状态'}
                  </div>
                  {renderFrameTimeControl(frame, true)}
                </div>
                <div className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--glass-stroke-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--glass-text-secondary)]">
                  <AppIcon name="link" size={10} className="shrink-0" />
                  {relationText}
                </div>
                <div className="flex items-start gap-1.5">
                  <div className="max-h-20 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-[var(--glass-text-tertiary)]">
                    {getFramePrompt(frame) || '暂无提示词'}
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--glass-stroke-subtle)] text-[var(--glass-text-tertiary)] transition hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)]"
                    title={`复制 F${frame.frameIndex + 1} 提示词`}
                    aria-label={`复制 F${frame.frameIndex + 1} 提示词`}
                    onClick={() => void handleCopyFramePrompt(frame)}
                  >
                    <AppIcon name="copy" size={12} />
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {isExpanded && typeof document !== 'undefined' ? createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setIsExpanded(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-6xl overflow-hidden rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--glass-stroke-subtle)] px-4 py-3">
              <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
                分镜组关键帧 · {frames.length} 帧
              </div>
              <button
                type="button"
                className="rounded-full p-2 text-[var(--glass-text-tertiary)] hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)]"
                onClick={() => setIsExpanded(false)}
              >
                <AppIcon name="close" size={18} />
              </button>
            </div>
            <div className="max-h-[calc(90vh-56px)] overflow-y-auto p-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {frames.map((frame) => (
                  <div key={frame.id} className="overflow-hidden rounded-lg border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-surface-strong)]">
                    <button
                      type="button"
                      className="relative block aspect-video w-full bg-[var(--glass-bg-muted)]"
                      onClick={() => frame.imageUrl && onPreviewImage?.(frame.imageUrl)}
                    >
                      {frame.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={frame.imageUrl} alt={`F${frame.frameIndex + 1}`} className="h-full w-full object-contain" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm text-[var(--glass-text-tertiary)]">待生成</div>
                      )}
                      <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-1 text-xs font-semibold text-white">
                        F{frame.frameIndex + 1} · {frame.frameTimeSec}s
                      </span>
                    </button>
                    <div className="space-y-2 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--glass-text-secondary)]">
                        <span className="rounded-full bg-[var(--glass-bg-muted)] px-2 py-0.5">{frame.frameRole || '关键状态'}</span>
                        <span className="rounded-full border border-[var(--glass-stroke-subtle)] px-2 py-0.5">{getRelationText(frame)}</span>
                        {renderFrameTimeControl(frame)}
                        {onDeleteFrame ? (
                          <button
                            type="button"
                            className="rounded-full border border-red-300/40 px-2 py-0.5 text-red-500 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={(frame.generationStatus === 'processing' && !isStaleFrameProcessing(frame)) || frames.length <= 1}
                            onClick={() => handleDeleteFrame(frame)}
                          >
                            删除
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="rounded-full border border-[var(--glass-stroke-subtle)] px-2 py-0.5 text-[var(--glass-text-secondary)] transition hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)]"
                          onClick={() => void handleCopyFramePrompt(frame)}
                        >
                          复制提示词
                        </button>
                      </div>
                      <textarea
                        value={getFramePromptDraft(frame)}
                        disabled={!onUpdateFramePrompt || savingFramePromptIds.has(frame.id)}
                        rows={7}
                        className="w-full resize-y rounded-lg border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-muted)] px-3 py-2 text-xs leading-5 text-[var(--glass-text-secondary)] outline-none transition focus:border-[var(--glass-tone-info-fg)] disabled:opacity-70"
                        placeholder="暂无提示词"
                        onChange={(event) => setFramePromptDraft(frame.id, event.currentTarget.value)}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          className="rounded-full border border-[var(--glass-stroke-subtle)] px-3 py-1 text-xs text-[var(--glass-text-secondary)] transition hover:bg-[var(--glass-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!onUpdateFramePrompt || savingFramePromptIds.has(frame.id)}
                          onClick={() => setFramePromptDraft(frame.id, getFramePrompt(frame))}
                        >
                          还原
                        </button>
                        <button
                          type="button"
                          className="rounded-full bg-[var(--glass-tone-info-fg)] px-3 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!onUpdateFramePrompt || savingFramePromptIds.has(frame.id)}
                          onClick={() => void saveFramePrompt(frame)}
                        >
                          {savingFramePromptIds.has(frame.id) ? '保存中...' : '保存提示词'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

export default function PanelCard({
  projectId,
  panel,
  panelData,
  imageUrl,
  globalPanelNumber,
  storyboardId,
  videoRatio,
  isSaving,
  hasUnsavedChanges = false,
  saveErrorMessage = null,
  isDeleting,
  isModifying,
  isSubmittingPanelImageTask,
  isQueued = false,
  failedError,
  candidateData,
  previousImageUrl,
  onUpdate,
  onDelete,
  onOpenCharacterPicker,
  onOpenLocationPicker,
  onRetrySave,
  onRemoveCharacter,
  onRemoveLocation,
  onRegeneratePanelImage,
  onUploadImage,
  onUploadFrameImage,
  onRegenerateFrameImage,
  onUpdateFrameTime,
  onUpdateFramePrompt,
  onDeleteFrame,
  onOpenEditModal,
  onOpenAIDataModal,
  onSelectCandidateIndex,
  onConfirmCandidate,
  onCancelCandidate,
  onClearError,
  onUndo,
  onPreviewImage,
  onInsertAfter,
  onDuplicatePanel,
  onVariant,
  isInsertDisabled
}: PanelCardProps) {
  const t = useTranslations('storyboard')
  const locale = useLocale()
  const refineStoryboardPrompt = useRefineProjectStoryboardPrompt(projectId)
  const [refinedStoryboardPrompt, setRefinedStoryboardPrompt] = useState<string | null>(null)
  const [isDuplicatingPanel, setIsDuplicatingPanel] = useState(false)
  const panelFrames = Array.isArray(panel.frames) ? panel.frames : []

  const handleRefineStoryboardPrompt = async () => {
    try {
      setRefinedStoryboardPrompt(null)
      const result = await refineStoryboardPrompt.mutateAsync({
        panelId: panel.id,
        locale: locale === 'en' ? 'en' : 'zh',
        draft: {
          shotType: panelData.shotType,
          cameraMove: panelData.cameraMove,
          description: panelData.description,
          videoPrompt: panelData.videoPrompt,
          location: panelData.location,
          characters: panelData.characters,
        },
      })
      const nextPrompt = (result.prompt || result.refinedPrompt || '').trim()
      if (!nextPrompt) {
        throw new Error(t('panel.refineStoryboardPromptEmptyResult'))
      }
      setRefinedStoryboardPrompt(nextPrompt)
    } catch (error: unknown) {
      if (shouldShowError(error)) {
        alert(t('messages.refinePromptFailed', {
          error: extractErrorMessage(error, t('common.unknownError')),
        }))
      }
    }
  }

  const handleDuplicatePanel = () => {
    if (!onDuplicatePanel || isDuplicatingPanel) return
    setIsDuplicatingPanel(true)
    void Promise.resolve(onDuplicatePanel())
      .catch((error: unknown) => {
        if (shouldShowError(error)) {
          alert(extractErrorMessage(error, '复制分镜失败'))
        }
      })
      .finally(() => setIsDuplicatingPanel(false))
  }

  return (
    <GlassSurface
      variant="elevated"
      padded={false}
      className="relative h-full overflow-visible transition-all hover:shadow-[var(--glass-shadow-md)] group/card"
      data-storyboard-id={storyboardId}
    >
      {/* 删除按钮 - 右上角外部 */}
      {!isModifying && !isDeleting && (
        <button
          onClick={onDelete}
          className="absolute -top-2 -right-2 z-10 opacity-0 group-hover/card:opacity-100 transition-opacity bg-[var(--glass-tone-danger-fg)] hover:bg-[var(--glass-tone-danger-fg)] text-white w-5 h-5 rounded-full flex items-center justify-center text-xs shadow-md"
          title={t('panelActions.deleteShot')}
        >
          <AppIcon name="closeMd" className="h-3 w-3" />
        </button>
      )}

      {/* 镜头图片区域 - 包含插入按钮 */}
      <div className="relative">
        <ImageSection
          projectId={projectId}
          panelId={panel.id}
          imageUrl={imageUrl}
          globalPanelNumber={globalPanelNumber}
          shotType={panel.shot_type}
          videoRatio={videoRatio}
          isDeleting={isDeleting}
          isModifying={isModifying}
          isSubmittingPanelImageTask={isSubmittingPanelImageTask}
          isQueued={isQueued}
          failedError={failedError}
          candidateData={candidateData}
          previousImageUrl={previousImageUrl}
          onRegeneratePanelImage={onRegeneratePanelImage}
          onUploadImage={onUploadImage}
          onOpenEditModal={onOpenEditModal}
          onOpenAIDataModal={onOpenAIDataModal}
          onSelectCandidateIndex={onSelectCandidateIndex}
          onConfirmCandidate={onConfirmCandidate}
          onCancelCandidate={onCancelCandidate}
          onClearError={onClearError}
          onUndo={onUndo}
          onPreviewImage={onPreviewImage}
        />
        <PanelFrameGrid
          panelId={panel.id}
          frames={panelFrames}
          onPreviewImage={onPreviewImage}
          onUploadFrameImage={onUploadFrameImage}
          onRegenerateFrameImage={onRegenerateFrameImage}
          onUpdateFrameTime={onUpdateFrameTime}
          onUpdateFramePrompt={onUpdateFramePrompt}
          onDeleteFrame={onDeleteFrame}
        />
        {/* 插入分镜/镜头变体按钮 - 在图片区域右侧垂直居中 */}
        {(onInsertAfter || onDuplicatePanel || onVariant) && (
          <div className="absolute -right-[22px] top-1/2 -translate-y-1/2 z-50">
            <PanelActionButtons
              onInsertPanel={onInsertAfter || (() => { })}
              onDuplicatePanel={onDuplicatePanel ? handleDuplicatePanel : undefined}
              onVariant={onVariant || (() => { })}
              disabled={isInsertDisabled || isDuplicatingPanel}
              hasImage={!!imageUrl}
            />
          </div>
        )}
      </div>

      {/* 分镜信息编辑区 */}
      <div className="p-3">
        <PanelEditForm
          panelData={panelData}
          isSaving={isSaving}
          saveStatus={hasUnsavedChanges ? 'error' : (isSaving ? 'saving' : 'idle')}
          saveErrorMessage={saveErrorMessage}
          onRetrySave={onRetrySave}
          onUpdate={onUpdate}
          onOpenCharacterPicker={onOpenCharacterPicker}
          onOpenLocationPicker={onOpenLocationPicker}
          onRemoveCharacter={onRemoveCharacter}
          onRemoveLocation={onRemoveLocation}
          onRefineStoryboardPrompt={handleRefineStoryboardPrompt}
          isRefiningStoryboardPrompt={refineStoryboardPrompt.isPending}
          refinedStoryboardPrompt={refinedStoryboardPrompt}
          onClearRefinedStoryboardPrompt={() => setRefinedStoryboardPrompt(null)}
        />
      </div>
    </GlassSurface>
  )
}
