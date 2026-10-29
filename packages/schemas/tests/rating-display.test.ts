import { describe, expect, it } from 'vitest'
import {
  BrowseFieldSchema,
  albumBrowseFields,
  filmBrowseFields,
} from '../src/browse'

describe('rating display metadata', () => {
  it('keeps each MDBList audience score and vote count distinct', () => {
    for (const [key, provider, scale, votesKey] of [
      [
        'ratingMetacriticUser',
        'metacriticuser',
        10,
        'ratingMetacriticUserVotes',
      ],
      ['ratingTrakt', 'trakt', 100, 'ratingTraktVotes'],
      ['ratingLetterboxd', 'letterboxd', 5, 'ratingLetterboxdVotes'],
      [
        'ratingRtAudience',
        'rottentomatoes-audience',
        100,
        'ratingRtAudienceVotes',
      ],
    ]) {
      expect(
        filmBrowseFields.find((field) => field.key === key)?.rating,
      ).toEqual({ provider, scale, votesKey })
    }
  })
  it('pairs public scores with their own vote counts and scales', () => {
    expect(
      filmBrowseFields.find((field) => field.key === 'ratingImdbValue')?.rating,
    ).toEqual({ provider: 'imdb', scale: 10, votesKey: 'ratingImdbVotes' })
    expect(
      albumBrowseFields.find((field) => field.key === 'ratingDiscogsValue')
        ?.rating,
    ).toEqual({ provider: 'discogs', scale: 5, votesKey: 'ratingDiscogsVotes' })
    expect(
      filmBrowseFields.find((field) => field.key === 'ratingMetascore')?.rating
        ?.votesKey,
    ).toBeUndefined()
    expect(
      filmBrowseFields.find((field) => field.key === 'ratingImdbPersonal')
        ?.rating,
    ).toBeUndefined()
  })

  const field = {
    key: 'plugin.fixture.rating',
    label: 'Fixture rating',
    type: 'number',
    rating: {
      provider: 'fixture',
      scale: 100,
      votesKey: 'plugin.fixture.votes',
    },
  }

  it('retains plugin-supplied rating presentation', () => {
    expect(BrowseFieldSchema.parse(field).rating).toEqual(field.rating)
    expect(
      BrowseFieldSchema.parse({
        ...field,
        rating: { ...field.rating, compact: true },
      }).rating?.compact,
    ).toBe(true)
    expect(
      BrowseFieldSchema.safeParse({
        ...field,
        rating: { ...field.rating, compact: 'true' },
      }).success,
    ).toBe(false)
  })

  it('rejects unsafe icon URLs and invalid scales', () => {
    for (const iconUrl of [
      'javascript:alert(1)',
      'http://example.com/icon.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
    ]) {
      expect(
        BrowseFieldSchema.safeParse({
          ...field,
          rating: { ...field.rating, iconUrl },
        }).success,
      ).toBe(false)
    }
    expect(
      BrowseFieldSchema.safeParse({
        ...field,
        rating: { ...field.rating, scale: 0 },
      }).success,
    ).toBe(false)
  })

  it('accepts locally embedded raster icons without provider requests', () => {
    const iconUrl = 'data:image/png;base64,aWNvbg=='
    expect(
      BrowseFieldSchema.parse({
        ...field,
        rating: { ...field.rating, iconUrl },
      }).rating?.iconUrl,
    ).toBe(iconUrl)
  })
})
