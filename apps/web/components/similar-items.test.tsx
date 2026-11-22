import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  TidalSimilarItemSchema,
  TidalSimilarSchema,
  type TidalSimilar,
} from '@repo/schemas/tidal'
import { ConfigContext } from './providers'
import {
  SimilarBody,
  SimilarItems,
  similarCounts,
  spotifyPlayable,
} from './similar-items'

const createdAt = '2026-01-01T00:00:00.000Z'
const job = (status: 'queued' | 'running' | 'succeeded' | 'failed') => ({
  jobId: `example-${status}`,
  status,
  errorMessage: status === 'failed' ? 'Example failure.' : null,
  createdAt,
  finishedAt: status === 'queued' || status === 'running' ? null : createdAt,
})
const suggestion = (
  tidalId: string,
  state: 'library' | 'spotify' | 'none' | 'unsearched',
  title: string,
) =>
  TidalSimilarItemSchema.parse({
    tidalId,
    title,
    version: null,
    artists: ['Example artist'],
    code: '000000000017',
    durationSec: 348,
    releaseDate: '2023-04-01',
    url: `https://tidal.com/browse/album/${tidalId}`,
    state,
    library:
      state === 'library'
        ? {
            id: `library-${tidalId}`,
            title,
            artworkUrl: null,
            spotifyId: null,
            album: null,
            albumName: null,
            trackCount: 9,
          }
        : null,
    spotify:
      state === 'spotify'
        ? {
            spotifyId: '0000000000000000000017',
            url: 'https://open.spotify.com/album/0000000000000000000017',
            title,
            artists: ['Example artist'],
            albumName: null,
            spotifyAlbumId: null,
            artworkUrl: null,
            durationSec: null,
            trackCount: 9,
          }
        : null,
  })
const items = [
  suggestion('100001', 'library', 'Library album'),
  suggestion('100002', 'spotify', 'Spotify album'),
  suggestion('100003', 'none', 'Missing album'),
  suggestion('100004', 'unsearched', 'Unsearched album'),
]
const similar = (values: Partial<TidalSimilar> = {}) =>
  TidalSimilarSchema.parse({
    kind: 'album',
    itemId: 'example-album',
    matched: true,
    matchJob: null,
    job: job('succeeded'),
    lookupJob: null,
    readAt: createdAt,
    items,
    ...values,
  })

function render(element: React.ReactNode, client = new QueryClient()) {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          {element}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

const body = (values: Partial<TidalSimilar> = {}, requestFailed = false) =>
  render(
    <SimilarBody
      similar={similar(values)}
      requesting={false}
      requestFailed={requestFailed}
      onRequest={() => assert.fail('Rendering must not request')}
    />,
  )

test('each suggestion says where it plays and links where it opens', () => {
  const html = body()
  assert.match(html, /4 from TIDAL · 1 in library · 1 on Spotify/)
  assert.match(html, /In library · Example artist · 2023/)
  assert.match(html, /On Spotify · Example artist · 2023/)
  assert.match(html, /Not on Spotify · Example artist · 2023/)
  assert.match(html, /Not looked up on Spotify · Example artist · 2023/)
  // The library title opens the library album; the others are text.
  assert.match(html, /href="[^"]*library-100001[^"]*"[^>]*>Library album</)
  assert.match(
    html,
    /href="https:\/\/open.spotify.com\/album\/0000000000000000000017"/,
  )
  assert.match(html, /href="https:\/\/tidal.com\/browse\/album\/100003"/)
  assert.match(html, /href="https:\/\/tidal.com\/browse\/album\/100004"/)
  assert.doesNotMatch(html, /tidal.com\/browse\/album\/100001/)
  // Library and Spotify suggestions have the play pair, the others none.
  assert.match(html, /aria-label="Play Library album/)
  assert.match(html, /aria-label="Play Spotify album/)
  assert.doesNotMatch(html, /aria-label="Play Missing album/)
  assert.doesNotMatch(html, /aria-label="Play Unsearched album/)
  assert.match(html, /Read again from TIDAL · updated 2026-01-01/)
  // A suggestion that cannot be played keeps the play slot empty.
  assert.match(
    html,
    /Not on Spotify · Example artist · 2023<\/span><\/div><span><\/span>/,
  )
})

test('a running Spotify lookup replaces the counts with its status', () => {
  const html = body({ lookupJob: job('running') })
  assert.match(html, /Finding on Spotify/)
  assert.doesNotMatch(html, /\d from TIDAL ·/)
  assert.match(html, /Spotify album/)
})

test('the tab says what TIDAL is doing and what is missing', () => {
  assert.match(body({ matchJob: job('running') }), /Matching on TIDAL/)
  assert.match(
    body({ job: job('queued'), readAt: null, items: [] }),
    /Reading from TIDAL/,
  )
  // Matched and never read: Loading while the tab reads it.
  assert.match(body({ job: null, readAt: null, items: [] }), /Reading from/)
  assert.match(
    body({ job: null, readAt: null, items: [] }, true),
    /Could not read from TIDAL/,
  )
  const unmatched = body({ matched: false, job: null, readAt: null, items: [] })
  assert.match(unmatched, /Not matched on TIDAL/)
  assert.match(unmatched, /Similar albums come from TIDAL\./)
  assert.match(unmatched, />Match on TIDAL</)
  assert.match(
    body({
      matched: false,
      matchJob: job('failed'),
      job: null,
      readAt: null,
      items: [],
    }),
    /Example failure\./,
  )
  const failed = body({ job: job('failed'), readAt: null, items: [] })
  assert.match(failed, /Could not read from TIDAL/)
  assert.match(failed, /Example failure\./)
  assert.match(failed, /Read again/)
  const empty = body({ items: [] })
  assert.match(empty, /TIDAL has no similar albums/)
  assert.match(empty, /Read 2026-01-01/)
  const tracks = render(
    <SimilarBody
      similar={similar({ kind: 'track', items: [] })}
      requesting={false}
      onRequest={() => undefined}
    />,
  )
  assert.match(tracks, /TIDAL has no similar tracks/)
})

test('the tab shows the stored result without fetching again', () => {
  const client = new QueryClient()
  client.setQueryData(['tidal-similar', 'album', 'example-album'], similar())
  const original = globalThis.fetch
  globalThis.fetch = () => assert.fail('Rendering must not fetch')
  try {
    const html = render(
      <SimilarItems kind="album" id="example-album" />,
      client,
    )
    assert.match(html, /4 from TIDAL/)
  } finally {
    globalThis.fetch = original
  }
})

test('a Spotify-only suggestion plays by its Spotify URI', () => {
  const [, spotify] = items
  assert.ok(spotify)
  assert.deepEqual(spotifyPlayable('album', spotify), {
    kind: 'album',
    uri: 'spotify:album:0000000000000000000017',
    title: 'Spotify album',
    artist: 'Example artist',
    albumId: null,
    albumTitle: 'Spotify album',
    artworkUrl: null,
    trackCount: 9,
    credits: [{ id: null, name: 'Example artist' }],
  })
  assert.equal(similarCounts([]), '0 from TIDAL · 0 in library · 0 on Spotify')
})
