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
import MixStationImportPageClient from './pages/mix-station-import-page-client'
import SpotifyPodcastsPageClient from './pages/spotify-podcasts-page-client'
import {
  invalidateSubscriptionLibrary,
  subscriptionSourceProgress,
} from './subscription-sync'

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
  failedRefresh = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['subscription-sync', 'spotify'], status)
  client.setQueryData(['spotify-account'], spotify)
  if (failedRefresh)
    client
      .getQueryCache()
      .build(client, {
        queryKey: ['subscription-sync', 'spotify'],
      })
      .setState({
        status: 'error',
        error: new Error('Offline'),
        fetchStatus: 'idle',
      })
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
  assert.match(
    html,
    /role="progressbar" aria-valuemin="0" aria-valuemax="8" aria-valuenow="3"/,
  )
  assert.match(html, /href="\/jobs\/job-5">View current job/)
  assert.match(html, />Reconnect Spotify</)
  assert.match(html, /href="\/subscriptions\/channels\?type=spotify"/)
  assert.doesNotMatch(html, /channels read|videos/i)
})

test('podcast sync retains cached progress after a failed background refresh', () => {
  const html = render(sync, account(true, true), '', true)
  assert.match(html, /<dt>Podcasts read<\/dt><dd>3 of 8<\/dd>/)
  assert.match(html, /<dt>Stored episodes<\/dt><dd>240<\/dd>/)
})

test('a cached unavailable sync remains unavailable after a refresh failure', () => {
  const html = render(null, account(true, true), '', true)
  assert.match(html, /Podcast sync is not available on this server\./)
})

test('reading the saved podcast list is shown before podcasts are counted', () => {
  assert.equal(
    subscriptionSourceProgress({ ...sync, phase: 'sources' }),
    'Reading saved podcasts',
  )
  assert.equal(
    subscriptionSourceProgress({ ...sync, state: 'never', phase: null }),
    '–',
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
  assert.match(unconnected, /data-status="attention">Needs sign-in</)
  assert.match(unconnected, /<button[^>]*>Connect Spotify<\/button>/)
  assert.match(unconnected, /<button[^>]*disabled=""[^>]*>Sync now<\/button>/)
  const unconfigured = render(null, account(false, false))
  assert.match(unconfigured, /Spotify is not configured\./)
  assert.match(unconfigured, /href="\/providers\/spotify\?tab=settings"/)
  assert.match(
    unconfigured,
    /<button[^>]*disabled=""[^>]*>Connect Spotify<\/button>/,
  )
})

test('the Spotify OAuth return is confirmed or reported', () => {
  const connected = render(sync, account(true, true), 'spotify=connected')
  assert.match(
    connected,
    /data-feedback="done"[^>]*>.*?<span>Spotify connected<\/span><\/span><\/button>/,
  )
  assert.equal(
    connected.replace(/<[^>]*>/g, '').split('Spotify connected').length - 1,
    1,
  )
  assert.match(
    render(sync, account(true, false), 'spotify=error'),
    /role="alert">.*<span>Spotify did not connect\. Try again\.<\/span>/,
  )
})

const stationSync = SubscriptionSyncStatusSchema.parse({
  ...sync,
  provider: 'nts',
  job: { id: 'job-9', status: 'running' },
  sourcesDone: 2,
  sourcesTotal: 5,
  storedSources: 5,
  storedItems: 80,
})

function renderStation(status: SubscriptionSyncStatus) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['subscription-sync', status.provider], status)
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <MixStationImportPageClient station="nts" />
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

test('a station page shows its sync of shows and mixes and the schedule, without an account', () => {
  const html = renderStation(stationSync)
  assert.match(html, /<h1>NTS<\/h1>/)
  assert.match(html, /href="\/mixes\/shows\?type=nts">Shows</)
  assert.match(html, /<dt>Shows read<\/dt><dd>2 of 5<\/dd>/)
  assert.match(html, /<dt>New mixes this run<\/dt>/)
  assert.match(html, /<dt>Stored mixes<\/dt><dd>80<\/dd>/)
  assert.match(html, /href="\/jobs\/job-9">View current job/)
  assert.match(html, /<label[^>]*>Schedule<\/label>/)
  assert.doesNotMatch(html, /Account|Connect|podcast|episode|channel/i)
})

test('a station feed run counts pages instead of shows', () => {
  const feed = { ...stationSync, sourcesDone: 7, sourcesTotal: 0 }
  assert.equal(subscriptionSourceProgress(feed), '7')
  assert.equal(
    subscriptionSourceProgress({ ...feed, phase: 'sources' }),
    'Reading shows',
  )
  const html = renderStation(feed)
  assert.match(html, /<dt>Pages read<\/dt><dd>7<\/dd>/)
  assert.doesNotMatch(html, /of 0|role="progressbar"/)
  // A podcast run with no podcasts still reads as a count of sources.
  assert.equal(
    subscriptionSourceProgress({ ...sync, sourcesDone: 0, sourcesTotal: 0 }),
    '0 of 0',
  )
})

test('a finished sync refreshes only its own library', async () => {
  const client = new QueryClient()
  client.setQueryData(['mixes', 'browse', 'x', 1], { items: [] })
  client.setQueryData(['subscriptions', 'browse', 'x', 1], { items: [] })
  await invalidateSubscriptionLibrary(client, 'mixes')
  assert.equal(
    client.getQueryState(['mixes', 'browse', 'x', 1])?.isInvalidated,
    true,
  )
  assert.equal(
    client.getQueryState(['subscriptions', 'browse', 'x', 1])?.isInvalidated,
    false,
  )
  client.clear()
})
