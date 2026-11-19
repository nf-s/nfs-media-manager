import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import { expect, it, vi } from 'vitest'
import { verifySpotifyArtistCatalogRecordings } from '../spotify-artist-catalog'

const name = 'Fixture Artist'
const artistId = '0123456789abcdefghijkl'
const credit = { id: artistId, name }
const first = { title: 'First Recording', albumName: 'Fixture Release' }
const second = { title: 'Second Recording', albumName: 'Fixture Release' }
const firstId = '0123456789abcdefghijkm'
const secondId = '0123456789abcdefghijkn'
const otherArtist = { id: '0123456789abcdefghijko', name }

function track(id: string, recording: typeof first) {
  return {
    id,
    name: recording.title,
    artists: [credit],
    album: {
      name: recording.albumName,
      album_type: 'album',
      artists: [credit],
    },
  }
}

function page(
  items: unknown[],
  total = items.length,
  next: string | null = null,
) {
  return { tracks: { offset: 0, items, total, next } }
}

function fixture(...payloads: unknown[]) {
  return {
    secrets: { market: 'AU' },
    request: vi.fn<MediaPluginTestContext['request']>(async () => {
      if (!payloads.length) throw new Error('Exceeded mocked request bound')
      return Response.json(payloads.shift())
    }),
  }
}

it('verifies an artist with two distinct recordings from the same reported release', async () => {
  const context = fixture(
    page([track(firstId, first)]),
    page([track(secondId, second)]),
  )
  expect(
    await verifySpotifyArtistCatalogRecordings(context, name, 'fixture-token', [
      first,
      second,
    ]),
  ).toEqual({
    artistId,
    artistName: name,
    recordings: [
      {
        spotifyTrackId: firstId,
        title: first.title,
        release: first.albumName,
        artistId,
      },
      {
        spotifyTrackId: secondId,
        title: second.title,
        release: second.albumName,
        artistId,
      },
    ],
  })
  expect(context.request).toHaveBeenCalledTimes(2)
  expect(
    context.request.mock.calls.map(([url]) => {
      const search = new URL(String(url)).searchParams
      return [
        search.get('type'),
        search.get('limit'),
        search.get('market'),
        search.get('q'),
      ]
    }),
  ).toEqual(
    [first, second].map(({ title, albumName }) => [
      'track',
      '10',
      'AU',
      `artist:"${name}" track:"${title}" album:"${albumName}"`,
    ]),
  )
})

it.each([
  [page([track(firstId, first)], 2)],
  [page([track(firstId, first)], 1, 'https://example.test/next')],
  [page([{ ...track(firstId, first), name: `${first.title} - Live` }])],
  [
    page([
      {
        ...track(firstId, first),
        album: { ...track(firstId, first).album, name: 'Other Release' },
      },
    ]),
  ],
  [
    page([
      {
        ...track(firstId, first),
        artists: [{ ...otherArtist, name: 'Primary Artist' }, credit],
      },
    ]),
  ],
  [
    page([
      {
        ...track(firstId, first),
        album: {
          ...track(firstId, first).album,
          album_type: 'compilation',
          artists: [{ ...otherArtist, name: 'Various Artists' }],
        },
      },
    ]),
  ],
  [page([{ ...track(firstId, first), artists: [credit, otherArtist] }])],
  [
    page([
      track(firstId, first),
      { ...track(secondId, first), artists: [otherArtist] },
    ]),
  ],
])(
  'rejects an incomplete or unreliable Spotify catalog page %#',
  async (response) => {
    const context = fixture(response)
    expect(
      await verifySpotifyArtistCatalogRecordings(
        context,
        name,
        'fixture-token',
        [first, second],
      ),
    ).toBeNull()
    expect(context.request).toHaveBeenCalledOnce()
  },
)

it('rejects distinct recordings credited to different exact-name Spotify artists', async () => {
  const context = fixture(
    page([track(firstId, first)]),
    page([{ ...track(secondId, second), artists: [otherArtist] }]),
  )
  expect(
    await verifySpotifyArtistCatalogRecordings(context, name, 'fixture-token', [
      first,
      second,
    ]),
  ).toBeNull()
  expect(context.request).toHaveBeenCalledTimes(2)
})

it('skips catalog search with only versions of one title or no second reported release', async () => {
  const context = fixture()
  expect(
    await verifySpotifyArtistCatalogRecordings(context, name, 'fixture-token', [
      first,
      { ...first, title: `${first.title} (Live)` },
      { ...second, albumName: null },
    ]),
  ).toBeNull()
  expect(context.request).not.toHaveBeenCalled()
})
