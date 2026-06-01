'use client'
import { useTranslations } from 'next-intl'
import { useState, useRef, useCallback } from 'react'
import { Character, Location, Prop } from '@/types/project'
import { useProjectAssets } from '@/lib/query/hooks/useProjectAssets'
import { SelectedAsset } from './hooks/useImageGeneration'
import ImagePreviewModal from '@/components/ui/ImagePreviewModal'
import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'
import ImageEditModalSelectedAssets from './ImageEditModalSelectedAssets'
import ImageEditModalAssetPicker from './ImageEditModalAssetPicker'
import { AppIcon } from '@/components/ui/icons'
import { toDisplayImageUrl } from '@/lib/media/image-url'
import type { PreviousPanelImageOption } from './PanelCard'

interface ImageEditModalProps {
  projectId: string
  defaultAssets: SelectedAsset[]
  previousPanelImageOptions?: PreviousPanelImageOption[]
  onSubmit: (prompt: string, images: string[], assets: SelectedAsset[]) => void
  onClose: () => void
}

export default function ImageEditModal({
  projectId,
  defaultAssets,
  previousPanelImageOptions = [],
  onSubmit,
  onClose,
}: ImageEditModalProps) {
  const t = useTranslations('storyboard')

  const { data: assets } = useProjectAssets(projectId)
  const characters: Character[] = assets?.characters ?? []
  const locations: Location[] = assets?.locations ?? []
  const props: Prop[] = assets?.props ?? []

  const [editPrompt, setEditPrompt] = useState('')
  const [editImages, setEditImages] = useState<string[]>([])
  const [selectedAssets, setSelectedAssets] = useState<SelectedAsset[]>(defaultAssets)
  const [showAssetPicker, setShowAssetPicker] = useState(false)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImageUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return

    Array.from(files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = (readerEvent) => {
        const base64 = readerEvent.target?.result as string
        setEditImages((previous) => [...previous, base64])
      }
      reader.readAsDataURL(file)
    })

    event.target.value = ''
  }, [])

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData.items
    for (let index = 0; index < items.length; index++) {
      if (items[index].type.startsWith('image/')) {
        const file = items[index].getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = (readerEvent) => {
            const base64 = readerEvent.target?.result as string
            setEditImages((previous) => [...previous, base64])
          }
          reader.readAsDataURL(file)
        }
      }
    }
  }, [])

  const removeImage = (index: number) => {
    setEditImages((previous) => previous.filter((_, imageIndex) => imageIndex !== index))
  }

  const togglePreviousPanelImage = (imageUrl: string) => {
    setEditImages((previous) => {
      if (previous.includes(imageUrl)) {
        return previous.filter((item) => item !== imageUrl)
      }
      return [imageUrl, ...previous]
    })
  }

  const handleAddAsset = (asset: SelectedAsset) => {
    setSelectedAssets((previous) => {
      if (previous.some((item) => item.id === asset.id && item.type === asset.type)) return previous
      return [...previous, asset]
    })
  }

  const handleRemoveAsset = (assetId: string, assetType: string) => {
    setSelectedAssets((previous) => previous.filter((item) => !(item.id === assetId && item.type === assetType)))
  }

  const handleSubmit = () => {
    if (!editPrompt.trim()) {
      alert(t('prompts.enterInstruction'))
      return
    }
    onSubmit(editPrompt, editImages, selectedAssets)
  }

  return (
    <div className="fixed inset-0 bg-[var(--glass-overlay)] z-50 flex items-center justify-center p-4">
      <div
        className="bg-[var(--glass-bg-surface)] rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onPaste={handlePaste}
      >
        <div className="p-6 border-b shrink-0">
          <h3 className="text-lg font-bold text-[var(--glass-text-primary)]">{t('imageEdit.title')}</h3>
          <p className="text-sm text-[var(--glass-text-tertiary)] mt-1">{t('imageEdit.subtitle')}</p>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto app-scrollbar flex-1 min-h-0">
          <div>
            <label className="block text-sm font-medium text-[var(--glass-text-secondary)] mb-2">{t('prompts.aiInstruction')}</label>
            <textarea
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              placeholder={t('imageEdit.promptPlaceholder')}
              className="w-full h-24 px-3 py-2 border border-[var(--glass-stroke-strong)] rounded-lg focus:ring-2 focus:ring-[var(--glass-tone-info-fg)] focus:border-[var(--glass-stroke-focus)] resize-none"
              autoFocus
            />
          </div>

          <ImageEditModalSelectedAssets
            selectedAssets={selectedAssets}
            onOpenAssetPicker={() => setShowAssetPicker(true)}
            onPreviewImage={setPreviewImage}
            onRemoveAsset={handleRemoveAsset}
          />

          {previousPanelImageOptions.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-[var(--glass-text-secondary)] mb-2">
                上一分镜图片 <span className="text-[var(--glass-text-tertiary)] font-normal">可多选，作为本次编辑参考图</span>
              </label>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {previousPanelImageOptions.map((option) => {
                  const selected = editImages.includes(option.imageUrl)
                  const displayUrl = toDisplayImageUrl(option.imageUrl) || option.imageUrl
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => togglePreviousPanelImage(option.imageUrl)}
                      className={`group overflow-hidden rounded-lg border text-left transition ${
                        selected
                          ? 'border-[var(--glass-tone-info-fg)] ring-2 ring-[var(--glass-focus-ring)]'
                          : 'border-[var(--glass-stroke-subtle)] hover:border-[var(--glass-stroke-focus)]'
                      }`}
                      title={selected ? '已选中，点击取消' : '点击加入编辑参考图'}
                    >
                      <div className="relative aspect-video bg-[var(--glass-bg-muted)]">
                        <MediaImageWithLoading
                          src={displayUrl}
                          alt={option.label}
                          containerClassName="h-full w-full"
                          className="h-full w-full object-cover"
                        />
                        <span className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          selected ? 'bg-[var(--glass-tone-info-fg)] text-white' : 'bg-black/55 text-white opacity-0 group-hover:opacity-100'
                        }`}>
                          {selected ? '已选' : '选择'}
                        </span>
                      </div>
                      <div className="line-clamp-1 px-2 py-1.5 text-xs text-[var(--glass-text-secondary)]">
                        {option.label}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-[var(--glass-text-secondary)] mb-2">
              {t('imageEdit.referenceImagesLabel')} <span className="text-[var(--glass-text-tertiary)] font-normal">{t('imageEdit.referenceImagesHint')}</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleImageUpload}
              className="hidden"
            />
            <div className="flex flex-wrap gap-2">
              {editImages.map((image, index) => (
                <div key={index} className="relative w-16 h-16">
                  <MediaImageWithLoading
                    src={image}
                    alt=""
                    containerClassName="w-full h-full rounded-lg"
                    className="w-full h-full object-cover rounded-lg"
                  />
                  <button
                    onClick={() => removeImage(index)}
                    className="absolute -top-1 -right-1 w-5 h-5 bg-[var(--glass-tone-danger-fg)] text-white rounded-full text-xs flex items-center justify-center hover:bg-[var(--glass-tone-danger-fg)]"
                  >
                    <AppIcon name="closeSm" className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-16 h-16 border-2 border-dashed border-[var(--glass-stroke-strong)] rounded-lg flex items-center justify-center text-[var(--glass-text-tertiary)] hover:border-[var(--glass-stroke-focus)] hover:text-[var(--glass-tone-info-fg)] transition-colors"
              >
                <AppIcon name="plus" className="w-6 h-6" />
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 border-t flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-muted)] rounded-lg transition-colors"
          >
            {t('candidate.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!editPrompt.trim()}
            className="px-4 py-2 bg-[var(--glass-accent-from)] text-white rounded-lg hover:bg-[var(--glass-accent-to)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('imageEdit.start')}
          </button>
        </div>
      </div>

      <ImageEditModalAssetPicker
        isOpen={showAssetPicker}
        characters={characters}
        locations={locations}
        props={props}
        selectedAssets={selectedAssets}
        onClose={() => setShowAssetPicker(false)}
        onAddAsset={handleAddAsset}
        onRemoveAsset={handleRemoveAsset}
        onPreviewImage={setPreviewImage}
      />

      {previewImage && (
        <ImagePreviewModal
          imageUrl={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  )
}
