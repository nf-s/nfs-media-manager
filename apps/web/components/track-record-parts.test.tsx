import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TrackDetailSchema } from '@repo/schemas/tracks'
import { TrackPartsSchema, type TrackParts } from '@repo/schemas/track-versions'
import { trackPartsKey } from '@/utils/track-versions'
import { ConfigContext } from './providers'
import { TrackRecordParts } from './track-record-parts'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const item = TrackDetailSchema.parse({
  id: 'track-1',
  mediaType: 'track',
  title: 'Night Drive',
  artworkUrl: null,
  releaseDate: null,
  artists: ['Example Artist'],
  albumName: 'Example Album',
  album: null,
  albumLinkStrategy: null,
  albumTags: [],
  playlists: [],
  sources: ['lastfm'],
  durationSec: 200,
  dateAdded: null,
  spotifyTrackId: null,
  spotifyMatch: 'unmatched',
  spotifyUrl: null,
  isrc: null,
  scrobbles: 20,
  lastListenedAt: null,
  lastfmSources: [],
  listening: {
    total: 0,
    firstListenedAt: null,
    lastListenedAt: null,
    months: [],
    sources: [],
  },
})

const version = (
  id: string,
  type: 'spotify' | 'album' | 'lastfm',
  albumTitle: string | null,
  shown: boolean,
) => ({
  id,
  title: 'Night Drive',
  by: 'Example Artist',
  type,
  album: albumTitle ? { id: `album-${id}`, title: albumTitle } : null,
  albumName: null,
  durationSec: 200,
  scrobbles: 10,
  shown,
})

const joined = TrackPartsSchema.parse({
  shownId: 'track-2',
  stored: true,
  scrobbles: 20,
  versions: [
    version('track-1', 'lastfm', null, false),
    version('track-2', 'spotify', 'Example Album', true),
  ],
  names: [
    {
      trackId: 'track-1',
      artistKey: 'example artist',
      trackKey: 'nite drive',
      artistName: 'Example Artist',
      trackName: 'Nite Drive',
      scrobbles: 8,
      manuallyMatched: true,
    },
  ],
})

function render(parts: TrackParts | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (parts) client.setQueryData(trackPartsKey(item.id), parts)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <TrackRecordParts item={item} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('Made of lists the versions, shown first, then the names they own', () => {
  const html = render(joined)
  assert.match(
    html,
    /<h3>Made of<\/h3><span class="ds-muted">2 versions · 1 name<\/span>/,
  )
  assert.match(html, />Merge with…<\/button>/)
  assert.match(html, /aria-label="Made of"/)
  const heads = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(heads, ['Part', 'Type', 'Album', 'Scrobbles', 'Shown', ''])
  assert.ok(html.indexOf('Spotify version') < html.indexOf('Last.fm version'))
  assert.ok(html.indexOf('Last.fm version') < html.indexOf('Scrobbled name'))
  assert.match(
    html,
    /<input type="radio" class="ds-check" aria-label="Show as Night Drive · Example Album" name="[^"]+" checked=""\/>/,
  )
  assert.match(
    html,
    /<input type="radio" class="ds-check" aria-label="Show as Night Drive" name="[^"]+"\/>/,
  )
  assert.match(html, /aria-label="Separate Night Drive · Example Album"/)
  assert.match(html, /aria-label="Separate Night Drive"[^>]*>Separate</)
  // The other version opens; the open track's own title does not link.
  assert.match(html, /href="\/tracks\/track-2\?tab=sources"/)
  assert.doesNotMatch(html, /href="\/tracks\/track-1/)
  assert.match(html, /Example Artist — Nite Drive/)
  assert.match(
    html,
    /Scrobbled name<span class="ds-muted"> · Manually matched<\/span>/,
  )
  assert.doesNotMatch(html, /<dialog/)
})

test('a record of one version cannot be shown as another or separated', () => {
  const html = render(
    TrackPartsSchema.parse({
      ...joined,
      shownId: 'track-1',
      versions: [version('track-1', 'lastfm', null, true)],
      names: [],
    }),
  )
  assert.match(html, /<span class="ds-muted">1 version<\/span>/)
  assert.match(html, /type="radio"[^>]*disabled=""[^>]*checked=""/)
  assert.doesNotMatch(html, />Separate</)
  assert.match(html, />Merge with…<\/button>/)
})

test('Made of stays hidden while it loads', () => {
  assert.equal(render(null), '')
})
