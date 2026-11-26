import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import {
  LibraryChangeSchema,
  type LibraryChange,
  type LibraryChangeKind,
} from '@repo/schemas/library-changes'
import { libraryChangesKey } from '@/utils/library-changes'
import LibraryChanges, {
  LibraryChangeRow,
  LibraryRecordChanges,
  libraryChangesPaths,
} from './library-changes'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const record = (id: string, title: string, exists = true) => ({
  id,
  title,
  by: 'Example Artist',
  exists,
})

const merge = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'track',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: record('track-1', 'Night Drive'),
  sources: [record('track-2', 'Nite Drive', false)],
  names: [
    { artistName: 'Example Artist', trackName: 'Nite Drive', scrobbles: 12 },
  ],
  nameCount: 1,
  scrobbles: 1234,
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
  details: null,
})

const albumMerge = LibraryChangeSchema.parse({
  ...merge,
  id: 'change-2',
  kind: 'album',
  actor: 'automatic',
  rule: 'album-alias',
  batchId: 'run-1',
  target: record('album-1', 'Night Cities'),
  sources: [record('album-2', 'Night Cities (Deluxe)')],
  names: [],
  nameCount: 0,
  scrobbles: 40,
  details: {
    counts: { edition: 1, 'album-name': 2, title: 14 },
    labels: ['Night Cities (Deluxe)', 'Night Cities - EP'],
  },
})

const artistMerge = LibraryChangeSchema.parse({
  ...merge,
  id: 'change-3',
  kind: 'artist',
  target: record('artist-1', 'Ferro and Lane'),
  sources: [record('artist-2', 'Ferro & Lane', false)],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  details: {
    counts: { credit: 9, 'artist-name': 1 },
    labels: ['Ferro & Lane'],
  },
})

const columns = ['when', 'change', 'by', 'scrobbles']

function Providers({
  client,
  search = '',
  path = '/tracks/changes',
  children,
}: {
  client: QueryClient
  search?: string
  path?: string
  children: ReactNode
}) {
  return (
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{
          appUrl: 'http://localhost:3001',
          apiBaseUrl: 'http://localhost:4001',
        }}
      >
        <PathnameContext.Provider value={path}>
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            {children}
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </ConfigContext.Provider>
    </QueryClientProvider>
  )
}

