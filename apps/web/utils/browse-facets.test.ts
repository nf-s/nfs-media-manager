import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { browseFacetOptions } from './browse-facets'
import { clientQueryDefaults } from './query-cache'

test('facet searches use their own query keys and cancel superseded requests', async (t) => {
  const client = new QueryClient()
  const requests: { input: RequestInfo | URL; init?: RequestInit }[] = []
  t.mock.method(
    globalThis,
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init })
      return new Promise<Response>(() => {})
    },
  )
  const observer = new QueryObserver(
    client,
    browseFacetOptions('/backend', 'films', 'first'),
  )
  const close = observer.subscribe(() => {})
  try {
    observer.setOptions(browseFacetOptions('/backend', 'films', 'second'))
    assert.equal(requests[0]?.init?.signal?.aborted, true)
    assert.equal(requests[1]?.init?.signal?.aborted, false)
    assert.equal(
      requests[1]?.input,
      '/backend/api/v1/films/facets?q=second&limitPerField=25',
    )
    assert.equal(observer.getCurrentResult().data, undefined)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(client.getQueryData(['films', 'facets', 'first']), undefined)
    close()
    assert.equal(requests[1]?.init?.signal?.aborted, true)
  } finally {
    observer.destroy()
    client.clear()
  }
})

test('facet query identities separate libraries and encode literal search text', () => {
  const films = browseFacetOptions('', 'films', '  50%_ rare  ')
  const albums = browseFacetOptions('', 'albums', '50%_ rare')
  assert.deepEqual(films.queryKey, ['films', 'facets', '50%_ rare'])
  assert.deepEqual(albums.queryKey, ['albums', 'facets', '50%_ rare'])
  assert.equal(films.gcTime, clientQueryDefaults.gcTime)
  const draft = 'x'.repeat(250)
  assert.deepEqual(browseFacetOptions('', 'films', draft).queryKey, [
    'films',
    'facets',
    'x'.repeat(200),
  ])
  assert.equal(draft.length, 250)
})

test('a tag location is sent with the suggestions and keys them apart from Auto', async (t) => {
  const requests: (RequestInfo | URL)[] = []
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL) => {
    requests.push(input)
    return new Promise<Response>(() => {})
  })
  const auto = browseFacetOptions('', 'tracks', 'house')
  const located = browseFacetOptions('/backend', 'tracks', 'house', false, [
    'track',
    'album',
  ])
  assert.deepEqual(auto.queryKey, ['tracks', 'facets', 'house'])
  assert.deepEqual(located.queryKey, [
    'tracks',
    'facets',
    'house',
    'track,album',
  ])
  const client = new QueryClient()
  const observer = new QueryObserver(client, located)
  const close = observer.subscribe(() => {})
  try {
    assert.equal(
      requests[0],
      '/backend/api/v1/tracks/facets?q=house&limitPerField=25&tagLevels=track%2Calbum',
    )
  } finally {
    close()
    observer.destroy()
    client.clear()
  }
})
