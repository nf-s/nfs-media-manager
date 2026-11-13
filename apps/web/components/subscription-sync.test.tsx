import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  SubscriptionSyncStatusSchema,
  type SubscriptionSyncStatus,
} from '@repo/schemas/subscriptions'
import { ConfigContext } from './providers'
import SpotifyPodcastsPageClient from './pages/spotify-podcasts-page-client'
import { subscriptionSourceProgress } from './subscription-sync'

const sync = SubscriptionSyncStatusSchema.parse({
  provider: 'spotify',
  account: { configured: true, connected: true, redirectUri: null },
  state: 'running',
  job: { id: 'job-5', status: 'running' },
  schedule: 'daily',
  nextScheduledAt: null,
  phase: 'items',
  sourcesDone: 3,
  sourcesTotal: 8,
  newItems: 12,
  storedSources: 8,
  storedItems: 240,
  startedAt: '2026-11-13T01:00:00.000Z',
  lastCompletedAt: null,
  resumeAfter: null,
  errorMessage: null,
})

function account(configured: boolean, connected: boolean) {
  return SpotifyAccountStatusSchema.parse({
    configured,
    connected,
    expiresAt: null,
    scope: null,
    redirectUri: null,
    playback: false,
    playlists: false,
  })
}

function render(
  status: SubscriptionSyncStatus | null,
  spotify = account(true, true),
  search = '',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['subscription-sync', 'spotify'], status)
  client.setQueryData(['spotify-account'], spotify)
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            <SpotifyPodcastsPageClient />
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
    network.mock.restore()
  }
}

test('podcast sync names podcasts and episodes and links to its job', () => {
  const html = render(sync)
  assert.match(html, /<h1>Spotify podcasts<\/h1>/)
  assert.match(html, /<dt>Podcasts read<\/dt><dd>3 of 8<\/dd>/)
  assert.match(html, /<dt>New episodes this run<\/dt>/)
  assert.match(html, /<dt>Stored episodes<\/dt><dd>240<\/dd>/)
  assert.match(html, /<progress[^>]+value="3"[^>]+max="8"/)
  assert.match(
    html,
    /href="\/jobs\?jobId=job-5&amp;mediaType=subscription">View current job/,
  )
  assert.match(html, />Reconnect Spotify</)
  assert.match(html, /href="\/subscriptions\/channels\?type=spotify"/)
  assert.doesNotMatch(html, /channels read|videos/i)
})

test('reading the saved podcast list is shown before podcasts are counted', () => {
  assert.equal(
    subscriptionSourceProgress({ ...sync, phase: 'sources' }),
    'Reading saved podcasts',
  )
  assert.equal(
    subscriptionSourceProgress({ ...sync, state: 'never', phase: null }),
    '-',
  )
})

test('a server without podcast sync says so instead of failing', () => {
  const html = render(null)
  assert.match(html, /Podcast sync is not available on this server\./)
  assert.match(html, />Reconnect Spotify</)
  assert.doesNotMatch(html, /Sync now|role="alert"/)
})

test('an unconnected or unconfigured account says so and offers Connect', () => {
  const unconnected = render(
    {
      ...sync,
      state: 'never',
      job: null,
      account: { ...sync.account, connected: false },
    },
    account(true, false),
  )
  assert.match(unconnected, /Spotify is not connected\./)
  assert.match(unconnected, /<button[^>]*>Connect Spotify<\/button>/)
  assert.match(unconnected, /<button[^>]*disabled=""[^>]*>Sync now<\/button>/)
  const unconfigured = render(null, account(false, false))
  assert.match(unconfigured, /Spotify is not configured\./)
  assert.match(
    unconfigured,
    /href="\/providers\?provider=spotify&amp;section=credentials&amp;mediaType=subscription"/,
  )
  assert.match(
    unconfigured,
    /<button[^>]*disabled=""[^>]*>Connect Spotify<\/button>/,
  )
})

test('the Spotify OAuth return is confirmed or reported', () => {
  assert.match(
    render(sync, account(true, true), 'spotify=connected'),
    /<p role="status">Spotify connected\.<\/p>/,
  )
  assert.match(
    render(sync, account(true, false), 'spotify=error'),
    /<p role="alert">Spotify did not connect\. Try again\.<\/p>/,
  )
})
