import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { LibraryChange } from '@repo/schemas/library-changes'
import {
  describeLibraryChange,
  describeLibraryChangeNote,
  describeMergeCaution,
  invalidateLibraryRecords,
  libraryChangeBlock,
  libraryChangeRule,
  libraryChangeRuleLabels,
} from './library-changes'

const record = (id: string, title: string) => ({
  id,
  title,
  by: 'Fixture Artist',
  exists: true,
})
const change: LibraryChange = {
  id: 'change-1',
  kind: 'track',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: record('kept', 'Night Drive'),
  sources: [record('merged', 'Nite Drive')],
  names: [
    { artistName: 'Fixture Artist', trackName: 'Nite Drive', scrobbles: 2 },
  ],
  nameCount: 1,
  scrobbles: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
  details: null,
}

test('a change is described by its action, the names it moved and its records', () => {
  assert.equal(
    describeLibraryChange(change),
    'Merged “Nite Drive” into “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      sources: [record('a', 'Nite Drive'), record('b', 'Night Drive (Demo)')],
    }),
    'Merged 2 tracks into “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({ ...change, action: 'move' }),
    'Moved “Nite Drive” to “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({ ...change, action: 'move', nameCount: 1200 }),
    'Moved 1,200 names to “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      action: 'separate',
      target: record('merged', 'Nite Drive'),
      sources: [record('kept', 'Night Drive')],
    }),
    'Separated “Nite Drive” from “Night Drive”',
  )
  assert.equal(
    describeLibraryChange({ ...change, action: 'rematch' }),
    'Returned “Nite Drive” to automatic matching',
  )
})

test('album and artist changes name their records by kind', () => {
  const album: LibraryChange = {
    ...change,
    kind: 'album',
    target: record('album-1', 'Night Cities'),
    sources: [record('album-2', 'Night Cities (Deluxe)')],
    names: [],
    nameCount: 0,
  }
  assert.equal(
    describeLibraryChange(album),
    'Merged “Night Cities (Deluxe)” into “Night Cities”',
  )
  assert.equal(
    describeLibraryChange({
      ...album,
      sources: [
        record('a', 'Night Cities (Deluxe)'),
        record('b', 'Night Cities EP'),
      ],
    }),
    'Merged 2 albums into “Night Cities”',
  )
  assert.equal(
    describeLibraryChange({
      ...album,
      kind: 'artist',
      target: record('artist-1', 'Ferro and Lane'),
      sources: [
        record('a', 'Ferro & Lane'),
        record('b', 'Ferro + Lane'),
        record('c', 'Ferro Lane'),
      ],
    }),
    'Merged 3 artists into “Ferro and Lane”',
  )
})

test('a move or separation with no scrobbled names says what it moved from its details', () => {
  const parts: LibraryChange = { ...change, names: [], nameCount: 0 }
  assert.equal(
    describeLibraryChange({
      ...parts,
      kind: 'album',
      action: 'move',
      target: record('album-1', 'Night Cities'),
      details: {
        counts: { 'album-name': 1 },
        labels: ['Night Cities (Remaster)'],
      },
    }),
    'Moved “Night Cities (Remaster)” to “Night Cities”',
  )
  const separated: LibraryChange = {
    ...parts,
    action: 'separate',
    sources: [record('kept', 'Night Drive')],
    details: {
      counts: { version: 2 },
      labels: ['Night Drive (Live)', 'Night Drive (Demo)'],
    },
  }
  assert.equal(
    describeLibraryChange(separated),
    'Separated 2 versions from “Night Drive”',
  )
  // The counts are on the line; the sub line gives their names.
  assert.equal(
    describeLibraryChangeNote(separated),
    '“Night Drive (Live)”, “Night Drive (Demo)”',
  )
  assert.equal(
    describeLibraryChangeNote({
      ...separated,
      details: { counts: { version: 1 }, labels: ['Night Drive (Live)'] },
    }),
    '',
  )
  // Without details, the names count as before.
  assert.equal(
    describeLibraryChange({ ...parts, action: 'move' }),
    'Moved 0 names to “Night Drive”',
  )
})

