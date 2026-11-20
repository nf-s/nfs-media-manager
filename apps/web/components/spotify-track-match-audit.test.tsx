import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ConfigContext } from './providers'
import {
  SpotifyTrackAuditItemSchema,
  SpotifyTrackAuditPageSchema,
  SpotifyTrackAuditQuerySchema,
  SpotifyTrackSearchSchema,
  type SpotifyTrackAuditItem,
} from '@repo/schemas/spotify-track-search'
import SpotifyTrackMatchAudit, {
  loadSpotifyTrackAudit,
  SpotifyTrackAuditEvidence,
} from './spotify-track-match-audit'

const searchedAt = '2026-01-05T01:23:00.000Z'
const candidate = {
  spotifyTrackId: 'A'.repeat(22),
  title: 'Catalog Recording',
  artists: ['Fixture Artist'],
  albumName: 'Fixture Catalog Album',
  durationSec: 195,
  spotifyUrl: `https://open.spotify.com/track/${'A'.repeat(22)}`,
  assessment: 'likely',
  summary: 'Artist and recording fit.',
  reasons: [
    {
      code: 'album_mismatch',
      explanation: 'The release names differ.',
      library: 'Fixture Recorded EP',
      spotify: 'Fixture Catalog Album',
    },
    {
      code: 'duration_delta',
      explanation: 'The duration is close.',
      library: '3:14',
      spotify: '3:15',
    },
  ],
  searchedAt,
  historical: true,
}
const track = SpotifyTrackAuditItemSchema.parse({
  trackId: 'fixture-track',
  title: 'Library Recording',
  artists: ['Fixture Artist'],
  albums: ['Fixture Recorded EP'],
  durations: [194],
  assessment: 'likely',
  summary: 'Candidate needs review.',
  candidates: [
    candidate,
    {
      ...candidate,
      spotifyTrackId: 'B'.repeat(22),
      spotifyUrl: `https://open.spotify.com/track/${'B'.repeat(22)}`,
      title: 'Unrelated Candidate',
      assessment: 'unlikely',
      historical: false,
    },
  ],
})

const savedQuery = 'Fixture search query with the full version and edition'

