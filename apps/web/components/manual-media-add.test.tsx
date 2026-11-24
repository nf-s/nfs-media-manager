import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ManualMediaSearchResultSchema } from '@repo/schemas/manual-add'
import { rememberManualMediaAddition } from '@/utils/manual-media-add'
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
    assert.doesNotMatch(
      html,
      /lucide-book-check|aria-label="(?:Add album to library · Synthetic result 1|Synthetic result 1 is in your library)/,
    )
    assert.match(html, /href="[^"]*library-example"[^>]*>Synthetic result 1</)
    assert.match(html, />Next</)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
    network.mock.restore()
  }
})

test('catalog results for each media kind keep title links and reserve Add for missing items', () => {
  for (const mediaType of ['track', 'album', 'film'] satisfies (
    | 'track'
    | 'album'
    | 'film'
  )[]) {
    const client = new QueryClient()
    try {
      rememberManualMediaAddition(
        client,
        mediaType,
        'synthetic-3',
        'library-added-elsewhere',
      )
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ConfigContext.Provider
            value={{
              appUrl: 'https://app.example.test',
              apiBaseUrl: 'https://api.example.test',
            }}
          >
            <ManualMediaSearch
              mediaType={mediaType}
              initialResult={{
                ...result,
                items: result.items.map((item, index) =>
                  index === 2 ? { ...item, membershipAmbiguous: true } : item,
                ),
              }}
              onAdded={() => {}}
            />
          </ConfigContext.Provider>
        </QueryClientProvider>,
      )
      assert.match(html, /href="[^"]*library-example"[^>]*>Synthetic result 1</)
      assert.ok(
        html.includes(
          `aria-label="Add ${mediaType} to library · Synthetic result 0"`,
        ),
      )
      assert.ok(
        !html.includes(
          `aria-label="Add ${mediaType} to library · Synthetic result 2"`,
        ),
      )
      assert.match(
        html,
        /href="[^"]*library-added-elsewhere"[^>]*>Synthetic result 3</,
      )
      assert.ok(
        !html.includes(
          `aria-label="Add ${mediaType} to library · Synthetic result 3"`,
        ),
      )
      assert.doesNotMatch(html, /lucide-book-check/)
    } finally {
      client.clear()
    }
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
