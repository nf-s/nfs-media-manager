import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ManualMediaSearchResultSchema } from '@repo/schemas/manual-add'
import { ManualMediaSearch } from './manual-media-add'
import { ConfigContext } from './providers'

const result = ManualMediaSearchResultSchema.parse({
  page: 1,
  hasMore: true,
  totalCount: 500,
  items: Array.from({ length: 10 }, (_, index) => ({
    externalId: `synthetic-${index}`,
    title: `Synthetic result ${index}`,
    subtitle: 'Example artist',
    releaseDate: null,
    artworkUrl: null,
    url: `https://open.spotify.com/album/synthetic-${index}`,
    mediaItemId: index === 1 ? 'library-example' : null,
  })),
})

test('stored provider results remain bounded even when their snapshot includes a total', () => {
  const network = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  const client = new QueryClient()
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <ManualMediaSearch
            mediaType="album"
            initialQuery="Example"
            initialResult={result}
            onAdded={() => {}}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(html, /class="sec-bounded sec-results"/)
    assert.doesNotMatch(html, /height:24010px/)
    assert.equal((html.match(/class="sec-result-slot"/g) ?? []).length, 10)
    assert.match(html, /class="ds-list" data-compact=""/)
    assert.match(html, /aria-label="Add album to library · Synthetic result 0"/)
    assert.match(
      html,
      /aria-label="Synthetic result 1 is in your library \(album\)"/,
    )
    assert.match(html, /href="[^"]*library-example"[^>]*>Synthetic result 1</)
    assert.match(html, />Next</)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
    network.mock.restore()
  }
})

test('the saved Last.fm album search keeps its Link and Add actions', () => {
  const client = new QueryClient()
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <ManualMediaSearch
            mediaType="album"
            initialResult={result}
            existingActionLabel="Link"
            onAdded={() => {}}
          />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
    assert.match(html, /aria-label="Link Synthetic result 1"[^>]*>Link</)
    assert.match(html, /aria-label="Add Synthetic result 0"[^>]*>Add</)
    assert.doesNotMatch(html, /lucide-book-/)
  } finally {
    client.clear()
  }
})
