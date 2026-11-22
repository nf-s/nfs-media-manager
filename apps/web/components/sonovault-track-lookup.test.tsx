import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  SonovaultSummarySchema,
  SonovaultTrackStateSchema,
  type SonovaultTrackState,
} from '@repo/schemas/sonovault'
import { TrackDetailSchema } from '@repo/schemas/tracks'
import { ConfigContext } from './providers'
import { SonovaultSummaryValues } from './sonovault-provider-settings'
import {
  SonovaultTrackLookupCell,
  TrackSonovaultSource,
  hasSonovaultLookupInput,
  sonovaultLookupBody,
  sonovaultLookupDue,
  sonovaultLookupKey,
} from './sonovault-track-lookup'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const lookedUpAt = '2026-01-01T00:00:00.000Z'
const now = Date.parse('2026-02-01T00:00:00.000Z')
const job = {
  jobId: 'example-job',
  status: 'succeeded',
  errorMessage: null,
  createdAt: lookedUpAt,
  finishedAt: lookedUpAt,
}
const matched = {
  status: 'matched',
  inputType: 'spotify_id',
  sonovaultTrackId: 'sv-example-1',
  verified: true,
  primaryIsrc: null,
  lookedUpAt,
  retryAfter: null,
}
const reference = (
  referenceType: string,
  externalId: string,
  url: string | null,
  verified = true,
) => ({ referenceType, externalId, url, verified, fetchedAt: lookedUpAt })
const references = [
  reference('tidal-track', '700001', 'https://tidal.com/browse/track/700001'),
  reference('discogs-release-track', '12345-B1', null),
  reference('isrc', 'QZFX12600001', null),
  reference(
    'youtube-video',
    'exampleVid01',
    'https://www.youtube.com/watch?v=exampleVid01',
  ),
]

function state(values: Partial<Record<keyof SonovaultTrackState, unknown>>) {
  return SonovaultTrackStateSchema.parse({
    trackId: 'example-track',
    lookup: null,
    references: [],
    job: null,
    ...values,
  })
}

