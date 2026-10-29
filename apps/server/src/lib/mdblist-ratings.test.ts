import { describe, expect, it } from 'vitest'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { normalizeMdblistPayload } from './mdblist-normalizer'

const payload = { type: 'movie', keywords: [], ids: { imdb: 'tt0133093' } }

describe('MDBList audience ratings', () => {
  it('normalizes all four scales, counts and actual URLs without canonical title edits', () => {
    const result = normalizeMdblistPayload({
      ...payload,
      ratings: [
        {
          source: 'metacriticuser',
          value: 8.7,
          score: 87,
          votes: 123,
          url: '/the-matrix',
        },
        {
          source: 'trakt',
          value: 82,
          score: 82,
          votes: 456,
          url: 'https://trakt.tv/movies/the-matrix-1999',
        },
        {
          source: 'letterboxd',
          value: 8.4,
          score: 84,
          votes: 789,
          url: '/film/the-matrix/',
        },
        {
          source: 'popcorn',
          value: 85,
          score: 85,
          votes: 1000,
          url: '/m/the_matrix',
        },
      ],
    })
    expect(result.normalized.mediaPatch).toEqual({
      metadata: {
        browse: {
          ratingMetacriticUser: 8.7,
          ratingMetacriticUserVotes: 123,
          ratingTrakt: 82,
          ratingTraktVotes: 456,
          ratingLetterboxd: 4.2,
          ratingLetterboxdVotes: 789,
          ratingRtAudience: 85,
          ratingRtAudienceVotes: 1000,
        },
      },
    })
    expect(result.normalized.links.map((link) => link.url)).toEqual([
      'https://www.metacritic.com/movie/the-matrix',
      'https://trakt.tv/movies/the-matrix-1999',
      'https://letterboxd.com/film/the-matrix/',
      'https://www.rottentomatoes.com/m/the_matrix',
    ])
    expect(PluginResultSchema.parse(result)).toEqual(result)
    expect(result.payload).toHaveProperty('ratings')
  })

  it('preserves zero, absent values and native value-only ratings', () => {
    const result = normalizeMdblistPayload({
      ...payload,
      ratings: [
        { source: 'metacriticuser', value: 0, votes: 0 },
        { source: 'trakt', value: null, score: null, votes: null },
        { source: 'letterboxd', value: 4, votes: 20 },
        { source: 'tomatoesaudience', score: 91 },
      ],
    })
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingMetacriticUser: 0,
      ratingMetacriticUserVotes: 0,
      ratingTrakt: null,
      ratingTraktVotes: null,
      ratingLetterboxd: 4,
      ratingLetterboxdVotes: 20,
      ratingRtAudience: 91,
      ratingRtAudienceVotes: null,
    })
    expect(result.normalized.links).toEqual([])
  })

  it('uses a supplied critic URL for the corresponding audience score', () => {
    const result = normalizeMdblistPayload({
      ...payload,
      ratings: [
        { source: 'tomatoes', url: '/m/the_matrix' },
        { source: 'audience', score: 90 },
        { source: 'metacritic', url: '/the-matrix' },
        { source: 'metacriticuser', score: 80 },
      ],
    })
    expect(result.normalized.links).toHaveLength(2)
  })

  it('uses the real Trakt ID when the response has no rating URL', () => {
    const result = normalizeMdblistPayload({
      ...payload,
      ids: { imdb: 'tt36491653', trakt: 1192614 },
      ratings: [
        { source: 'trakt', value: 73, score: 73, votes: 2492, url: null },
        {
          source: 'letterboxd',
          value: 4,
          score: 80,
          votes: 349596,
          url: '/film/it-was-just-an-accident/',
        },
      ],
    })
    expect(result.normalized.links[0]?.url).toBe(
      'https://trakt.tv/movies/1192614',
    )
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingLetterboxd: 4,
      ratingTrakt: 73,
    })
  })

  it.each([
    'javascript:alert(1)',
    '//evil.test/film/x',
    'https://letterboxd.com.evil.test/film/x',
    'https://a:b@letterboxd.com/film/x',
    'https://letterboxd.com/member/x',
    '../member/x',
  ])('does not import unsafe or unrelated rating URLs: %s', (url) => {
    const result = normalizeMdblistPayload({
      ...payload,
      ratings: [{ source: 'letterboxd', score: 80, url }],
    })
    expect(result.normalized.links).toEqual([])
  })

  it.each([
    { score: -1 },
    { score: 101 },
    { score: '80' },
    { votes: -1 },
    { votes: 1.5 },
  ])('rejects invalid rating boundary data: %j', (rating) => {
    expect(() =>
      normalizeMdblistPayload({
        ...payload,
        ratings: [{ source: 'trakt', ...rating }],
      }),
    ).toThrow('invalid movie')
  })

  it('ignores unknown sources and does not clear scores when ratings were omitted', () => {
    expect(
      normalizeMdblistPayload(payload).normalized.mediaPatch,
    ).toBeUndefined()
    expect(
      normalizeMdblistPayload({
        ...payload,
        ratings: [{ source: 'unknown', score: 90 }],
      }).normalized.mediaPatch,
    ).toBeUndefined()
  })
})
