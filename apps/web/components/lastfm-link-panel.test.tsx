import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  LastfmLinkGroupSchema,
  LastfmSpotifySearchSchema,
} from '@repo/schemas/lastfm'
import LastfmLinkPanel from './lastfm-link-panel'
import { ConfigContext } from './providers'

const group = LastfmLinkGroupSchema.parse({
  artistName: 'Example artist',
  albumName: 'Example album',
  scrobbles: 5,
  lastListenedAt: '2026-01-01T00:00:00Z',
  reason: 'unmatched',
  album: null,
  candidates: [],
})

function renderPanel({
  mode = 'new',
  stored,
  error,
  pending,
}: {
  mode?: 'library' | 'new'
  stored?: unknown
  error?: string
  pending?: boolean
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (stored)
    client.setQueryData(
      ['lastfm-spotify-search', group.artistName, group.albumName],
      LastfmSpotifySearchSchema.parse(stored),
    )
  const request = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
        >
          <LastfmLinkPanel
            group={group}
            initialMode={mode}
            backgroundError={error}
            backgroundPending={pending}
            onRetry={() => {}}
            onClose={() => {}}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.equal(request.mock.callCount(), 0)
    return html
  } finally {
    request.mock.restore()
    client.clear()
  }
}

test('library tab starts with the album title and does not render the Spotify search', () => {
  const html = renderPanel({ mode: 'library' })
  assert.match(
    html,
    /placeholder="Search library albums"[^>]*value="Example album"/,
  )
  assert.doesNotMatch(html, /Search Spotify|Loading saved Spotify search/)
})

test('stored Spotify candidates are available to choose without a new provider search', () => {
  const html = renderPanel({
    stored: {
      query: 'Example artist Example album',
      job: {
        jobId: 'search-job',
        status: 'succeeded',
        resultCount: 1,
        errorMessage: null,
      },
      result: {
        page: 1,
        hasMore: false,
        items: [
          {
            externalId: '1234567890123456789012',
            title: 'Saved result',
            subtitle: 'Example artist',
            releaseDate: null,
            artworkUrl: null,
            url: 'https://open.spotify.com/album/1234567890123456789012',
            mediaItemId: 'library-album',
          },
        ],
      },
    },
  })
  assert.match(html, /aria-label="Spotify results"/)
  assert.match(html, /Saved result/)
  assert.match(html, /aria-label="Link Saved result"/)
  assert.match(html, /jobs\?jobId=search-job&amp;mediaType=album/)
  assert.doesNotMatch(html, /Searching Spotify/)
})

test('an active saved job shows its state and prevents a duplicate search', () => {
  const html = renderPanel({
    stored: {
      query: 'Example artist Example album',
      job: {
        jobId: 'search-job',
        status: 'queued',
        resultCount: null,
        errorMessage: null,
      },
      result: null,
    },
  })
  assert.match(html, /Spotify search queued/)
  assert.match(html, /type="submit" disabled="">Search/)
})

test('failed background additions expose recovery and active additions remain closable', () => {
  assert.match(
    renderPanel({ error: 'Could not link album' }),
    /Could not link album/,
  )
  assert.match(
    renderPanel({ error: 'Could not link album' }),
    /Retry add and link/,
  )
  const html = renderPanel({ pending: true })
  assert.match(html, /Adding and linking this album/)
  assert.match(html, /aria-label="Close scrobble link"><svg/)
})
