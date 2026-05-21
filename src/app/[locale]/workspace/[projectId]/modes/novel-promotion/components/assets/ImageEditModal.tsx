'use client'
import { useTranslations } from 'next-intl'
import { MediaImageWithLoading } from '@/components/media/MediaImageWithLoading'
import { useAssets } from '@/lib/query/hooks'
import type { AssetSummary } from '@/lib/assets/contracts'

/**
 * 图片编辑弹窗 - 统一的 AI 修图组件
 * 支持角色和场景图片的 AI 编辑
 */

import { useMemo, useRef, useState } from 'react'
import { AppIcon } from '@/components/ui/icons'

type ReferenceAssetImage = {
    id: string
    url: string
    kind: 'character' | 'location' | 'prop'
    assetName: string
    variantLabel: string
    renderLabel: string
    isCurrent: boolean
}

interface ImageEditModalProps {
    type: 'character' | 'location' | 'prop'
    name: string
    assetScope?: 'global' | 'project'
    projectId?: string
    targetAssetId?: string
    targetVariantId?: string
    targetVariantIndex?: number
    targetRenderIndex?: number
    onClose: () => void
    onConfirm: (modifyPrompt: string, extraImageUrls?: string[]) => void
}

const isVisualAsset = (asset: AssetSummary): asset is Extract<AssetSummary, { kind: 'character' | 'location' | 'prop' }> => (
    asset.kind === 'character' || asset.kind === 'location' || asset.kind === 'prop'
)

const assetKindLabel = (kind: ReferenceAssetImage['kind']) => {
    if (kind === 'character') return '角色'
    if (kind === 'prop') return '道具'
    return '场景'
}

const collectReferenceAssetImages = (
    assets: AssetSummary[],
    target: {
        assetId?: string
        variantId?: string
        variantIndex?: number
        renderIndex?: number
    },
): ReferenceAssetImage[] => {
    const options: ReferenceAssetImage[] = []
    const seen = new Set<string>()

    for (const asset of assets) {
        if (!isVisualAsset(asset)) continue
        for (const variant of asset.variants) {
            for (const render of variant.renders) {
                if (!render.imageUrl) continue
                const isTargetAsset = target.assetId === asset.id
                const isTargetVariant = target.variantId
                    ? target.variantId === variant.id
                    : target.variantIndex === variant.index
                const isTargetRender = target.renderIndex === undefined || target.renderIndex === render.index
                if (seen.has(render.imageUrl)) continue
                seen.add(render.imageUrl)
                options.push({
                    id: `${asset.kind}:${asset.id}:${variant.id}:${render.id}`,
                    url: render.imageUrl,
                    kind: asset.kind,
                    assetName: asset.name,
                    variantLabel: variant.label || `${assetKindLabel(asset.kind)} ${variant.index + 1}`,
                    renderLabel: `图 ${render.index + 1}`,
                    isCurrent: isTargetAsset && isTargetVariant && isTargetRender,
                })
            }
        }
    }

    return options
}

