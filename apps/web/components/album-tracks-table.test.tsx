import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AlbumDetailSchema } from '@repo/schemas/media'
import AlbumTracksTable from './album-tracks-table'
import { ConfigContext } from './providers'
import { PlaybackViewContext } from './playback-provider'
import { idlePlaybackState } from '@/utils/playback-engine'
import { albumTrackView, albumTrackViewHref } from '@/utils/playback-source'

// Detail components import CSS modules; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})
const album = AlbumDetailSchema.parse({
  id: 'fixture-album',
  mediaType: 'album',
  slug: 'fixture-album',
  title: 'Fixture album',
  originalTitle: null,
  summary: null,
  artworkUrl: null,
  releaseDate: null,
  sourceLabel: null,
  metadata: null,
  tags: [],
  credits: [],
  links: [],
  providerReferences: [],
  playlists: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  dateAdded: null,
  durationSec: null,
  spotifyUrl: `https://open.spotify.com/album/${'A'.repeat(22)}`,
  trackCount: 3,
  tracks: [
    {
      title: 'Song A',
      position: 1,
      externalId: 'B'.repeat(22),
      durationSec: 180,
    },
    {
      title: 'Song Z',
      position: 2,
      externalId: 'C'.repeat(22),
      durationSec: 200,
    },
    {
      title: 'Instrumental',
      position: 3,
      externalId: 'D'.repeat(22),
      durationSec: 220,
    },
  ],
})

async function render(search: URLSearchParams, detail = false) {
  const Detail = detail ? (await import('./media-detail')).default : null
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['album', album.id], album)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ appUrl: 'http://localhost', apiBaseUrl: 'http://localhost' }}
        >
          <SearchParamsContext.Provider value={search}>
            <PlaybackViewContext.Provider
              value={{ ...idlePlaybackState, enabled: true }}
            >
              {Detail ? (
                <Detail mediaType="album" id={album.id} />
              ) : (
                <AlbumTracksTable album={album} scrobbles={null} />
              )}
            </PlaybackViewContext.Provider>
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function returnParams() {
  const view = albumTrackView(
    JSON.stringify({
      id: album.id,
      q: 'Song ',
      sortBy: 'title',
      direction: 'desc',
    }),
    album.id,
  )
  return new URL(
    albumTrackViewHref(
      '/albums',
      new URLSearchParams({ item: album.id }),
      view,
    ),
    'http://localhost',
  ).searchParams
}

test('album track tables restore a playback source search and sort', async () => {
  const html = await render(returnParams())
  assert.match(html, /value="Song "/)
  assert.match(html, /aria-sort="descending"/)
  assert.match(html, /2 of 3 tracks/)
  assert.ok(html.indexOf('Play Song Z') < html.indexOf('Play Song A'))
  assert.doesNotMatch(html, /Instrumental/)
})

test('returning to an album playback source opens Tracks with its saved table state', async () => {
  const html = await render(returnParams(), true)
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Tracks/)
  assert.match(html, /aria-label="Album tracks"/)
  assert.match(html, /value="Song "/)
  assert.doesNotMatch(html, /Instrumental/)
  const other = returnParams()
  other.set('albumTrackView', JSON.stringify({ id: 'another-album' }))
  assert.match(
    await render(other, true),
    /role="tab" aria-selected="true"[^>]*>Overview/,
  )
})
