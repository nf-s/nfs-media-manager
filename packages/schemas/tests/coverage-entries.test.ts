import { describe, expect, it } from 'vitest'
import {
  COVERAGE_ITEM_ID_LIMIT,
  CoverageEntriesQuerySchema,
  CoverageEntriesSchema,
  CoverageSchema,
  CoverageSubjectSchema,
} from '../src/coverage'

const page = {
  page: 1,
  size: 100,
  totalCount: 1,
  pageCount: 1,
  name: 'Fixture playlist',
  gap: 'missing',
  provider: null,
  olderThanDays: 180,
  albumCount: 1,
  items: [
    {
      entry: {
        kind: 'album',
        position: 0,
        addedAt: null,
        album: {
          id: 'album-1',
          title: 'Fixture Album',
          artists: ['Fixture Artist'],
          artworkUrl: null,
          releaseDate: null,
          spotifyUrl: null,
        },
      },
      gaps: [
        {
          provider: 'fixture-a',
          displayName: 'Fixture A',
          albumIds: ['album-1'],
        },
      ],
    },
  ],
}

describe('coverage entry contracts', () => {
  it('defaults to missing data for any provider in playlist order', () => {
    expect(CoverageEntriesQuerySchema.parse({})).toMatchObject({
      gap: 'missing',
      olderThanDays: 180,
      page: 1,
      size: 100,
      sortBy: 'position',
      direction: 'asc',
    })
    expect(CoverageEntriesQuerySchema.parse({}).provider).toBeUndefined()
    expect(
      CoverageEntriesQuerySchema.parse({
        gap: 'stale',
        provider: ' fixture-a ',
        olderThanDays: '30',
        kinds: '["track"]',
      }),
    ).toMatchObject({
      gap: 'stale',
      provider: 'fixture-a',
      olderThanDays: 30,
      kinds: ['track'],
    })
  })

  it('rejects unknown gaps, empty providers and unbounded periods', () => {
    for (const input of [
      { gap: 'old' },
      { provider: '' },
      { provider: 'x'.repeat(101) },
      { olderThanDays: 0 },
      { olderThanDays: 3651 },
    ])
      expect(CoverageEntriesQuerySchema.safeParse(input).success).toBe(false)
  })

  it('names each gap with at least one album', () => {
    expect(CoverageEntriesSchema.safeParse(page).success).toBe(true)
    const [item] = page.items
    expect(
      CoverageEntriesSchema.safeParse({
        ...page,
        items: [
          {
            ...item,
            gaps: [{ provider: 'fixture-a', displayName: 'A', albumIds: [] }],
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('coverage contracts', () => {
  it('counts a playlist by its albums or its artists', () => {
    expect(CoverageSubjectSchema.options).toEqual(['albums', 'artists'])
    expect(CoverageSubjectSchema.safeParse('tracks').success).toBe(false)
  })

  it('bounds the IDs returned for each gap', () => {
    const provider = {
      provider: 'musicbrainz',
      displayName: 'MusicBrainz',
      eligible: 101,
      covered: 0,
      stale: 0,
      missing: 101,
      unavailableReason: null,
      missingItemIds: Array.from(
        { length: COVERAGE_ITEM_ID_LIMIT },
        (_, index) => `artist-${index}`,
      ),
      staleItemIds: [],
    }
    const coverage = { total: 101, olderThanDays: 180, providers: [provider] }
    expect(CoverageSchema.safeParse(coverage).success).toBe(true)
    expect(
      CoverageSchema.safeParse({
        ...coverage,
        providers: [
          {
            ...provider,
            missingItemIds: [...provider.missingItemIds, 'artist-100'],
          },
        ],
      }).success,
    ).toBe(false)
  })
})
