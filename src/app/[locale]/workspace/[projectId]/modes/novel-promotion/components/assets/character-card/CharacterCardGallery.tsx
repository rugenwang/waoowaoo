'use client'

import type { MouseEvent, ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { resolveErrorDisplay } from '@/lib/errors/display'
import TaskStatusOverlay from '@/components/task/TaskStatusOverlay'
import type { TaskPresentationState } from '@/lib/task/presentation'
import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'
import { AppIcon } from '@/components/ui/icons'
import { downloadRemoteFile } from '@/lib/media/download-remote-file'

type CharacterCardGalleryProps =
  | {
    mode: 'selection'
    characterId: string
    appearanceId: string
    characterName: string
    imageUrlsWithIndex: Array<{ url: string; originalIndex: number }>
    selectedIndex: number | null
    isGroupTaskRunning: boolean
    isImageTaskRunning: (imageIndex: number) => boolean
    displayTaskPresentation: TaskPresentationState | null
    onImageClick: (imageUrl: string) => void
    onSelectImage?: (characterId: string, appearanceId: string, imageIndex: number | null) => void
  }
  | {
    mode: 'single'
    characterName: string
    changeReason: string
    aspectClassName: string
    currentImageUrl: string | null | undefined
    selectedIndex: number | null
    hasMultipleImages: boolean
    isAppearanceTaskRunning: boolean
    displayTaskPresentation: TaskPresentationState | null
    appearanceErrorMessage?: string | null
    onImageClick: (imageUrl: string) => void
    overlayActions: ReactNode
  }

export default function CharacterCardGallery(props: CharacterCardGalleryProps) {
  const t = useTranslations('assets')
  const handleDownload = (event: MouseEvent, url: string, fileName: string) => {
    event.stopPropagation()
    void downloadRemoteFile(url, fileName).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      alert(t('assetLibrary.downloadFailed') + (message ? `: ${message}` : ''))
    })
  }

  if (props.mode === 'selection') {
    return (
      <div className="grid grid-cols-3 gap-3">
        {props.imageUrlsWithIndex.map(({ url, originalIndex }) => {
          const isThisSelected = props.selectedIndex === originalIndex
          const isThisTaskRunning = props.isImageTaskRunning(originalIndex) || props.isGroupTaskRunning
          return (
            <div key={originalIndex} className="relative group/thumb">
              <div
                onClick={() => props.onImageClick(url)}
                className={`rounded-lg overflow-hidden border-2 transition-all cursor-pointer relative ${isThisSelected
                  ? 'border-[var(--glass-stroke-success)] ring-2 ring-[var(--glass-focus-ring)]'
                  : 'border-[var(--glass-stroke-base)] hover:border-[var(--glass-stroke-focus)]'
                  }`}
              >
                <MediaImageWithLoading
                  src={url}
                  alt={`${props.characterName} - ${t('image.optionNumber', { number: originalIndex + 1 })}`}
                  containerClassName="w-full min-h-[96px]"
                  className="w-full h-auto object-contain"
                />

                {isThisTaskRunning && (
                  <TaskStatusOverlay state={props.displayTaskPresentation} />
                )}

                <div
                  className={`absolute bottom-2 left-2 flex items-center gap-1 text-white text-xs px-2 py-0.5 rounded ${isThisSelected ? 'bg-[var(--glass-tone-success-fg)]' : 'bg-[var(--glass-overlay)]'
                    }`}
                >
                  <span>{t('image.optionNumber', { number: originalIndex + 1 })}</span>
                  {isThisSelected && (
                    <AppIcon name="checkTiny" className="h-3 w-3" />
                  )}
                </div>

                <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
                  <button
                    onClick={(event) => handleDownload(
                      event,
                      url,
                      `${props.characterName}-${t('image.optionNumber', { number: originalIndex + 1 })}`,
                    )}
                    disabled={isThisTaskRunning}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-secondary)] shadow-sm transition-all hover:bg-[var(--glass-accent-from)] hover:text-white disabled:opacity-50"
                    title={t('common.download')}
                  >
                    <AppIcon name="download" className="h-4 w-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!isThisTaskRunning) {
                        props.onSelectImage?.(props.characterId, props.appearanceId, isThisSelected ? null : originalIndex)
                      }
                    }}
                    disabled={isThisTaskRunning}
                    className={`flex h-7 w-7 items-center justify-center rounded-full shadow-sm transition-all ${isThisSelected
                      ? 'bg-[var(--glass-tone-success-fg)] text-white'
                      : 'bg-[var(--glass-bg-surface-strong)] hover:bg-[var(--glass-accent-from)] hover:text-white'
                      } disabled:opacity-50`}
                    title={isThisSelected ? t('image.cancelSelection') : t('image.useThis')}
                  >
                    <AppIcon name="check" className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const appearanceErrorDisplay = resolveErrorDisplay({
    code: props.appearanceErrorMessage || null,
    message: props.appearanceErrorMessage || null,
  })

  return (
    <div className={`relative overflow-hidden rounded-lg border-2 border-[var(--glass-stroke-base)] ${props.aspectClassName}`}>
      {props.currentImageUrl ? (
        <div className="relative h-full w-full">
          <MediaImageWithLoading
            src={props.currentImageUrl}
            alt={`${props.characterName} - ${props.changeReason}`}
            containerClassName="h-full w-full"
            className="h-full w-full object-contain cursor-pointer hover:opacity-90 transition-opacity"
            onClick={() => props.onImageClick(props.currentImageUrl!)}
          />
          {props.selectedIndex !== null && props.hasMultipleImages && (
            <div className="absolute bottom-2 left-2 bg-[var(--glass-tone-success-fg)] text-white text-xs px-2 py-0.5 rounded">
              {t('image.optionNumber', { number: props.selectedIndex + 1 })}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[var(--glass-bg-muted)]">
          {appearanceErrorDisplay && !props.isAppearanceTaskRunning ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <AppIcon name="alert" className="w-8 h-8 text-[var(--glass-tone-danger-fg)] mb-2" />
              <div className="text-[var(--glass-tone-danger-fg)] text-xs font-medium mb-1">{t('common.generateFailed')}</div>
              <div className="text-[var(--glass-tone-danger-fg)] text-xs max-w-full break-words">{appearanceErrorDisplay.message}</div>
            </div>
          ) : (
            <AppIcon name="userAlt" className="w-8 h-8 text-[var(--glass-text-tertiary)]" />
          )}
        </div>
      )}
      {props.isAppearanceTaskRunning && (
        <TaskStatusOverlay state={props.displayTaskPresentation} />
      )}
      {!props.isAppearanceTaskRunning && (
        <div className="absolute top-2 left-2 z-20 flex max-w-[calc(100%-1rem)] flex-wrap gap-1">
          {props.overlayActions}
        </div>
      )}
      {!props.isAppearanceTaskRunning && props.currentImageUrl && (
        <button
          type="button"
          onClick={(event) => handleDownload(event, props.currentImageUrl!, `${props.characterName}-${props.changeReason}`)}
          className="absolute bottom-2 right-2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--glass-bg-surface-strong)] text-[var(--glass-text-secondary)] shadow-sm transition-all hover:bg-[var(--glass-accent-from)] hover:text-white"
          title={t('common.download')}
        >
          <AppIcon name="download" className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
