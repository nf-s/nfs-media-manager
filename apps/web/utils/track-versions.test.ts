import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TrackPartVersionSchema } from '@repo/schemas/track-versions'
import { errorMessage } from '@/components/lastfm-sync'
import {
  albumUnlistedNamesKey,
  changeTrackVersion,
  describeTrackParts,
  loadAlbumUnlistedNames,
  loadTrackParts,
  trackPartAlbum,
  trackPartsKey,
} from './track-versions'

const apiBaseUrl = 'http://localhost:4001'

const version = TrackPartVersionSchema.parse({
  id: 'track 1',
  title: 'Night Drive',
  by: 'Example Artist',
  type: 'spotify',
  album: { id: 'album-1', title: 'Example Album' },
  albumName: 'Example Album (Remaster)',
  durationSec: 200,
  scrobbles: 12,
  shown: true,
})

const change = {
  id: 'change-1',
  kind: 'track',
  action: 'show',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: {
    id: 'track 1',
    title: 'Night Drive',
    by: 'Example Artist',
    exists: true,
  },
  sources: [],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  details: null,
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
}

test('parts and unlisted names live under their record, so its changes refresh them', () => {
  assert.deepEqual(trackPartsKey('track-1'), ['track', 'track-1', 'parts'])
  assert.deepEqual(albumUnlistedNamesKey('album-1'), [
    'album',
    'album-1',
    'unlisted-names',
  ])
})

test('the loaders read the parts and unlisted-names endpoints', async (t) => {
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: url.endsWith('/parts')
        ? {
            shownId: 'track 1',
            stored: true,
            scrobbles: 12,
            versions: [version],
            names: [],
          }
        : { names: [] },
    })
  })
  const parts = await loadTrackParts(apiBaseUrl, 'track 1')
  assert.equal(parts.shownId, 'track 1')
  assert.deepEqual(await loadAlbumUnlistedNames(apiBaseUrl, 'album/1'), {
    names: [],
  })
  assert.deepEqual(urls, [
    `${apiBaseUrl}/api/v1/tracks/track%201/parts`,
    `${apiBaseUrl}/api/v1/albums/album%2F1/unlisted-names`,
  ])
})

test('Shown and Separate post the version and return the change', async (t) => {
  const requests: Array<{ url: string; body: unknown }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return Response.json({ statusCode: 200, message: 'OK', data: change })
    },
  )
  assert.equal(
    (await changeTrackVersion(apiBaseUrl, 'shown', 'track 1')).id,
    'change-1',
  )
  await changeTrackVersion(apiBaseUrl, 'separate', 'track 2')
  assert.deepEqual(requests, [
    {
      url: `${apiBaseUrl}/api/v1/library-changes/track-versions/shown`,
      body: { trackId: 'track 1' },
    },
    {
      url: `${apiBaseUrl}/api/v1/library-changes/track-versions/separate`,
      body: { trackId: 'track 2' },
    },
  ])
})

test("a refused version change reads as the server's sentence", async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { statusCode: 409, message: 'This track has no other versions.' },
      { status: 409 },
    ),
  )
  const failure = await changeTrackVersion(
    apiBaseUrl,
    'separate',
    'track 1',
  ).catch((error: unknown) => error)
  assert.equal(
    errorMessage(failure, 'The version could not be changed.'),
    'This track has no other versions.',
  )
})

test('a part names its library album first, and a record lists what it is made of', () => {
  assert.equal(trackPartAlbum(version), 'Example Album')
  assert.equal(
    trackPartAlbum({ ...version, album: null }),
    'Example Album (Remaster)',
  )
  assert.equal(
    trackPartAlbum({ ...version, album: null, albumName: null }),
    null,
  )
  assert.equal(
    describeTrackParts({ versions: [1, 2], names: [1] }),
    '2 versions · 1 name',
  )
  assert.equal(describeTrackParts({ versions: [1], names: [] }), '1 version')
})
