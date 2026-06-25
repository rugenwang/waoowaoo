import { describe, expect, it } from 'vitest'
import { getStoryInputComposerLayoutClasses } from '@/components/story-input/story-input-layout'

describe('mobile story input layout', () => {
  it('keeps selectors scrollable but places actions in a separate full-width row', () => {
    const classes = getStoryInputComposerLayoutClasses(true)

    expect(classes.footer).not.toContain('overflow-x-auto')
    expect(classes.selectors).toContain('overflow-x-auto')
    expect(classes.actions).toContain('w-full')
    expect(classes.actions).not.toContain('min-w-max')
  })

  it('preserves the desktop single-row toolbar by default', () => {
    const classes = getStoryInputComposerLayoutClasses(false)

    expect(classes.footer).toContain('overflow-x-auto')
    expect(classes.actions).toContain('min-w-max')
  })
})
