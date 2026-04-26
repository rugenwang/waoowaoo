'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
    ART_STYLES,
    VIDEO_RATIOS,
} from '@/lib/constants'
import type {
    CapabilitySelections,
    CapabilityValue,
    ModelCapabilities,
} from '@/lib/model-config-contract'
import { filterNormalVideoModelOptions } from '@/lib/model-capabilities/video-model-options'
import { RatioSelector, StyleSelector } from './config-modal-selectors'
import { ModelCapabilityDropdown } from './ModelCapabilityDropdown'
import { AppIcon } from '@/components/ui/icons'

interface ModelOption {
    value: string
    label: string
    provider?: string
    providerName?: string
    capabilities?: ModelCapabilities
}

interface UserModels {
    llm: ModelOption[]
    image: ModelOption[]
    video: ModelOption[]
    audio: ModelOption[]
}

interface CapabilityFieldDefinition {
    field: string
    options: CapabilityValue[]
    label: string
}

interface SettingsModalProps {
    isOpen: boolean
    onClose: () => void
    availableModels?: Partial<UserModels>
    modelsLoaded?: boolean
    artStyle?: string
    analysisModel?: string
    characterModel?: string
    locationModel?: string
    imageModel?: string
    editModel?: string

    videoModel?: string
    audioModel?: string
    videoRatio?: string
    capabilityOverrides?: CapabilitySelections
    ttsRate?: string
    // 本地 local 图片模型（wo -> ltx）配置
    localImageWidth?: number
    localImageHeight?: number
    localImageSteps?: number
    localT2IWidth?: number
    localT2IHeight?: number
    localT2ISteps?: number
    localI2IWidth?: number
    localI2IHeight?: number
    localI2ISteps?: number
    localStoryboardPromptRefineEnabled?: boolean
    localStoryboardPromptRefineLevel?: 'conservative' | 'medium' | 'simple'
    onArtStyleChange?: (value: string) => void
    onAnalysisModelChange?: (value: string) => void
    onCharacterModelChange?: (value: string) => void
    onLocationModelChange?: (value: string) => void
    onImageModelChange?: (value: string) => void
    onEditModelChange?: (value: string) => void

