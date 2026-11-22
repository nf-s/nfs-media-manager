import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  SonovaultTrackCandidateReviewSchema,
  type SonovaultTrackCandidateReview,
} from '@repo/schemas/sonovault-candidates'
import { ConfigContext } from './providers'
import {
  SonovaultCandidateCell,
  SonovaultCandidateReviewDialog,
} from './sonovault-track-candidates'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const foundAt = '2026-01-01T00:00:00.000Z'
const job = {
  jobId: 'example-job',
  status: 'succeeded',
  errorMessage: null,
  createdAt: foundAt,
  finishedAt: foundAt,
}
const candidate = {
  sonovaultTrackId: 'sv-example-1',
  title: 'Example recording',
  artists: ['Example artist', 'Guest artist'],
  release: 'Example album',
  releaseDate: '2020-05-01',
  durationSec: 192,
  isrc: 'QZFX12600001',
  spotifyTrackId: '0000000000000000000001',
  spotifyUrl: 'https://open.spotify.com/track/0000000000000000000001',
  status: 'pending',
  acceptedBy: null,
  foundAt,
  decidedAt: null,
  jobId: 'example-job',
  spotifyJobId: null,
}
const accepted = (acceptedBy: 'automatic' | 'owner') => ({
  ...candidate,
  status: 'accepted',
  acceptedBy,
  decidedAt: foundAt,
})
const rejected = { ...candidate, status: 'rejected', decidedAt: foundAt }

function review(
  values: Partial<Record<keyof SonovaultTrackCandidateReview, unknown>>,
) {
  return SonovaultTrackCandidateReviewSchema.parse({
    trackId: 'example-track',
    job: null,
    notFound: false,
    candidates: [],
    ...values,
  })
}

const track = {
  id: 'example-track',
  title: 'Example recording',
  artists: ['Example artist'],
  albumName: 'Example album',
  durationSec: 190,
  isrc: null,
  album: null,
}
const withoutIds = { spotifyTrackId: null, isrc: null }

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
    assert.equal(network.mock.callCount(), 0)
  }
}

const cell = (
  value: SonovaultTrackCandidateReview,
  ids: { spotifyTrackId: string | null; isrc: string | null } = withoutIds,
) =>
  render(
    <SonovaultCandidateCell review={value} track={ids} onReview={() => {}} />,
  )

test('a Sonovault candidate cell shows Never, or a dash for a track found by ID', () => {
  assert.match(cell(review({})), /data-status="never"/)
  const bySpotify = cell(review({}), {
    spotifyTrackId: '0000000000000000000001',
    isrc: null,
  })
  assert.match(bySpotify, /class="ds-empty-value"/)
  assert.doesNotMatch(bySpotify, /data-status="never"/)
  const byIsrc = cell(review({}), {
    spotifyTrackId: null,
    isrc: 'QZFX12600001',
  })
  assert.match(byIsrc, /class="ds-empty-value"/)
})

test('a Sonovault candidate cell offers Review or shows what became of the candidates', () => {
  const waiting = cell(review({ job, candidates: [candidate] }))
  assert.match(waiting, /data-status="done"/)
  assert.match(waiting, /aria-haspopup="dialog"[^>]*>Review</)
  const automatic = cell(review({ job, candidates: [accepted('automatic')] }))
  assert.match(automatic, />Accepted automatically</)
  assert.match(automatic, /tab=sources/)
  assert.match(automatic, /sourceProvider=sonovault/)
  assert.doesNotMatch(automatic, />Review</)
  const byOwner = cell(
    review({ job, candidates: [accepted('owner'), rejected] }),
  )
  assert.match(byOwner, /sourceProvider=sonovault[^>]*>Accepted</)
  const incorrect = cell(
    review({
      job,
      candidates: [rejected, { ...rejected, sonovaultTrackId: 'sv-example-2' }],
    }),
  )
  assert.match(incorrect, /data-status="attention"[^>]*>Incorrect</)
  assert.doesNotMatch(incorrect, />Review</)
  const miss = cell(review({ job, notFound: true }))
  assert.match(miss, />Not found</)
  assert.doesNotMatch(miss, /data-status="never"/)
  const missWithoutJob = cell(review({ notFound: true }))
  assert.match(missWithoutJob, />Not found</)
  assert.doesNotMatch(missWithoutJob, /data-status="never"/)
})

test('the review dialog lists each candidate with Accept and Mark incorrect', () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['tracks', 'sonovault-candidates', track.id],
    review({
      job,
      candidates: [
        candidate,
        {
          ...rejected,
          sonovaultTrackId: 'sv-example-2',
          title: 'Example recording (live)',
          release: null,
          releaseDate: null,
          durationSec: null,
          isrc: null,
        },
      ],
    }),
  )
  const html = render(
    <SonovaultCandidateReviewDialog track={track} onClose={() => {}} />,
    client,
  )
  assert.match(html, /Sonovault candidates/)
  assert.match(html, /2 candidates/)
  assert.match(html, /<span class="ds-row-title" title="Example recording">/)
  assert.match(html, /Example artist, Guest artist/)
  assert.match(html, /Example album · /)
  assert.match(html, /3:12/)
  assert.match(html, /ISRC QZFX12600001/)
  assert.match(html, /aria-label="Accept Example recording"[^>]*>Accept</)
  assert.match(
    html,
    /aria-label="Mark Example recording as incorrect"[^>]*>Mark incorrect</,
  )
  assert.doesNotMatch(html, /Accept Example recording \(live\)/)
})

test('a reviewed candidate shows its decision first and no actions', () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(
    ['tracks', 'sonovault-candidates', track.id],
    review({
      job,
      candidates: [
        { ...rejected, release: null, durationSec: null, isrc: null },
      ],
    }),
  )
  const html = render(
    <SonovaultCandidateReviewDialog track={track} onClose={() => {}} />,
    client,
  )
  assert.match(
    html,
    /Incorrect · [^<]*Release unknown · Duration unknown · ISRC unknown/,
  )
  assert.doesNotMatch(html, />Accept</)
  assert.doesNotMatch(html, />Mark incorrect</)
})
