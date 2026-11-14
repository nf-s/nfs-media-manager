import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
  clientCacheStaleTime,
  clientQueryDefaults,
  invalidateMediaItem,
  refreshClientQueries,
} from './query-cache'

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { ...clientQueryDefaults, retry: false } },
  })
}

test('fresh results survive navigation without another request', async () => {
  const client = createClient()
  let calls = 0
  const options = {
    queryKey: ['albums'],
    queryFn: async () => ++calls,
  }
  await client.fetchQuery(options)
  await settle()
  const observer = new QueryObserver(client, options)
  const close = observer.subscribe(() => {})
  try {
    assert.equal(observer.getCurrentResult().data, 1)
    assert.equal(observer.getCurrentResult().isFetching, false)
    assert.equal(calls, 1)
  } finally {
    close()
    client.clear()
  }
})

test('expired results render immediately while refreshing and survive a refresh failure', async () => {
  const client = createClient()
  const queryKey = ['albums']
  client.setQueryData(queryKey, ['Cached album'], {
    updatedAt: Date.now() - clientCacheStaleTime - 1000,
  })
  let reject: ((error: Error) => void) | undefined
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: () =>
      new Promise<string[]>((_resolve, fail) => {
        reject = fail
      }),
  })
  const close = observer.subscribe(() => {})
  try {
    assert.deepEqual(observer.getCurrentResult().data, ['Cached album'])
    assert.equal(observer.getCurrentResult().isPending, false)
    assert.equal(observer.getCurrentResult().isFetching, true)
    assert.ok(reject)
    reject(new Error('Offline'))
    await settle()
    assert.equal(observer.getCurrentResult().isError, true)
    assert.deepEqual(observer.getCurrentResult().data, ['Cached album'])
  } finally {
    close()
    client.clear()
  }
})

test('Refresh keeps current rows, reloads active queries and expires inactive queries without fetching them', async () => {
  const client = createClient()
  const activeKey = ['films', 'browse', 'title', 1]
  const inactiveKey = ['albums', 'browse', 'title', 1]
  client.setQueryData(activeKey, ['Cached film'])
  client.setQueryData(inactiveKey, ['Cached album'])
  let finish: ((data: string[]) => void) | undefined
  const observer = new QueryObserver(client, {
    queryKey: activeKey,
    queryFn: () =>
      new Promise<string[]>((resolve) => {
        finish = resolve
      }),
  })
  const close = observer.subscribe(() => {})
  try {
    const refresh = refreshClientQueries(client)
    assert.deepEqual(observer.getCurrentResult().data, ['Cached film'])
    assert.equal(observer.getCurrentResult().isPending, false)
    assert.equal(observer.getCurrentResult().isFetching, true)
    assert.equal(client.getQueryState(inactiveKey)?.isInvalidated, true)
    assert.equal(client.getQueryState(inactiveKey)?.fetchStatus, 'idle')
    assert.deepEqual(client.getQueryData(inactiveKey), ['Cached album'])
    assert.ok(finish)
    finish(['Updated film'])
    await refresh
    assert.deepEqual(observer.getCurrentResult().data, ['Updated film'])
    assert.equal(client.getQueryState(activeKey)?.isInvalidated, false)
  } finally {
    close()
    client.clear()
  }
})

test('editing media expires related details, browse, selection and memberships', async () => {
  const mediaTypes: Array<'album' | 'film'> = ['album', 'film']
  for (const mediaType of mediaTypes) {
    const client = createClient()
    const keys = [
      [mediaType, 'fixture'],
      ['history', 'fixture'],
      [`${mediaType}s`, 'facets', ''],
      [`${mediaType}-selection`, 'filters'],
      ...(mediaType === 'album'
        ? [
            ['playlist', 'fixture'],
            ['playlists'],
            ['album-playlists', 'fixture'],
            ['tracks'],
            ['track', 'fixture'],
            ['album-picker'],
            ['lastfm-links'],
          ]
        : [['film-collections'], ['film-collection', 'fixture']]),
    ]
    for (const key of keys) client.setQueryData(key, 'Cached')
    client.setQueryData(['subscriptions'], 'Unchanged')
    try {
      await invalidateMediaItem(client, mediaType, 'fixture')
      for (const key of keys)
        assert.equal(
          client.getQueryState(key)?.isInvalidated,
          true,
          key.join('/'),
        )
      assert.equal(
        client.getQueryState(['subscriptions'])?.isInvalidated,
        false,
      )
    } finally {
      client.clear()
    }
  }
})
