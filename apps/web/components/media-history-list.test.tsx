import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaHistorySchema } from '@repo/schemas/media'
import MediaHistoryList from './media-history-list'

test('Google snapshots are visibly legacy without rewriting history data', () => {
  const history = MediaHistorySchema.parse({
    mediaItemId: 'album-1',
    events: [
      {
        id: 'snapshot-1',
        type: 'snapshot',
        provider: 'google-custom-search',
        title: 'google-custom-search snapshot',
        description: 'legacy-import',
        createdAt: '2026-01-01T00:00:00Z',
        data: { rymGoogle: { rating: { value: 0, votes: 0 } } },
      },
    ],
  })
  const original = structuredClone(history)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MediaHistoryList history={history} />
      </QueryClientProvider>,
    )
    assert.match(html, /<strong>Google Custom Search \(legacy\)<\/strong>/)
    assert.match(html, /Provider snapshots \(1\)/)
    assert.deepEqual(history, original)
  } finally {
    client.clear()
  }
})