test('Keep separate lists the records and Shown names the version picked', () => {
  assert.equal(
    describeLibraryChange({
      ...change,
      action: 'keep-separate',
      target: null,
      sources: [record('a', 'Night Drive'), record('b', 'Night Drive (Live)')],
    }),
    'Kept 2 tracks separate: “Night Drive”, “Night Drive (Live)”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      kind: 'album',
      action: 'keep-separate',
      target: null,
      sources: [
        record('a', 'Night Cities'),
        record('b', 'Night Cities (Live)'),
      ],
    }),
    'Kept 2 albums separate: “Night Cities”, “Night Cities (Live)”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      action: 'show',
      target: record('v', 'Night Drive (2019 Remaster)'),
      sources: [],
    }),
    'Shown as “Night Drive (2019 Remaster)”',
  )
  assert.equal(
    describeLibraryChange({
      ...change,
      kind: 'album',
      action: 'show',
      target: null,
      sources: [],
    }),
    'Changed the edition shown',
  )
})

test('each automatic rule has a label, and an unknown code is shown as it is', () => {
  for (const code of [
    'lastfm-exact-name',
    'lastfm-album-alias',
    'lastfm-accepted-search',
    'lastfm-unmatched',
    'spotify-search',
    'album-alias',
    'album-history',
  ])
    assert.ok(libraryChangeRuleLabels.get(code), code)
  assert.equal(libraryChangeRule('lastfm-exact-name'), 'Same title and artist')
  assert.equal(libraryChangeRule('spotify-search'), 'Spotify track search')
  assert.equal(libraryChangeRule('new-rule'), 'new-rule')
  assert.equal(libraryChangeRule('constructor'), 'constructor')
})

test('the sub line gives the rule, what else moved, the remembered undo and the reason', () => {
  const automatic: LibraryChange = {
    ...change,
    actor: 'automatic',
    rule: 'lastfm-exact-name',
    batchId: 'run-1',
  }
  assert.equal(
    describeLibraryChangeNote(automatic),
    'Fixture Artist · Nite Drive. Same title and artist',
  )
  // Two Spotify tracks moved no scrobbled names: the details say what moved.
  assert.equal(
    describeLibraryChangeNote({
      ...change,
      names: [],
      nameCount: 0,
      details: { counts: { version: 1 } },
    }),
    'Also merged 1 version',
  )
  assert.equal(
    describeLibraryChangeNote({
      ...change,
      details: { counts: { position: 2, 'playlist-entry': 1 } },
    }),
    'Fixture Artist · Nite Drive. Also merged 2 album positions and 1 playlist entry',
  )
  assert.equal(
    describeLibraryChangeNote({
      ...change,
      action: 'move',
      details: { labels: ['Night Drive (Live)'] },
    }),
    'Fixture Artist · Nite Drive. Also moved “Night Drive (Live)”',
  )
  const undone: LibraryChange = {
    ...automatic,
    undoneAt: '2024-01-02T00:00:00.000Z',
    canUndo: false,
    canRedo: true,
  }
  assert.equal(
    describeLibraryChangeNote(undone),
    'Fixture Artist · Nite Drive. Same title and artist. Will not be merged automatically again',
  )
  assert.equal(
    describeLibraryChangeNote({ ...undone, actor: 'owner', rule: null }),
    'Fixture Artist · Nite Drive',
  )
  assert.equal(
    describeLibraryChangeNote({
      ...undone,
      canRedo: false,
      blocked: 'A track in this change is no longer in the library.',
    }),
    'Fixture Artist · Nite Drive. Same title and artist. Will not be merged automatically again. A track in this change is no longer in the library',
  )
})

test('undo is offered only while the names are where the change put them', () => {
  assert.equal(libraryChangeBlock(change), null)
  assert.equal(
    libraryChangeBlock({ ...change, canUndo: false }),
    'A later change moved these names. Undo that change first.',
  )
  assert.equal(
    libraryChangeBlock({
      ...change,
      undoneAt: '2024-01-02T00:00:00.000Z',
      canUndo: false,
      canRedo: true,
    }),
    null,
  )
  assert.match(
    libraryChangeBlock({ ...change, reversible: false, canUndo: false }) ?? '',
    /cannot be undone/,
  )
})