const track = TrackDetailSchema.parse({
  id: 'example-track',
  mediaType: 'track',
  title: 'Example recording',
  artworkUrl: null,
  releaseDate: null,
  artists: ['Example artist'],
  artistCredits: [],
  albumName: 'Example album',
  album: null,
  albumLinkStrategy: null,
  albumTags: [],
  playlists: [],
  sources: ['spotify'],
  durationSec: 192,
  dateAdded: lookedUpAt,
  spotifyTrackId: '0000000000000000000001',
  spotifyMatch: 'spotify-import',
  spotifyUrl: null,
  isrc: null,
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
          <SearchParamsContext.Provider
            value={new URLSearchParams('tab=sources&sourceProvider=sonovault')}
          >
            {element}
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function renderSource(value: SonovaultTrackState, item = track) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData([...sonovaultLookupKey, item.id], value)
  return render(<TrackSonovaultSource item={item} />, client)
}

test('a Sonovault cell shows the job, the result opening Sources and its age', () => {
  const cell = (value: SonovaultTrackState, canLookUp = true) =>
    render(<SonovaultTrackLookupCell status={value} canLookUp={canLookUp} />)
  assert.match(cell(state({})), /Never/)
  assert.doesNotMatch(cell(state({}), false), /Never/)
  const found = cell(state({ job, lookup: matched }))
  assert.match(found, /data-status="done"/)
  assert.match(found, />Matched</)
  assert.match(found, /sourceProvider=sonovault/)
  assert.match(found, new RegExp(`<time[^>]*dateTime="${lookedUpAt}"`))
  assert.match(
    cell(state({ lookup: { ...matched, verified: false } })),
    />Unverified</,
  )
  assert.match(
    cell(
      state({
        lookup: {
          ...matched,
          status: 'not_found',
          sonovaultTrackId: null,
          verified: null,
          retryAfter: '2026-01-31T00:00:00.000Z',
        },
      }),
    ),
    />Not found</,
  )
  assert.match(
    cell(state({ job: { ...job, status: 'running', finishedAt: null } })),
    /data-status="running"/,
  )
})

test('the Sonovault source lists verified references with their service pages', () => {
  const html = renderSource(state({ job, lookup: matched, references }))
  assert.match(html, /Sonovault/)
  assert.match(html, /data-status="done"[^>]*>Matched</)
  assert.match(html, /sv-example-1/)
  assert.match(html, /Found by Spotify ID/)
  assert.match(html, /<h4>Sonovault references<\/h4>/)
  const row = (label: string, id: string) =>
    new RegExp(
      `<span class="ds-row-title">${label}</span><span class="ds-row-by"><span class="ds-mono" title="${id}">${id}</span>`,
    )
  assert.match(html, row('TIDAL', '700001'))
  assert.match(html, /href="https:\/\/tidal.com\/browse\/track\/700001"/)
  assert.match(html, row('Discogs release track', '12345-B1'))
  assert.match(html, row('ISRC', 'QZFX12600001'))
  assert.match(html, /href="https:\/\/www.youtube.com\/watch\?v=exampleVid01"/)
  assert.ok(html.indexOf('>ISRC<') < html.indexOf('>TIDAL<'))
  assert.doesNotMatch(html, /Unverified/)
  assert.doesNotMatch(html, /Look up on Sonovault/)
})

test('an unverified record marks its references as possibly another version', () => {
  const html = renderSource(
    state({
      job,
      lookup: { ...matched, verified: false },
      references: references
        .filter(({ referenceType }) => referenceType !== 'isrc')
        .map((item) => ({ ...item, verified: false })),
    }),
  )
  assert.match(html, /data-status="attention"[^>]*>Unverified</)
  assert.equal(html.match(/may be another version/g)?.length, 1)
  assert.match(html, /<h4>Sonovault references<\/h4>/)
  assert.equal(html.match(/>Unverified</g)?.length, 1)
})

test('a miss shows when it can be looked up again; a new track offers a lookup', () => {
  const miss = renderSource(
    state({
      job,
      lookup: {
        ...matched,
        status: 'not_found',
        sonovaultTrackId: null,
        verified: null,
        retryAfter: '2099-01-31T00:00:00.000Z',
      },
    }),
  )
  assert.match(miss, />Not found</)
  assert.match(miss, /Can be looked up again from/)
  assert.doesNotMatch(miss, /Sonovault references/)
  assert.doesNotMatch(miss, /Look up on Sonovault/)
  const fresh = renderSource(state({}))
  assert.match(fresh, /data-status="never"[^>]*>Not looked up</)
  assert.match(fresh, /Look up on Sonovault/)
  const without = renderSource(state({}), { ...track, spotifyTrackId: null })
  assert.match(without, /No Spotify ID or ISRC/)
  assert.doesNotMatch(without, /Look up on Sonovault/)
})

test('a lookup is due when new, after a miss expires or for a record over 11 months old', () => {
  assert.deepEqual(sonovaultLookupDue(state({}), now), { refresh: false })
  assert.equal(sonovaultLookupDue(state({ lookup: matched }), now), null)
  assert.deepEqual(
    sonovaultLookupDue(
      state({ lookup: { ...matched, lookedUpAt: '2025-01-01T00:00:00.000Z' } }),
      now,
    ),
    { refresh: true },
  )
  const miss = {
    ...matched,
    status: 'not_found',
    sonovaultTrackId: null,
    verified: null,
    retryAfter: '2026-01-31T00:00:00.000Z',
  }
  assert.deepEqual(sonovaultLookupDue(state({ lookup: miss }), now), {
    refresh: false,
  })
  assert.equal(
    sonovaultLookupDue(
      state({ lookup: { ...miss, retryAfter: '2026-03-01T00:00:00.000Z' } }),
      now,
    ),
    null,
  )
  assert.equal(
    sonovaultLookupDue(
      state({ job: { ...job, status: 'queued', finishedAt: null } }),
      now,
    ),
    null,
  )
  assert.equal(
    hasSonovaultLookupInput({ spotifyTrackId: null, isrc: 'QZFX12600001' }),
    true,
  )
  assert.equal(
    hasSonovaultLookupInput({ spotifyTrackId: 'short', isrc: null }),
    false,
  )
})

test('the selection action sends the chunk, batch and refresh, confirming a broad run', () => {
  assert.deepEqual(
    JSON.parse(
      sonovaultLookupBody({
        trackIds: ['track-1', 'track-2'],
        batchId: 'example-batch',
        refresh: true,
        total: 6,
      }),
    ),
    {
      trackIds: ['track-1', 'track-2'],
      batchId: 'example-batch',
      refresh: true,
      confirmBroadRun: true,
    },
  )
  assert.deepEqual(
    JSON.parse(
      sonovaultLookupBody({ trackIds: ['track-1'], refresh: false, total: 1 }),
    ),
    { trackIds: ['track-1'], refresh: false, confirmBroadRun: false },
  )
  assert.throws(() =>
    sonovaultLookupBody({
      trackIds: Array.from({ length: 101 }, (_, index) => `track-${index}`),
      refresh: false,
      total: 101,
    }),
  )
})

test('the provider settings list what is stored and the credits as last reported', () => {
  const summary = SonovaultSummarySchema.parse({
    lookups: { matched: 12, verified: 11, notFound: 3, dueForRefresh: 2 },
    references: 70,
    primaryIsrcs: 4,
    responses: 2,
    credits: {
      remaining: 4321,
      reportedAt: lookedUpAt,
      monthlyCredits: 5000,
      reserve: 200,
    },
  })
  const html = render(<SonovaultSummaryValues summary={summary} />)
  assert.match(html, /<dt>Records matched<\/dt><dd>12<\/dd>/)
  assert.match(html, /<dt>Due for refresh<\/dt><dd>2<\/dd>/)
  assert.match(html, /<dt>Primary ISRCs given<\/dt><dd>4<\/dd>/)
  assert.match(html, /<dt>Credits left<\/dt><dd>4,321 <time/)
  assert.match(html, /<dt>Reserve<\/dt><dd>200<\/dd>/)
  const unreported = render(
    <SonovaultSummaryValues
      summary={{
        ...summary,
        credits: { ...summary.credits, remaining: null, reportedAt: null },
      }}
    />,
  )
  assert.match(
    unreported,
    /<dt>Credits left<\/dt><dd><span class="ds-empty-value">/,
  )
})
