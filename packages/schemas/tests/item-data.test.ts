import { describe, expect, it } from 'vitest'
import {
  COVERAGE_ITEM_ID_LIMIT,
  CoverageQuerySchema,
  ProviderCoverageSchema,
} from '../src/coverage'
import { LISTENING_SERIES_DAYS, ListeningSeriesSchema } from '../src/lastfm'
import { MediaProvenanceSchema } from '../src/provenance'

const series = {
  total: 0,
  firstDate: null,
  lastDate: null,
  historyFrom: null,
  daysFrom: '2021-11-16',
  daysTo: '2026-11-16',
  days: [],
  months: [],
}

describe('item data contracts', () => {
  it('bounds daily listening to five years and rejects empty buckets', () => {
    expect(ListeningSeriesSchema.parse(series)).toEqual(series)
    const day = { date: '2026-11-16', count: 1 }
    expect(
      ListeningSeriesSchema.safeParse({
        ...series,
        days: Array.from({ length: LISTENING_SERIES_DAYS }, () => day),
      }).success,
    ).toBe(true)
    expect(
      ListeningSeriesSchema.safeParse({
        ...series,
        days: Array.from({ length: LISTENING_SERIES_DAYS + 1 }, () => day),
      }).success,
    ).toBe(false)
    expect(
      ListeningSeriesSchema.safeParse({
        ...series,
        days: [{ date: '2026-11-16', count: 0 }],
      }).success,
    ).toBe(false)
    expect(
      ListeningSeriesSchema.safeParse({ ...series, firstDate: '2026-13-01' })
        .success,
    ).toBe(false)
  })

  it('defaults and bounds the coverage freshness period and ID lists', () => {
    expect(CoverageQuerySchema.parse({})).toEqual({ olderThanDays: 180 })
    expect(CoverageQuerySchema.parse({ olderThanDays: '30' })).toEqual({
      olderThanDays: 30,
    })
    for (const olderThanDays of ['0', '3651', 'soon'])
      expect(CoverageQuerySchema.safeParse({ olderThanDays }).success).toBe(
        false,
      )
    const provider = {
      provider: 'fixture',
      displayName: 'Fixture',
      eligible: 101,
      covered: 0,
      stale: 0,
      missing: 101,
      unavailableReason: null,
      missingItemIds: Array.from(
        { length: COVERAGE_ITEM_ID_LIMIT + 1 },
        (_, index) => `album-${index}`,
      ),
      staleItemIds: [],
    }
    expect(ProviderCoverageSchema.safeParse(provider).success).toBe(false)
    expect(
      ProviderCoverageSchema.safeParse({
        ...provider,
        missingItemIds: provider.missingItemIds.slice(
          0,
          COVERAGE_ITEM_ID_LIMIT,
        ),
      }).success,
    ).toBe(true)
  })

  it('accepts a field supplied by two providers with an override', () => {
    const source = {
      provider: 'fixture-a',
      scrapedAt: '2026-11-01T00:00:00.000Z',
      snapshotId: 'snapshot-a',
      snapshotSource: 'scrape-job',
      jobId: 'job-a',
      value: 4.1,
      matchesCurrent: false,
    }
    const provenance = {
      mediaItemId: 'album-1',
      mediaType: 'album',
      fields: [
        {
          key: 'browse.ratingDiscogsValue',
          label: 'Discogs rating',
          value: 4.4,
          override: {
            at: '2026-11-02T00:00:00.000Z',
            by: null,
            note: null,
          },
          sources: [
            {
              ...source,
              provider: 'fixture-b',
              value: 4.4,
              matchesCurrent: true,
            },
            source,
          ],
        },
      ],
    }
    expect(MediaProvenanceSchema.parse(provenance)).toEqual(provenance)
  })
})