function renderWith(
  children: ReactNode,
  prepare?: (client: QueryClient) => void,
  search = '',
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  prepare?.(client)
  try {
    return renderToStaticMarkup(
      <Providers client={client} search={search}>
        {children}
      </Providers>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function render(change: LibraryChange) {
  return renderWith(
    <table>
      <tbody>
        <LibraryChangeRow change={change} columns={columns} index={0} />
      </tbody>
    </table>,
  )
}

const sub = (html: string) =>
  /<span class="ds-cell-sub" title="([^"]*)">/.exec(html)?.[1]

test('a change row shows when, what, who, scrobbles moved and Undo', () => {
  const html = render(merge)
  assert.match(html, /aria-rowindex="2"/)
  assert.match(html, /<span class="ds-num">2026-03-04 \d{2}:\d{2}<\/span>/)
  assert.match(
    html,
    /<span class="ds-cell-two"><span class="ds-cell-title" title="Merged “Nite Drive” into “Night Drive”">Merged “Nite Drive” into “Night Drive”<\/span><span class="ds-cell-sub" title="Example Artist · Nite Drive">Example Artist · Nite Drive<\/span><\/span>/,
  )
  assert.match(html, /data-status="done"[^>]*>You<\/span>/)
  assert.match(html, />1,234</)
  assert.match(html, /<button[^>]*>Undo<\/button>/)
  assert.doesNotMatch(html, /disabled/)
})

test('the sub line gives the names moved, the rule and why Undo or Redo is not offered', () => {
  const html = render({
    ...merge,
    actor: 'automatic',
    rule: 'Same title and artist',
    nameCount: 3,
    scrobbles: 0,
    canUndo: false,
  })
  const reason = 'A later change moved these names. Undo that change first'
  const note = `Example Artist · Nite Drive and 2 more. Same title and artist. ${reason}`
  assert.ok(
    html.includes(`<span class="ds-cell-sub" title="${note}">${note}</span>`),
  )
  assert.match(html, /data-status="done"[^>]*>Automatic<\/span>/)
  assert.match(html, /–/)
  assert.match(
    html,
    new RegExp(`<button[^>]*disabled=""[^>]*title="${reason}\\.`),
  )
})

test('an undone change shows Undone and offers Redo', () => {
  const html = render({
    ...merge,
    undoneAt: '2026-03-05T05:06:00.000Z',
    canRedo: true,
  })
  assert.match(html, /data-status="cancelled"[^>]*>Undone<\/span>/)
  assert.match(html, /<button[^>]*>Redo<\/button>/)
})

test('an automatic album merge names its rule and what else it merged', () => {
  const html = render(albumMerge)
  assert.match(
    html,
    /<span class="ds-cell-title" title="Merged “Night Cities \(Deluxe\)” into “Night Cities”">/,
  )
  assert.equal(
    sub(html),
    'Album track list. Also merged 1 edition, 2 album names, and 14 track names: “Night Cities (Deluxe)”, “Night Cities - EP”',
  )
  assert.match(html, /data-status="done"[^>]*>Automatic<\/span>/)
  assert.match(html, />40</)
})

test('an undone automatic change says it will not be made again', () => {
  const html = render({
    ...albumMerge,
    details: null,
    undoneAt: '2026-03-05T05:06:00.000Z',
    canUndo: false,
    canRedo: true,
  })
  assert.equal(
    sub(html),
    'Album track list. Will not be merged automatically again',
  )
  assert.match(html, /data-status="cancelled"[^>]*>Undone<\/span>/)
  assert.match(html, /<button[^>]*>Redo<\/button>/)
})

test('the server’s reason replaces the guessed one on the sub line and the button', () => {
  const reason = 'A later change moved these credits. Undo that change first.'
  const html = render({ ...artistMerge, canUndo: false, blocked: reason })
  assert.match(html, /title="Merged “Ferro &amp; Lane” into “Ferro and Lane”"/)
  assert.equal(
    sub(html),
    'Also merged 1 artist name and 9 credits: “Ferro &amp; Lane”. A later change moved these credits. Undo that change first',
  )
  assert.match(
    html,
    /<button[^>]*disabled=""[^>]*title="A later change moved these credits\. Undo that change first\.">Undo/,
  )
  assert.doesNotMatch(html, /these names/)
})

test('a change with nothing more to say keeps an empty sub line', () => {
  const html = render({
    ...merge,
    action: 'keep-separate',
    target: null,
    sources: [
      record('track-1', 'Night Drive'),
      record('track-2', 'Night Drive (Live)'),
    ],
    names: [],
    nameCount: 0,
    scrobbles: 0,
  })
  assert.match(
    html,
    /title="Kept 2 tracks separate: “Night Drive”, “Night Drive \(Live\)”"/,
  )
  assert.match(html, /<span class="ds-cell-sub">\u00a0<\/span>/)
})

function page(kind: LibraryChangeKind, items: LibraryChange[]) {
  return (client: QueryClient) =>
    client.setQueryData([...libraryChangesKey({ kind, size: 50 }), 1], {
      page: 1,
      size: 50,
      totalCount: items.length,
      pageCount: 1,
      items,
    })
}

test('each library has its own History path', () => {
  assert.deepEqual(libraryChangesPaths, {
    track: '/tracks/changes',
    album: '/albums/changes',
    artist: '/artists/changes',
  })
})

const histories: [LibraryChangeKind, LibraryChange, string][] = [
  ['album', albumMerge, 'Merged “Night Cities (Deluxe)” into “Night Cities”'],
  ['artist', artistMerge, 'Merged “Ferro &amp; Lane” into “Ferro and Lane”'],
  ['track', merge, 'Merged “Nite Drive” into “Night Drive”'],
]
for (const [kind, change, title] of histories) {
  test(`History for ${kind}s lists that library’s changes with the filter and count`, () => {
    const html = renderWith(
      <LibraryChanges kind={kind} />,
      page(kind, [change]),
    )
    assert.match(html, /<h1[^>]*>History<\/h1>/)
    assert.match(html, /aria-label="Changed by"/)
    for (const label of ['All', 'You', 'Automatic'])
      assert.match(html, new RegExp(`>${label}</button>`))
    assert.match(html, /aria-pressed="true"[^>]*>All<\/button>/)
    assert.match(html, />1 change</)
    for (const label of ['When', 'Change', 'By', 'Scrobbles moved'])
      assert.match(html, new RegExp(`>${label}<`))
    assert.doesNotMatch(html, />In</)
    assert.ok(html.includes(`title="${title}"`))
    assert.match(html, /<button[^>]*>Undo<\/button>/)
  })
}

test('History reads the actor filter from the URL', () => {
  const html = renderWith(
    <LibraryChanges kind="album" />,
    (client) =>
      client.setQueryData(
        [
          ...libraryChangesKey({ kind: 'album', actor: 'automatic', size: 50 }),
          1,
        ],
        {
          page: 1,
          size: 50,
          totalCount: 2,
          pageCount: 1,
          items: [albumMerge, { ...albumMerge, id: 'change-4' }],
        },
      ),
    'actor=automatic',
  )
  assert.match(html, /aria-pressed="true"[^>]*>Automatic<\/button>/)
  assert.match(html, />2 changes</)
})

test('a saved change opens its exact History row with Undo and a link to all changes', () => {
  const html = renderWith(
    <LibraryChanges kind="album" />,
    (client) => {
      page('album', [{ ...albumMerge, id: 'other-change' }])(client)
      client.setQueryData(
        [
          ...libraryChangesKey({
            kind: 'album',
            changeId: albumMerge.id,
            size: 50,
          }),
          1,
        ],
        {
          page: 1,
          size: 50,
          totalCount: 1,
          pageCount: 1,
          items: [albumMerge],
        },
      )
    },
    `changeId=${albumMerge.id}&actor=owner`,
  )
  assert.match(html, /href="\/albums\/changes">All changes<\/a>/)
  assert.doesNotMatch(html, /Changed by/)
  assert.match(html, />1 change</)
  assert.match(html, /Merged “Night Cities \(Deluxe\)” into “Night Cities”/)
  assert.match(html, /<button[^>]*>Undo<\/button>/)
})

test('History with no changes says so', () => {
  const html = renderWith(<LibraryChanges kind="artist" />, page('artist', []))
  assert.match(html, /No changes/)
  assert.match(html, />0 changes</)
})

test('a record’s Changes list its changes for any kind, and hides when there are none', () => {
  const key = (kind: LibraryChangeKind, recordId: string) =>
    libraryChangesKey({ kind, recordId, size: 10 })
  const list = (items: LibraryChange[]) => ({
    page: 1,
    size: 10,
    totalCount: items.length,
    pageCount: 1,
    items,
  })
  const html = renderWith(
    <>
      <LibraryRecordChanges kind="album" recordId="album-1" />
      <LibraryRecordChanges kind="artist" recordId="artist-1" />
      <LibraryRecordChanges kind="track" recordId="track-9" />
    </>,
    (client) => {
      client.setQueryData(key('album', 'album-1'), list([albumMerge]))
      client.setQueryData(key('artist', 'artist-1'), list([artistMerge]))
      client.setQueryData(key('track', 'track-9'), list([]))
    },
  )
  assert.equal(html.match(/>Changes</g)?.length, 2)
  assert.match(
    html,
    /<ol class="ds-timeline" data-wrap="">.*<span title="Merged “Night Cities \(Deluxe\)” into “Night Cities”">/,
  )
  assert.match(
    html,
    /<span title="Merged “Ferro &amp; Lane” into “Ferro and Lane”">/,
  )
  assert.match(html, /data-status="done"[^>]*>Automatic<\/span>/)
  assert.equal(html.match(/>Undo<\/button>/g)?.length, 2)
})
