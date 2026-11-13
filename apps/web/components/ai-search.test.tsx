import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { trackBrowseFields } from '@repo/schemas/browse'
import { ConfigContext } from './providers'

// The pages import CSS modules, which Node cannot load; class names are not under test.
require.extensions['.css'] = (module) => {
  module.exports = {}
}

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

function render(path: string, search: string, children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['ai-status'], { available: true, reason: null })
  client.setQueryData(['tracks', 'fields'], trackBrowseFields)
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value={path}>
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              {children}
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function assertAiSearchBox(html: string, placeholder: string) {
  const box = html.match(
    /<div class="browse-search">[\s\S]*?<div class="search-input-actions">[\s\S]*?<\/div>/,
  )?.[0]
  assert.ok(box, 'search box with input actions')
  assert.match(box, /class="search-input-wrap has-actions"/)
  assert.match(box, new RegExp(`placeholder="${placeholder}"`))
  assert.match(box, /aria-label="Record search"/)
}

test('the track browser offers AI search and dictation inside its search box', async () => {
  const { default: TrackBrowser } = await import('./track-browser')
  const html = render('/tracks', 'q=live', <TrackBrowser />)
  assertAiSearchBox(html, 'Search titles, artists, albums, playlists...')
  assert.match(html, /Search: live/)
})
