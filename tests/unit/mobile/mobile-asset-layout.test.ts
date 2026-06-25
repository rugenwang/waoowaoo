import { describe, expect, it } from 'vitest'
import { getAssetLayoutClasses } from '@/features/mobile-h5/mobile-asset-layout'

describe('mobile project asset layout', () => {
  it('uses a touch-friendly single-column hierarchy on mobile', () => {
    const classes = getAssetLayoutClasses(true)

    expect(classes.stage).toContain('space-y-3')
    expect(classes.section).not.toContain('glass-surface')
    expect(classes.groupGrid).toContain('grid-cols-1')
    expect(classes.assetGrid).toContain('grid-cols-1')
    expect(classes.card).toContain('w-full')
  })

  it('preserves the current desktop hierarchy by default', () => {
    const classes = getAssetLayoutClasses(false)

    expect(classes.section).toContain('glass-surface')
    expect(classes.groupGrid).toContain('md:grid-cols-2')
    expect(classes.locationGrid).toContain('lg:grid-cols-6')
  })
})
