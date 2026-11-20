import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SpotifyTrackAuditItemSchema,
  SpotifyTrackAuditPageSchema,
  SpotifyTrackAuditQuerySchema,
} from '@repo/schemas/spotify-track-search'
import {
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

test('the audit shows the saved choices and field evidence for the selected candidate', () => {
  const html = renderToStaticMarkup(
    <SpotifyTrackAuditEvidence track={track} onClose={() => {}} />,
  )
  assert.match(html, /class="sec-drawer"/)
  assert.match(html, /Library Recording/)
  assert.match(html, /Candidate needs review/)
  assert.match(html, /Compare Catalog Recording from Fixture Catalog Album/)
  assert.match(html, /Compare Unrelated Candidate from Fixture Catalog Album/)
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
