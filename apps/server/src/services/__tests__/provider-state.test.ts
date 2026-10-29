import { describe, expect, it } from 'vitest'
import { normalizeCreditsForInsert } from '@/services/provider-state'

describe('normalizeCreditsForInsert', () => {
  it('deduplicates repeated artist-role pairs and keeps the earliest billing order', () => {
    const normalized = normalizeCreditsForInsert([
      {
        name: 'Broadcast',
        role: 'artist',
        billingOrder: 1,
      },
      {
        name: 'Broadcast',
        role: 'artist',
        billingOrder: 0,
      },
      {
        name: 'Trish Keenan',
        role: 'writer',
        billingOrder: 2,
      },
    ])

    expect(normalized).toEqual([
      {
        artistId: expect.stringMatching(/^artist_/),
        name: 'Broadcast',
        role: 'artist',
        billingOrder: 0,
      },
      {
        artistId: expect.stringMatching(/^artist_/),
        name: 'Trish Keenan',
        role: 'writer',
        billingOrder: 2,
      },
    ])
  })
})
