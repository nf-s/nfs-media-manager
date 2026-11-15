import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  ProviderLocalWorkerStatusSchema,
  ProviderSummarySchema,
  type ProviderLocalWorkerStatus,
} from '@repo/schemas/provider'
import ProvidersPageClient from './pages/providers-page-client'

function render(
  total: number,
  section = 'activity',
  worker?: ProviderLocalWorkerStatus,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  })
  const provider = ProviderSummarySchema.parse({
    id: 'fixture',
    displayName: 'Fixture provider',
    description: '',
    surface: 'provider',
    mediaTypes: ['album'],
    rateLimit: { maxConcurrent: 1, minTimeMs: 1500 },
    supportsScrape: false,
    supportsLocalWorker: Boolean(worker),
    supportsLegacyImport: true,
    secrets: [],
    pluginPath: null,
  })
  client.setQueryData(['providers'], [provider])
  if (worker)
    client.setQueryData(['providers', 'local-worker', provider.id], worker)
  client.setQueryData(['jobs', 'provider-summary', provider.id], {
    provider: provider.id,
    total,
    queued: total,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value="/providers">
          <SearchParamsContext.Provider
            value={
              new URLSearchParams({
                provider: provider.id,
                mediaType: 'album',
                section,
              })
            }
          >
            <ProvidersPageClient />
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('provider activity shows the job totals and a jobs tab when jobs exist', () => {
  const html = render(12)
  assert.match(html, /role="tab"[^>]*>Jobs</)
  assert.match(html, /Jobs · 12/)
  assert.match(html, />View jobs</)
})

test('a provider without jobs omits the jobs tab and falls back to activity', () => {
  const html = render(0, 'jobs')
  assert.doesNotMatch(html, /role="tab"[^>]*>Jobs</)
  assert.match(html, /Jobs · 0/)
  assert.doesNotMatch(html, /aria-label="Jobs"|aria-label="Job dispatch"/)
})

test('provider jobs render the shared table and keep the provider fixed', () => {
  const html = render(12, 'jobs')
  assert.match(html, /aria-label="Jobs"/)
  assert.match(html, /aria-label="Search jobs"/)
  assert.match(html, /aria-label="Filter Job status"/)
  assert.doesNotMatch(html, /aria-label="Filter Job provider"/)
  assert.doesNotMatch(html, /Resume queue|Restart queue/)
})

test('provider settings describe the dispatch stop and bounded request retries', () => {
  const settings = render(0, 'settings')
  assert.match(
    settings,
    /Five consecutive unexpected failures stop queued work/,
  )
  assert.match(
    settings,
    /Serial metadata GET requests can make up to three attempts total on HTTP 502, 503 or 504/,
  )
})

test('the provider header shows transport and availability on every tab', () => {
  const worker = ProviderLocalWorkerStatusSchema.parse({
    mode: 'local',
    configured: true,
    paired: true,
    online: false,
    blocked: false,
    active: false,
    lastSeenAt: null,
    supportsModeSwitch: false,
  })
  const settings = render(0, 'settings', worker)
  assert.match(settings, /<h1>Fixture provider<\/h1>.*>Local<\/span>/)
  assert.match(settings, /Local worker offline/)
  assert.doesNotMatch(settings, /Switch to Cloudflare/)

  const activity = render(1, 'activity', {
    ...worker,
    mode: 'cloud',
    online: true,
    supportsModeSwitch: true,
  })
  assert.match(activity, /<h1>Fixture provider<\/h1>.*>Cloudflare<\/span>/)
  assert.match(activity, /Local worker online/)
  assert.doesNotMatch(render(0), /Local worker|>Cloudflare<\/span>/)
})
