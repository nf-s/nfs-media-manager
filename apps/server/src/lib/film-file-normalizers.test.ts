import { describe, expect, it } from 'vitest'
import { normalizeImdbCsv, normalizeNfo } from './film-file-normalizers'
import {
  normalizeOmdbPayload,
  normalizeTmdbPayload,
} from './provider-normalizers'
import { PluginResultSchema } from '@repo/media-plugin-sdk'

describe('film file normalization', () => {
  it('does not treat an XML added date as filesystem creation time', () => {
    expect(
      normalizeNfo(
        '<movie><title>Fixture</title><dateadded>2001-01-01</dateadded></movie>',
      ).normalized.filmPatch?.dateAdded,
    ).toBeUndefined()
  })
  it('reads repeated and single XML fields, attributes, credits and escaped text', () => {
    const result = normalizeNfo(
      '<movie><title>Rock &amp; Roll</title><year>2000</year><uniqueid type="imdb" default="true">tt1234567</uniqueid><uniqueid type="tmdb">12</uniqueid><ratings><rating name="imdb"><value>8.2</value><votes>12</votes></rating></ratings><genre>Drama</genre><genre>Comedy</genre><country>France</country><director>Director</director><actor><name>Actor</name></actor><thumb aspect="poster">https://example.test/poster.jpg</thumb><watched>false</watched></movie>',
    )
    expect(result.normalized.mediaPatch?.title).toBe('Rock & Roll')
    expect(result.normalized.references).toHaveLength(2)
    expect(result.normalized.tags).toHaveLength(2)
    expect(result.normalized.credits).toHaveLength(2)
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      country: ['France'],
      ratingImdbValue: 8.2,
      ratingImdbVotes: 12,
    })
    expect(result.normalized.filmPatch?.watched).toBeUndefined()
  })
  it('rejects malformed, non-film and entity-declaring XML', () => {
    for (const xml of [
      '<movie>',
      '<tvshow><title>TV</title></tvshow>',
      '<!DOCTYPE movie [<!ENTITY secret SYSTEM "file:///etc/passwd">]><movie><title>&secret;</title></movie>',
    ])
      expect(() => normalizeNfo(xml)).toThrow()
  })
  it('retains titled films without external identifiers for manual identification', () => {
    expect(
      normalizeNfo('<movie><title>Unknown</title></movie>').normalized
        .references,
    ).toEqual([])
    for (const Const of ['', 'not-an-id']) {
      const result = normalizeImdbCsv(
        { Const, Title: 'Unknown' },
        'imdb-watchlist',
      )
      expect(result?.normalized.mediaPatch?.title).toBe('Unknown')
      expect(result?.normalized.references).toEqual([])
    }
  })
  it('accepts Kodi combined NFO documents with trailing scraper URLs only', () => {
    const xml =
      '<movie><title>Fixture</title><uniqueid type="imdb">tt1234567</uniqueid></movie>'
    expect(
      normalizeNfo(
        `${xml}\nhttps://www.imdb.com/title/tt1234567/\nhttps://www.themoviedb.org/movie/12`,
      ).normalized.mediaPatch?.title,
    ).toBe('Fixture')
    expect(() => normalizeNfo(`${xml}\nunexpected trailing content`)).toThrow()
  })
  it('imports ratings and watchlist independently without treating a watchlist entry as watched', () => {
    const row = {
      Const: 'tt1234567',
      Title: 'Fixture',
      'Title Type': 'Movie',
      'Your Rating': '9',
      'Date Rated': '2025-10-01',
      Year: '2000',
      'IMDb Rating': '8.1',
      'Num Votes': '1,234',
      Directors: 'One, Two',
    }
    const ratings = normalizeImdbCsv(row, 'imdb-ratings')
    expect(ratings?.normalized.filmPatch?.watched).toBe(true)
    expect(ratings?.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      ratingImdbPersonal: 9,
      ratingImdbVotes: 1234,
      ratingImdbPersonalDate: Date.parse('2025-10-01'),
    })
    expect(
      normalizeImdbCsv({ ...row, 'Your Rating': '' }, 'imdb-watchlist')
        ?.normalized.filmPatch?.watched,
    ).toBeUndefined()
    expect(
      normalizeImdbCsv({ ...row, 'Title Type': 'TV Series' }, 'imdb-ratings'),
    ).toBeNull()
  })
  it('normalizes native OMDb casing, missing art and rich browse fields', () => {
    const result = normalizeOmdbPayload({
      Title: 'Fixture',
      imdbID: 'tt1234567',
      Genre: 'Drama, Comedy',
      Director: 'One',
      Actors: 'Two',
      Country: 'France, Canada',
      Language: 'French',
      Released: '25 May 1979',
      Poster: 'N/A',
      imdbRating: '8.5',
      imdbVotes: '1,000',
      Metascore: '89',
      Ratings: [{ Source: 'Rotten Tomatoes', Value: '96%' }],
    })
    expect(PluginResultSchema.safeParse(result).success).toBe(true)
    expect(result.normalized.mediaPatch?.title).toBe('Fixture')
    expect(result.normalized.mediaPatch?.artworkUrl).toBeUndefined()
    expect(result.normalized.mediaPatch?.releaseDate).toBe('1979-05-25')
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toMatchObject({
      country: ['France', 'Canada'],
      ratingImdbVotes: 1000,
      ratingRt: 96,
    })
    expect(result.normalized.credits).toHaveLength(2)
  })
  it('retains TMDb ratings, countries and appended credits in a single result', () => {
    const result = normalizeTmdbPayload({
      id: 12,
      title: 'Fixture',
      vote_average: 8,
      vote_count: 10,
      production_countries: [{ name: 'France' }],
      credits: {
        cast: [{ name: 'Actor' }],
        crew: [{ name: 'Director', job: 'Director' }],
      },
    })
    expect(PluginResultSchema.safeParse(result).success).toBe(true)
    expect(result.normalized.credits).toHaveLength(2)
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({
      ratingTmdbValue: 8,
      ratingTmdbVotes: 10,
      country: ['France'],
    })
  })
})
