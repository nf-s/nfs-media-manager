import { describe, expect, it } from 'vitest'
import { BrowseFacetQuerySchema } from '../src/browse'

describe('bounded facet queries', () => {
  it('defaults to 25 values per field and trims optional search', () => {
    expect(BrowseFacetQuerySchema.parse({})).toEqual({ limitPerField: 25 })
    expect(
      BrowseFacetQuerySchema.parse({ q: ' rare tag ', limitPerField: '50' }),
    ).toEqual({ q: 'rare tag', limitPerField: 50 })
  })
  it('rejects excessive search length and unbounded limits', () => {
    for (const input of [
      { q: 'x'.repeat(201) },
      { limitPerField: 0 },
      { limitPerField: 51 },
      { limitPerField: 1.5 },
    ])
      expect(BrowseFacetQuerySchema.safeParse(input).success).toBe(false)
  })
})
