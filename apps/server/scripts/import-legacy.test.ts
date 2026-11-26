import { describe, expect, it } from 'vitest'
import { normalizeSpotifyAlbum } from './import-legacy'

describe('normalizeSpotifyAlbum', () => {
  it('reads nested spotify payload fields from the legacy album record', () => {
    const result = normalizeSpotifyAlbum(
      {
        spotify: {
          id: 'FixtureSavedEdition001',
          name: 'Fixture Album',
          artists: [{ name: 'Fixture Artist' }],
          external_ids: { upc: '123456789012' },
          external_urls: {
            spotify: 'https://open.spotify.com/album/FixtureSavedEdition001',
          },
          images: [{ url: 'https://example.com/art.jpg', height: 300 }],
          release_date: '2021-09-03',
          genres: ['ambient jazz'],
          total_tracks: 2,
          tracks: {
            offset: 0,
            total: 2,
            next: null,
            items: [
              {
                id: 'FixtureSavedRecording2',
                name: 'Fixture Encore',
                disc_number: 2,
                track_number: 1,
                duration_ms: 60000,
                artists: [{ name: 'Fixture Guest' }],
              },
              {
                id: 'FixtureSavedRecording1',
                name: 'Fixture Song',
                disc_number: 1,
                track_number: 1,
                duration_ms: 120000,
                artists: [{ name: 'Fixture Artist' }],
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
      title: 'Fixture Album',
      artworkUrl: 'https://example.com/art.jpg',
      releaseDate: '2021-09-03',
    })
    expect(result.normalized.albumPatch).toMatchObject({
      durationSec: 180,
      spotifyUrl: 'https://open.spotify.com/album/FixtureSavedEdition001',
    })
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
    expect(result.normalized.links).toEqual([
      {
        provider: 'spotify',
        label: 'Spotify',
        url: 'https://open.spotify.com/album/FixtureSavedEdition001',
      },
    ])
    expect(result.normalized.tracks).toEqual([
      {
        externalId: 'FixtureSavedRecording1',
        title: 'Fixture Song',
        position: 1,
        durationSec: 120,
        artists: ['Fixture Artist'],
      },
      {
        externalId: 'FixtureSavedRecording2',
        title: 'Fixture Encore',
        position: 2,
        durationSec: 60,
        artists: ['Fixture Guest'],
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
