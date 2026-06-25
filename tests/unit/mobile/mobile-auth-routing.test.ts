import { describe, expect, it } from 'vitest'
import {
  isMobileAuthTarget,
  resolveSafePostLoginTarget,
} from '@/lib/auth/redirect-target'

describe('mobile authentication routing', () => {
  it('removes an existing locale before passing a mobile target to next-intl router', () => {
    expect(resolveSafePostLoginTarget('/zh/mobile')).toBe('/mobile')
    expect(resolveSafePostLoginTarget('/en/mobile/workspace/project-1?episode=episode-1'))
      .toBe('/mobile/workspace/project-1?episode=episode-1')
  })

  it('keeps an already locale-free mobile target', () => {
    expect(resolveSafePostLoginTarget('/mobile/workspace/project-1')).toBe('/mobile/workspace/project-1')
  })

  it('detects only safe mobile destinations for the compact auth shell', () => {
    expect(isMobileAuthTarget('/zh/mobile')).toBe(true)
    expect(isMobileAuthTarget('/mobile/workspace/project-1')).toBe(true)
    expect(isMobileAuthTarget('/zh/workspace')).toBe(false)
    expect(isMobileAuthTarget('https://example.com/mobile')).toBe(false)
  })
})
