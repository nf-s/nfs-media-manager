import { describe, expect, it } from 'vitest'
import {
  getBrowseValues,
  BrowseFilterSchema,
  sameBrowseFilter,
  filmBrowseFields,
  albumBrowseFields,
} from '../src/browse'
import {
  buildAlbumPatchInput,
  buildFilmPatchInput,
  type AlbumDetail,
  type FilmDetail,
} from '../src/media'

const baseAlbumDetail: AlbumDetail = {
  id: 'album-1',
  mediaType: 'album',
  slug: 'fearless',
  title: 'Fearless',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: '2021-01-08T00:00:00.000Z',
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [],
  links: [],
  providerReferences: [
    {
      provider: 'discogs',
      referenceType: 'master',
      externalId: '110843',
      isPrimary: true,
      metadata: null,
    },
  ],
  playlists: [],
  createdAt: '2026-04-03T06:00:00.000Z',
  updatedAt: '2026-04-03T06:00:00.000Z',
  dateAdded: null,
  durationSec: null,
  spotifyUrl: null,
  trackCount: 0,
  tracks: [],
}

const baseFilmDetail: FilmDetail = {
  id: 'film-1',
  mediaType: 'film',
  slug: '12-angry-men',
  title: '12 Angry Men',
  originalTitle: '12 Angry Men',
  summary: 'Summary',
  artworkUrl: 'https://example.com/poster.jpg',
  releaseDate: '1957-04-10T00:00:00.000Z',
  sourceLabel: 'File',
  metadata: null,
  tags: [],
  credits: [],
  links: [],
  providerReferences: [
    {
      provider: 'omdb',
      referenceType: 'imdb',
      externalId: 'tt0050083',
      isPrimary: true,
      metadata: null,
    },
  ],
  playlists: [],
  createdAt: '2026-04-03T06:00:00.000Z',
  updatedAt: '2026-04-03T06:00:00.000Z',
  runtimeMinutes: 97,
  watched: true,
  sourceKind: 'imdb-rating',
  budget: 350000,
  boxOffice: 1000000,
}

describe('keyword browse values', () => {
  it('exposes one Tags concept and keeps legacy field aliases and normalized matching', () => {
    for (const fields of [albumBrowseFields, filmBrowseFields]) {
      expect(fields.filter((field) => field.label === 'Tags')).toHaveLength(1)
      expect(fields.some((field) => field.key === 'keyword')).toBe(false)
    }
    expect(
      BrowseFilterSchema.parse({ field: 'keyword', value: 'Drama' }).field,
    ).toBe('genre')
    expect(
      sameBrowseFilter(
        { field: 'genre', value: 'Caf\u00e9\u00a0 Society' },
        { field: 'keyword', value: ' cafe\u0301 society ' },
      ),
    ).toBe(true)
    expect(
      sameBrowseFilter(
        { field: 'genre', value: 'history' },
        { field: 'genre', value: 'art history' },
      ),
    ).toBe(false)
  })
  it('combines film keywords with tags without duplicates', () => {
    const values = getBrowseValues({
      ...baseFilmDetail,
      tags: [
        { name: 'Drama', kind: 'genre' },
        { name: 'history of spain', kind: 'keyword' },
        { name: 'Drama', kind: 'keyword' },
      ],
    })
    expect(values.genre).toEqual(['Drama', 'history of spain'])
    expect(values.keyword).toBeUndefined()
  })

  it('includes album keywords in the same Tags values', () => {
    const values = getBrowseValues({
      ...baseAlbumDetail,
      tags: [
        { name: 'Jazz', kind: 'genre' },
        { name: 'live', kind: 'keyword' },
      ],
    })
    expect(values.genre).toEqual(['Jazz', 'live'])
    expect(values.keyword).toBeUndefined()
  })
})

describe('buildAlbumPatchInput', () => {
  it('omits unchanged album fields', () => {
    const patch = buildAlbumPatchInput(baseAlbumDetail, {
      title: 'Fearless',
      originalTitle: '',
      summary: '',
      artworkUrl: '',
      releaseDate: '2021-01-08T00:00:00.000Z',
      sourceLabel: '',
      dateAdded: '',
      durationSec: '',
      spotifyUrl: '',
      note: '',
      referenceProvider: '',
      referenceType: '',
      referenceExternalId: '',
    })

    expect(patch).toEqual({})
  })

  it('includes only changed album fields and a new reference override', () => {
    const patch = buildAlbumPatchInput(baseAlbumDetail, {
      title: 'Fearless',
      originalTitle: '',
      summary: '',
      artworkUrl: '',
      releaseDate: '2021-01-08T00:00:00.000Z',
      sourceLabel: 'Manual fix',
      dateAdded: '',
      durationSec: '1234',
      spotifyUrl: '',
      note: 'runtime verification',
      referenceProvider: 'musicbrainz',
      referenceType: 'release-group',
      referenceExternalId: 'rg-1',
    })

    expect(patch).toEqual({
      sourceLabel: 'Manual fix',
      durationSec: 1234,
      note: 'runtime verification',
      referenceOverrides: [
        {
          provider: 'musicbrainz',
          referenceType: 'release-group',
          externalId: 'rg-1',
        },
      ],
    })
  })
})

describe('buildFilmPatchInput', () => {
  it('omits unchanged film fields', () => {
    const patch = buildFilmPatchInput(baseFilmDetail, {
      title: '12 Angry Men',
      originalTitle: '12 Angry Men',
      summary: 'Summary',
      artworkUrl: 'https://example.com/poster.jpg',
      releaseDate: '1957-04-10T00:00:00.000Z',
      sourceLabel: 'File',
      runtimeMinutes: '97',
      watched: true,
      sourceKind: 'imdb-rating',
      budget: '350000',
      boxOffice: '1000000',
      note: '',
      referenceProvider: 'omdb',
      referenceType: 'imdb',
      referenceExternalId: 'tt0050083',
    })

    expect(patch).toEqual({})
  })

  it('captures changed film fields and nullable clears', () => {
    const patch = buildFilmPatchInput(baseFilmDetail, {
      title: '12 Angry Men',
      originalTitle: '',
      summary: 'Updated summary',
      artworkUrl: '',
      releaseDate: '1957-04-10T00:00:00.000Z',
      sourceLabel: 'Runtime QA',
      runtimeMinutes: '',
      watched: false,
      sourceKind: 'manual',
      budget: '',
      boxOffice: '1234567',
      note: 'runtime verification',
      referenceProvider: '',
      referenceType: '',
      referenceExternalId: '',
    })

    expect(patch).toEqual({
      originalTitle: null,
      summary: 'Updated summary',
      artworkUrl: null,
      sourceLabel: 'Runtime QA',
      runtimeMinutes: null,
      watched: false,
      sourceKind: 'manual',
      budget: null,
      boxOffice: 1234567,
      note: 'runtime verification',
    })
  })
})
