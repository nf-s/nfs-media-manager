import { describe, expect, it } from 'vitest'
import {
  normalizeOmdbPayload,
  normalizeSpotifyAlbum,
} from '../../scripts/import-legacy'

describe('legacy import normalizers', () => {
  it('normalizes spotify album payloads into canonical album data', () => {
    const result = normalizeSpotifyAlbum(
      {
        id: 'spotify-album-1',
        name: 'Selected Ambient Works 85-92',
        release_date: '1992-11-09',
        artists: [
          {
            name: 'Aphex Twin',
          },
        ],
        tracks: {
          items: [
            {
              id: 'track-1',
              name: 'Xtal',
              track_number: 1,
              duration_ms: 291000,
            },
            {
              id: 'track-2',
              name: 'Tha',
              track_number: 2,
              duration_ms: 540000,
            },
          ],
        },
        external_ids: {
          upc: '123456789012',
        },
        external_urls: {
          spotify: 'https://open.spotify.com/album/spotify-album-1',
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
      title: 'Selected Ambient Works 85-92',
      artworkUrl: 'https://images.example/cover-300.jpg',
      sourceLabel: 'playlist',
    })
    expect(result.normalized.albumPatch).toMatchObject({
      dateAdded: '2020-01-01',
      durationSec: 831,
      spotifyUrl: 'https://open.spotify.com/album/spotify-album-1',
    })
    expect(result.normalized.references).toEqual([
      {
        referenceType: 'album',
        externalId: 'spotify-album-1',
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
