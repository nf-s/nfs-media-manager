import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  TidalSimilarItemSchema,
  TidalSimilarSchema,
  type TidalSimilar,
  type TidalSimilarUnmatched,
} from '@repo/schemas/tidal'
import { TrackDetailSchema } from '@repo/schemas/tracks'
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
    unmatched: null,
    job: job('succeeded'),
    lookupJob: null,
    readAt: createdAt,
    source: null,
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

test('the counts say which TIDAL ID the list was read with', () => {
  const sonovault = body({
    kind: 'track',
    source: { kind: 'sonovault', tidalId: '200001', jobId: 'example-lookup' },
  })
  assert.match(sonovault, /on Spotify · <a [^>]*>TIDAL ID from Sonovault<\/a>/)
  assert.match(sonovault, /href="[^"]*example-lookup[^"]*"/)
  const match = body({
    source: { kind: 'tidal', tidalId: '200002', jobId: null },
  })
  assert.match(match, /on Spotify · TIDAL match/)
  assert.doesNotMatch(body(), /TIDAL ID from|TIDAL match/)
  assert.match(
    body({
      items: [],
      source: { kind: 'sonovault', tidalId: '200001', jobId: null },
    }),
    /Read 2026-01-01 · TIDAL ID from Sonovault/,
  )
})

test('a running Spotify lookup replaces the counts with its status', () => {
  const html = body({ lookupJob: job('running') })
  assert.match(html, /Finding on Spotify/)
  assert.doesNotMatch(html, /\d from TIDAL ·/)
  assert.match(html, /Spotify album/)
})

test("a track's read names Sonovault, which maps it in the same request", () => {
  const reading = (kind: TidalSimilar['kind'], items?: []) =>
    render(
      <SimilarBody
        similar={similar({ kind, ...(items ? { items } : {}) })}
        requesting
        onRequest={() => assert.fail('Rendering must not request')}
      />,
    )
  assert.match(reading('track'), /Reading from TIDAL and Sonovault/)
  assert.match(reading('track', []), /Reading from TIDAL and Sonovault/)
  assert.doesNotMatch(reading('album'), /Sonovault/)
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

test('an unmatched track says why, and what can be done', () => {
  const unmatched = (values: Partial<TidalSimilar>, onReview?: () => void) =>
    render(
      <SimilarBody
        similar={similar({
          kind: 'track',
          itemId: 'example-track',
          matched: false,
          matchJob: job('succeeded'),
          job: null,
          readAt: null,
          items: [],
          ...values,
        })}
        requesting={false}
        onRequest={() => assert.fail('Rendering must not request')}
        {...(onReview ? { onReview } : {})}
      />,
    )
  const review: TidalSimilarUnmatched = { reason: 'review', candidateCount: 3 }
  const reviewing = unmatched({ unmatched: review }, () => undefined)
  assert.match(reviewing, /3 TIDAL tracks to review/)
  assert.match(reviewing, /Choose one to read similar tracks\./)
  assert.match(reviewing, /<button[^>]*aria-haspopup="dialog"[^>]*>Review</)
  assert.doesNotMatch(reviewing, /disabled=""[^>]*>Review</)
  assert.doesNotMatch(reviewing, /Match on TIDAL/)
  // Until the track is loaded, the dialog cannot open.
  assert.match(
    unmatched({ unmatched: review }),
    /<button[^>]*disabled=""[^>]*>Review</,
  )
  assert.match(
    unmatched({ unmatched: { reason: 'review', candidateCount: 1 } }),
    /1 TIDAL track to review/,
  )
  const noIsrc = unmatched({ matchJob: null, unmatched: { reason: 'no-isrc' } })
  assert.match(noIsrc, /No ISRC/)
  assert.match(noIsrc, /TIDAL matches tracks by ISRC\./)
  assert.doesNotMatch(noIsrc, /<button/)
  const notFound = unmatched({
    matchJob: job('failed'),
    unmatched: { reason: 'not-found', isrc: 'QZFX22800001' },
  })
  assert.match(notFound, /Not on TIDAL/)
  assert.match(notFound, /TIDAL has no track with ISRC QZFX22800001/)
  assert.match(notFound, /href="[^"]*example-failed[^"]*"[^>]*>Match job</)
  assert.match(notFound, />Match on TIDAL</)
  const running = unmatched({ matchJob: job('running'), unmatched: null })
  assert.match(running, /Matching on TIDAL/)
  assert.doesNotMatch(running, /<button/)
  const never = unmatched({ matchJob: null })
  assert.match(never, /Not matched on TIDAL/)
  assert.match(never, /Similar tracks come from TIDAL\./)
})

test("the review opens from the track's loaded detail", () => {
  const client = new QueryClient()
  client.setQueryData(
    ['tidal-similar', 'track', 'example-track'],
    similar({
      kind: 'track',
      itemId: 'example-track',
      matched: false,
      matchJob: job('succeeded'),
      unmatched: { reason: 'review', candidateCount: 2 },
      job: null,
      readAt: null,
      items: [],
    }),
  )
  client.setQueryData(
    ['track', 'example-track'],
    TrackDetailSchema.parse({
      id: 'example-track',
      mediaType: 'track',
      title: 'Example track',
      artworkUrl: null,
      releaseDate: null,
      artists: ['Example artist'],
      artistCredits: [{ id: 'example-artist', name: 'Example artist' }],
      albumName: 'Example album',
      album: null,
      albumLinkStrategy: null,
      albumTags: [],
      playlists: [],
      sources: ['spotify'],
      durationSec: 348,
      dateAdded: createdAt,
      spotifyTrackId: null,
      spotifyMatch: 'unmatched',
      spotifyUrl: null,
      isrc: 'QZFX22800002',
      scrobbles: 0,
      lastListenedAt: null,
      lastfmSources: [],
      spotifyAlbumId: null,
      scrobbledAlbums: [],
      isrcs: [],
      listening: {
        total: 0,
        firstListenedAt: null,
        lastListenedAt: null,
        months: [],
        sources: [],
      },
    }),
  )
  const original = globalThis.fetch
  globalThis.fetch = () => assert.fail('Rendering must not fetch')
  try {
    const html = render(
      <SimilarItems kind="track" id="example-track" />,
      client,
    )
    assert.match(html, /2 TIDAL tracks to review/)
    assert.match(html, /<button[^>]*aria-haspopup="dialog"[^>]*>Review</)
    assert.doesNotMatch(html, /disabled=""[^>]*>Review</)
  } finally {
    globalThis.fetch = original
  }
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
