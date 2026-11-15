import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detailEntries,
  detailEntryParams,
  detailPageHref,
  withoutDetailEntries,
  type DetailEntry,
} from './detail-inspector'

test('cross-kind stacks preserve workspace parameters and each view when copied or reloaded', () => {
  const workspace = new URLSearchParams({
    q: 'Fixture album',
    view: 'grid',
    sortBy: 'title',
    tab: 'existing workspace tab',
  })
  const stack: DetailEntry[] = [
    { kind: 'album', id: 'album-1', view: 'tab=tracks&albumTrackView=fixture' },
    { kind: 'playlist', id: 'playlist-1', view: 'tab=sync' },
    { kind: 'track', id: 'track-1', view: 'tab=listening' },
  ]
  const linked = detailEntryParams('/albums', workspace, stack)
  assert.deepEqual(
    detailEntries('/albums', new URLSearchParams(linked.toString())),
    stack,
  )
  assert.deepEqual(withoutDetailEntries('/albums', linked), workspace)
  const back = detailEntryParams('/albums', linked, stack.slice(0, -1))
  assert.deepEqual(detailEntries('/albums', back), stack.slice(0, -1))
  assert.equal(back.get('tab'), 'existing workspace tab')
})

test('existing inspector links normalize without losing tabs or filters', () => {
  const legacy = new URLSearchParams({
    item: 'replaced-track',
    playlist: 'playlist-1',
    tab: 'sync',
    q: 'original filter',
    playlistView: 'saved',
  })
  const entries = detailEntries('/tracks', legacy)
  assert.deepEqual(entries, [
    { kind: 'playlist', id: 'playlist-1', view: 'tab=sync&playlistView=saved' },
  ])
  assert.deepEqual(
    withoutDetailEntries('/tracks', legacy),
    new URLSearchParams({ q: 'original filter' }),
  )
  assert.deepEqual(
    detailEntries('/tracks', detailEntryParams('/tracks', legacy, entries)),
    entries,
  )
})

test('invalid inspector state falls back to the legacy detail or original workspace', () => {
  assert.deepEqual(
    detailEntries(
      '/films',
      new URLSearchParams({ inspect: '{"kind":"other"}', item: 'film-1' }),
    ),
    [{ kind: 'film', id: 'film-1' }],
  )
  assert.deepEqual(
    detailEntries(
      '/jobs',
      new URLSearchParams({ inspect: '[broken', item: 'unrelated' }),
    ),
    [],
  )
  assert.equal(
    detailPageHref(
      { kind: 'playlist', id: 'playlist/1' },
      new URLSearchParams({ tab: 'sync' }),
    ),
    '/playlists/playlist%2F1?tab=sync',
  )
})
