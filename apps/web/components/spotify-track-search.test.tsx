import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  SpotifyTrackSearchCandidateSchema,
  SpotifyTrackSearchJobSchema,
  SpotifyTrackSearchSchema,
} from '@repo/schemas/spotify-track-search'
import { ConfigContext } from './providers'
import {
  SpotifyTrackSearchConfirmation,
  SpotifyTrackSearchJobCell,
  SpotifyTrackSearchReview,
  SpotifyTrackSearchSelectionBar,
} from './spotify-track-search'

const createdAt = '2026-01-01T00:00:00.000Z'
const job = SpotifyTrackSearchJobSchema.parse({
  jobId: 'example-job',
  status: 'succeeded',
  resultCount: 1,
  errorMessage: null,
  createdAt,
  startedAt: createdAt,
  finishedAt: createdAt,
})
const candidate = SpotifyTrackSearchCandidateSchema.parse({
  spotifyTrackId: '1234567890ABCDEFGHIJKL',
  title: 'Catalog recording',
  artists: ['Example artist'],
  albumName: 'Catalog album',
  spotifyAlbumId: null,
  durationSec: 192,
  isrc: null,
  artworkUrl: null,
  spotifyUrl: 'https://open.spotify.com/track/1234567890ABCDEFGHIJKL',
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

test('Spotify track search requires review above five explicitly selected rows', () => {
  function selection(count: number) {
    return render(
      <SpotifyTrackSearchSelectionBar
        selectedIds={Array.from(
          { length: count },
          (_, index) => `track-${index}`,
        )}
        onSelect={() => assert.fail('Rendering must preserve selection')}
        onPendingChange={() => assert.fail('Rendering must not queue jobs')}
      />,
    )
  }
  assert.equal(selection(0), '')
  assert.match(selection(5), />Search Spotify tracks<\/button>/)
  assert.doesNotMatch(selection(5), /aria-haspopup="dialog"/)
  assert.match(
    selection(6),
    /aria-haspopup="dialog"[^>]*>Search Spotify tracks/,
  )
})

test('only a successful search with candidates offers review', () => {
  const onReview = () => assert.fail('Rendering must not open review')
  assert.match(
    render(<SpotifyTrackSearchJobCell job={job} onReview={onReview} />),
    /Review matches/,
  )
  const empty = render(
    <SpotifyTrackSearchJobCell
      job={{ ...job, resultCount: 0 }}
      onReview={onReview}
    />,
  )
  assert.match(empty, /No matches/)
  assert.doesNotMatch(empty, /Review matches/)
  const accepted = render(
    <SpotifyTrackSearchJobCell
      job={{ ...job, acceptedTrackId: 'kept-recording' }}
      onReview={onReview}
    />,
  )
  assert.match(accepted, /Matched track/)
  assert.doesNotMatch(accepted, /Review matches/)
  const automatic = render(
    <SpotifyTrackSearchJobCell
      job={{
        ...job,
        acceptedTrackId: 'retained-recording',
        matchMethod: 'automatic',
      }}
      onReview={onReview}
    />,
  )
  assert.match(automatic, /Matched automatically/)
  assert.match(automatic, /href="\/tracks\/retained-recording\?tab=sources"/)
  assert.doesNotMatch(automatic, /Review matches/)
  const skipped = render(
    <SpotifyTrackSearchJobCell
      job={{ ...job, resultCount: null }}
      onReview={onReview}
    />,
  )
  assert.match(skipped, /Search skipped/)
  assert.doesNotMatch(skipped, /Review matches|No matches/)
  const failed = render(
    <SpotifyTrackSearchJobCell
      job={{ ...job, status: 'failed', errorMessage: 'Example error' }}
      onReview={onReview}
    />,
  )
  assert.match(failed, /href="\/jobs\/example-job"/)
  assert.match(failed, /title="Example error">Failed/)
  assert.doesNotMatch(failed, /Review matches/)
})

test('saved Spotify results show enough recording details for review before confirmation', () => {
  const client = new QueryClient()
  client.setQueryData(
    ['tracks', 'spotify-track-search', 'stored-track'],
    SpotifyTrackSearchSchema.parse({
      job,
      query: 'Example artist Stored recording',
      candidates: [candidate],
    }),
  )
  const html = render(
    <SpotifyTrackSearchReview
      track={{
        id: 'stored-track',
        title: 'Stored recording',
        artists: ['Example artist'],
        albumName: 'Recorded album',
        durationSec: 190,
      }}
      onClose={() => assert.fail('Rendering must not close the dialog')}
      onMatched={() => assert.fail('Rendering must not save a match')}
    />,
    client,
  )
  assert.match(html, /Stored recording/)
  assert.match(html, /Recorded album · 3:10/)
  assert.match(html, /Example artist · Catalog album · 3:12/)
  assert.match(html, /aria-label="Review Catalog recording from Catalog album"/)
  assert.match(
    html,
    /https:\/\/open.spotify.com\/track\/1234567890ABCDEFGHIJKL/,
  )
  assert.doesNotMatch(html, /Confirm Spotify match/)
})

function renderConfirmation(failure: unknown) {
  const inactive = () => assert.fail('Rendering must not invoke dialog actions')
  return render(
    <SpotifyTrackSearchConfirmation
      candidate={candidate}
      failure={failure}
      pending={false}
      onConfirm={inactive}
      onChooseAnother={inactive}
      onClose={inactive}
    />,
  )
}

test('a conflicting Spotify ID links to the existing recording and blocks repeat confirmation', () => {
  const html = renderConfirmation({
    statusCode: 409,
    message: 'The library recording conflicts with this Spotify track.',
    data: {
      code: 'spotify-track-target-conflict',
      trackId: 'existing-recording',
      title: 'Existing library title',
    },
  })
  assert.match(html, /role="alert"/)
  assert.match(
    html,
    /The library recording conflicts with this Spotify track\./,
  )
  assert.match(
    html,
    /href="\/tracks\/existing-recording\?tab=sources"[^>]*>Open Sources for Existing library title<\/a>/,
  )
  assert.match(
    html,
    /<button[^>]* disabled=""[^>]*>Confirm Spotify match<\/button>/,
  )
  assert.match(
    html,
    /<button(?![^>]* disabled)[^>]*>Choose another track<\/button>/,
  )
  assert.doesNotMatch(html, /keep its listening history/)
})

test('ordinary or incomplete match errors remain retryable', () => {
  for (const failure of [
    { statusCode: 500, message: 'Try again later.' },
    {
      statusCode: 409,
      message: 'Try again later.',
      data: { code: 'spotify-track-target-conflict', trackId: 'missing-title' },
    },
  ]) {
    const html = renderConfirmation(failure)
    assert.match(html, /Try again later\./)
    assert.match(
      html,
      /<button(?![^>]* disabled)[^>]*>Confirm Spotify match<\/button>/,
    )
    assert.doesNotMatch(html, /Open Sources for/)
  }
})
