export const spotifyAlbumId = '1234567890abcdefghijkl'
export const spotifyTrackId = 'abcdefghijkl1234567890'
export function spotifyAlbumFixture() {
  return {
    id: spotifyAlbumId,
    name: 'Example Album',
    artists: [{ id: 'artist-example', name: 'Example Artist' }],
    images: [{ url: 'https://i.scdn.co/image/example' }],
    release_date: '2020-05',
    release_date_precision: 'month',
    external_ids: { upc: '012345678901' },
    total_tracks: 1,
    popularity: 0,
    tracks: {
      offset: 0,
      total: 1,
      next: null,
      items: [
        {
          id: spotifyTrackId,
          name: 'Opening',
          disc_number: 1,
          track_number: 1,
          duration_ms: 120500,
          artists: [{ name: 'Example Artist' }],
        },
      ],
    },
  }
}
export const spotifyTokenFixture = {
  access_token: 'fake-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'fake-refresh-token',
  scope: 'user-library-read',
}