export default function ImageEditModal({
    type,
    name,
    assetScope = 'project',
    projectId,
    targetAssetId,
    targetVariantId,
    targetVariantIndex,
    targetRenderIndex,
    onClose,
    onConfirm
}: ImageEditModalProps) {
    const t = useTranslations('assets')
    const [modifyPrompt, setModifyPrompt] = useState('')
    const [editImages, setEditImages] = useState<string[]>([])
    const [assetReferenceUrls, setAssetReferenceUrls] = useState<string[]>([])
    const [assetFilter, setAssetFilter] = useState<'all' | 'character' | 'location' | 'prop'>('all')
    const fileInputRef = useRef<HTMLInputElement>(null)
    const assetsQuery = useAssets({
        scope: assetScope,
        projectId: assetScope === 'project' ? projectId : undefined,
    })
    const referenceImages = useMemo(
        () => collectReferenceAssetImages(assetsQuery.data ?? [], {
            assetId: targetAssetId,
            variantId: targetVariantId,
            variantIndex: targetVariantIndex,
            renderIndex: targetRenderIndex,
        }),
        [assetsQuery.data, targetAssetId, targetVariantId, targetVariantIndex, targetRenderIndex],
    )
    const filteredReferenceImages = useMemo(
        () => assetFilter === 'all'
            ? referenceImages
            : referenceImages.filter((image) => image.kind === assetFilter),
        [assetFilter, referenceImages],
    )
    const selectedReferenceSet = useMemo(() => new Set(assetReferenceUrls), [assetReferenceUrls])
    const totalReferenceCount = editImages.length + assetReferenceUrls.length

    const title = type === 'character'
        ? t('imageEdit.editCharacterImage')
        : type === 'prop'
            ? t('imageEdit.editPropImage')
            : t('imageEdit.editLocationImage')
    const subtitle = type === 'character'
        ? t('imageEdit.characterLabel', { name })
        : type === 'prop'
            ? t('imageEdit.propLabel', { name })
            : t('imageEdit.locationLabel', { name })

    const handleSubmit = () => {
        if (!modifyPrompt.trim()) {
            alert(t('modal.designInstruction'))
            return
        }
        const extraImageUrls = [...editImages, ...assetReferenceUrls]
        onConfirm(modifyPrompt, extraImageUrls.length > 0 ? extraImageUrls : undefined)
    }

    // 处理粘贴事件
    const handlePaste = async (e: React.ClipboardEvent) => {
        const items = e.clipboardData?.items
        if (!items) return

        for (const item of Array.from(items)) {
            if (item.type.startsWith('image/')) {
                e.preventDefault()
                const file = item.getAsFile()
                if (file) {
                    const reader = new FileReader()
                    reader.onload = (e) => {
                        const base64 = e.target?.result as string
                        setEditImages(prev => [...prev, base64])
                    }
                    reader.readAsDataURL(file)
                }
            }
        }
    }

    // 处理文件上传
    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files
        if (!files) return

        Array.from(files).forEach(file => {
            const reader = new FileReader()
            reader.onload = (e) => {
                const base64 = e.target?.result as string
                setEditImages(prev => [...prev, base64])
            }
            reader.readAsDataURL(file)
        })

        if (fileInputRef.current) {
            fileInputRef.current.value = ''
        }
    }

    const removeImage = (index: number) => {
        setEditImages(prev => prev.filter((_, i) => i !== index))
    }

    const toggleAssetReference = (url: string) => {
        setAssetReferenceUrls(prev => (
            prev.includes(url)
                ? prev.filter(item => item !== url)
                : [...prev, url]
        ))
    }

    return (
        <div className="fixed inset-0 bg-[var(--glass-overlay)] z-50 flex items-center justify-center p-4">
            <div
                className="bg-[var(--glass-bg-surface)] rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
                onPaste={handlePaste}
            >
                <div className="p-6 border-b shrink-0">
                    <h3 className="text-lg font-bold text-[var(--glass-text-primary)]">{title}</h3>
                    <p className="text-sm text-[var(--glass-text-tertiary)] mt-1">{subtitle} · {t('imageEdit.subtitle')}</p>
                </div>
                <div className="p-6 space-y-4 overflow-y-auto app-scrollbar flex-1 min-h-0">
                    <div>
                        <label className="block text-sm font-medium text-[var(--glass-text-secondary)] mb-2">{t('imageEdit.editInstruction')}</label>
                        <textarea
                            value={modifyPrompt}
                            onChange={(e) => setModifyPrompt(e.target.value)}
                            placeholder={type === 'character'
                                ? t('imageEdit.characterPlaceholder')
                                : type === 'prop'
                                    ? t('imageEdit.propPlaceholder')
                                : t('imageEdit.locationPlaceholder')
                            }
                            className="w-full h-24 px-3 py-2 border border-[var(--glass-stroke-strong)] rounded-lg focus:ring-2 focus:ring-[var(--glass-tone-info-fg)] focus:border-[var(--glass-stroke-focus)] resize-none"
                            autoFocus
                        />
                    </div>
	                    <div>
	                        <label className="block text-sm font-medium text-[var(--glass-text-secondary)] mb-2">
	                            {t('imageEdit.referenceImages')} <span className="text-[var(--glass-text-tertiary)] font-normal">{t('imageEdit.referenceImagesHint')}</span>
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
                            {editImages.map((img, idx) => (
                                <div key={idx} className="relative w-16 h-16">
                                    <MediaImageWithLoading
                                        src={img}
                                        alt=""
                                        containerClassName="w-full h-full rounded-lg"
                                        className="w-full h-full object-cover rounded-lg"
                                    />
                                    <button
                                        onClick={() => removeImage(idx)}
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
	                    <div className="rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-3">
	                        <div className="mb-3 flex items-center justify-between gap-3">
	                            <div>
	                                <div className="text-sm font-semibold text-[var(--glass-text-primary)]">从资产库选择参考图</div>
	                                <div className="text-xs text-[var(--glass-text-tertiary)]">
	                                    已选 {assetReferenceUrls.length} 张，和本地参考图一起传给多图编辑接口
	                                </div>
	                            </div>
	                            {assetReferenceUrls.length > 0 && (
	                                <button
	                                    type="button"
	                                    onClick={() => setAssetReferenceUrls([])}
	                                    className="rounded-lg px-2.5 py-1 text-xs text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-surface)]"
	                                >
	                                    清空
	                                </button>
	                            )}
	                        </div>
	                        <div className="mb-3 flex flex-wrap gap-2">
	                            {(['all', 'character', 'location', 'prop'] as const).map(filter => (
	                                <button
	                                    key={filter}
	                                    type="button"
	                                    onClick={() => setAssetFilter(filter)}
	                                    className={`rounded-full px-3 py-1 text-xs transition ${
	                                        assetFilter === filter
	                                            ? 'bg-[var(--glass-accent-from)] text-white'
	                                            : 'bg-[var(--glass-bg-surface)] text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-surface-strong)]'
	                                    }`}
	                                >
	                                    {filter === 'all' ? '全部' : assetKindLabel(filter)}
	                                </button>
	                            ))}
	                        </div>
	                        {assetsQuery.isLoading ? (
	                            <div className="flex h-24 items-center justify-center text-sm text-[var(--glass-text-tertiary)]">
	                                加载资产图片中...
	                            </div>
	                        ) : filteredReferenceImages.length === 0 ? (
	                            <div className="flex h-24 items-center justify-center text-sm text-[var(--glass-text-tertiary)]">
	                                暂无可选参考图
	                            </div>
	                        ) : (
	                            <div className="grid max-h-52 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
	                                {filteredReferenceImages.map(image => {
	                                    const selected = selectedReferenceSet.has(image.url)
	                                    return (
	                                        <button
	                                            key={image.id}
	                                            type="button"
	                                            onClick={() => toggleAssetReference(image.url)}
	                                            className={`group relative overflow-hidden rounded-lg border text-left transition ${
	                                                selected
	                                                    ? 'border-[var(--glass-stroke-focus)] ring-2 ring-[var(--glass-stroke-focus)]'
	                                                    : 'border-[var(--glass-stroke-base)] hover:border-[var(--glass-stroke-strong)]'
	                                            }`}
	                                            title={`${assetKindLabel(image.kind)} · ${image.assetName} · ${image.variantLabel} · ${image.renderLabel}`}
	                                        >
	                                            <MediaImageWithLoading
	                                                src={image.url}
	                                                alt=""
	                                                containerClassName="aspect-[4/3] w-full bg-[var(--glass-bg-surface-strong)]"
	                                                className="h-full w-full object-contain"
	                                            />
	                                            <div className="absolute left-1 top-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
	                                                {image.isCurrent ? '当前' : assetKindLabel(image.kind)}
	                                            </div>
	                                            <div className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border ${
	                                                selected
	                                                    ? 'border-white bg-[var(--glass-accent-from)] text-white'
	                                                    : 'border-white/80 bg-black/35 text-white/70'
	                                            }`}>
	                                                {selected && <AppIcon name="check" className="h-3.5 w-3.5" />}
	                                            </div>
	                                            <div className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1">
	                                                <div className="truncate text-xs font-medium text-white">{image.assetName}</div>
	                                                <div className="truncate text-[10px] text-white/75">{image.variantLabel} · {image.renderLabel}</div>
	                                            </div>
	                                        </button>
	                                    )
	                                })}
	                            </div>
	                        )}
	                        {totalReferenceCount > 0 && (
	                            <div className="mt-3 text-xs text-[var(--glass-text-tertiary)]">
	                                本次会额外传入 {totalReferenceCount} 张参考图，当前被编辑图片仍作为主参考图。
	                            </div>
	                        )}
	                    </div>
	                </div>
                <div className="p-6 border-t flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-[var(--glass-text-secondary)] hover:bg-[var(--glass-bg-muted)] rounded-lg transition-colors"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!modifyPrompt.trim()}
                        className="px-4 py-2 bg-[var(--glass-accent-from)] text-white rounded-lg hover:bg-[var(--glass-accent-to)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                        {t('imageEdit.startEditing')}
                    </button>
                </div>
            </div>
        </div>
    )
}