test('the server’s reason for refusing Undo or Redo is shown as it is', () => {
  const reason = 'A later change moved these versions. Undo that change first.'
  assert.equal(
    libraryChangeBlock({ ...change, canUndo: false, blocked: reason }),
    reason,
  )
  assert.equal(
    libraryChangeBlock({
      ...change,
      reversible: false,
      canUndo: false,
      blocked: 'This change cannot be undone.',
    }),
    'This change cannot be undone.',
  )
  assert.equal(
    libraryChangeBlock({
      ...change,
      undoneAt: '2024-01-02T00:00:00.000Z',
      canUndo: false,
      canRedo: false,
      blocked: reason,
    }),
    reason,
  )
})

async function refreshed(kind: 'album' | 'artist', removedIds: string[]) {
  const client = new QueryClient()
  const keys = [
    ['library-changes', { kind }],
    ['albums', 'browse', 1],
    ['album', 'album-1'],
    ['album', 'album-2'],
    ['artists', 'browse', 1],
    ['artist', 'artist-1'],
    ['artist', 'artist-2'],
    ['artist-overview', '/api/v1/artists/artist-1', 'albums', 'page=1'],
    ['tracks', 'browse', 1],
    ['track', 'track-1'],
    ['jobs'],
    ['tags'],
  ]
  const fetched: string[] = []
  const subscriptions = keys.map((queryKey) => {
    client.setQueryData(queryKey, 'stored')
    return new QueryObserver(client, {
      queryKey,
      queryFn: async () => {
        fetched.push(JSON.stringify(queryKey))
        return 'fresh'
      },
      staleTime: Infinity,
    }).subscribe(() => {})
  })
  try {
    await invalidateLibraryRecords(client, kind, removedIds)
    return {
      fetched: fetched.sort(),
      /** Marked stale without being fetched again. */
      stale: keys
        .filter((queryKey) => client.getQueryState(queryKey)?.isInvalidated)
        .map((queryKey) => JSON.stringify(queryKey)),
    }
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe()
    client.clear()
  }
}

test('undoing an album or artist change refreshes the libraries and lists it affects', async () => {
  const library = (kind: string, removed: string) =>
    [
      `["library-changes",{"kind":"${kind}"}]`,
      '["albums","browse",1]',
      '["album","album-1"]',
      '["album","album-2"]',
      '["artists","browse",1]',
      '["artist","artist-1"]',
      '["artist","artist-2"]',
      '["artist-overview","/api/v1/artists/artist-1","albums","page=1"]',
      '["tracks","browse",1]',
      '["track","track-1"]',
    ]
      .filter((key) => key !== removed)
      .sort()
  // A record the change removed is marked stale but not fetched again; Jobs
  // and Tags are left alone.
  assert.deepEqual(await refreshed('album', ['album-2']), {
    fetched: library('album', '["album","album-2"]'),
    stale: ['["album","album-2"]'],
  })
  assert.deepEqual(await refreshed('artist', ['artist-2']), {
    fetched: library('artist', '["artist","artist-2"]'),
    stale: ['["artist","artist-2"]'],
  })
  assert.deepEqual(await refreshed('artist', []), {
    fetched: library('artist', ''),
    stale: [],
  })
})

test('each caution reads as one sentence', () => {
  assert.equal(
    describeMergeCaution({ code: 'version', words: ['Demo'] }),
    '“Demo” is in some titles only.',
  )
  assert.equal(
    describeMergeCaution({ code: 'version', words: ['Live', 'Demo'] }),
    '“Live” and “Demo” are in some titles only.',
  )
  assert.equal(
    describeMergeCaution({ code: 'duration', seconds: 60 }),
    'Lengths differ by 1:00.',
  )
  assert.equal(
    describeMergeCaution({
      code: 'artists',
      names: ['Fixture Artist', 'Other Band'],
    }),
    'The artists differ: Fixture Artist, Other Band.',
  )
})
