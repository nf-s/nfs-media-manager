import { describe, expect, it } from 'vitest'
import {
  PROVIDER_REQUEST_SERIES_DAYS,
  ProviderLibraryCoverageSchema,
  ProviderRequestSeriesSchema,
  ProviderSiteUrlSchema,
} from '../src/provider'

describe('provider site URL', () => {
  it('accepts http and https URLs only', () => {
    for (const url of ['https://example.com', 'http://example.org/films'])
      expect(ProviderSiteUrlSchema.safeParse(url).success).toBe(true)
    for (const url of [
      'javascript:alert(1)',
      'ftp://example.com',
      'example.com',
      '',
    ])
      expect(ProviderSiteUrlSchema.safeParse(url).success).toBe(false)
  })
})

describe('provider request series', () => {
  const series = {
    provider: 'fixture',
    recordedSince: null,
    daysFrom: '2026-08-19',
    daysTo: '2026-11-16',
    total: 3,
    days: [{ date: '2026-11-16', count: 3 }],
  }

  it('holds sparse positive day counts within the 90-day window', () => {
    expect(ProviderRequestSeriesSchema.parse(series)).toEqual(series)
    expect(
      ProviderRequestSeriesSchema.safeParse({
        ...series,
        days: [{ date: '2026-11-16', count: 0 }],
      }).success,
    ).toBe(false)
    expect(
      ProviderRequestSeriesSchema.safeParse({
        ...series,
        days: Array.from({ length: PROVIDER_REQUEST_SERIES_DAYS + 1 }, () => ({
          date: '2026-11-16',
          count: 1,
        })),
      }).success,
    ).toBe(false)
  })
})

describe('provider library coverage', () => {
  it('lists album, film and track coverage and allows none', () => {
    expect(
      ProviderLibraryCoverageSchema.parse({
        provider: 'fixture',
        mediaTypes: [{ mediaType: 'album', covered: 96, total: 128 }],
      }).mediaTypes,
    ).toHaveLength(1)
    expect(
      ProviderLibraryCoverageSchema.parse({
        provider: 'account',
        mediaTypes: [],
      }).mediaTypes,
    ).toEqual([])
    expect(
      ProviderLibraryCoverageSchema.parse({
        provider: 'fixture',
        mediaTypes: [
          { mediaType: 'track', covered: 1, total: 2 },
          { mediaType: 'album', covered: 0, total: 1, queueFrom: 'item' },
        ],
      }).mediaTypes.map((row) => row.queueFrom),
    ).toEqual(['metadata', 'item'])
    expect(
      ProviderLibraryCoverageSchema.safeParse({
        provider: 'fixture',
        mediaTypes: [{ mediaType: 'artist', covered: 1, total: 1 }],
      }).success,
    ).toBe(false)
  })
})
