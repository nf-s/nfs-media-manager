import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AlbumDetailSchema } from '@repo/schemas/media'
import AlbumTracksTable, { albumTrackPreviewLimit } from './album-tracks-table'
import { tableHeaderHeight, tableRowHeight } from '@/hooks/useVirtualTable'
import { ConfigContext } from './providers'
import { PlaybackViewContext } from './playback-provider'
import { idlePlaybackState } from '@/utils/playback-engine'
import { albumTrackView } from '@/utils/playback-source'
import { albumUnlistedNamesKey } from '@/utils/track-versions'

// Detail components import CSS modules; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})
function albumTrack(
  position: number,
  title: string,
  spotifyTrackId: string | null,
  durationSec: number | null,
) {
  return {
    position,
    track: {
      id: `fixture-track-${position}`,
      mediaType: 'track',
      title,
      artworkUrl: null,
      releaseDate: null,
      artists: ['Fixture artist'],
      albumName: 'Fixture album',
      album: { id: 'fixture-album', title: 'Fixture album' },
      albumLinkStrategy: null,
      albumTags: [],
      playlists: [],
      sources: ['album'],
      durationSec,
      dateAdded: null,
      spotifyTrackId,
      spotifyMatch: spotifyTrackId ? 'album-track-list' : 'unmatched',
      spotifyUrl: spotifyTrackId
        ? `https://open.spotify.com/track/${spotifyTrackId}`
        : null,
      isrc: null,
      scrobbles: 0,
      lastListenedAt: null,
    },
  }
}

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
    albumTrack(1, 'Song A', 'B'.repeat(22), 180),
    albumTrack(2, 'Song Z', 'C'.repeat(22), 200),
    albumTrack(3, 'Instrumental', 'D'.repeat(22), 220),
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
              value={{
                ...idlePlaybackState,
                enabled: true,
                connection: 'connected',
              }}
            >
              {Detail ? (
                <Detail mediaType="album" id={album.id} />
              ) : (
                <AlbumTracksTable album={album} />
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
  return new URLSearchParams({
    item: album.id,
    albumTrackView: JSON.stringify(view),
    tab: 'tracks',
  })
}

test('album track tables are compact and restore a playback source sort', async () => {
  const html = await render(returnParams())
  assert.doesNotMatch(html, /aria-label="(Grid|List|Table) view"|type="search"/)
  assert.match(
    html,
    /<table class="ds-table" data-layout="fixed" aria-label="Album tracks"/,
  )
  assert.match(
    html,
    /<th scope="col" aria-sort="descending"><button type="button" class="ds-th-sort">Title/,
  )
  assert.ok(html.indexOf('Play Song Z') < html.indexOf('Play Song A'))
  assert.ok(html.indexOf('Play Song Z') < html.indexOf('Add Song Z to queue'))
  assert.match(html, /Instrumental/)
  assert.doesNotMatch(html, />Artists</)
  assert.match(html, /<td data-align="end">3:20<\/td>/)
})

test('an old Tracks link opens the album Overview with its saved table order', async () => {
  const html = await render(returnParams(), true)
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(tabs, [
    'Overview',
    'Similar',
    'Listening',
    'Sources',
    'Edit',
  ])
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Overview/)
  assert.match(html, /<h3>Tracks<\/h3>/)
  assert.match(html, /aria-label="Album tracks"/)
  assert.ok(html.indexOf('Play Song Z') < html.indexOf('Play Song A'))
  assert.match(html, /<h3>Playlists<\/h3>/)
  assert.match(html, /aria-expanded="false"[^>]*>All fields</)
})

test('the album preview adds only whole rows that fit below the header', () => {
  const roomForThirty = tableHeaderHeight + 30 * tableRowHeight
  assert.equal(albumTrackPreviewLimit(0), 20)
  assert.equal(albumTrackPreviewLimit(roomForThirty - 1), 29)
  assert.equal(albumTrackPreviewLimit(roomForThirty), 30)
})

test('long albums initially show twenty tracks and compilations add Artists', async () => {
  const tracks = Array.from({ length: 21 }, (_, index) => {
    const entry = albumTrack(index + 1, `Track ${index + 1}`, null, 100)
    return index === 3
      ? { ...entry, track: { ...entry.track, artists: ['Guest artist'] } }
      : entry
  })
  const long = AlbumDetailSchema.parse({
    ...album,
    credits: [
      { id: 'a1', name: 'Fixture artist', role: 'artist', billingOrder: 0 },
    ],
    tracks,
  })
  const client = new QueryClient()
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SearchParamsContext.Provider value={new URLSearchParams()}>
        <AlbumTracksTable album={long} />
      </SearchParamsContext.Provider>
    </QueryClientProvider>,
  )
  assert.match(html, />Artists</)
  assert.match(html, />Track 20</)
  assert.doesNotMatch(html, />Track 21</)
  assert.match(html, /aria-expanded="false">Show all 21</)
})

function renderWithUnlisted(
  names: Array<{ trackId: string; trackName: string; scrobbles: number }>,
  subject = album,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(albumUnlistedNamesKey(subject.id), {
    names: names.map((name) => ({
      ...name,
      artistKey: 'fixture artist',
      trackKey: name.trackName.toLowerCase(),
      artistName: 'Fixture artist',
    })),
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ appUrl: 'http://localhost', apiBaseUrl: 'http://localhost' }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <AlbumTracksTable album={subject} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('album tracks and the names scrobbled under the album can be selected to merge', () => {
  const html = renderWithUnlisted([
    { trackId: 'lastfm-song-a', trackName: 'Song A (Live)', scrobbles: 12 },
    { trackId: 'lastfm-song-b', trackName: 'Song B', scrobbles: 4 },
  ])
  assert.match(
    html,
    /<th scope="col"><input type="checkbox" class="ds-check" aria-label="Select album tracks"\/><\/th>/,
  )
  assert.match(html, /aria-label="Select Song A"/)
  assert.match(html, /aria-label="Select Instrumental"/)
  assert.match(
    html,
    /<tr data-group=""><td colSpan="5">Scrobbled under this album, not on its track list<\/td><\/tr>/,
  )
  const group = html.indexOf('Scrobbled under this album')
  assert.ok(html.indexOf('Play Instrumental') < group)
  assert.ok(group < html.indexOf('Select Song A (Live) by Fixture artist'))
  assert.ok(
    html.indexOf('Select Song A (Live) by Fixture artist') <
      html.indexOf('Select Song B by Fixture artist'),
  )
  assert.match(html, /href="\/tracks\/lastfm-song-a"[^>]*>Song A \(Live\)</)
  assert.match(html, /<td data-align="end">12<\/td>/)
  // The selection bar is hidden until a row is selected.
  assert.match(html, /<div class="ds-selectbar sec-selectbar"><\/div>/)
})

test('a name scrobbled under the album is listed once its whole track list shows', () => {
  const tracks = Array.from({ length: 21 }, (_, index) =>
    albumTrack(index + 1, `Track ${index + 1}`, null, 100),
  )
  const long = AlbumDetailSchema.parse({ ...album, tracks })
  const html = renderWithUnlisted(
    [{ trackId: 'lastfm-track', trackName: 'Bonus', scrobbles: 2 }],
    long,
  )
  assert.doesNotMatch(html, /Scrobbled under this album|Bonus/)
  assert.match(html, />Show all 21</)
  assert.doesNotMatch(
    renderWithUnlisted([]),
    /Scrobbled under this album, not on its track list/,
  )
})
