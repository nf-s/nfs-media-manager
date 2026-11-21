import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addRowHeights,
  describeTrackDuplicateNotice,
  formatTrackDuplicateEvidence,
  keepTracksSeparate,
  loadTrackDuplicateCount,
  loadTrackDuplicateLayout,
  loadTrackDuplicates,
  trackDuplicateRows,
} from './track-duplicates'

const group = (id: string, offset: number) => ({
  id,
  rule: 'key' as const,
  evidence: ['Same title and artist'],
  cautions: [],
  memberCount: 2,
  scrobbles: 4,
  memberIds: [`${id}-a`, `${id}-b`],
  offset,
  rowCount: 2,
})

const change = {
  id: 'change-1',
  kind: 'track',
  action: 'keep-separate',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: null,
  sources: [
    { id: 'track-a', title: 'Harbour Lights', by: 'Fixture', exists: true },
    { id: 'track-b', title: 'Harbour Lights', by: 'Fixture', exists: true },
  ],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
  details: null,
}

test('the evidence of a group reads as one line', () => {
  assert.equal(
    formatTrackDuplicateEvidence({
      evidence: ['Same artist', 'Same title without “Remastered 2011”'],
    }),
    'Same artist · Same title without “Remastered 2011”',
  )
  assert.equal(formatTrackDuplicateEvidence({ evidence: [] }), '')
})

test('the notice on an open track names the other tracks and the evidence', () => {
  assert.equal(
    describeTrackDuplicateNotice({
      ...group('group-1', 0),
      others: [
        { id: 'b', title: 'Harbour Lights (Remastered 2011)', by: 'Fixture' },
        { id: 'c', title: 'Harbour Lights', by: '' },
      ],
    }),
    'Possible duplicate: “Harbour Lights (Remastered 2011)” by Fixture, “Harbour Lights”. Same title and artist',
  )
  assert.equal(
    describeTrackDuplicateNotice({
      ...group('group-1', 0),
      evidence: [],
      others: [{ id: 'b', title: 'Longwave', by: 'Fixture' }],
    }),
    'Possible duplicate: “Longwave” by Fixture.',
  )
})

test('group rows add their height above their first row: in the header for the first row, below the row before otherwise', () => {
  const rows = trackDuplicateRows(
    [group('late', 7), group('first', 0), group('next', 3)],
    28,
  )
  assert.equal(rows.count, 3)
  assert.equal(rows.leading?.id, 'first')
  assert.equal(rows.leadingHeight, 28)
  assert.deepEqual(
    [...rows.heights],
    [
      [2, 28],
      [6, 28],
    ],
  )
  assert.equal(rows.above(3)?.id, 'next')
  assert.equal(rows.above(4), undefined)
  // Group rows at or above each table row.
  assert.deepEqual(
    [0, 1, 2, 3, 6, 7, 100].map((index) => rows.through(index)),
    [1, 1, 1, 2, 2, 3, 3],
  )
  const none = trackDuplicateRows([], 28)
  assert.equal(none.leading, undefined)
  assert.equal(none.leadingHeight, 0)
  assert.equal(none.heights.size, 0)
  assert.equal(none.through(10), 0)
})

test('heights below the same row add up, and no heights is none', () => {
  assert.deepEqual(
    [
      ...(addRowHeights(
        new Map([[2, 96]]),
        new Map([
          [2, 28],
          [5, 28],
        ]),
      ) ?? []),
    ],
    [
      [2, 124],
      [5, 28],
    ],
  )
  assert.equal(addRowHeights(undefined, new Map()), undefined)
})

test('the loaders read the count, layout and track groups, and Keep separate posts the tracks', async (t) => {
  const requests: { url: string; init?: RequestInit }[] = []
  const responses = [
    { count: 3, ready: true },
    { count: 1, ready: true },
    { totalRows: 2, groups: [group('group-1', 0)] },
    { items: [] },
    change,
  ]
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: responses[requests.length - 1],
      })
    },
  )
  assert.deepEqual(await loadTrackDuplicateCount('http://api'), {
    count: 3,
    ready: true,
  })
  await loadTrackDuplicateCount('http://api', 'artist-1')
  const params = new URLSearchParams({ q: 'harbour', duplicates: 'true' })
  const layout = await loadTrackDuplicateLayout('http://api', params)
  assert.equal(layout.groups[0]?.offset, 0)
  await loadTrackDuplicates('http://api', 'track/a')
  const kept = await keepTracksSeparate('http://api', ['track-a', 'track-b'])
  assert.equal(kept.action, 'keep-separate')
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      'http://api/api/v1/tracks/duplicates/count',
      'http://api/api/v1/tracks/duplicates/count?creatorId=artist-1',
      'http://api/api/v1/tracks/duplicates/layout?q=harbour&duplicates=true',
      'http://api/api/v1/tracks/track%2Fa/duplicates',
      'http://api/api/v1/library-changes/track-separations',
    ],
  )
  assert.equal(requests[4]?.init?.method, 'POST')
  assert.equal(
    requests[4]?.init?.body,
    JSON.stringify({ trackIds: ['track-a', 'track-b'] }),
  )
})
