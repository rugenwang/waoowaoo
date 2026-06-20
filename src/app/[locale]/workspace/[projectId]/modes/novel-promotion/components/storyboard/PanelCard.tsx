'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useState, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import PanelEditForm, { PanelEditData } from '../PanelEditForm'
import RegenerateVideoPromptModal from '../RegenerateVideoPromptModal'
import ImageSection from './ImageSection'
import PanelActionButtons from './PanelActionButtons'
import { StoryboardPanel } from './hooks/useStoryboardState'
import { GlassSurface } from '@/components/ui/primitives'
import { AppIcon } from '@/components/ui/icons'
import { useRefineProjectStoryboardPrompt, useRegenerateProjectVideoPrompt, useUpdateProjectPanelVideoPrompt } from '@/lib/query/hooks'
import { useTaskTargetStateMap } from '@/lib/query/hooks/useTaskTargetStateMap'
import { shouldShowError } from '@/lib/error-utils'
import { extractErrorMessage } from '@/lib/errors/extract'
import { downloadRemoteFile } from '@/lib/media/download-remote-file'
import { toDisplayImageUrl } from '@/lib/media/image-url'
import type { NovelPromotionPanelFrame } from '@/types/project'

interface PanelCandidateData {
  candidates: string[]
  selectedIndex: number
}

export interface PreviousPanelImageOption {
  id: string
  label: string
  imageUrl: string
}

