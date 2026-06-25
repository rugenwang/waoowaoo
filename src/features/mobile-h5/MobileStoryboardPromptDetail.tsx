'use client'

import { useEffect, useMemo, useState } from 'react'
import { AppIcon } from '@/components/ui/icons'
import type { MobilePanel, MobilePanelFrame } from './types'
import {
  displayMediaUrl,
  resolveSelectedPanelFrameId,
} from './mobile-utils'

interface MobileStoryboardPromptDetailProps {
  panel: MobilePanel
  panelOrder: number
  frames: MobilePanelFrame[]
  copiedFrameId: string | null
  regeneratingFrameId: string | null
  onClose: () => void
  onPreview: (url: string) => void
  onCopyPrompt: (frame: MobilePanelFrame) => void
  onEditPrompt: (frame: MobilePanelFrame) => void
  onRegenerate: (panelId: string, frameId: string) => void
}

export default function MobileStoryboardPromptDetail({
  panel,
  panelOrder,
  frames,
  copiedFrameId,
  regeneratingFrameId,
  onClose,
  onPreview,
  onCopyPrompt,
  onEditPrompt,
  onRegenerate,
}: MobileStoryboardPromptDetailProps) {
  const orderedFrames = useMemo(
    () => [...frames].sort((left, right) => left.frameIndex - right.frameIndex),
    [frames],
  )
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(() => (
    resolveSelectedPanelFrameId(orderedFrames, null)
  ))
  const validSelectedFrameId = resolveSelectedPanelFrameId(orderedFrames, selectedFrameId)
  const selectedFrame = orderedFrames.find((frame) => frame.id === validSelectedFrameId) || null

  useEffect(() => {
    setSelectedFrameId((current) => resolveSelectedPanelFrameId(orderedFrames, current))
  }, [orderedFrames])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  if (!selectedFrame) return null

  const imageUrl = displayMediaUrl(
    selectedFrame.imageMedia?.url
      || selectedFrame.media?.url
      || selectedFrame.imageUrl
      || panel.imageMedia?.url
      || panel.media?.url
      || panel.imageUrl,
  )
  const prompt = selectedFrame.imagePrompt
    || selectedFrame.videoPrompt
    || panel.imagePrompt
    || panel.description
    || ''
  const isRegenerating = regeneratingFrameId === selectedFrame.id

  return (
    <div className="fixed inset-0 z-[70] h-[100dvh] bg-slate-100 text-slate-950">
      <div className="mx-auto flex h-full w-full max-w-md flex-col bg-slate-100">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] shadow-sm">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 active:scale-95"
              aria-label="关闭分镜提示详情"
            >
              <AppIcon name="chevronLeft" className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold">分镜 {panelOrder} · 分镜提示</h2>
                <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-600">
                  {orderedFrames.length} 帧
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {panel.shotType || panel.location || '未命名镜头'}
                {typeof panel.groupDurationSec === 'number' || typeof panel.duration === 'number'
                  ? ` · ${panel.groupDurationSec ?? panel.duration}s`
                  : ''}
              </p>
            </div>
          </div>
        </header>

        <nav className="shrink-0 overflow-x-auto border-b border-slate-200 bg-white px-4 py-3" aria-label="关键帧选择">
          <div className="flex min-w-max gap-2">
            {orderedFrames.map((frame) => {
              const active = frame.id === selectedFrame.id
              return (
                <button
                  key={frame.id}
                  type="button"
                  onClick={() => setSelectedFrameId(frame.id)}
                  className={`min-h-10 rounded-full px-4 text-sm font-semibold ring-1 transition active:scale-95 ${active ? 'bg-slate-950 text-white ring-slate-950' : 'bg-white text-slate-600 ring-slate-200'}`}
                >
                  F{frame.frameIndex + 1} · {frame.frameTimeSec}s
                </button>
              )
            })}
          </div>
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <section className="overflow-hidden rounded-[24px] bg-white shadow-sm ring-1 ring-slate-200/80">
              <button
                type="button"
                disabled={!imageUrl}
                onClick={() => imageUrl && onPreview(imageUrl)}
                className="relative block w-full bg-slate-200 disabled:cursor-default"
                style={{ aspectRatio: '16 / 9' }}
              >
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl} alt={`关键帧 F${selectedFrame.frameIndex + 1}`} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center text-sm text-slate-400">暂无关键帧图片</span>
                )}
                {imageUrl ? (
                  <span className="absolute bottom-3 right-3 rounded-full bg-white/95 px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                    点按预览
                  </span>
                ) : null}
              </button>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold">F{selectedFrame.frameIndex + 1}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedFrame.frameRole || '关键状态'}</div>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                  {selectedFrame.frameTimeSec}s
                </span>
              </div>
            </section>

            <section className="rounded-[24px] bg-white p-4 shadow-sm ring-1 ring-slate-200/80">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">完整提示词</h3>
                <span className="text-xs text-slate-400">F{selectedFrame.frameIndex + 1}</span>
              </div>
              {prompt ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">{prompt}</p>
              ) : (
                <div className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-400">暂无提示词</div>
              )}
            </section>
          </div>
        </main>

        <footer className="grid shrink-0 grid-cols-3 gap-2 border-t border-slate-200 bg-white px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_rgba(15,23,42,0.06)]">
          <button
            type="button"
            disabled={!prompt}
            onClick={() => onCopyPrompt(selectedFrame)}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl bg-slate-100 px-2 text-xs font-semibold text-slate-700 disabled:opacity-40"
          >
            <AppIcon name="copy" className="h-4 w-4" />
            {copiedFrameId === selectedFrame.id ? '已复制' : '复制提示词'}
          </button>
          <button
            type="button"
            onClick={() => onEditPrompt(selectedFrame)}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl bg-slate-950 px-2 text-xs font-semibold text-white"
          >
            <AppIcon name="edit" className="h-4 w-4" />
            编辑提示词
          </button>
          <button
            type="button"
            disabled={isRegenerating}
            onClick={() => onRegenerate(panel.id, selectedFrame.id)}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-2xl bg-blue-600 px-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            <AppIcon name="refresh" className={`h-4 w-4 ${isRegenerating ? 'animate-spin' : ''}`} />
            {isRegenerating ? '生成中' : '重新生成'}
          </button>
        </footer>
      </div>
    </div>
  )
}
