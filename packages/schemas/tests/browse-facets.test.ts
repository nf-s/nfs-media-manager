import { describe, expect, it } from 'vitest'
import {
  BrowseFacetQuerySchema,
  browseFacetLabelLocale,
  compareBrowseFacets,
} from '../src/browse'

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

describe('facet order (DEVICE-25)', () => {
  const facets = [
    { count: 2, label: 'Tags: zeta' },
    { count: 5, label: 'Tags: beta' },
    { count: 2, label: 'Tags: Alpha' },
    { count: 2, label: 'Tags: alpha' },
    { count: 2, label: 'Tags: Émile' },
  ]

  it('puts higher counts first and orders ties by label in the named locale', () => {
    expect([...facets].sort(compareBrowseFacets).map((f) => f.label)).toEqual([
      'Tags: beta',
      'Tags: alpha',
      'Tags: Alpha',
      'Tags: Émile',
      'Tags: zeta',
    ])
  })

  it('orders as localeCompare does with the named locale', () => {
    expect([...facets].sort(compareBrowseFacets)).toEqual(
      [...facets].sort(
        (a, b) =>
          b.count - a.count ||
          a.label.localeCompare(b.label, browseFacetLabelLocale),
      ),
    )
  })
})
