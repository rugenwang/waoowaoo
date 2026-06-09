import { describe, expect, it } from 'vitest'
import { findBuiltinCapabilities } from '@/lib/model-capabilities/catalog'

describe('eeeapi image capabilities catalog', () => {
  it('registers gpt-image-2 1280x704 image resolution', () => {
    const capabilities = findBuiltinCapabilities('image', 'eeeapi', 'gpt-image-2')

    expect(capabilities?.image?.resolutionOptions).toContain('1280x704')
  })
})
