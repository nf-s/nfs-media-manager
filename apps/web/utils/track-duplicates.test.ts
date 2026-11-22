import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trackMatchDiagnosticsQuery } from './match-diagnostics'
import {
  describeTrackDuplicateGroup,
  describeTrackDuplicateMerge,
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
  merge: {
    keep: { id: `${id}-a`, title: 'Night Drive', by: 'Fixture' },
    versions: 0,
    removed: 1,
    removedRecords: 1,
  },
  offset,
  rowCount: 2,
})

const keep = { id: 'track-a', title: 'Night Drive', by: 'Fixture' }

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

test('what Merge does names the kept track, then the versions and the removed Last.fm records', () => {
  assert.equal(
    describeTrackDuplicateMerge({
      merge: { keep, versions: 0, removed: 1, removedRecords: 1 },
    }),
    'Merge keeps “Night Drive”: 1 Last.fm record is removed and its plays and names move to it',
  )
  assert.equal(
    describeTrackDuplicateMerge({
      merge: { keep, versions: 1, removed: 0, removedRecords: 0 },
    }),
    'Merge keeps “Night Drive”: 1 other track stays under it as a version',
  )
  assert.equal(
    describeTrackDuplicateMerge({
      merge: { keep, versions: 1, removed: 2, removedRecords: 2 },
    }),
    'Merge keeps “Night Drive”: 1 other track stays under it as a version; 2 Last.fm records are removed and their plays and names move to it',
  )
  assert.equal(
    describeTrackDuplicateMerge({
      merge: { keep, versions: 1200, removed: 3400, removedRecords: 3400 },
    }),
    'Merge keeps “Night Drive”: 1,200 other tracks stay under it as versions; 3,400 Last.fm records are removed and their plays and names move to it',
  )
  assert.equal(describeTrackDuplicateMerge({ merge: null }), null)
})

test('a removed track with an album position or playlist entry is not called a Last.fm record', () => {
  assert.equal(
    describeTrackDuplicateMerge({
      merge: { keep, versions: 0, removed: 1, removedRecords: 0 },
    }),
    'Merge keeps “Night Drive”: 1 other track is removed and its plays, names, album positions and playlist entries move to it',
  )
  assert.equal(
    describeTrackDuplicateMerge({
      merge: { keep, versions: 0, removed: 2, removedRecords: 1 },
    }),
    'Merge keeps “Night Drive”: 2 other tracks are removed and their plays, names, album positions and playlist entries move to it',
  )
})

test('a group row says what Merge does, then the evidence', () => {
  const merge = { keep, versions: 0, removed: 1, removedRecords: 1 }
  assert.equal(
    describeTrackDuplicateGroup({
      merge,
      evidence: ['Same title and artist'],
    }),
    'Merge keeps “Night Drive”: 1 Last.fm record is removed and its plays and names move to it · Same title and artist',
  )
  assert.equal(
    describeTrackDuplicateGroup({ merge, evidence: [] }),
    'Merge keeps “Night Drive”: 1 Last.fm record is removed and its plays and names move to it',
  )
  assert.equal(
    describeTrackDuplicateGroup({
      merge: null,
      evidence: ['Same artist', 'Same title'],
    }),
    'Same artist · Same title',
  )
})

test('the notice on an open track names the other tracks, the evidence and what Merge does', () => {
  const others = [
    { id: 'b', title: 'Harbour Lights (Remastered 2011)', by: 'Fixture' },
    { id: 'c', title: 'Harbour Lights', by: '' },
  ]
  assert.equal(
    describeTrackDuplicateNotice({ ...group('group-1', 0), others }),
    'Possible duplicate: “Harbour Lights (Remastered 2011)” by Fixture, “Harbour Lights”. Same title and artist. Merge keeps “Night Drive”: 1 Last.fm record is removed and its plays and names move to it.',
  )
  assert.equal(
    describeTrackDuplicateNotice({
      ...group('group-1', 0),
      merge: { keep, versions: 1, removed: 2, removedRecords: 2 },
      others,
    }),
    'Possible duplicate: “Harbour Lights (Remastered 2011)” by Fixture, “Harbour Lights”. Same title and artist. Merge keeps “Night Drive”: 1 other track stays under it as a version; 2 Last.fm records are removed and their plays and names move to it.',
  )
  assert.equal(
    describeTrackDuplicateNotice({
      ...group('group-1', 0),
      evidence: [],
      others: [{ id: 'b', title: 'Longwave', by: 'Fixture' }],
    }),
    'Possible duplicate: “Longwave” by Fixture. Merge keeps “Night Drive”: 1 Last.fm record is removed and its plays and names move to it.',
  )
  assert.equal(
    describeTrackDuplicateNotice({
      ...group('group-1', 0),
      merge: null,
      others: [{ id: 'b', title: 'Longwave', by: 'Fixture' }],
    }),
    'Possible duplicate: “Longwave” by Fixture. Same title and artist.',
  )
  assert.equal(
    describeTrackDuplicateNotice({
      ...group('group-1', 0),
      evidence: [],
      merge: null,
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
  const query = trackMatchDiagnosticsQuery(
    new URLSearchParams({
      q: 'harbour',
      duplicates: 'true',
      sortBy: 'scrobbles',
      direction: 'desc',
      creatorId: 'artist-1',
    }),
  )
  const layout = await loadTrackDuplicateLayout('http://api', query)
  assert.equal(layout.groups[0]?.offset, 0)
  await loadTrackDuplicates('http://api', 'track/a')
  const kept = await keepTracksSeparate('http://api', ['track-a', 'track-b'])
  assert.equal(kept.action, 'keep-separate')
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      'http://api/api/v1/tracks/duplicates/count',
      'http://api/api/v1/tracks/duplicates/count?creatorId=artist-1',
      'http://api/api/v1/tracks/duplicates/layout?sortBy=scrobbles&direction=desc&q=harbour&creatorId=artist-1&duplicates=true',
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
