import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ProviderSummarySchema } from '@repo/schemas/provider'
import ProvidersPageClient from './pages/providers-page-client'

function render(total: number, section = 'activity') {
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
    supportsLegacyImport: true,
    secrets: [],
    pluginPath: null,
  })
  client.setQueryData(['providers'], [provider])
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
