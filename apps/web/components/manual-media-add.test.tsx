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
    mediaItemId: null,
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
    assert.match(html, /manual-add-results-scroll/)
    assert.doesNotMatch(html, /height:43120px/)
    assert.equal((html.match(/manual-add-result-slot/g) ?? []).length, 10)
    assert.match(html, />Next</)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
    network.mock.restore()
  }
})
