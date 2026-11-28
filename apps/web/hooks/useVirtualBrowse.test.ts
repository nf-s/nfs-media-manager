import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
  skipToken,
} from '@tanstack/react-query'
import { useInLibraryBrowseCount } from './useVirtualBrowse'

type InLibraryCount = ReturnType<typeof useInLibraryBrowseCount>

function inLibraryCount(
  client: QueryClient,
  view: Record<string, string>,
  total = 128,
) {
  let result: InLibraryCount | undefined
  function Probe() {
    result = useInLibraryBrowseCount({
      apiBaseUrl: 'http://localhost:4001',
      collection: 'tracks',
      params: new URLSearchParams({ q: 'rain', ...view }),
      enabled: true,
      total,
    })
    return null
  }
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(Probe)),
  )
  assert.ok(result)
  return result
}

const countQueries = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .filter(({ queryKey }) => queryKey[1] === 'browse-count')

test('the In library count of a whole-result selection is the view’s own count at that scope', () => {
  const client = new QueryClient()
  assert.deepEqual(inLibraryCount(client, {}), {
    total: 128,
    outside: false,
    error: null,
  })
  // No request is made for it.
  assert.ok(
    countQueries(client).every((query) => query.options.queryFn === skipToken),
  )
})

test('at the All scope the Browse count is read at the In library scope', () => {
  const client = new QueryClient()
  client.setQueryData(
    ['tracks', 'browse-count', 'libraryScope=library&q=rain'],
    {
      totalCount: 77,
    },
  )
  assert.deepEqual(inLibraryCount(client, { libraryScope: 'all' }), {
    total: 77,
    outside: false,
    error: null,
  })
  const [query] = countQueries(client)
  assert.notEqual(query?.options.queryFn, skipToken)
})

test('at the Outside scope nothing can be added and no count is requested', () => {
  const client = new QueryClient()
  assert.deepEqual(inLibraryCount(client, { libraryScope: 'outside' }), {
    total: 0,
    outside: true,
    error: null,
  })
  assert.ok(
    countQueries(client).every((query) => query.options.queryFn === skipToken),
  )
})

test('a failed count gives its request’s message', () => {
  // The failure stands until it is retried, as after a failed request.
  const client = new QueryClient({
    defaultOptions: { queries: { retryOnMount: false } },
  })
  const query = client.getQueryCache().build(client, {
    queryKey: ['tracks', 'browse-count', 'libraryScope=library&q=rain'],
  })
  query.setState({
    status: 'error',
    error: new Error('Count timed out'),
    fetchStatus: 'idle',
  })
  assert.deepEqual(inLibraryCount(client, { libraryScope: 'all' }), {
    total: undefined,
    outside: false,
    error: 'Count timed out',
  })
})
