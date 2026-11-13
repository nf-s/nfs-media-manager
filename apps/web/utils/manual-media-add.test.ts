import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ManualMediaSearchItem } from '@repo/schemas/manual-add'
import { addManualMediaItem } from './manual-media-add'

const item: ManualMediaSearchItem = {
  externalId: '1234567890123456789012',
  title: 'Example album',
  subtitle: 'Example artist',
  releaseDate: null,
  artworkUrl: null,
  url: 'https://open.spotify.com/album/1234567890123456789012',
  mediaItemId: null,
}

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

test('a selected result adds only its provider identity and retains the returned album', async () => {
  const request = mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(url, 'http://localhost/api/v1/manual-add/add')
      assert.equal(init?.method, 'POST')
      assert.equal(
        init?.body,
        JSON.stringify({ mediaType: 'album', externalId: item.externalId }),
      )
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: { mediaItemId: 'created-album', created: true },
      })
    },
  )
  try {
    const id = await addManualMediaItem('http://localhost', 'album', item)
    assert.equal(id, 'created-album')
    assert.equal(
      await addManualMediaItem('http://localhost', 'album', {
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
