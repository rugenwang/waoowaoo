import type { CapabilitySelections } from '@/lib/model-config-contract'
import type { MobileNovelPromotionData } from './types'

export interface MobileProjectSettingsSnapshot {
  capabilityOverrides: CapabilitySelections
  localImageWidth: number
  localImageHeight: number
  localImageSteps: number
  localT2IWidth: number
  localT2IHeight: number
  localT2ISteps: number
  localI2IWidth: number
  localI2IHeight: number
  localI2ISteps: number
  localStoryboardPromptRefineEnabled: boolean
  localStoryboardPromptRefineLevel: 'conservative' | 'medium' | 'simple'
  localStoryboardUsePanelDescriptionEnabled: boolean
  progressPopupEnabled: boolean
  forcedStoryboardDurationSec: 8 | 10 | 15 | 20 | null
}

function parseCapabilityOverrides(raw: MobileNovelPromotionData['capabilityOverrides']): CapabilitySelections {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CapabilitySelections
      : {}
  } catch {
    return {}
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function getMobileProjectSettingsSnapshot(
  projectData: MobileNovelPromotionData | null | undefined,
): MobileProjectSettingsSnapshot {
  const legacyWidth = numberOr(projectData?.localImageWidth, 1024)
  const legacyHeight = numberOr(projectData?.localImageHeight, 1024)
  const legacySteps = numberOr(projectData?.localImageSteps, 8)
  const refineLevel = projectData?.localStoryboardPromptRefineLevel
  const duration = projectData?.forcedStoryboardDurationSec

  return {
    capabilityOverrides: parseCapabilityOverrides(projectData?.capabilityOverrides),
    localImageWidth: legacyWidth,
    localImageHeight: legacyHeight,
    localImageSteps: legacySteps,
    localT2IWidth: numberOr(projectData?.localT2IWidth, legacyWidth),
    localT2IHeight: numberOr(projectData?.localT2IHeight, legacyHeight),
    localT2ISteps: numberOr(projectData?.localT2ISteps, legacySteps),
    localI2IWidth: numberOr(projectData?.localI2IWidth, legacyWidth),
    localI2IHeight: numberOr(projectData?.localI2IHeight, legacyHeight),
    localI2ISteps: numberOr(projectData?.localI2ISteps, legacySteps),
    localStoryboardPromptRefineEnabled: projectData?.localStoryboardPromptRefineEnabled === true,
    localStoryboardPromptRefineLevel: refineLevel === 'conservative' || refineLevel === 'simple' || refineLevel === 'medium'
      ? refineLevel
      : 'medium',
    localStoryboardUsePanelDescriptionEnabled: projectData?.localStoryboardUsePanelDescriptionEnabled === true,
    progressPopupEnabled: projectData?.progressPopupEnabled === true,
    forcedStoryboardDurationSec: duration === 8 || duration === 10 || duration === 15 || duration === 20
      ? duration
      : null,
  }
}
