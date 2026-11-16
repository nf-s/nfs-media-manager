import { describe, expect, it } from 'vitest'
import {
  MatchCandidateSchema,
  MatchSearchInputSchema,
  UnresolvedMatchListSchema,
} from '../src/find-match'
import { ProviderSummarySchema } from '../src/provider'

describe('find match schemas', () => {
  it('accepts one item and provider with optional trimmed search text', () => {
    expect(
      MatchSearchInputSchema.parse({
        kind: 'album',
        id: 'album-1',
        provider: 'discogs',
        q: ' Example ',
      }),
    ).toEqual({
      kind: 'album',
      id: 'album-1',
      provider: 'discogs',
      q: 'Example',
    })
    for (const input of [
      { kind: 'track', id: 'track-1', provider: 'spotify' },
      { kind: 'film', id: 'film-1', provider: 'tmdb', q: ' ' },
      { kind: 'film', id: 'film-1', provider: 'tmdb', q: 'x'.repeat(201) },
      { kind: 'film', id: 'film-1', provider: 'tmdb', page: 2 },
    ])
      expect(MatchSearchInputSchema.safeParse(input).success).toBe(false)
  })

  it('bounds unresolved lookups and their stored candidates', () => {
    const candidate = {
      referenceType: 'artist',
      externalId: 'id-1',
      title: 'Example Artist',
      subtitle: null,
      releaseDate: null,
      artworkUrl: null,
      url: 'https://provider.example.test/artist/id-1',
      current: false,
    }
    expect(
      UnresolvedMatchListSchema.safeParse({
        query: 'Example Artist',
        items: [
          {
            provider: 'musicbrainz',
            jobId: 'job-1',
            outcome: 'ambiguous',
            candidates: [candidate],
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      UnresolvedMatchListSchema.safeParse({
        query: null,
        items: [
          {
            provider: 'musicbrainz',
            jobId: 'job-1',
            outcome: 'ambiguous',
            candidates: Array.from({ length: 21 }, () => candidate),
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('accepts only HTTP(S) candidate links and artwork', () => {
    const candidate = {
      referenceType: 'album',
      externalId: 'id-1',
      title: 'Example Album',
      subtitle: null,
      releaseDate: null,
      artworkUrl: 'https://img.example.test/cover.jpg',
      url: 'http://provider.example.test/album/id-1',
      current: false,
    }
    expect(MatchCandidateSchema.safeParse(candidate).success).toBe(true)
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,x']) {
      expect(
        MatchCandidateSchema.safeParse({ ...candidate, url: unsafe }).success,
      ).toBe(false)
      expect(
        MatchCandidateSchema.safeParse({ ...candidate, artworkUrl: unsafe })
          .success,
      ).toBe(false)
    }
  })

  it('defaults match search support off for older provider summaries', () => {
    expect(
      ProviderSummarySchema.parse({
        id: 'example',
        displayName: 'Example',
        description: '',
        surface: 'provider',
        mediaTypes: ['album'],
        rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
        supportsScrape: true,
        supportsLegacyImport: false,
        secrets: [],
        pluginPath: null,
      }).supportsMatchSearch,
    ).toBe(false)
  })
})