function renderEvidence(item: SpotifyTrackAuditItem) {
  const client = new QueryClient()
  const savedJob = {
    jobId: 'fixture-search',
    status: 'succeeded',
    resultCount: 1,
    errorMessage: null,
    createdAt: searchedAt,
    startedAt: searchedAt,
    finishedAt: searchedAt,
  }
  client.setQueryData(
    ['tracks', 'spotify-track-search', item.trackId],
    SpotifyTrackSearchSchema.parse({
      job: savedJob,
      resultJob: savedJob,
      query: savedQuery,
      candidates: item.candidates.slice(0, 1).map((result) => ({
        ...result,
        artworkUrl: null,
        isrc: null,
        spotifyAlbumId: null,
      })),
    }),
  )
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <SpotifyTrackAuditEvidence track={item} onClose={() => {}} />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('review immediately shows complete library and Spotify details', () => {
  const longTitle =
    'A long recorded title with a suffix that must remain readable'
  const longArtist =
    'The Spotify artist name has several credits lasting beyond one line'
  const html = renderEvidence({
    ...track,
    title: longTitle,
    candidates: track.candidates.map((candidate) => ({
      ...candidate,
      artists: [longArtist],
    })),
  })
  const candidates = html.indexOf('Saved Spotify candidates')
  const comparison = html.indexOf('Comparison')
  const evidence = html.indexOf('Match evidence')
  assert.ok(
    comparison >= 0 && comparison < candidates && candidates < evidence,
    'Keep the candidate picker in the comparison',
  )
  const initialReview = html.slice(comparison, evidence)
  for (const value of [
    longTitle,
    longArtist,
    'Fixture Recorded EP',
    'Fixture Catalog Album',
    '3:14',
    '3:15',
  ]) {
    assert.ok(initialReview.includes(value), value)
  }
  assert.doesNotMatch(initialReview, /ds-facts|ds-row-title/)
})

test('the audit shows the saved choices and field evidence for the selected candidate', () => {
  const html = renderEvidence(track)
  assert.match(html, /class="sec-drawer"/)
  assert.match(html, /Library Recording/)
  assert.match(html, /Artist and recording fit/)
  assert.doesNotMatch(html, /Candidate needs review/)
  assert.match(
    html,
    />Catalog Recording · Fixture Artist · Fixture Catalog Album<\/option>/,
  )
  assert.match(
    html,
    />Unrelated Candidate · Fixture Artist · Fixture Catalog Album<\/option>/,
  )
  assert.ok(html.includes(`<strong>Saved query</strong> ${savedQuery}`))
  assert.match(html, />Confirm Spotify match<\/button>/)
  assert.match(html, /Historical|Earlier search/)
  assert.match(html, /2026-01-05/)
  assert.match(
    html,
    /href="\/tracks\/fixture-track\?tab=sources&amp;sourceProvider=spotify"/,
  )
  assert.match(html, /Open on Spotify/)
  assert.match(html, /The release names differ/)
  assert.match(html, /<dt>Library<\/dt><dd>Fixture Recorded EP<\/dd>/)
  assert.match(html, /<dt>Spotify<\/dt><dd>Fixture Catalog Album<\/dd>/)
  assert.match(html, /The duration is close/)
})

test('review keeps alternate coverage evidence and the saved query readable without offering confirmation', () => {
  const html = renderEvidence({
    ...track,
    candidates: track.candidates.map((item) => ({
      ...item,
      reasons: [
        {
          code: 'alternate-coverage',
          explanation: 'Another library version already plays on Spotify.',
          library: 'Open the existing version from Sources.',
          spotify: '',
        },
      ],
    })),
  })
  assert.match(html, /Another library version already plays on Spotify/)
  assert.ok(html.includes(`<strong>Saved query</strong> ${savedQuery}`))
  assert.match(html, /Open track Sources/)
  assert.doesNotMatch(html, />Confirm Spotify match<\/button>/)
})

test('the audit reads a bounded filtered page and preserves the server order', async (t) => {
  const page = SpotifyTrackAuditPageSchema.parse({
    generatedAt: searchedAt,
    totalTracks: 1,
    totalCandidates: 2,
    counts: { likely: 1, review: 0, unlikely: 0 },
    totalCount: 1,
    pageCount: 1,
    items: [track],
  })
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
    const request = new URL(url)
    assert.equal(request.pathname, '/api/v1/spotify/tracks/match-audit')
    assert.deepEqual(Object.fromEntries(request.searchParams), {
      page: '2',
      size: '25',
      sort: 'assessment',
      direction: 'asc',
      q: 'Fixture Artist',
      assessment: 'likely',
    })
    return Response.json({ statusCode: 200, message: 'OK', data: page })
  })
  const query = SpotifyTrackAuditQuerySchema.parse({
    page: 2,
    q: 'Fixture Artist',
    assessment: 'likely',
  })
  assert.deepEqual(
    await loadSpotifyTrackAudit('https://fixture.example.test', query),
    page,
  )
  assert.equal(fetch.mock.callCount(), 1)
})

test('audit rows show both recording credits and an explicit review action', () => {
  const client = new QueryClient()
  const path = '/tracks/spotify-match-audit'
  const result = {
    ...track,
    candidates: [{ ...track.candidates[0], artists: ['Catalog Performer'] }],
  }
  client.setQueryData(
    ['tracks', 'spotify-match-audit', '', undefined, 'assessment', 'asc', 1],
    SpotifyTrackAuditPageSchema.parse({
      generatedAt: searchedAt,
      totalTracks: 1,
      totalCandidates: 1,
      counts: { likely: 1, review: 0, unlikely: 0 },
      totalCount: 1,
      pageCount: 1,
      items: [result],
    }),
  )
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://example.test',
            apiBaseUrl: 'https://example.test',
          }}
        >
          <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams()}>
              <SpotifyTrackMatchAudit />
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    const body = html.split('<tbody>')[1]?.split('</tbody>')[0] ?? ''
    assert.match(body, /Library Recording/)
    assert.match(body, /Fixture Artist/)
    assert.match(body, />Catalog Recording/)
    assert.match(body, /Catalog Performer/)
    assert.match(body, />Review match<\/button>/)
  } finally {
    client.clear()
  }
})
