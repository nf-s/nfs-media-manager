import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ApiKeysSchema } from '@repo/schemas/api-key'
import UserPageClient from './pages/user-page-client'
import { ConfigContext } from './providers'
import UserLink from './user-link'

const apiKeys = ApiKeysSchema.parse([
  {
    id: 'fixture-active',
    name: 'Fixture active',
    start: 'mm_active',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastRequest: null,
    enabled: true,
    rateLimit: { enabled: true, maxRequests: 80, windowSeconds: 60 },
    requestsUsed: 12,
  },
  {
    id: 'fixture-expired',
    name: 'Fixture expired',
    start: 'mm_expired',
    createdAt: '2025-01-01T00:00:00.000Z',
    expiresAt: '2025-01-01T01:00:00.000Z',
    lastRequest: null,
    enabled: true,
    rateLimit: { enabled: true, maxRequests: 80, windowSeconds: 60 },
    requestsUsed: 12,
  },
  {
    id: 'fixture-revoked',
    name: 'Fixture revoked',
    start: 'mm_revoked',
    createdAt: '2024-01-01T00:00:00.000Z',
    expiresAt: null,
    lastRequest: null,
    enabled: false,
    rateLimit: { enabled: false },
    requestsUsed: null,
  },
])

test('User renders key actions, table metadata and documentation without making requests', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden during rendering')
  })
  const client = new QueryClient()
  client.setQueryData(['user-api-keys'], apiKeys)
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            apiBaseUrl: 'https://media.example.test',
            appUrl: 'https://media.example.test',
          }}
        >
          <UserPageClient />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(html, /<h1>User<\/h1>/)
    assert.match(html, />Grant Agent Access<\/button>/)
    assert.match(html, /expires in 60 minutes/)
    assert.match(html, /href="https:\/\/media\.example\.test\/api\/v1\/scalar"/)
    assert.match(html, /disabled=""[^>]*>Create key<\/button>/)
    assert.match(html, /aria-label="Search API keys"/)
    assert.match(html, /aria-sort="descending"/)
    assert.match(html, /<th[^>]*>Actions<\/th>/)
    assert.match(html, /<label><input[^>]*\/>Actions<\/label>/)
    assert.doesNotMatch(html, /title="Sort by Actions"/)
    assert.match(html, /aria-label="Edit rate limit for Fixture active"/)
    assert.match(html, /12 \/ 80 in 60s/)
    assert.match(html, />Unlimited</)
    assert.match(
      html,
      /<button(?=[^>]*disabled="")(?=[^>]*aria-label="Edit rate limit for Fixture expired")/,
    )
    assert.match(html, />Maximum requests</)
    assert.match(html, />Window \(seconds\)</)
    assert.match(html, />mm_active…<\/code>/)
    for (const status of ['Active', 'Expired', 'Revoked']) {
      assert.match(
        html,
        new RegExp(
          `class="ds-status" data-status="[a-z]+"[^>]* title="${status}">${status}</span>`,
        ),
      )
    }
    assert.match(html, /<button[^>]*aria-label="Revoke Fixture active"[^>]*>/)
    assert.match(
      html,
      /<button[^>]*disabled=""[^>]*aria-label="Revoke Fixture revoked"/,
    )
    assert.doesNotMatch(html, /<textarea|Copy API key|Copy agent instructions/)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

test('the User link keeps the current library and identifies the active page', () => {
  const html = renderToStaticMarkup(
    <PathnameContext.Provider value="/user">
      <SearchParamsContext.Provider
        value={new URLSearchParams('mediaType=track')}
      >
        <UserLink />
      </SearchParamsContext.Provider>
    </PathnameContext.Provider>,
  )
  assert.match(html, /aria-current="page"/)
  assert.match(html, /href="\/user\?mediaType=track"/)
  assert.match(html, />User<\/span>/)
})
