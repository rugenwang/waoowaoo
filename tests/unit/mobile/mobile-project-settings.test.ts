import { describe, expect, it } from 'vitest'
import { getMobileProjectSettingsSnapshot } from '@/features/mobile-h5/mobile-project-settings'

describe('mobile project settings snapshot', () => {
  it('uses the same defaults as the desktop project settings controller', () => {
    expect(getMobileProjectSettingsSnapshot(undefined)).toEqual({
      capabilityOverrides: {},
      localImageWidth: 1024,
      localImageHeight: 1024,
      localImageSteps: 8,
      localT2IWidth: 1024,
      localT2IHeight: 1024,
      localT2ISteps: 8,
      localI2IWidth: 1024,
      localI2IHeight: 1024,
      localI2ISteps: 8,
      localStoryboardPromptRefineEnabled: false,
      localStoryboardPromptRefineLevel: 'medium',
      localStoryboardUsePanelDescriptionEnabled: false,
      progressPopupEnabled: false,
      forcedStoryboardDurationSec: null,
    })
  })

  it('inherits legacy local image values and parses stored capability overrides', () => {
    const snapshot = getMobileProjectSettingsSnapshot({
      localImageWidth: 2720,
      localImageHeight: 1536,
      localImageSteps: 12,
      localT2IWidth: 1280,
      capabilityOverrides: JSON.stringify({ 'local::image2': { quality: 'high' } }),
      forcedStoryboardDurationSec: 20,
    })

    expect(snapshot.localT2IWidth).toBe(1280)
    expect(snapshot.localT2IHeight).toBe(1536)
    expect(snapshot.localI2IWidth).toBe(2720)
    expect(snapshot.localI2ISteps).toBe(12)
    expect(snapshot.capabilityOverrides).toEqual({ 'local::image2': { quality: 'high' } })
    expect(snapshot.forcedStoryboardDurationSec).toBe(20)
  })
})
