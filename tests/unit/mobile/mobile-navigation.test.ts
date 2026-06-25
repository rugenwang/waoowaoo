import { describe, expect, it } from 'vitest'
import {
  MOBILE_MORE_DESTINATIONS,
  MOBILE_PRIMARY_TABS,
  isMobileWorkspaceTab,
} from '@/features/mobile-h5/mobile-navigation'

describe('mobile navigation parity', () => {
  it('keeps five primary touch targets and excludes the editor', () => {
    expect(MOBILE_PRIMARY_TABS.map((item) => item.key)).toEqual([
      'story',
      'script',
      'storyboard',
      'videos',
      'more',
    ])
    expect(isMobileWorkspaceTab('editor')).toBe(false)
  })

  it('exposes assets, voice, queue, and all settings destinations', () => {
    expect(MOBILE_MORE_DESTINATIONS.map((item) => item.key)).toEqual([
      'assets',
      'voice',
      'tasks',
      'project-settings',
      'global-assets',
      'api-settings',
    ])
  })
})
