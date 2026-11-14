import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import RefreshDataButton from './refresh-data-button'

test('Refresh is an accessible explicit action and rendering does not invalidate data', () => {
  const client = new QueryClient()
  client.setQueryData(['albums'], ['Cached album'])
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RefreshDataButton />
      </QueryClientProvider>,
    )
    assert.match(html, /type="button"/)
    assert.match(html, /aria-label="Refresh cached data"/)
    assert.match(html, />Refresh<\/span>/)
    assert.doesNotMatch(html, /disabled=""/)
    assert.equal(client.getQueryState(['albums'])?.isInvalidated, false)
  } finally {
    client.clear()
  }
})
