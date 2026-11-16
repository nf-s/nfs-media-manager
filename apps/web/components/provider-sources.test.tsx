import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { InspectorEntryContext } from './detail-inspector-context'
import { ProviderSources } from './provider-sources'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in source navigation rendering tests')
})

function render(view: string, initialProvider?: string) {
  const client = new QueryClient()
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value="/films">
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <InspectorEntryContext.Provider
              value={{
                active: { kind: 'film', id: 'film-1', view },
                replaceView: () => {},
              }}
            >
              <ProviderSources
                scope={{ kind: 'film', id: 'film-1' }}
                rows={[{ id: 'example', label: 'Example provider' }]}
                initialProvider={initialProvider}
              />
            </InspectorEntryContext.Provider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('returning to a saved Sources entry restores its open history and job table filters', () => {
  const html = render(
    'tab=sources&sourceProvider=example&sourceMode=history&jobsQ=fixture&jobsSortBy=status&jobsDirection=asc',
  )
  assert.match(
    html,
    /aria-label="Example provider history" aria-expanded="true"/,
  )
  assert.match(html, /aria-label="Job history"/)
  assert.match(html, /aria-label="Search job history"[^>]*value="fixture"/)
  assert.match(
    html,
    /aria-sort="ascending"><div[^>]*><button[^>]+title="Sort by Status"/,
  )
})

test('closing a legacy source history stays closed after restoring its entry', () => {
  const html = render('tab=sources&sourceMode=closed', 'example')
  assert.match(
    html,
    /aria-label="Example provider history" aria-expanded="false"/,
  )
  assert.doesNotMatch(html, /aria-label="Job history"/)
  assert.match(
    render('tab=sources', 'example'),
    /aria-label="Example provider history" aria-expanded="true"/,
  )
})
