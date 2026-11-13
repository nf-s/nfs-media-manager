import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { LastfmSyncStatusSchema } from '@repo/schemas/lastfm'
import type { ManualMediaSearchItem } from '@repo/schemas/manual-add'
import { addAndLinkLastfmAlbum } from './lastfm-album-add'

const source = { artistName: 'Example artist', albumName: 'Example album' }
const item: ManualMediaSearchItem = {
  externalId: '1234567890123456789012',
  title: source.albumName,
  subtitle: source.artistName,
  releaseDate: null,
  artworkUrl: null,
  url: 'https://open.spotify.com/album/1234567890123456789012',
  mediaItemId: null,
}
const status = LastfmSyncStatusSchema.parse({
  configured: true,
  state: 'complete',
  schedule: 'off',
  nextScheduledAt: null,
  pagesFetched: 1,
  totalPages: 1,
  newScrobbles: 1,
  storedScrobbles: 1,
  matchedScrobbles: 1,
  startedAt: null,
  lastCompletedAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
})

function ok(data: unknown) {
  return Response.json({ statusCode: 200, message: 'OK', data })
}

test('a deleted cached album is resolved only on the next explicit retry', async () => {
  const identities = new Map<string, string | null>([
    [item.externalId, 'deleted-album'],
  ])
  const calls: string[] = []
  const request = mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(`${url} ${String(init?.body)}`)
      if (calls.length === 1)
        return Response.json(
          { statusCode: 404, message: 'Album not found' },
          { status: 404 },
        )
      if (calls.length === 2)
        return ok({ mediaItemId: 'replacement-album', created: false })
      return ok(status)
    },
  )
  const save = () =>
    addAndLinkLastfmAlbum({
      apiBaseUrl: 'http://localhost',
      source,
      item: { ...item, mediaItemId: 'stale-search-album' },
      identities,
    })
  try {
    await assert.rejects(save(), { message: 'Album not found' })
    assert.equal(calls.length, 1)
    assert.equal(identities.get(item.externalId), null)
    await save()
    assert.match(calls[0] ?? '', /lastfm\/links .*"albumId":"deleted-album"/)
    assert.match(
      calls[1] ?? '',
      /manual-add\/add .*"externalId":"1234567890123456789012"/,
    )
    assert.match(
      calls[2] ?? '',
      /lastfm\/links .*"albumId":"replacement-album"/,
    )
    assert.equal(identities.get(item.externalId), 'replacement-album')
    assert.equal(calls.length, 3)
  } finally {
    request.mock.restore()
  }
})

test('a transient link failure retains a created album and retry does not add again', async () => {
  const identities = new Map<string, string | null>()
  const calls: string[] = []
  const request = mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0]) => {
      calls.push(String(url))
      if (calls.length === 1)
        return ok({ mediaItemId: 'created-album', created: true })
      if (calls.length === 2)
        return Response.json(
          { statusCode: 500, message: 'Link failed' },
          { status: 500 },
        )
      return ok(status)
    },
  )
  const save = () =>
    addAndLinkLastfmAlbum({
      apiBaseUrl: 'http://localhost',
      source,
      item,
      identities,
    })
  try {
    await assert.rejects(save(), { message: 'Link failed' })
    assert.equal(identities.get(item.externalId), 'created-album')
    await save()
    assert.deepEqual(calls, [
      'http://localhost/api/v1/manual-add/add',
      'http://localhost/api/v1/lastfm/links',
      'http://localhost/api/v1/lastfm/links',
    ])
  } finally {
    request.mock.restore()
  }
})

test('a missing scrobble source does not discard the existing album identity', async () => {
  const identities = new Map<string, string | null>()
  const request = mock.method(
    globalThis,
    'fetch',
    async (url: Parameters<typeof fetch>[0]) => {
      assert.equal(url, 'http://localhost/api/v1/lastfm/links')
      return Response.json(
        {
          statusCode: 404,
          message: 'No scrobbles have this artist and album name.',
        },
        { status: 404 },
      )
    },
  )
  try {
    await assert.rejects(
      addAndLinkLastfmAlbum({
        apiBaseUrl: 'http://localhost',
        source,
        item: { ...item, mediaItemId: 'existing-album' },
        identities,
      }),
      { message: 'No scrobbles have this artist and album name.' },
    )
    assert.equal(identities.get(item.externalId), 'existing-album')
    assert.equal(request.mock.callCount(), 1)
  } finally {
    request.mock.restore()
  }
})
