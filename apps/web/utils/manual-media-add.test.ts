import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ManualMediaSearchItem } from '@repo/schemas/manual-add'
import {
  addManualMediaItem,
  describeSearchItem,
  holdsFewerTracks,
  loadManualSearchPage,
  orderSearchItems,
} from './manual-media-add'

const item: ManualMediaSearchItem = {
  externalId: '1234567890123456789012',
  title: 'Example album',
  subtitle: 'Example artist',
  releaseDate: null,
  artworkUrl: null,
  url: 'https://open.spotify.com/album/1234567890123456789012',
  mediaItemId: null,
}

test('scrolling a saved counted search never fetches a provider page', async () => {
  const request = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    const page = await loadManualSearchPage({
      apiBaseUrl: 'http://localhost',
      mediaType: 'album',
      query: 'Example',
      page: 20,
      stored: { items: [item], page: 3, hasMore: true, totalCount: 500 },
      liveSearch: false,
      signal: new AbortController().signal,
    })
    assert.deepEqual(page, { items: [item], totalCount: 1 })
    assert.equal(request.mock.callCount(), 0)
  } finally {
    request.mock.restore()
  }
})

test('an explicit search loads only its requested distant page and preserves the total', async () => {
  const request = mock.method(
    globalThis,
    'fetch',
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        mediaType: 'album',
        q: 'Example',
        page: 20,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { items: [item], page: 20, hasMore: true, totalCount: 500 },
      })
    },
  )
  try {
    assert.deepEqual(
      await loadManualSearchPage({
        apiBaseUrl: 'http://localhost',
        mediaType: 'album',
        query: 'Example',
        page: 20,
        stored: { items: [item], page: 1, hasMore: true, totalCount: 500 },
        liveSearch: true,
        signal: new AbortController().signal,
      }),
      { items: [item], totalCount: 500 },
    )
    assert.equal(request.mock.callCount(), 1)
  } finally {
    request.mock.restore()
  }
})

test('an existing library result is reused without an add request', async () => {
  const request = mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden')
  })
  try {
    assert.equal(
      await addManualMediaItem('http://localhost', 'album', {
        ...item,
        mediaItemId: 'existing-album',
      }),
      'existing-album',
    )
    assert.equal(request.mock.callCount(), 0)
  } finally {
    request.mock.restore()
  }
})

for (const mediaType of ['album', 'track'] satisfies ('album' | 'track')[]) {
  test(`a selected ${mediaType} adds only its provider identity and reuses its library ID`, async () => {
    const request = mock.method(
      globalThis,
      'fetch',
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        assert.equal(url, 'http://localhost/api/v1/manual-add/add')
        assert.equal(init?.method, 'POST')
        assert.equal(
          init?.body,
          JSON.stringify({ mediaType, externalId: item.externalId }),
        )
        return Response.json({
          statusCode: 200,
          message: 'OK',
          data: { mediaItemId: `created-${mediaType}`, created: true },
        })
      },
    )
    try {
      const id = await addManualMediaItem('http://localhost', mediaType, item)
      assert.equal(id, `created-${mediaType}`)
      assert.equal(
        await addManualMediaItem('http://localhost', mediaType, {
          ...item,
          mediaItemId: id,
        }),
        id,
      )
      assert.equal(request.mock.callCount(), 1)
    } finally {
      request.mock.restore()
    }
  })
}

test('failed additions propagate once and do not retry provider requests', async () => {
  const request = mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { statusCode: 429, message: 'Spotify is cooling down' },
      { status: 429 },
    ),
  )
  try {
    await assert.rejects(
      addManualMediaItem('http://localhost', 'album', item),
      { message: 'Spotify is cooling down' },
    )
    assert.equal(request.mock.callCount(), 1)
  } finally {
    request.mock.restore()
  }
})

test('album results say how many tracks they have, and a release with fewer than were played says so and is listed last', async () => {
  const single = { ...item, externalId: 'single', trackCount: 1 }
  const ep = { ...item, externalId: 'ep', trackCount: 6, releaseDate: '2014' }
  const deluxe = { ...item, externalId: 'deluxe', trackCount: 9 }
  // Stored results from before track counts were kept.
  const unknown = { ...item, externalId: 'unknown' }
  assert.equal(holdsFewerTracks(single, 6), true)
  assert.equal(holdsFewerTracks(ep, 6), false)
  assert.equal(holdsFewerTracks(unknown, 6), false)
  assert.equal(holdsFewerTracks(single, undefined), false)
  assert.deepEqual(
    orderSearchItems([single, unknown, ep, deluxe], 6).map(
      ({ externalId }) => externalId,
    ),
    ['unknown', 'ep', 'deluxe', 'single'],
  )
  // Without played tracks the provider's order stays.
  assert.deepEqual(orderSearchItems([single, ep], undefined), [single, ep])
  assert.equal(
    describeSearchItem(single, { inLibrary: false, tracksPlayed: 6 }),
    'Example artist · 1 track, fewer than the 6 you played',
  )
  assert.equal(
    describeSearchItem(ep, { inLibrary: true, tracksPlayed: 6 }),
    'Example artist · 2014 · 6 tracks · In library',
  )
  assert.equal(
    describeSearchItem(single, { inLibrary: false }),
    'Example artist · 1 track',
  )
  assert.equal(
    describeSearchItem(unknown, { inLibrary: false, tracksPlayed: 6 }),
    'Example artist',
  )
  const request = mock.method(globalThis, 'fetch', async () =>
    Response.json({
      statusCode: 200,
      message: 'OK',
      data: { items: [single, ep], page: 2, hasMore: false, totalCount: 12 },
    }),
  )
  try {
    const stored = { items: [single, ep], page: 1, hasMore: true }
    // A stored page and a fetched page are both ordered.
    for (const [page, liveSearch] of [
      [1, false],
      [2, true],
    ] satisfies [number, boolean][]) {
      const loaded = await loadManualSearchPage({
        apiBaseUrl: 'http://localhost',
        mediaType: 'album',
        query: 'Example',
        page,
        stored: liveSearch ? { ...stored, totalCount: 12 } : stored,
        liveSearch,
        tracksPlayed: 6,
        signal: new AbortController().signal,
      })
      assert.deepEqual(
        loaded.items.map(({ externalId }) => externalId),
        ['ep', 'single'],
      )
    }
    assert.equal(request.mock.callCount(), 1)
  } finally {
    request.mock.restore()
  }
})
