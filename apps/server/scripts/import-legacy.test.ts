import { describe, expect, it } from 'vitest'
import { normalizeSpotifyAlbum } from './import-legacy'

describe('normalizeSpotifyAlbum', () => {
  it('reads nested spotify payload fields from the legacy album record', () => {
    const result = normalizeSpotifyAlbum(
      {
        spotify: {
          id: 'spotify-album-id',
          name: 'Spaces',
          artists: [{ name: 'Nala Sinephro' }],
          external_ids: { upc: '123456789012' },
          external_urls: {
            spotify: 'https://open.spotify.com/album/spotify-album-id',
          },
          images: [{ url: 'https://example.com/art.jpg', height: 300 }],
          release_date: '2021-09-03',
          genres: ['ambient jazz'],
          tracks: {
            items: [
              {
                id: 'track-1',
                name: 'Space 1',
                track_number: 1,
                duration_ms: 120000,
              },
              {
                id: 'track-2',
                name: 'Space 1 Reprise',
                track_number: 1,
                duration_ms: 60000,
              },
            ],
          },
        },
        playlists: ['playlist-1'],
      },
      {
        'playlist-1': {
          name: 'Daily Rotation',
        },
      },
    )

    expect(result.normalized.mediaPatch).toMatchObject({
      title: 'Spaces',
      artworkUrl: 'https://example.com/art.jpg',
      releaseDate: '2021-09-03',
    })
    expect(result.normalized.albumPatch).toMatchObject({
      durationSec: 180,
      spotifyUrl: 'https://open.spotify.com/album/spotify-album-id',
    })
    expect(result.normalized.references).toEqual([
      {
        referenceType: 'album',
        externalId: 'spotify-album-id',
        isPrimary: true,
      },
      {
        referenceType: 'upc',
        externalId: '123456789012',
        isPrimary: false,
      },
    ])
    expect(result.normalized.links).toEqual([
      {
        provider: 'spotify',
        label: 'Spotify',
        url: 'https://open.spotify.com/album/spotify-album-id',
      },
    ])
    expect(result.normalized.tracks).toEqual([
      {
        externalId: 'track-1',
        title: 'Space 1',
        position: 1,
        durationSec: 120,
      },
      {
        externalId: 'track-2',
        title: 'Space 1 Reprise',
        position: 2,
        durationSec: 60,
      },
    ])
    expect(result.normalized.playlists).toEqual([
      {
        name: 'Daily Rotation',
        kind: 'playlist',
        position: 0,
      },
    ])
  })
})
