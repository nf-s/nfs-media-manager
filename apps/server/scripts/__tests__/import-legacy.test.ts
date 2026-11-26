import { describe, expect, it } from 'vitest'
import {
  normalizeOmdbPayload,
  normalizeSpotifyAlbum,
} from '../../scripts/import-legacy'

describe('legacy import normalizers', () => {
  it('keeps metadata from a partial Spotify album page without installing tracks', () => {
    const result = normalizeSpotifyAlbum(
      {
        id: 'FixtureSavedEdition001',
        name: 'Fixture Album',
        release_date: '2019-01-01',
        artists: [
          {
            name: 'Fixture Artist',
          },
        ],
        total_tracks: 2,
        tracks: {
          offset: 0,
          total: 2,
          next: 'https://example.test/next-page',
          items: [
            {
              id: 'FixtureSavedRecording1',
              name: 'Fixture Song',
              disc_number: 1,
              track_number: 1,
              duration_ms: 291000,
              artists: [{ name: 'Fixture Artist' }],
            },
          ],
        },
        external_ids: {
          upc: '123456789012',
        },
        external_urls: {
          spotify: 'https://open.spotify.com/album/FixtureSavedEdition001',
        },
        source: {
          type: 'playlist',
        },
        playlists: ['playlist-1'],
        genres: ['ambient'],
        images: [
          {
            height: 300,
            url: 'https://images.example/cover-300.jpg',
          },
        ],
        addedDate: '2020-01-01',
      },
      {
        'playlist-1': {
          name: 'Electronic Essentials',
        },
      },
    )

    expect(result.normalized.mediaPatch).toMatchObject({
      title: 'Fixture Album',
      artworkUrl: 'https://images.example/cover-300.jpg',
      sourceLabel: 'playlist',
    })
    expect(result.normalized.albumPatch).toMatchObject({
      dateAdded: '2020-01-01',
      spotifyUrl: 'https://open.spotify.com/album/FixtureSavedEdition001',
    })
    expect(result.normalized.albumPatch?.durationSec).toBeUndefined()
    expect(result.normalized.tracks).toEqual([])
    expect(result.normalized.references).toEqual([
      {
        referenceType: 'album',
        externalId: 'FixtureSavedEdition001',
        isPrimary: true,
      },
      {
        referenceType: 'upc',
        externalId: '123456789012',
        isPrimary: false,
      },
    ])
    expect(result.normalized.playlists).toEqual([
      {
        name: 'Electronic Essentials',
        kind: 'playlist',
        position: 0,
      },
    ])
  })

  it('normalizes omdb payloads into canonical film data', () => {
    const result = normalizeOmdbPayload({
      title: 'Alien',
      plot: 'The crew encounters a lethal organism.',
      poster: 'https://images.example/alien.jpg',
      released: '1979-05-25',
      runtime: '117 min',
      boxoffice: '$106,285,522',
      imdbid: 'tt0078748',
      imdburl: 'https://www.imdb.com/title/tt0078748/',
      genres: 'Horror, Sci-Fi',
      director: 'Ridley Scott',
      writer: 'Dan O’Bannon',
      actors: 'Sigourney Weaver, Tom Skerritt',
    })

    expect(result.normalized.mediaPatch).toMatchObject({
      title: 'Alien',
      summary: 'The crew encounters a lethal organism.',
      artworkUrl: 'https://images.example/alien.jpg',
      releaseDate: '1979-05-25',
    })
    expect(result.normalized.filmPatch).toMatchObject({
      runtimeMinutes: 117,
      boxOffice: 106285522,
    })
    expect(result.normalized.references).toEqual([
      {
        referenceType: 'imdb',
        externalId: 'tt0078748',
        isPrimary: true,
      },
    ])
    expect(result.normalized.tags).toEqual([
      { name: 'Horror', kind: 'genre' },
      { name: 'Sci-Fi', kind: 'genre' },
    ])
    expect(result.normalized.credits).toEqual([
      { name: 'Ridley Scott', role: 'director', billingOrder: 0 },
      { name: 'Dan O’Bannon', role: 'writer', billingOrder: 0 },
      { name: 'Sigourney Weaver', role: 'actor', billingOrder: 0 },
      { name: 'Tom Skerritt', role: 'actor', billingOrder: 1 },
    ])
  })
})
