import { describe, expect, it } from 'vitest'
import {
  earliestFilmAddedDate,
  filmAddedDate,
  legacyFilmAddedDate,
  nfoCreationDate,
} from './film-added-date'
import { normalizeImdbCsv, normalizeNfo } from './film-file-normalizers'

describe('film library dates', () => {
  it('normalizes date-only, naive timestamps, numeric timestamps and explicit offsets consistently', () => {
    for (const value of [
      '2020-01-02',
      '2020-01-02 00:00:00',
      ['2020-01-02'],
      Date.parse('2020-01-02'),
    ]) {
      expect(filmAddedDate(value, 'Fixture')?.dateAdded).toBe(
        '2020-01-02T00:00:00.000Z',
      )
    }
    expect(
      filmAddedDate('2020-01-02T00:00:00+10:00', 'Fixture')?.dateAdded,
    ).toBe('2020-01-01T14:00:00.000Z')
  })
  it('does not invent dates from invalid, incomplete or future values', () => {
    for (const value of [
      undefined,
      null,
      '',
      'not a date',
      '2020',
      '2020-02-30',
      '9999-01-01',
      Infinity,
      {},
      [],
    ]) {
      expect(filmAddedDate(value, 'Fixture')).toBeUndefined()
    }
    expect(
      legacyFilmAddedDate({
        releaseDate: '2000-01-01',
        lastUploadDate: '2021-01-01',
      }),
    ).toBeUndefined()
  })
  it('recovers the earliest personal record and preserves its provenance', () => {
    expect(
      legacyFilmAddedDate({
        raw: { movie: { dateadded: ['2020-09-05 14:35:28'] } },
        imdb: {
          myWatchlist: { date: '2012-04-22' },
          myRating: { date: '2019-07-13' },
        },
      }),
    ).toEqual({
      dateAdded: '2012-04-22T00:00:00.000Z',
      dateAddedSource: 'IMDb watchlist (estimated)',
    })
    expect(
      earliestFilmAddedDate([
        undefined,
        filmAddedDate('2020-01-01', 'Later'),
        filmAddedDate('2010-01-01', 'Earlier'),
      ])?.dateAddedSource,
    ).toBe('Earlier')
  })
  it('preserves CSV Created and uses only the NFO file birthtime', () => {
    expect(
      normalizeImdbCsv(
        {
          Title: 'Film',
          Created: '2012-04-22',
          'Date Rated': '2019-07-13',
          'Release Date': '1950-01-01',
        },
        'imdb-watchlist',
      )?.normalized.filmPatch,
    ).toMatchObject({
      dateAdded: '2012-04-22T00:00:00.000Z',
      dateAddedSource: 'IMDb watchlist (estimated)',
    })
    expect(
      normalizeNfo(
        '<movie><title>Film</title><dateadded>2020-09-05 14:35:28</dateadded></movie>',
        {
          path: '/films/Film/movie.nfo',
          birthtimeMs: Date.parse('2018-01-01'),
        },
      ).normalized.filmPatch,
    ).toMatchObject({
      dateAdded: '2018-01-01T00:00:00.000Z',
      dateAddedSource: 'NFO file creation time',
    })
    expect(
      normalizeNfo('<movie><title>Film</title><year>1950</year></movie>')
        .normalized.filmPatch?.dateAdded,
    ).toBeUndefined()
  })
  it('does not substitute mtime, ctime, XML or import time when birthtime is unavailable', () => {
    for (const value of [0, -1, NaN, Infinity, Date.now() + 100000])
      expect(nfoCreationDate(value)).toBeUndefined()
    expect(
      legacyFilmAddedDate({ raw: { movie: { dateadded: ['2000-01-01'] } } }),
    ).toBeUndefined()
    const result = normalizeNfo(
      '<movie><title>Film</title><dateadded>2000-01-01</dateadded></movie>',
      { path: '/films/a.nfo', birthtimeMs: 0 },
    )
    expect(result.normalized.filmPatch?.dateAdded).toBeUndefined()
    expect(result.normalized.mediaPatch?.metadata?.nfo).toEqual({
      path: '/films/a.nfo',
      createdAt: null,
    })
  })
})
