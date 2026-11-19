import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detailCrumbKey,
  detailCrumbTrail,
  detailEntries,
  detailEntryParams,
  detailPageHref,
  detailTab,
  parseTagDetailId,
  tagDetailId,
  userDetailId,
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

test('User uses one inspector entry and keeps a standalone scoped page', () => {
  const workspace = new URLSearchParams({ view: 'table', q: 'Fixture' })
  const user: DetailEntry = { kind: 'user', id: userDetailId }
  const url = detailEntryParams('/tracks', workspace, [user])
  assert.deepEqual(detailEntries('/tracks', url), [user])
  assert.deepEqual(withoutDetailEntries('/tracks', url), workspace)
  assert.equal(
    detailPageHref(user, new URLSearchParams({ mediaType: 'track' })),
    '/user?mediaType=track',
  )
  assert.deepEqual(
    detailEntries(
      '/tracks',
      detailEntryParams('/tracks', workspace, [{ ...user, id: 'invalid' }]),
    ),
    [],
  )
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

test('legacy film history links preserve the detail tab and browse filters', () => {
  const params = new URLSearchParams({
    item: 'film-1',
    tab: 'history',
    q: 'Fixture',
  })
  assert.deepEqual(detailEntries('/films', params), [
    { kind: 'film', id: 'film-1', view: 'tab=history' },
  ])
  assert.deepEqual(
    withoutDetailEntries('/films', params),
    new URLSearchParams({ q: 'Fixture' }),
  )
})

test('legacy job links open details without consuming the job table filters', () => {
  const params = new URLSearchParams({
    jobId: 'job-1',
    tab: 'logs',
    mediaType: 'album',
    provider: 'spotify',
    statuses: '["failed"]',
    sortBy: 'createdAt',
  })
  const entries = [{ kind: 'job', id: 'job-1', view: 'tab=logs' }]
  assert.deepEqual(detailEntries('/jobs', params), entries)
  const workspace = withoutDetailEntries('/jobs', params)
  assert.equal(workspace.has('jobId'), false)
  assert.equal(workspace.has('tab'), false)
  assert.equal(workspace.get('mediaType'), 'album')
  assert.equal(workspace.get('provider'), 'spotify')
  assert.equal(workspace.get('statuses'), '["failed"]')
  assert.equal(workspace.get('sortBy'), 'createdAt')
  assert.equal(
    detailPageHref(
      { kind: 'job', id: 'job/1' },
      new URLSearchParams({ tab: 'data' }),
    ),
    '/jobs/job%2F1?tab=data',
  )
})

test('job, retry and item navigation retain each parent view in the inspector stack', () => {
  const workspace = new URLSearchParams({ q: 'Fixture', view: 'table' })
  const entries: DetailEntry[] = [
    {
      kind: 'album',
      id: 'album-1',
      view: 'tab=sources&jobsSortBy=status&jobsDirection=asc',
    },
    { kind: 'job', id: 'job-1', view: 'tab=logs' },
    { kind: 'job', id: 'retry-1', view: 'tab=data' },
    { kind: 'artist', id: 'artist-1' },
  ]
  const params = detailEntryParams('/albums', workspace, entries)
  assert.deepEqual(
    detailEntries('/albums', new URLSearchParams(params)),
    entries,
  )
  const back = detailEntryParams('/albums', params, entries.slice(0, -1))
  assert.deepEqual(detailEntries('/albums', back), entries.slice(0, -1))
  assert.deepEqual(withoutDetailEntries('/albums', back), workspace)
})

test('tags open in the drawer with their library and a Tags page link', () => {
  const tag: DetailEntry = { kind: 'tag', id: tagDetailId('film', 'tag:7') }
  assert.deepEqual(parseTagDetailId(tag.id), { mediaType: 'film', id: 'tag:7' })
  assert.equal(parseTagDetailId('track:tag-1'), null)
  assert.equal(parseTagDetailId('album:'), null)
  const url = detailEntryParams('/albums', new URLSearchParams(), [tag])
  assert.deepEqual(detailEntries('/albums', url), [tag])
  assert.deepEqual(
    detailEntries(
      '/albums',
      detailEntryParams('/albums', new URLSearchParams(), [
        { kind: 'tag', id: 'unknown-tag' },
      ]),
    ),
    [],
  )
  const page = new URL(detailPageHref(tag), 'http://localhost')
  assert.equal(page.pathname, '/tags')
  assert.equal(page.searchParams.get('mediaType'), 'film')
  assert.equal(page.searchParams.get('tag'), 'tag:7')
})

test('detail tabs fall back to the first tab and map older tab values', () => {
  const tabs: readonly ['overview', 'listening', 'sources'] = [
    'overview',
    'listening',
    'sources',
  ]
  const aliases = { tracks: 'overview', history: 'sources' } satisfies Record<
    string,
    'overview' | 'sources'
  >
  assert.equal(detailTab(null, tabs, aliases), 'overview')
  assert.equal(detailTab('listening', tabs, aliases), 'listening')
  assert.equal(detailTab('history', tabs, aliases), 'sources')
  assert.equal(detailTab('tracks', tabs, aliases), 'overview')
  assert.equal(detailTab('unknown', tabs, aliases), 'overview')
})

test('drawer breadcrumbs start at the library and name each item once loaded', () => {
  const album: DetailEntry = { kind: 'album', id: 'album-1' }
  const path: DetailEntry[] = [
    album,
    { kind: 'track', id: 'track-1' },
    { kind: 'artist', id: 'artist-1' },
  ]
  const crumbs = new Map([[detailCrumbKey(album), { title: 'Fixture album' }]])
  assert.deepEqual(detailCrumbTrail('/albums', path, crumbs), [
    { label: 'Albums', to: 'library' },
    { label: 'Fixture album', to: 'entry', index: 0 },
    { label: 'Track', to: 'entry', index: 1 },
    { label: 'Artist', to: 'current' },
  ])
  assert.deepEqual(
    detailCrumbTrail(
      '/subscriptions/channels',
      [{ kind: 'channel', id: 'c' }],
      new Map(),
    ),
    [
      { label: 'Channels', to: 'library' },
      { label: 'Channel', to: 'current' },
    ],
  )
  assert.deepEqual(detailCrumbTrail('/albums', [], new Map()), [])
})

test('the library crumb closes the drawer only over that library, and otherwise links to it', () => {
  const artist: DetailEntry[] = [{ kind: 'artist', id: 'artist-1' }]
  assert.deepEqual(detailCrumbTrail('/artists', artist, new Map())[0], {
    label: 'Artists',
    to: 'library',
  })
  // On an album's page the crumb leads to Albums, not back to the album.
  assert.deepEqual(detailCrumbTrail('/albums/album-1', artist, new Map())[0], {
    label: 'Albums',
    to: 'href',
    href: '/albums',
  })
  assert.deepEqual(
    detailCrumbTrail('/subscriptions/channels/x', artist, new Map())[0],
    { label: 'Channels', to: 'href', href: '/subscriptions/channels' },
  )
  // Outside the libraries the root item's library is named and linked.
  assert.deepEqual(
    detailCrumbTrail('/', [{ kind: 'person', id: 'p' }], new Map())[0],
    { label: 'People', to: 'href', href: '/people' },
  )
  assert.deepEqual(
    detailCrumbTrail('/', [{ kind: 'channel', id: 'c' }], new Map())[0],
    { label: 'Channels', to: 'href', href: '/subscriptions/channels' },
  )
  assert.deepEqual(
    detailCrumbTrail('/', [{ kind: 'user', id: 'me' }], new Map())[0],
    { label: 'Account', to: 'href', href: '/user' },
  )
})

test('a job in a batch shows the batch before the job', () => {
  const job: DetailEntry = { kind: 'job', id: 'job-1' }
  assert.deepEqual(
    detailCrumbTrail(
      '/jobs',
      [job],
      new Map([
        [
          detailCrumbKey(job),
          { title: 'Fetch rating', batchHref: '/jobs?batchId=batch-1' },
        ],
      ]),
    ),
    [
      { label: 'Jobs', to: 'library' },
      { label: 'Batch', to: 'href', href: '/jobs?batchId=batch-1' },
      { label: 'Fetch rating', to: 'current' },
    ],
  )
})

test('mixes and shows open in the inspector with their own library pages', () => {
  const mix: DetailEntry = { kind: 'mix', id: 'nts.example-mix' }
  const show: DetailEntry = { kind: 'show', id: 'nts.example-show' }
  assert.equal(detailPageHref(mix), '/mixes/nts.example-mix')
  assert.equal(detailPageHref(show), '/mixes/shows/nts.example-show')
  assert.equal(
    detailPageHref(mix, new URLSearchParams({ q: 'late' })),
    '/mixes/nts.example-mix?q=late',
  )
  // A Browse link that names an item opens it as a mix.
  assert.deepEqual(
    detailEntries('/mixes', new URLSearchParams({ item: 'nts.example-mix' })),
    [mix],
  )
  assert.deepEqual(detailCrumbTrail('/mixes', [mix, show], new Map()), [
    { label: 'Mixes', to: 'library' },
    { label: 'Mix', to: 'entry', index: 0 },
    { label: 'Show', to: 'current' },
  ])
  assert.deepEqual(detailCrumbTrail('/mixes/shows', [show], new Map())[0], {
    label: 'Shows',
    to: 'library',
  })
  assert.deepEqual(detailCrumbTrail('/', [show], new Map())[0], {
    label: 'Shows',
    to: 'href',
    href: '/mixes/shows',
  })
  assert.deepEqual(detailCrumbTrail('/', [mix], new Map())[0], {
    label: 'Mixes',
    to: 'href',
    href: '/mixes',
  })
  // Subscriptions keeps its kinds and pages.
  assert.equal(detailPageHref({ kind: 'channel', id: 'c' }), '/channels/c')
  assert.equal(
    detailPageHref({ kind: 'subscription', id: 's' }),
    '/subscriptions/s',
  )
})
