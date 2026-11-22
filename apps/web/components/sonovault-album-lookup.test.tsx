import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { AlbumDetailSchema } from '@repo/schemas/media'
import {
  SonovaultAlbumStateSchema,
  type SonovaultAlbumState,
} from '@repo/schemas/sonovault-album'
import { ConfigContext } from './providers'
import {
  AlbumSonovaultSource,
  sonovaultAlbumKey,
  sonovaultAlbumLookupDue,
  sonovaultReviewText,
} from './sonovault-album-lookup'

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
const confirmed = {
  status: 'confirmed',
  miss: null,
  releaseId: '8102',
  editionId: '501',
  confirmedBy: ['spotify-album', 'upc'],
  aligned: 9,
  unaligned: 1,
  isrcs: 8,
  creditsUsed: 3,
  lookedUpAt,
  retryAfter: null,
}
const reference = (
  referenceType: string,
  externalId: string,
  url: string | null,
  matchedEdition = false,
) => ({ referenceType, externalId, url, matchedEdition, fetchedAt: lookedUpAt })

function state(values: Partial<Record<keyof SonovaultAlbumState, unknown>>) {
  return SonovaultAlbumStateSchema.parse({
    albumId: 'example-album',
    lookup: null,
    canLookUp: true,
    references: [],
    review: [],
    job: null,
    ...values,
  })
}

const timestamp = '2026-01-01T00:00:00.000Z'
const album = AlbumDetailSchema.parse({
  id: 'example-album',
  mediaType: 'album',
  slug: 'example-album',
  title: 'Example album',
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
  createdAt: timestamp,
  updatedAt: timestamp,
  dateAdded: null,
  durationSec: null,
  spotifyUrl: null,
  trackCount: 10,
  tracks: [],
  editionOfId: null,
  editionCount: 0,
  editions: [],
  editionOf: null,
})

function renderSource(value: SonovaultAlbumState) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData([...sonovaultAlbumKey, album.id], value)
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
            <AlbumSonovaultSource item={album} />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('a confirmed album lists its release, alignment and references', () => {
  const html = renderSource(
    state({
      job,
      lookup: confirmed,
      references: [
        reference(
          'discogs-release',
          '7003',
          'https://www.discogs.com/release/7003',
        ),
        reference('sonovault-release', '8102', null),
        reference(
          'discogs-master',
          '222',
          'https://www.discogs.com/master/222',
          true,
        ),
      ],
    }),
  )
  assert.match(html, /data-status="done"[^>]*>Confirmed</)
  assert.match(html, /8102/)
  assert.match(html, /Confirmed [^<]* by Spotify album ID, UPC\./)
  assert.match(html, /Tracks aligned/)
  assert.match(html, /<h4>Sonovault references<\/h4>/)
  assert.match(html, /href="https:\/\/www.discogs.com\/master\/222"/)
  assert.match(html, /Matched edition/)
  assert.ok(
    html.indexOf('Sonovault release<') < html.indexOf('Discogs master<'),
  )
  assert.ok(html.indexOf('Discogs master<') < html.indexOf('Discogs release<'))
  assert.doesNotMatch(html, /Match review/)
  assert.doesNotMatch(html, /Look up on Sonovault/)
})

test('a differing match is listed for review with both values', () => {
  const review = {
    provider: 'discogs',
    referenceType: 'master',
    stored: '111',
    sonovault: '222',
    url: 'https://www.discogs.com/master/222',
  } as const
  const html = renderSource(state({ job, lookup: confirmed, review: [review] }))
  assert.match(html, /data-status="attention"[^>]*>Match review</)
  assert.match(html, /<h4>Match review<\/h4>/)
  assert.match(html, /Sonovault 222 · stored 111/)
  assert.equal(
    sonovaultReviewText({
      provider: 'musicbrainz',
      referenceType: 'release-group',
      stored: null,
      sonovault: 'mb-example',
      url: null,
    }),
    'No MusicBrainz release group: Sonovault has mb-example',
  )
})

test('a miss says why and when it can be looked up again', () => {
  const miss = state({
    job,
    lookup: {
      ...confirmed,
      status: 'not_found',
      miss: 'not-confirmed',
      releaseId: null,
      editionId: null,
      confirmedBy: [],
      retryAfter: '2026-01-31T00:00:00.000Z',
    },
  })
  const html = renderSource(miss)
  assert.match(html, />Not found</)
  assert.match(html, /No release on the track’s record carries/)
  assert.equal(sonovaultAlbumLookupDue(miss, now), true)
  assert.equal(
    sonovaultAlbumLookupDue(state({ job, lookup: confirmed }), now),
    false,
  )
  assert.equal(sonovaultAlbumLookupDue(state({ canLookUp: false }), now), false)
  assert.equal(
    sonovaultAlbumLookupDue(
      state({ job: { ...job, status: 'queued', finishedAt: null } }),
      now,
    ),
    false,
  )
  assert.match(renderSource(state({})), /Look up on Sonovault/)
})