function PreviousTailReferenceButton({
  enabled,
  disabled,
  onToggle,
}: {
  enabled?: boolean
  disabled?: boolean
  onToggle: () => void | Promise<void>
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
        enabled
          ? 'border-[var(--glass-tone-success-fg)] bg-[var(--glass-tone-success-fg)] text-white shadow-sm'
          : 'border-[var(--glass-tone-info-fg)] bg-[var(--glass-tone-info-bg)] text-[var(--glass-tone-info-fg)] hover:bg-[var(--glass-bg-muted)]'
      }`}
      disabled={disabled}
      onClick={() => void onToggle()}
      title={enabled ? '当前分镜已链接上一分镜尾帧' : '让当前分镜首帧参考上一分镜尾帧'}
    >
      <AppIcon name="link" size={12} />
      {enabled ? '已链接上一尾帧' : '链接上一尾帧'}
    </button>
  )
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
  onOpenPropPicker: () => void
  onRetrySave?: () => void
  onRemoveCharacter: (index: number) => void
  onRemoveLocation: () => void
  onRemoveProp: (index: number) => void
  onRegeneratePanelImage: (panelId: string, count?: number, force?: boolean) => void
  onUploadImage?: (panelId: string, file: File) => void | Promise<void>
  onUploadImageFromSource?: (panelId: string, sourceImageUrl: string) => void | Promise<void>
  onUploadFrameImage?: (frameId: string, file: File) => void | Promise<void>
  onUploadFrameImageFromSource?: (frameId: string, sourceImageUrl: string) => void | Promise<void>
  onRegenerateFrameImage?: (panelId: string, frameId: string) => void | Promise<void>
  onUpdateFrameTime?: (frameId: string, frameTimeSec: number) => void | Promise<void>
  onUpdateFramePrompt?: (frameId: string, imagePrompt: string) => void | Promise<void>
  onInsertFrame?: (payload: { panelId?: string; frameId?: string; placement?: 'before' | 'after' }) => void | Promise<void>
  onDeleteFrame?: (panelId: string, frameId: string) => void | Promise<void>
  onSplitFrame?: (frameId: string, placement: 'before' | 'after') => void | Promise<void>
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
  onMergePanelWithNext?: () => void | Promise<void> // 合并下一分镜为分镜组
  onToggleUsePreviousPanelTail?: (enabled: boolean) => void | Promise<void>
  onVariant?: () => void  // 生成镜头变体
  isInsertDisabled?: boolean  // 插入按钮是否禁用
  hasPreviousPanel?: boolean
  previousPanelImageOptions?: PreviousPanelImageOption[]
}

function PanelFrameGrid({
  projectId,
  panelId,
  frames,
  videoRatio,
  onPreviewImage,
  onUploadFrameImage,
  onPickPreviousImage,
  onRegenerateFrameImage,
  onUpdateFrameTime,
  onUpdateFramePrompt,
  onInsertFrame,
  onDeleteFrame,
  onSplitFrame,
  usePreviousPanelTailAsReference,
  onToggleUsePreviousPanelTail,
  previousPanelTailDisabled,
}: {
  projectId: string
  panelId: string
  frames: NovelPromotionPanelFrame[]
  videoRatio: string
  onPreviewImage?: (url: string) => void
  onUploadFrameImage?: (frameId: string, file: File) => void | Promise<void>
  onPickPreviousImage?: (frame: NovelPromotionPanelFrame) => void
  onRegenerateFrameImage?: (panelId: string, frameId: string) => void | Promise<void>
  onUpdateFrameTime?: (frameId: string, frameTimeSec: number) => void | Promise<void>
  onUpdateFramePrompt?: (frameId: string, imagePrompt: string) => void | Promise<void>
  onInsertFrame?: (payload: { panelId?: string; frameId?: string; placement?: 'before' | 'after' }) => void | Promise<void>
  onDeleteFrame?: (panelId: string, frameId: string) => void | Promise<void>
  onSplitFrame?: (frameId: string, placement: 'before' | 'after') => void | Promise<void>
  usePreviousPanelTailAsReference?: boolean
  onToggleUsePreviousPanelTail?: () => void | Promise<void>
  previousPanelTailDisabled?: boolean
}) {
  const t = useTranslations('storyboard')
  const [isExpanded, setIsExpanded] = useState(false)
  const [frameTimeDrafts, setFrameTimeDrafts] = useState<Record<string, string>>({})
  const [framePromptDrafts, setFramePromptDrafts] = useState<Record<string, string>>({})
  const [savingFrameTimeIds, setSavingFrameTimeIds] = useState<Set<string>>(new Set())
  const [savingFramePromptIds, setSavingFramePromptIds] = useState<Set<string>>(new Set())
  const [downloadingFrameIds, setDownloadingFrameIds] = useState<Set<string>>(new Set())
  const [splitFrameTarget, setSplitFrameTarget] = useState<NovelPromotionPanelFrame | null>(null)
  const frameTaskStateMap = useTaskTargetStateMap(
    projectId,
    frames.map((frame) => ({
      targetType: 'NovelPromotionPanelFrame',
      targetId: frame.id,
      types: ['image_panel'],
    })),
    { enabled: frames.length > 0, staleTime: 2000 },
  )
  if (frames.length === 0) return null
  const [ratioWidth, ratioHeight] = videoRatio.split(':').map((value) => Number(value))
  const isVerticalRatio = Number.isFinite(ratioWidth) && Number.isFinite(ratioHeight) && ratioHeight > ratioWidth
  const frameAspectRatio = Number.isFinite(ratioWidth) && Number.isFinite(ratioHeight) && ratioWidth > 0 && ratioHeight > 0
    ? `${ratioWidth} / ${ratioHeight}`
    : '16 / 9'

  const parseDependencies = (raw: string | null | undefined): { frameIndexes: number[]; previousTail: boolean } => {
    if (!raw) return { frameIndexes: [], previousTail: false }
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return { frameIndexes: [], previousTail: false }
      const frameIndexes: number[] = []
      let previousTail = false
      for (const item of parsed) {
        if (typeof item === 'string' && item.trim().toUpperCase() === 'FP') {
          previousTail = true
          continue
        }
        const value = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN
        if (Number.isFinite(value) && value >= 0) {
          frameIndexes.push(Math.floor(value))
        }
      }
      return { frameIndexes, previousTail }
    } catch {
      return { frameIndexes: [], previousTail: false }
    }
  }

  const getRelationText = (frame: NovelPromotionPanelFrame) => {
    const dependencyPlan = parseDependencies(frame.dependencyFrameIds)
    const labels = [
      dependencyPlan.previousTail ? 'FP' : '',
      ...dependencyPlan.frameIndexes.map((index) => `F${index + 1}`),
    ].filter(Boolean)
    if (labels.length > 0) {
      return `参考 ${labels.join('、')}`
    }
    if (frame.frameIndex === 0 && usePreviousPanelTailAsReference) {
      return '参考 FP'
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
    const taskPhase = frameTaskStateMap.getState('NovelPromotionPanelFrame', frame.id)?.phase || null
    if (taskPhase === 'completed' || taskPhase === 'failed') return true
    const updatedAt = frame.updatedAt ? new Date(frame.updatedAt).getTime() : 0
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false
    if (taskPhase === 'idle' && frameTaskStateMap.isFetched) {
      return Date.now() - updatedAt > 30 * 1000
    }
    return Date.now() - updatedAt > 5 * 60 * 1000
  }

  const isFrameGenerationBusy = (frame: NovelPromotionPanelFrame) => {
    if (frame.generationStatus !== 'processing') return false
    const taskPhase = frameTaskStateMap.getState('NovelPromotionPanelFrame', frame.id)?.phase || null
    if (taskPhase === 'queued' || taskPhase === 'processing') return true
    if (taskPhase === 'completed' || taskPhase === 'failed') return false
    const updatedAt = frame.updatedAt ? new Date(frame.updatedAt).getTime() : 0
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true
    if (taskPhase === 'idle' && frameTaskStateMap.isFetched) {
      return Date.now() - updatedAt <= 30 * 1000
    }
    return Date.now() - updatedAt <= 30 * 1000
  }

  const handleRegenerateFrame = (frame: NovelPromotionPanelFrame) => {
    if (!onRegenerateFrameImage) return
    const dependencyPlan = parseDependencies(frame.dependencyFrameIds)
    const missingDependencyIndexes = dependencyPlan.frameIndexes
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

  const handleSplitFrame = (frame: NovelPromotionPanelFrame) => {
    if (!onSplitFrame) return
    if (frames.length <= 1) {
      alert('只有多帧分镜组可以拆出单帧')
      return
    }
    setSplitFrameTarget(frame)
  }

  const commitSplitFrame = (placement: 'before' | 'after') => {
    if (!onSplitFrame || !splitFrameTarget) return
    const targetFrame = splitFrameTarget
    setSplitFrameTarget(null)
    void Promise.resolve(onSplitFrame(targetFrame.id, placement)).catch((error: unknown) => {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '拆出关键帧失败'))
      }
    })
  }

  const handleInsertFrame = (frame: NovelPromotionPanelFrame, placement: 'before' | 'after') => {
    if (!onInsertFrame) return
    const payload = frame.virtual
      ? { panelId, placement }
      : { frameId: frame.id, placement }
    void Promise.resolve(onInsertFrame(payload)).catch((error: unknown) => {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '插入关键帧失败'))
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

  const handleDownloadFrameImage = async (frame: NovelPromotionPanelFrame) => {
    const imageUrl = frame.imageUrl || ''
    if (!imageUrl || downloadingFrameIds.has(frame.id)) return
    const sourceUrl = toDisplayImageUrl(imageUrl) || imageUrl
    setDownloadingFrameIds((prev) => new Set(prev).add(frame.id))
    try {
      await downloadRemoteFile(sourceUrl, `storyboard-panel-${panelId}-F${frame.frameIndex + 1}`)
    } catch (error: unknown) {
      alert(t('messages.downloadFailed', {
        error: extractErrorMessage(error, t('common.unknownError')),
      }))
    } finally {
      setDownloadingFrameIds((prev) => {
        const next = new Set(prev)
        next.delete(frame.id)
        return next
      })
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
          {frames.length > 1 ? '分镜组关键帧' : '分镜关键帧'} · {frames.length} 帧
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
          {onToggleUsePreviousPanelTail ? (
            <PreviousTailReferenceButton
              enabled={usePreviousPanelTailAsReference}
              disabled={previousPanelTailDisabled}
              onToggle={onToggleUsePreviousPanelTail}
            />
          ) : (
            <div className="flex items-center gap-1 text-[11px] text-[var(--glass-text-tertiary)]">
              <AppIcon name="link" size={12} />
              连贯参考链
            </div>
          )}
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
      <div className={`${isVerticalRatio ? 'flex gap-2 overflow-x-auto pb-1' : 'grid grid-cols-2 gap-2.5 sm:grid-cols-3'}`}>
        {frames.map((frame) => {
          const imageUrl = frame.imageUrl || ''
          const displayImageUrl = toDisplayImageUrl(imageUrl) || imageUrl
          const relationText = getRelationText(frame)
          const isFrameStaleProcessing = isStaleFrameProcessing(frame)
          const isFrameBusy = isFrameGenerationBusy(frame) && !isFrameStaleProcessing
          const isFrameDownloading = downloadingFrameIds.has(frame.id)
          return (
            <div
              key={frame.id}
              className={`group/frame overflow-hidden rounded-[var(--glass-radius-md)] border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-surface-strong)] text-left shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--glass-tone-info-fg)] hover:shadow-md ${isVerticalRatio ? 'w-[118px] shrink-0' : ''}`}
              title={frame.imagePrompt || frame.videoPrompt || undefined}
            >
              <div className={`relative bg-[var(--glass-bg-muted)] ${isVerticalRatio ? 'w-full overflow-hidden rounded-t-[var(--glass-radius-md)]' : 'aspect-video'}`} style={isVerticalRatio ? { aspectRatio: frameAspectRatio } : undefined}>
                <button
                  type="button"
                  className={`group absolute inset-0 h-full w-full text-left ${imageUrl && onPreviewImage ? 'cursor-zoom-in' : 'cursor-default'}`}
                  onClick={() => {
                    if (displayImageUrl) onPreviewImage?.(displayImageUrl)
                  }}
                  aria-label={`预览关键帧 F${frame.frameIndex + 1}`}
                  title={imageUrl && onPreviewImage ? `点击放大 F${frame.frameIndex + 1}` : undefined}
                >
                  {imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={displayImageUrl}
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
                  <div className="inline-flex h-7 min-w-9 items-center justify-center rounded-full border border-white/80 bg-black/75 px-2 text-[11px] font-extrabold leading-none text-white shadow-[0_4px_12px_rgba(0,0,0,0.42)] backdrop-blur">
                    F{frame.frameIndex + 1}
                  </div>
                  <div className="flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                    <AppIcon name="clock" size={10} />
                    {frame.frameTimeSec}s
                  </div>
                </div>
                <div className={`absolute flex max-w-[calc(100%-12px)] flex-wrap items-center justify-end gap-1 opacity-90 transition sm:opacity-0 sm:group-hover/frame:opacity-100 ${isVerticalRatio ? 'bottom-1.5 right-1.5' : 'bottom-2 right-2'}`}>
                  {onRegenerateFrameImage ? (
                    <button
                      type="button"
                      className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-black/55 text-white shadow-sm backdrop-blur transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-60`}
                      title={`重新生成 F${frame.frameIndex + 1}${getRelationText(frame).startsWith('参考') ? `，会${getRelationText(frame)}` : ''}`}
                      aria-label={`重新生成 F${frame.frameIndex + 1}`}
                      disabled={isFrameBusy}
                      onClick={() => handleRegenerateFrame(frame)}
                    >
                      <AppIcon name="refresh" size={isVerticalRatio ? 12 : 13} className={isFrameBusy ? 'animate-spin' : undefined} />
                    </button>
                  ) : null}
                  {onInsertFrame ? (
                    <>
                      <button
                        type="button"
                        className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-blue-600/85 text-white shadow-sm backdrop-blur transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60`}
                        title={`在 F${frame.frameIndex + 1} 前插入关键帧`}
                        aria-label={`在 F${frame.frameIndex + 1} 前插入关键帧`}
                        disabled={isFrameBusy}
                        onClick={() => handleInsertFrame(frame, 'before')}
                      >
                        <AppIcon name="plus" size={isVerticalRatio ? 12 : 13} />
                      </button>
                      <button
                        type="button"
                        className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-indigo-600/85 text-white shadow-sm backdrop-blur transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60`}
                        title={`在 F${frame.frameIndex + 1} 后插入关键帧`}
                        aria-label={`在 F${frame.frameIndex + 1} 后插入关键帧`}
                        disabled={isFrameBusy}
                        onClick={() => handleInsertFrame(frame, 'after')}
                      >
                        <AppIcon name="plusAlt" size={isVerticalRatio ? 12 : 13} />
                      </button>
                    </>
                  ) : null}
                  {imageUrl ? (
                    <button
                      type="button"
                      className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-black/55 text-white shadow-sm backdrop-blur transition hover:bg-black/70 disabled:cursor-not-allowed disabled:opacity-60`}
                      title={`下载 F${frame.frameIndex + 1} 原图`}
                      aria-label={`下载 F${frame.frameIndex + 1} 原图`}
                      disabled={isFrameDownloading}
                      onClick={() => void handleDownloadFrameImage(frame)}
                    >
                      <AppIcon name={isFrameDownloading ? 'refresh' : 'download'} size={isVerticalRatio ? 12 : 13} className={isFrameDownloading ? 'animate-spin' : undefined} />
                    </button>
                  ) : null}
                  {onUploadFrameImage ? (
                    <label
                      className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex cursor-pointer items-center justify-center rounded-full border border-white/45 bg-black/55 text-white shadow-sm backdrop-blur transition hover:bg-black/70`}
                      title={`上传替换 F${frame.frameIndex + 1}`}
                      aria-label={`上传替换 F${frame.frameIndex + 1}`}
                    >
                      <AppIcon name="upload" size={isVerticalRatio ? 12 : 13} />
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(event) => handleFrameUpload(frame.id, event)}
                      />
                    </label>
                  ) : null}
                  {onPickPreviousImage ? (
                    <button
                      type="button"
                      className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-emerald-600/85 text-white shadow-sm backdrop-blur transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60`}
                      title={`从上一大分镜选择图片替换 F${frame.frameIndex + 1}`}
                      aria-label={`从上一大分镜选择图片替换 F${frame.frameIndex + 1}`}
                      disabled={isFrameBusy}
                      onClick={() => onPickPreviousImage(frame)}
                    >
                      <AppIcon name="imagePreview" size={isVerticalRatio ? 12 : 13} />
                    </button>
                  ) : null}
                  {onDeleteFrame ? (
                    <button
                      type="button"
                      className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-red-600/80 text-white shadow-sm backdrop-blur transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60`}
                      title={`删除 F${frame.frameIndex + 1}`}
                      aria-label={`删除 F${frame.frameIndex + 1}`}
                      disabled={isFrameBusy || frames.length <= 1}
                      onClick={() => handleDeleteFrame(frame)}
                    >
                      <AppIcon name="trash" size={isVerticalRatio ? 12 : 13} />
                    </button>
                  ) : null}
                  {onSplitFrame ? (
                    <button
                      type="button"
                      className={`${isVerticalRatio ? 'h-6 w-6' : 'h-7 w-7'} inline-flex items-center justify-center rounded-full border border-white/45 bg-sky-600/85 text-white shadow-sm backdrop-blur transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60`}
                      title={`拆出 F${frame.frameIndex + 1} 为独立分镜`}
                      aria-label={`拆出 F${frame.frameIndex + 1} 为独立分镜`}
                      disabled={isFrameBusy || frames.length <= 1}
                      onClick={() => handleSplitFrame(frame)}
                    >
                      <AppIcon name="externalLink" size={isVerticalRatio ? 12 : 13} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className={isVerticalRatio ? 'space-y-1 p-1.5' : 'space-y-1.5 p-2'}>
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-[11px] font-medium text-[var(--glass-text-secondary)]">
                    {frame.frameRole || '关键状态'}
                  </div>
                  {renderFrameTimeControl(frame, true)}
                </div>
                <div className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--glass-stroke-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--glass-text-secondary)]" title={relationText}>
                  <AppIcon name="link" size={10} className="shrink-0" />
                  <span className="min-w-0 truncate">{relationText}</span>
                </div>
                <div className={`items-start gap-1.5 ${isVerticalRatio ? 'hidden' : 'flex'}`}>
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
                {frames.length > 1 ? '分镜组关键帧' : '分镜关键帧'} · {frames.length} 帧
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
                      className={`group/expanded-frame relative mx-auto block w-full bg-[var(--glass-bg-muted)] ${frame.imageUrl && onPreviewImage ? 'cursor-zoom-in' : 'cursor-default'} ${isVerticalRatio ? 'max-w-[260px]' : ''}`}
                      style={{ aspectRatio: frameAspectRatio }}
                      onClick={() => {
                        const displayUrl = toDisplayImageUrl(frame.imageUrl) || frame.imageUrl
                        if (displayUrl) onPreviewImage?.(displayUrl)
                      }}
                      title={frame.imageUrl && onPreviewImage ? `点击放大 F${frame.frameIndex + 1}` : undefined}
                    >
                      {frame.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={toDisplayImageUrl(frame.imageUrl) || frame.imageUrl} alt={`F${frame.frameIndex + 1}`} className="h-full w-full object-contain" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm text-[var(--glass-text-tertiary)]">待生成</div>
                      )}
                      <span className="absolute left-2 top-2 inline-flex min-h-7 items-center rounded-full border border-white/70 bg-black/75 px-2.5 py-1 text-xs font-extrabold text-white shadow-[0_4px_12px_rgba(0,0,0,0.42)] backdrop-blur">
                        F{frame.frameIndex + 1} · {frame.frameTimeSec}s
                      </span>
                    </button>
                    <div className="space-y-2 p-3">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--glass-text-secondary)]">
                        <span className="rounded-full bg-[var(--glass-bg-muted)] px-2 py-0.5">{frame.frameRole || '关键状态'}</span>
                        <span className="rounded-full border border-[var(--glass-stroke-subtle)] px-2 py-0.5">{getRelationText(frame)}</span>
                        {renderFrameTimeControl(frame)}
                        {frame.imageUrl ? (
                          <button
                            type="button"
                            className="rounded-full border border-[var(--glass-stroke-subtle)] px-2 py-0.5 text-[var(--glass-text-secondary)] transition hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={downloadingFrameIds.has(frame.id)}
                            onClick={() => void handleDownloadFrameImage(frame)}
                          >
                            {downloadingFrameIds.has(frame.id) ? '下载中...' : '下载原图'}
                          </button>
                        ) : null}
                        {onDeleteFrame ? (
                          <button
                            type="button"
                            className="rounded-full border border-red-300/40 px-2 py-0.5 text-red-500 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={(isFrameGenerationBusy(frame) && !isStaleFrameProcessing(frame)) || frames.length <= 1}
                            onClick={() => handleDeleteFrame(frame)}
                          >
                            删除
                          </button>
                        ) : null}
                        {onSplitFrame ? (
                          <button
                            type="button"
                            className="rounded-full border border-sky-300/50 px-2 py-0.5 text-sky-500 transition hover:bg-sky-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={(isFrameGenerationBusy(frame) && !isStaleFrameProcessing(frame)) || frames.length <= 1}
                            onClick={() => handleSplitFrame(frame)}
                          >
                            拆出
                          </button>
                        ) : null}
                        {onInsertFrame ? (
                          <>
                            <button
                              type="button"
                              className="rounded-full border border-blue-300/50 px-2 py-0.5 text-blue-500 transition hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={isFrameGenerationBusy(frame) && !isStaleFrameProcessing(frame)}
                              onClick={() => handleInsertFrame(frame, 'before')}
                            >
                              前插
                            </button>
                            <button
                              type="button"
                              className="rounded-full border border-indigo-300/50 px-2 py-0.5 text-indigo-500 transition hover:bg-indigo-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={isFrameGenerationBusy(frame) && !isStaleFrameProcessing(frame)}
                              onClick={() => handleInsertFrame(frame, 'after')}
                            >
                              后插
                            </button>
                          </>
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
      {splitFrameTarget && typeof document !== 'undefined' ? createPortal(
        <div
          className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          onClick={() => setSplitFrameTarget(null)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-1 text-base font-semibold text-[var(--glass-text-primary)]">
              拆出 F{splitFrameTarget.frameIndex + 1} 为独立分镜
            </div>
            <p className="mb-4 text-sm leading-6 text-[var(--glass-text-secondary)]">
              拆出后会继承这张关键帧的图片、提示词和估算时长，并成为普通分镜，可继续使用插入、复制、生成图等原有操作。
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className="rounded-lg border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-muted)] px-4 py-3 text-sm font-medium text-[var(--glass-text-primary)] transition hover:border-[var(--glass-tone-info-fg)] hover:text-[var(--glass-tone-info-fg)]"
                onClick={() => commitSplitFrame('before')}
              >
                放到原组前面
              </button>
              <button
                type="button"
                className="rounded-lg bg-[var(--glass-tone-info-fg)] px-4 py-3 text-sm font-medium text-white transition hover:opacity-90"
                onClick={() => commitSplitFrame('after')}
              >
                放到原组后面
              </button>
            </div>
            <button
              type="button"
              className="mt-3 w-full rounded-lg px-4 py-2 text-sm text-[var(--glass-text-tertiary)] transition hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)]"
              onClick={() => setSplitFrameTarget(null)}
            >
              取消
            </button>
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
  onOpenPropPicker,
  onRetrySave,
  onRemoveCharacter,
  onRemoveLocation,
  onRemoveProp,
  onRegeneratePanelImage,
  onUploadImage,
  onUploadImageFromSource,
  onUploadFrameImage,
  onUploadFrameImageFromSource,
  onRegenerateFrameImage,
  onUpdateFrameTime,
  onUpdateFramePrompt,
  onInsertFrame,
  onDeleteFrame,
  onSplitFrame,
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
  onMergePanelWithNext,
  onToggleUsePreviousPanelTail,
  onVariant,
  isInsertDisabled,
  hasPreviousPanel = false,
  previousPanelImageOptions = [],
}: PanelCardProps) {
  const t = useTranslations('storyboard')
  const locale = useLocale()
  const refineStoryboardPrompt = useRefineProjectStoryboardPrompt(projectId)
  const regenerateVideoPrompt = useRegenerateProjectVideoPrompt(projectId)
  const updatePanelVideoPrompt = useUpdateProjectPanelVideoPrompt(projectId)
  const [refinedStoryboardPrompt, setRefinedStoryboardPrompt] = useState<string | null>(null)
  const [isDuplicatingPanel, setIsDuplicatingPanel] = useState(false)
  const [isMergingPanel, setIsMergingPanel] = useState(false)
  const [isTogglingPreviousPanelTail, setIsTogglingPreviousPanelTail] = useState(false)
  const [videoPromptModalOpen, setVideoPromptModalOpen] = useState(false)
  const [videoPromptRequirement, setVideoPromptRequirement] = useState('')
  const [videoPromptCandidate, setVideoPromptCandidate] = useState<string | null>(null)
  const [previousImagePickerTarget, setPreviousImagePickerTarget] = useState<
    | { type: 'panel' }
    | { type: 'frame'; frameId: string; label: string }
    | null
  >(null)
  const panelFrames = Array.isArray(panel.frames) ? panel.frames : []
  const displayDurationSec = panel.duration ?? panel.groupDurationSec ?? panelData.duration ?? null
  const videoPromptField = panel.panelMode === 'group' ? 'groupVideoPrompt' : 'videoPrompt'

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
          imagePrompt: null,
          videoPrompt: currentVideoPrompt || null,
          location: panelData.location,
          characters: panelData.characters,
          props: panelData.props,
          sourceText: null,
          photographyRules: panelData.photographyRules || null,
          actingNotes: panelData.actingNotes || null,
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

  const handleMergePanelWithNext = () => {
    if (!onMergePanelWithNext || isMergingPanel) return
    const confirmed = window.confirm('确定把当前分镜和下一分镜合并为一个分镜组吗？合并后下一分镜会成为组内后续关键帧，并从列表中移除。')
    if (!confirmed) return
    setIsMergingPanel(true)
    void Promise.resolve(onMergePanelWithNext())
      .catch((error: unknown) => {
        if (shouldShowError(error)) {
          alert(extractErrorMessage(error, '合并分镜失败'))
        }
      })
      .finally(() => setIsMergingPanel(false))
  }

  const handleUsePreviousPanelImage = async (option: PreviousPanelImageOption) => {
    try {
      if (previousImagePickerTarget?.type === 'frame') {
        if (!onUploadFrameImageFromSource) return
        await Promise.resolve(onUploadFrameImageFromSource(previousImagePickerTarget.frameId, option.imageUrl))
      } else {
        if (!onUploadImageFromSource) return
        await Promise.resolve(onUploadImageFromSource(panel.id, option.imageUrl))
      }
      setPreviousImagePickerTarget(null)
    } catch (error: unknown) {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '替换图片失败'))
      }
    }
  }

  const handleToggleUsePreviousPanelTail = () => {
    if (!onToggleUsePreviousPanelTail || isTogglingPreviousPanelTail) return
    setIsTogglingPreviousPanelTail(true)
    void Promise.resolve(onToggleUsePreviousPanelTail(!panel.usePreviousPanelTailAsReference))
      .catch((error: unknown) => {
        if (shouldShowError(error)) {
          alert(extractErrorMessage(error, '更新沿用上一分镜尾帧开关失败'))
        }
      })
      .finally(() => setIsTogglingPreviousPanelTail(false))
  }

  const currentVideoPrompt = videoPromptField === 'groupVideoPrompt'
    ? panelData.groupVideoPrompt || panel.groupVideoPrompt || panelData.videoPrompt || ''
    : panelData.videoPrompt || panel.video_prompt || ''

  const handleGenerateVideoPromptCandidate = async () => {
    try {
      const result = await regenerateVideoPrompt.mutateAsync({
        panelId: panel.id,
        storyboardId,
        panelIndex: panel.panelIndex,
        field: videoPromptField,
        additionalRequirement: videoPromptRequirement,
        locale: locale === 'en' ? 'en' : 'zh',
      })
      const nextPrompt = result.prompt.trim()
      if (!nextPrompt) throw new Error('视频提示词为空')
      setVideoPromptCandidate(nextPrompt)
    } catch (error: unknown) {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '重新生成视频提示词失败'))
      }
    }
  }

  const handleUseVideoPromptCandidate = async () => {
    const nextPrompt = (videoPromptCandidate || '').trim()
    if (!nextPrompt) return
    try {
      await updatePanelVideoPrompt.mutateAsync({
        storyboardId,
        panelIndex: panel.panelIndex,
        value: nextPrompt,
        field: videoPromptField,
      })
      if (videoPromptField === 'videoPrompt') {
        onUpdate({ videoPrompt: nextPrompt })
      } else if (videoPromptField === 'groupVideoPrompt') {
        onUpdate({ groupVideoPrompt: nextPrompt })
      }
      setVideoPromptModalOpen(false)
      setVideoPromptRequirement('')
      setVideoPromptCandidate(null)
    } catch (error: unknown) {
      if (shouldShowError(error)) {
        alert(extractErrorMessage(error, '保存视频提示词失败'))
      }
    }
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
          durationSec={displayDurationSec}
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
          onUsePreviousImage={
            onUploadImageFromSource && previousPanelImageOptions.length > 0
              ? () => setPreviousImagePickerTarget({ type: 'panel' })
              : undefined
          }
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
          projectId={projectId}
          panelId={panel.id}
          frames={panelFrames}
          videoRatio={videoRatio}
          onPreviewImage={onPreviewImage}
          onUploadFrameImage={onUploadFrameImage}
          onPickPreviousImage={
            onUploadFrameImageFromSource && previousPanelImageOptions.length > 0
              ? (frame) => setPreviousImagePickerTarget({
                type: 'frame',
                frameId: frame.id,
                label: `F${frame.frameIndex + 1}`,
              })
              : undefined
          }
          onRegenerateFrameImage={onRegenerateFrameImage}
          onUpdateFrameTime={onUpdateFrameTime}
          onUpdateFramePrompt={onUpdateFramePrompt}
          onInsertFrame={onInsertFrame}
          onDeleteFrame={onDeleteFrame}
          onSplitFrame={onSplitFrame}
          usePreviousPanelTailAsReference={hasPreviousPanel ? panel.usePreviousPanelTailAsReference : false}
          onToggleUsePreviousPanelTail={hasPreviousPanel && onToggleUsePreviousPanelTail ? handleToggleUsePreviousPanelTail : undefined}
          previousPanelTailDisabled={isTogglingPreviousPanelTail}
        />
        {/* 插入分镜/镜头变体按钮 - 在图片区域右侧垂直居中 */}
        {(onInsertAfter || onDuplicatePanel || onMergePanelWithNext || onVariant) && (
          <div className="absolute -right-[22px] top-1/2 -translate-y-1/2 z-50">
            <PanelActionButtons
              onInsertPanel={onInsertAfter || (() => { })}
              onDuplicatePanel={onDuplicatePanel ? handleDuplicatePanel : undefined}
              onMergeWithNextPanel={onMergePanelWithNext ? handleMergePanelWithNext : undefined}
              onVariant={onVariant || (() => { })}
              disabled={isInsertDisabled || isDuplicatingPanel || isMergingPanel}
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
          onOpenPropPicker={onOpenPropPicker}
          onRemoveCharacter={onRemoveCharacter}
          onRemoveLocation={onRemoveLocation}
          onRemoveProp={onRemoveProp}
          videoPromptField={videoPromptField}
          onRefineStoryboardPrompt={handleRefineStoryboardPrompt}
          isRefiningStoryboardPrompt={refineStoryboardPrompt.isPending}
          refinedStoryboardPrompt={refinedStoryboardPrompt}
          onClearRefinedStoryboardPrompt={() => setRefinedStoryboardPrompt(null)}
          onRegenerateVideoPrompt={() => setVideoPromptModalOpen(true)}
          isRegeneratingVideoPrompt={regenerateVideoPrompt.isPending || updatePanelVideoPrompt.isPending}
        />
      </div>
      <RegenerateVideoPromptModal
        open={videoPromptModalOpen}
        title="重新生成视频提示词"
        description={videoPromptField === 'groupVideoPrompt' ? '当前是分镜组，将重新生成整组视频提示词。可补充你想叠加的风格、音乐、运镜或台词要求。' : '将重新生成当前分镜的视频提示词。可补充你想叠加的风格、音乐、运镜或台词要求。'}
        value={videoPromptRequirement}
        currentPrompt={currentVideoPrompt}
        candidatePrompt={videoPromptCandidate}
        isSubmitting={regenerateVideoPrompt.isPending}
        isSaving={updatePanelVideoPrompt.isPending}
        onChange={setVideoPromptRequirement}
        onClose={() => {
          if (regenerateVideoPrompt.isPending || updatePanelVideoPrompt.isPending) return
          setVideoPromptModalOpen(false)
        }}
        onGenerate={() => void handleGenerateVideoPromptCandidate()}
        onUseCandidate={() => void handleUseVideoPromptCandidate()}
      />
      {previousImagePickerTarget && previousPanelImageOptions.length > 0 && typeof document !== 'undefined' ? createPortal(
        <div
          className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setPreviousImagePickerTarget(null)}
        >
          <div
            className="w-full max-w-3xl overflow-hidden rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--glass-stroke-subtle)] px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-[var(--glass-text-primary)]">
                  选择上一大分镜图片
                </div>
                <div className="text-xs text-[var(--glass-text-tertiary)]">
                  将替换当前{previousImagePickerTarget.type === 'frame' ? `关键帧 ${previousImagePickerTarget.label}` : '分镜主图'}
                </div>
              </div>
              <button
                type="button"
                className="rounded-full p-2 text-[var(--glass-text-tertiary)] hover:bg-[var(--glass-bg-muted)] hover:text-[var(--glass-text-primary)]"
                onClick={() => setPreviousImagePickerTarget(null)}
              >
                <AppIcon name="close" size={18} />
              </button>
            </div>
            <div className="grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto p-4 md:grid-cols-3">
              {previousPanelImageOptions.map((option) => {
                const displayUrl = toDisplayImageUrl(option.imageUrl) || option.imageUrl
                return (
                  <button
                    key={option.id}
                    type="button"
                    className="overflow-hidden rounded-lg border border-[var(--glass-stroke-subtle)] bg-[var(--glass-bg-surface-strong)] text-left transition hover:-translate-y-0.5 hover:border-[var(--glass-tone-info-fg)] hover:shadow-md"
                    onClick={() => void handleUsePreviousPanelImage(option)}
                  >
                    <div className="aspect-video bg-[var(--glass-bg-muted)]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={displayUrl} alt={option.label} className="h-full w-full object-cover" />
                    </div>
                    <div className="px-3 py-2 text-xs font-medium text-[var(--glass-text-secondary)]">
                      {option.label}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </GlassSurface>
  )
}