    onVideoModelChange?: (value: string) => void
    onAudioModelChange?: (value: string) => void
    onVideoRatioChange?: (value: string) => void
    onCapabilityOverridesChange?: (value: CapabilitySelections) => void
    onTTSRateChange?: (value: string) => void
    onLocalImageWidthChange?: (value: number) => void
    onLocalImageHeightChange?: (value: number) => void
    onLocalImageStepsChange?: (value: number) => void
    onLocalT2IWidthChange?: (value: number) => void
    onLocalT2IHeightChange?: (value: number) => void
    onLocalT2IStepsChange?: (value: number) => void
    onLocalI2IWidthChange?: (value: number) => void
    onLocalI2IHeightChange?: (value: number) => void
    onLocalI2IStepsChange?: (value: number) => void
    onLocalStoryboardPromptRefineEnabledChange?: (value: boolean) => void
    onLocalStoryboardPromptRefineLevelChange?: (value: 'conservative' | 'medium' | 'simple') => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCapabilityValue(value: unknown): value is CapabilityValue {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function toFieldLabel(field: string): string {
    return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

function parseBySample(input: string, sample: CapabilityValue): CapabilityValue {
    if (typeof sample === 'number') return Number(input)
    if (typeof sample === 'boolean') return input === 'true'
    return input
}

function extractCapabilityFields(
    capabilities: ModelCapabilities | undefined,
    namespace: 'llm' | 'image' | 'video' | 'audio',
): CapabilityFieldDefinition[] {
    const rawNamespace = capabilities?.[namespace]
    if (!isRecord(rawNamespace)) return []

    return Object.entries(rawNamespace)
        .filter(([key, value]) => key.endsWith('Options') && Array.isArray(value) && value.every(isCapabilityValue) && value.length > 0)
        .map(([key, value]) => {
            const field = key.slice(0, -'Options'.length)
            return {
                field,
                options: value as CapabilityValue[],
                label: toFieldLabel(field),
            }
        })
}

function readCapabilitySelectionForModel(
    overrides: CapabilitySelections | undefined,
    modelKey: string | undefined,
): Record<string, CapabilityValue> {
    if (!modelKey || !overrides) return {}
    const raw = overrides[modelKey]
    if (!isRecord(raw)) return {}

    const normalized: Record<string, CapabilityValue> = {}
    for (const [field, value] of Object.entries(raw)) {
        if (isCapabilityValue(value)) {
            normalized[field] = value
        }
    }
    return normalized
}

export function SettingsModal({
    isOpen,
    onClose,
    availableModels,
    modelsLoaded = false,
    artStyle = 'american-comic',
    analysisModel,
    characterModel,
    locationModel,
    imageModel,
    editModel,
    videoModel,
    audioModel,
    videoRatio = '9:16',
    capabilityOverrides,
    ttsRate,
    localImageWidth,
    localImageHeight,
    localImageSteps,
    localT2IWidth,
    localT2IHeight,
    localT2ISteps,
    localI2IWidth,
    localI2IHeight,
    localI2ISteps,
    localStoryboardPromptRefineEnabled,
    localStoryboardPromptRefineLevel,
    onArtStyleChange,
    onAnalysisModelChange,
    onCharacterModelChange,
    onLocationModelChange,
    onImageModelChange,
    onEditModelChange,
    onVideoModelChange,
    onAudioModelChange,
    onVideoRatioChange,
    onCapabilityOverridesChange,
    onTTSRateChange,
    onLocalImageWidthChange,
    onLocalImageHeightChange,
    onLocalImageStepsChange,
    onLocalT2IWidthChange,
    onLocalT2IHeightChange,
    onLocalT2IStepsChange,
    onLocalI2IWidthChange,
    onLocalI2IHeightChange,
    onLocalI2IStepsChange,
    onLocalStoryboardPromptRefineEnabledChange,
    onLocalStoryboardPromptRefineLevelChange,
}: SettingsModalProps) {
    const t = useTranslations('configModal')
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle')
    const userModels = useMemo<UserModels>(() => ({
        llm: Array.isArray(availableModels?.llm) ? availableModels.llm : [],
        image: Array.isArray(availableModels?.image) ? availableModels.image : [],
        video: Array.isArray(availableModels?.video) ? availableModels.video : [],
        audio: Array.isArray(availableModels?.audio) ? availableModels.audio : [],
    }), [availableModels])
    const normalVideoModels = useMemo<ModelOption[]>(
        () => filterNormalVideoModelOptions(userModels.video),
        [userModels.video],
    )

    const selectedVideoModelOption = useMemo(
        () => normalVideoModels.find((model) => model.value === videoModel) || null,
        [normalVideoModels, videoModel],
    )
    const selectedAnalysisModelOption = useMemo(
        () => userModels.llm.find((model) => model.value === analysisModel) || null,
        [userModels.llm, analysisModel],
    )
    const selectedAudioModelOption = useMemo(
        () => userModels.audio.find((model) => model.value === audioModel) || null,
        [userModels.audio, audioModel],
    )

    const videoCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedVideoModelOption?.capabilities, 'video'),
        [selectedVideoModelOption],
    )
    const analysisCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedAnalysisModelOption?.capabilities, 'llm'),
        [selectedAnalysisModelOption],
    )
    const audioCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedAudioModelOption?.capabilities, 'audio'),
        [selectedAudioModelOption],
    )
    const selectedCharacterModelOption = useMemo(
        () => userModels.image.find((model) => model.value === characterModel) || null,
        [userModels.image, characterModel],
    )
    const selectedLocationModelOption = useMemo(
        () => userModels.image.find((model) => model.value === locationModel) || null,
        [userModels.image, locationModel],
    )
    const selectedStoryboardModelOption = useMemo(
        () => userModels.image.find((model) => model.value === imageModel) || null,
        [userModels.image, imageModel],
    )
    const selectedEditModelOption = useMemo(
        () => userModels.image.find((model) => model.value === editModel) || null,
        [userModels.image, editModel],
    )
    const characterCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedCharacterModelOption?.capabilities, 'image'),
        [selectedCharacterModelOption],
    )
    const locationCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedLocationModelOption?.capabilities, 'image'),
        [selectedLocationModelOption],
    )
    const storyboardCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedStoryboardModelOption?.capabilities, 'image'),
        [selectedStoryboardModelOption],
    )

    const isLocalImageModel = selectedStoryboardModelOption?.provider === 'local'
    const fallbackWidth = typeof localImageWidth === 'number' ? localImageWidth : 1024
    const fallbackHeight = typeof localImageHeight === 'number' ? localImageHeight : 1024
    const fallbackSteps = typeof localImageSteps === 'number' ? localImageSteps : 8
    const t2iWidth = typeof localT2IWidth === 'number' ? localT2IWidth : fallbackWidth
    const t2iHeight = typeof localT2IHeight === 'number' ? localT2IHeight : fallbackHeight
    const t2iSteps = typeof localT2ISteps === 'number' ? localT2ISteps : fallbackSteps
    const i2iWidth = typeof localI2IWidth === 'number' ? localI2IWidth : fallbackWidth
    const i2iHeight = typeof localI2IHeight === 'number' ? localI2IHeight : fallbackHeight
    const i2iSteps = typeof localI2ISteps === 'number' ? localI2ISteps : fallbackSteps
    const promptRefineEnabled = localStoryboardPromptRefineEnabled === true
    const promptRefineLevel: 'conservative' | 'medium' | 'simple' =
        localStoryboardPromptRefineLevel === 'conservative'
        || localStoryboardPromptRefineLevel === 'simple'
        || localStoryboardPromptRefineLevel === 'medium'
            ? localStoryboardPromptRefineLevel
            : 'medium'

    // 直接把 input 的 value 绑定到 props（并且 onChange 立刻写入数据库）会导致：
    // - 用户输入中间态（比如先输入 1、再输入 1024）会被后端校验/默认值“回弹”
    // - Number('') / Number('1') 这种中间值也会触发保存，UI 看起来“变来变去”
    // 所以这里用本地草稿值：onChange 只更新草稿，onBlur/Enter 时再提交。
    const [t2iWidthDraft, setT2IWidthDraft] = useState<string>(String(t2iWidth))
    const [t2iHeightDraft, setT2IHeightDraft] = useState<string>(String(t2iHeight))
    const [t2iStepsDraft, setT2IStepsDraft] = useState<string>(String(t2iSteps))
    const [i2iWidthDraft, setI2IWidthDraft] = useState<string>(String(i2iWidth))
    const [i2iHeightDraft, setI2IHeightDraft] = useState<string>(String(i2iHeight))
    const [i2iStepsDraft, setI2IStepsDraft] = useState<string>(String(i2iSteps))
    const [promptRefineEnabledDraft, setPromptRefineEnabledDraft] = useState<boolean>(promptRefineEnabled)
    const [promptRefineLevelDraft, setPromptRefineLevelDraft] = useState<'conservative' | 'medium' | 'simple'>(promptRefineLevel)

    useEffect(() => {
        if (!isOpen) return
        // 打开弹窗时同步一次；切换到 local 模型时也同步一次
        setT2IWidthDraft(String(t2iWidth))
        setT2IHeightDraft(String(t2iHeight))
        setT2IStepsDraft(String(t2iSteps))
        setI2IWidthDraft(String(i2iWidth))
        setI2IHeightDraft(String(i2iHeight))
        setI2IStepsDraft(String(i2iSteps))
        setPromptRefineEnabledDraft(promptRefineEnabled)
        setPromptRefineLevelDraft(promptRefineLevel)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, isLocalImageModel])

    const clampInt = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
    const snap64 = (value: number) => Math.max(64, Math.floor(value / 64) * 64)

    const commitT2IWidth = () => {
        const n = parseInt(t2iWidthDraft, 10)
        if (Number.isFinite(n)) onLocalT2IWidthChange?.(snap64(clampInt(n, 64, 4096)))
        else setT2IWidthDraft(String(t2iWidth))
    }
    const commitT2IHeight = () => {
        const n = parseInt(t2iHeightDraft, 10)
        if (Number.isFinite(n)) onLocalT2IHeightChange?.(snap64(clampInt(n, 64, 4096)))
        else setT2IHeightDraft(String(t2iHeight))
    }
    const commitT2ISteps = () => {
        const n = parseInt(t2iStepsDraft, 10)
        if (Number.isFinite(n)) onLocalT2IStepsChange?.(clampInt(n, 1, 200))
        else setT2IStepsDraft(String(t2iSteps))
    }
    const commitI2IWidth = () => {
        const n = parseInt(i2iWidthDraft, 10)
        if (Number.isFinite(n)) onLocalI2IWidthChange?.(snap64(clampInt(n, 64, 4096)))
        else setI2IWidthDraft(String(i2iWidth))
    }
    const commitI2IHeight = () => {
        const n = parseInt(i2iHeightDraft, 10)
        if (Number.isFinite(n)) onLocalI2IHeightChange?.(snap64(clampInt(n, 64, 4096)))
        else setI2IHeightDraft(String(i2iHeight))
    }
    const commitI2ISteps = () => {
        const n = parseInt(i2iStepsDraft, 10)
        if (Number.isFinite(n)) onLocalI2IStepsChange?.(clampInt(n, 1, 200))
        else setI2IStepsDraft(String(i2iSteps))
    }

    const commitPromptRefineEnabled = () => {
        onLocalStoryboardPromptRefineEnabledChange?.(promptRefineEnabledDraft)
    }
    const commitPromptRefineLevel = () => {
        onLocalStoryboardPromptRefineLevelChange?.(promptRefineLevelDraft)
    }
    const editCapabilityFields = useMemo(
        () => extractCapabilityFields(selectedEditModelOption?.capabilities, 'image'),
        [selectedEditModelOption],
    )

    const selectedVideoOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, videoModel)
    }, [capabilityOverrides, videoModel])
    const selectedAnalysisOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, analysisModel)
    }, [capabilityOverrides, analysisModel])
    const selectedAudioOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, audioModel)
    }, [capabilityOverrides, audioModel])
    const selectedCharacterOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, characterModel)
    }, [capabilityOverrides, characterModel])
    const selectedLocationOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, locationModel)
    }, [capabilityOverrides, locationModel])
    const selectedStoryboardOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, imageModel)
    }, [capabilityOverrides, imageModel])
    const selectedEditOverrides = useMemo<Record<string, CapabilityValue>>(() => {
        return readCapabilitySelectionForModel(capabilityOverrides, editModel)
    }, [capabilityOverrides, editModel])

    const applyCapabilityOverride = (modelKey: string | undefined, field: string, value: string, sample: CapabilityValue) => {
        if (!modelKey || !onCapabilityOverridesChange) return

        const nextOverrides: CapabilitySelections = {
            ...(capabilityOverrides || {}),
        }
        const currentSelection = isRecord(nextOverrides[modelKey])
            ? { ...(nextOverrides[modelKey] as Record<string, CapabilityValue>) }
            : {}

        if (!value) {
            delete currentSelection[field]
        } else {
            currentSelection[field] = parseBySample(value, sample)
        }

        if (Object.keys(currentSelection).length === 0) {
            delete nextOverrides[modelKey]
        } else {
            nextOverrides[modelKey] = currentSelection
        }

        onCapabilityOverridesChange(nextOverrides)
        showSaved()
    }

    /**
     * 切换模型时，自动将该模型所有 capability fields 的第一个 option 写入 overrides
     * 解决 UI 视觉上显示默认选中（第一项高亮）但 DB 实际为空，导致 requireAllFields 报错的问题
     */
    const handleModelChange = (
        modelKey: string,
        modelOptions: ModelOption[],
        namespace: 'llm' | 'image' | 'video' | 'audio',
        onModelChangeFn?: (v: string) => void,
    ) => {
        onModelChangeFn?.(modelKey)
        showSaved()
        if (!onCapabilityOverridesChange) return
        // 用新选中的模型的 capabilities 计算 fields，而不是旧模型的
        const newModel = modelOptions.find((m) => m.value === modelKey)
        const capabilityFieldsForModel = extractCapabilityFields(newModel?.capabilities, namespace)
        if (capabilityFieldsForModel.length === 0) return
        const nextOverrides: CapabilitySelections = { ...(capabilityOverrides || {}) }
        const existing = isRecord(nextOverrides[modelKey])
            ? { ...(nextOverrides[modelKey] as Record<string, CapabilityValue>) }
            : {}
        // 只对尚未配置的 field 设置默认值（不覆盖已有配置）
        let changed = false
        for (const def of capabilityFieldsForModel) {
            if (existing[def.field] === undefined && def.options.length > 0) {
                existing[def.field] = def.options[0]
                changed = true
            }
        }
        if (changed) {
            nextOverrides[modelKey] = existing
            onCapabilityOverridesChange(nextOverrides)
        }
    }

    void ttsRate
    void onTTSRateChange

    useEffect(() => {
        if (!isOpen) return
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [isOpen, onClose])

    const showSaved = () => {
        setSaveStatus('saved')
        setTimeout(() => setSaveStatus('idle'), 2000)
    }

    const handleChange = (callback?: (value: string) => void) => (value: string) => {
        callback?.(value)
        showSaved()
    }

    if (!isOpen) return null

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center glass-overlay animate-fadeIn"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose()
            }}
        >
            <div className="glass-surface-modal p-7 w-full max-w-3xl transform transition-all scale-100 max-h-[90vh] flex flex-col">
                <div className="flex justify-between items-center mb-2">
                    <h2 className="text-2xl font-bold text-[var(--glass-text-primary)]">{t('title')}</h2>
                    <div className="flex items-center gap-3">
                        <div className={`glass-chip text-xs transition-all duration-300 ${saveStatus === 'saved'
                            ? 'glass-chip-success'
                            : 'glass-chip-neutral'
                            }`}>
                            {saveStatus === 'saved' ? (
                                <>
                                    <AppIcon name="check" className="w-3.5 h-3.5" />
                                    {t('saved')}
                                </>
                            ) : (
                                <>
                                    <span className="w-1.5 h-1.5 bg-[var(--glass-tone-success-fg)] rounded-full"></span>
                                    {t('autoSave')}
                                </>
                            )}
                        </div>
                        <button
                            onClick={onClose}
                            className="glass-btn-base glass-btn-soft rounded-full p-2 text-[var(--glass-text-tertiary)] hover:text-[var(--glass-text-secondary)]"
                        >
                            <AppIcon name="close" className="w-6 h-6" />
                        </button>
                    </div>
                </div>
                <p className="text-[12px] text-[var(--glass-text-tertiary)] mb-6">{t('subtitle')}</p>
                <div className="space-y-5 flex-1 min-h-0 overflow-y-auto app-scrollbar">
                    <div className="glass-surface-soft p-5 sm:p-6 space-y-4">
                        <h3 className="text-sm font-semibold text-[var(--glass-text-tertiary)]">{t('visualSettings')}</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('visualStyle')}</label>
                                <StyleSelector
                                    value={artStyle}
                                    onChange={(value) => handleChange(onArtStyleChange)(value)}
                                    options={ART_STYLES}
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('aspectRatio')}</label>
                                <RatioSelector
                                    value={videoRatio}
                                    onChange={(value) => { handleChange(onVideoRatioChange)(value) }}
                                    options={VIDEO_RATIOS}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="glass-surface-soft p-5 sm:p-6 space-y-4">
                        <h3 className="text-sm font-semibold text-[var(--glass-text-tertiary)]">{t('modelParams')}</h3>
                        {!modelsLoaded && (
                            <div className="text-xs text-[var(--glass-text-tertiary)]">{t('loadingModels')}</div>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('analysisModel')}</label>
                                <ModelCapabilityDropdown
                                    models={userModels.llm}
                                    value={analysisModel}
                                    onModelChange={(v) => handleChange(onAnalysisModelChange)(v)}
                                    capabilityFields={analysisCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedAnalysisOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(analysisModel, field, rawValue, sample)
                                    }}
                                    placeholder={t('pleaseSelect')}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('characterModel')}</label>
                                <ModelCapabilityDropdown
                                    models={userModels.image}
                                    value={characterModel}
                                    onModelChange={(v) => handleModelChange(v, userModels.image, 'image', onCharacterModelChange)}
                                    capabilityFields={characterCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedCharacterOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(characterModel, field, rawValue, sample)
                                    }}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('locationModel')}</label>
                                <ModelCapabilityDropdown
                                    models={userModels.image}
                                    value={locationModel}
                                    onModelChange={(v) => handleModelChange(v, userModels.image, 'image', onLocationModelChange)}
                                    capabilityFields={locationCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedLocationOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(locationModel, field, rawValue, sample)
                                    }}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('storyboardModel')}</label>
                                <ModelCapabilityDropdown
                                    models={userModels.image}
                                    value={imageModel}
                                    onModelChange={(v) => handleModelChange(v, userModels.image, 'image', onImageModelChange)}
                                    capabilityFields={storyboardCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedStoryboardOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(imageModel, field, rawValue, sample)
                                    }}
                                />
                            </div>

                            {isLocalImageModel ? (
                                <div className="space-y-2 md:col-span-2">
                                    <div className="rounded-xl border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-muted)] p-4">
                                        <div className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('localImageTitle')}</div>
                                        <div className="mt-3 space-y-4">
                                            <div>
                                                <div className="text-xs font-medium text-[var(--glass-text-tertiary)]">{t('localT2ITitle')}</div>
                                                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localImageWidth')}</label>
                                                        <input
                                                            type="number"
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={t2iWidthDraft}
                                                            min={64}
                                                            max={4096}
                                                            step={1}
                                                            onChange={(e) => setT2IWidthDraft(e.target.value)}
                                                            onBlur={commitT2IWidth}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    commitT2IWidth()
                                                                    ;(e.currentTarget as HTMLInputElement).blur()
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localImageHeight')}</label>
                                                        <input
                                                            type="number"
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={t2iHeightDraft}
                                                            min={64}
                                                            max={4096}
                                                            step={1}
                                                            onChange={(e) => setT2IHeightDraft(e.target.value)}
                                                            onBlur={commitT2IHeight}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    commitT2IHeight()
                                                                    ;(e.currentTarget as HTMLInputElement).blur()
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localImageSteps')}</label>
                                                        <input
                                                            type="number"
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={t2iStepsDraft}
                                                            min={1}
                                                            max={200}
                                                            step={1}
                                                            onChange={(e) => setT2IStepsDraft(e.target.value)}
                                                            onBlur={commitT2ISteps}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    commitT2ISteps()
                                                                    ;(e.currentTarget as HTMLInputElement).blur()
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>

                                            <div>
                                                <div className="text-xs font-medium text-[var(--glass-text-tertiary)]">{t('localI2ITitle')}</div>
                                                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localImageWidth')}</label>
                                                        <input
                                                            type="number"
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={i2iWidthDraft}
                                                            min={64}
                                                            max={4096}
                                                            step={1}
                                                            onChange={(e) => setI2IWidthDraft(e.target.value)}
                                                            onBlur={commitI2IWidth}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    commitI2IWidth()
                                                                    ;(e.currentTarget as HTMLInputElement).blur()
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localImageHeight')}</label>
                                                        <input
                                                            type="number"
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={i2iHeightDraft}
                                                            min={64}
                                                            max={4096}
                                                            step={1}
                                                            onChange={(e) => setI2IHeightDraft(e.target.value)}
                                                            onBlur={commitI2IHeight}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    commitI2IHeight()
                                                                    ;(e.currentTarget as HTMLInputElement).blur()
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localImageSteps')}</label>
                                                        <input
                                                            type="number"
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={i2iStepsDraft}
                                                            min={1}
                                                            max={200}
                                                            step={1}
                                                            onChange={(e) => setI2IStepsDraft(e.target.value)}
                                                            onBlur={commitI2ISteps}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    commitI2ISteps()
                                                                    ;(e.currentTarget as HTMLInputElement).blur()
                                                                }
                                                            }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="pt-2 border-t border-[var(--glass-stroke-base)]">
                                                <div className="text-xs font-medium text-[var(--glass-text-tertiary)]">{t('localPromptRefineTitle')}</div>
                                                <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                                                    <label className="flex items-center gap-2 text-sm text-[var(--glass-text-secondary)]">
                                                        <input
                                                            type="checkbox"
                                                            checked={promptRefineEnabledDraft}
                                                            onChange={(e) => {
                                                                setPromptRefineEnabledDraft(e.target.checked)
                                                                // 立即提交，避免用户忘记点失焦
                                                                onLocalStoryboardPromptRefineEnabledChange?.(e.target.checked)
                                                            }}
                                                        />
                                                        {t('localPromptRefineEnabled')}
                                                    </label>
                                                    <div className="md:col-span-2">
                                                        <label className="text-xs text-[var(--glass-text-tertiary)]">{t('localPromptRefineLevel')}</label>
                                                        <select
                                                            className="mt-1 w-full rounded-lg border border-[var(--glass-stroke-base)] bg-[var(--glass-bg-surface)] px-3 py-2 text-sm"
                                                            value={promptRefineLevelDraft}
                                                            onChange={(e) => {
                                                                const v = e.target.value as 'conservative' | 'medium' | 'simple'
                                                                setPromptRefineLevelDraft(v)
                                                                onLocalStoryboardPromptRefineLevelChange?.(v)
                                                            }}
                                                        >
                                                            <option value="conservative">{t('localPromptRefineLevelConservative')}</option>
                                                            <option value="medium">{t('localPromptRefineLevelMedium')}</option>
                                                            <option value="simple">{t('localPromptRefineLevelSimple')}</option>
                                                        </select>
                                                        <div className="mt-1 text-xs text-[var(--glass-text-tertiary)]">
                                                            {t('localPromptRefineHint')}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="mt-2 text-xs text-[var(--glass-text-tertiary)]">
                                            {t('localImageHint')}
                                        </div>
                                    </div>
                                </div>
                            ) : null}

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('editModel')}</label>
                                <ModelCapabilityDropdown
                                    models={userModels.image}
                                    value={editModel}
                                    onModelChange={(v) => handleModelChange(v, userModels.image, 'image', onEditModelChange)}
                                    capabilityFields={editCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedEditOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(editModel, field, rawValue, sample)
                                    }}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('videoModel')}</label>
                                <ModelCapabilityDropdown
                                    models={normalVideoModels}
                                    value={videoModel}
                                    onModelChange={(v) => handleModelChange(v, normalVideoModels, 'video', onVideoModelChange)}
                                    capabilityFields={videoCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedVideoOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(videoModel, field, rawValue, sample)
                                    }}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-[var(--glass-text-secondary)]">{t('audioModel')}</label>
                                <ModelCapabilityDropdown
                                    models={userModels.audio}
                                    value={audioModel}
                                    onModelChange={(v) => handleModelChange(v, userModels.audio, 'audio', onAudioModelChange)}
                                    capabilityFields={audioCapabilityFields}
                                    placementMode="downward"
                                    capabilityOverrides={selectedAudioOverrides}
                                    onCapabilityChange={(field, rawValue, sample) => {
                                        applyCapabilityOverride(audioModel, field, rawValue, sample)
                                    }}
                                    placeholder={t('pleaseSelect')}
                                />
                            </div>
                        </div>
                    </div>


                </div>
            </div>
        </div>
    )
}

export { SettingsModal as ConfigEditModal }
export { WorldContextModal } from './WorldContextModal'
