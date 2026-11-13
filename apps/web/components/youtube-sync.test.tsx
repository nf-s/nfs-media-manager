import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  SubscriptionSyncStatusSchema,
  type SubscriptionSyncStatus,
} from '@repo/schemas/subscriptions'
import { ConfigContext } from './providers'
import YoutubeSyncPanel from './youtube-sync'

type StatusInput = Partial<Omit<SubscriptionSyncStatus, 'account'>> & {
  account?: Partial<SubscriptionSyncStatus['account']>
}

function status({ account, ...overrides }: StatusInput = {}) {
  return SubscriptionSyncStatusSchema.parse({
    provider: 'youtube',
    account: {
      configured: true,
      connected: true,
      redirectUri: 'https://media.example.test/api/v1/youtube/callback',
      ...account,
    },
    state: 'complete',
    job: { id: 'job-1', status: 'succeeded' },
    schedule: 'daily',
    nextScheduledAt: '2026-11-14T02:00:00.000Z',
    phase: 'items',
    sourcesDone: 6,
    sourcesTotal: 6,
    newItems: 4,
    storedSources: 6,
    storedItems: 60,
    startedAt: '2026-11-13T01:00:00.000Z',
    lastCompletedAt: '2026-11-13T01:05:00.000Z',
    resumeAfter: null,
    errorMessage: null,
    ...overrides,
  })
}

function render(data: SubscriptionSyncStatus, search = '') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['subscription-sync', 'youtube'], data)
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
            <YoutubeSyncPanel />
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

function button(html: string, label: string) {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html)
  assert.ok(match, `Missing ${label} button`)
  return match[0]
}

test('an unconfigured account links to the YouTube credentials and cannot sync', () => {
  const html = render(
    status({
      account: { configured: false, connected: false, redirectUri: null },
      state: 'never',
      job: null,
      phase: null,
      sourcesDone: 0,
      sourcesTotal: 0,
      lastCompletedAt: null,
      nextScheduledAt: null,
    }),
  )
  assert.match(
    html,
    /href="\/providers\?provider=youtube&amp;section=credentials&amp;mediaType=subscription"/,
  )
  assert.doesNotMatch(html, /Connect YouTube|Reconnect|Disconnect/)
  assert.match(button(html, 'Sync now'), / disabled=""/)
  assert.match(html, /<dd>Not synced<\/dd>/)
  assert.doesNotMatch(html, /View last job/)
})

test('a configured account offers to connect and shows the redirect URI', () => {
  const html = render(
    status({ account: { connected: false }, state: 'never', job: null }),
  )
  assert.doesNotMatch(button(html, 'Connect YouTube'), / disabled=""/)
  assert.match(
    html,
    /Redirect URI: <code>https:\/\/media\.example\.test\/api\/v1\/youtube\/callback<\/code>/,
  )
  assert.match(button(html, 'Sync now'), / disabled=""/)
})

test('a running sync shows channel progress, stop and the current job', () => {
  const html = render(
    status({
      state: 'running',
      job: { id: 'job-2', status: 'running' },
      sourcesDone: 2,
      sourcesTotal: 6,
    }),
  )
  assert.match(html, /<dd>Running<\/dd>/)
  assert.match(html, /<dd>2 of 6<\/dd>/)
  assert.match(html, /<progress[^>]+value="2"[^>]+max="6"/)
  assert.match(button(html, 'Sync now'), / disabled=""/)
  assert.doesNotMatch(button(html, 'Stop'), / disabled=""/)
  assert.match(
    html,
    /href="\/jobs\?jobId=job-2&amp;mediaType=subscription">View current job/,
  )
  assert.match(button(html, 'Reconnect'), /<button/)
  assert.match(button(html, 'Disconnect'), /<button/)
})

test('reading the subscription list is shown before channels are counted', () => {
  const html = render(
    status({
      state: 'running',
      job: { id: 'job-2', status: 'queued' },
      phase: 'sources',
      sourcesDone: 0,
      sourcesTotal: 0,
    }),
  )
  assert.match(html, /<dd>Reading subscriptions<\/dd>/)
  assert.doesNotMatch(html, /<progress[^>]+value=/)
})

test('a paused sync explains the quota and can be resumed', () => {
  const html = render(
    status({
      state: 'paused',
      job: { id: 'job-3', status: 'succeeded' },
      resumeAfter: '2026-11-14T08:00:00.000Z',
    }),
  )
  assert.match(html, /<dd>Paused<\/dd>/)
  assert.match(html, /Paused: the daily YouTube API quota is used up\./)
  assert.match(html, /The schedule resumes it after /)
  assert.doesNotMatch(button(html, 'Resume sync'), / disabled=""/)
  assert.doesNotMatch(html, />Stop</)
  const manual = render(
    status({
      state: 'paused',
      schedule: 'off',
      resumeAfter: '2026-11-14T08:00:00.000Z',
    }),
  )
  assert.match(manual, /Resume after /)
})

test('a failed sync shows its error and offers to resume', () => {
  const html = render(
    status({
      state: 'failed',
      job: { id: 'job-4', status: 'failed' },
      errorMessage: 'Access was revoked',
    }),
  )
  assert.match(html, /<p role="alert">Access was revoked<\/p>/)
  assert.match(button(html, 'Resume sync'), /<button/)
  assert.match(html, /View last job/)
})

test('the OAuth return is confirmed or reported', () => {
  assert.match(
    render(status(), 'youtube=connected'),
    /<p role="status">YouTube connected\.<\/p>/,
  )
  assert.match(
    render(status({ account: { connected: false } }), 'youtube=error'),
    /<p role="alert">YouTube did not connect\. Try again\.<\/p>/,
  )
})

test('the channel list is on the Channels page, linked from the import page', async () => {
  const { default: Page } =
    await import('./pages/youtube-subscriptions-page-client')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['subscription-sync', 'youtube'], status())
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{ apiBaseUrl: 'http://localhost', appUrl: 'http://localhost' }}
      >
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <Page />
        </SearchParamsContext.Provider>
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
  client.clear()
  assert.match(html, /<h1>YouTube<\/h1>/)
  assert.match(
    html,
    /href="\/subscriptions\/channels\?type=youtube">Subscribed channels/,
  )
  assert.match(html, /Channels read/)
})
