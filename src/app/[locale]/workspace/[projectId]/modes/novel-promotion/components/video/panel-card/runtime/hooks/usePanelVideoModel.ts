import { useEffect, useMemo, useState } from 'react'
import type { VideoModelOption, VideoGenerationOptionValue, VideoGenerationOptions } from '../../../types'
import type { CapabilitySelections } from '@/lib/model-config-contract'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'

interface UsePanelVideoModelParams {
  defaultVideoModel: string
  capabilityOverrides?: CapabilitySelections
  userVideoModels?: VideoModelOption[]
  /**
   * 当前分镜的“成片时长（秒）”，来源于 NovelPromotionPanel.duration。
   * 该值应覆盖模型级 capabilityOverrides，避免“改一个全都变”。
   */
  panelDuration?: number | null
}

interface CapabilityField {
  field: string
  label: string
  labelKey?: string
  unitKey?: string
  optionLabelKeys?: Record<string, string>
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isGenerationOptionValue(value: unknown): value is VideoGenerationOptionValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function readSelectionForModel(
  capabilityOverrides: CapabilitySelections | undefined,
  modelKey: string,
): VideoGenerationOptions {
  if (!modelKey || !capabilityOverrides) return {}
  const rawSelection = capabilityOverrides[modelKey]
  if (!isRecord(rawSelection)) return {}

  const selection: VideoGenerationOptions = {}
  for (const [field, value] of Object.entries(rawSelection)) {
    if (field === 'aspectRatio') continue
    // duration 改为分镜级（panel.duration），不再从 capabilityOverrides 读取
    if (field === 'duration') continue
    if (!isGenerationOptionValue(value)) continue
    selection[field] = value
  }
  return selection
}

export function usePanelVideoModel({
  defaultVideoModel,
  capabilityOverrides,
  userVideoModels,
  panelDuration,
}: UsePanelVideoModelParams) {
  const [selectedModel, setSelectedModel] = useState(defaultVideoModel || '')
  const [localDuration, setLocalDuration] = useState<number | null>(
    typeof panelDuration === 'number' && Number.isFinite(panelDuration) ? panelDuration : null,
  )
  const [generationOptions, setGenerationOptions] = useState<VideoGenerationOptions>(() =>
    readSelectionForModel(capabilityOverrides, defaultVideoModel || ''),
  )
  const videoModelOptions = userVideoModels ?? []
  const selectedOption = videoModelOptions.find((option) => option.value === selectedModel)
  const pricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'normal',
      },
    }),
    [selectedOption?.videoPricingTiers],
  )

  useEffect(() => {
    setSelectedModel(defaultVideoModel || '')
  }, [defaultVideoModel])

  useEffect(() => {
    if (!selectedModel) {
      if (videoModelOptions.length > 0) {
        setSelectedModel(videoModelOptions[0].value)
      }
      return
    }
    if (videoModelOptions.some((option) => option.value === selectedModel)) return
    setSelectedModel(videoModelOptions[0]?.value || '')
  }, [selectedModel, videoModelOptions])

  const capabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedOption?.capabilities?.video,
      pricingTiers,
    }),
    [pricingTiers, selectedOption?.capabilities?.video],
  )

  const selectedModelOverrides = useMemo(
    () => readSelectionForModel(capabilityOverrides, selectedModel),
    [capabilityOverrides, selectedModel],
  )
  const selectedModelOverridesSignature = useMemo(
    () => JSON.stringify(selectedModelOverrides),
    [selectedModelOverrides],
  )

  useEffect(() => {
    setLocalDuration(typeof panelDuration === 'number' && Number.isFinite(panelDuration) ? panelDuration : null)
  }, [panelDuration])

  useEffect(() => {
    setGenerationOptions(normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: localDuration !== null
        ? {
          ...selectedModelOverrides,
          duration: localDuration,
        }
        : selectedModelOverrides,
      pinnedFields: localDuration !== null ? ['duration'] : [],
    }))
  }, [selectedModel, selectedModelOverridesSignature, capabilityDefinitions, pricingTiers, selectedModelOverrides, localDuration])

  useEffect(() => {
    setGenerationOptions((previous) => normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: localDuration !== null
        ? {
          ...previous,
          duration: localDuration,
        }
        : previous,
      pinnedFields: localDuration !== null ? ['duration'] : [],
    }))
  }, [capabilityDefinitions, pricingTiers, localDuration])

  const effectiveFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: generationOptions,
    }),
    [capabilityDefinitions, generationOptions, pricingTiers],
  )
  const missingCapabilityFields = useMemo(
    () => effectiveFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    [effectiveFields],
  )
  const effectiveFieldMap = useMemo(
    () => new Map(effectiveFields.map((field) => [field.field, field])),
    [effectiveFields],
  )
  const definitionFieldMap = useMemo(
    () => new Map(capabilityDefinitions.map((definition) => [definition.field, definition])),
    [capabilityDefinitions],
  )
  const capabilityFields: CapabilityField[] = useMemo(() => {
    return capabilityDefinitions.map((definition) => {
      const effectiveField = effectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        labelKey: definition.fieldI18n?.labelKey,
        unitKey: definition.fieldI18n?.unitKey,
        optionLabelKeys: definition.fieldI18n?.optionLabelKeys,
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [capabilityDefinitions, effectiveFieldMap])

  const setCapabilityValue = (field: string, rawValue: string) => {
    const definitionField = definitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    if (field === 'duration' && rawValue === '') {
      setLocalDuration(null)
      return
    }
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return
    if (field === 'duration') {
      setLocalDuration(typeof parsedValue === 'number' && Number.isFinite(parsedValue) ? parsedValue : null)
    }
    setGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: capabilityDefinitions,
        pricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
  }

  return {
    selectedModel,
    setSelectedModel,
    generationOptions,
    capabilityFields,
    setCapabilityValue,
    missingCapabilityFields,
    videoModelOptions,
  }
}
