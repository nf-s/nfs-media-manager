import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  LibraryPlaylistDetailSchema,
  LibraryPlaylistSummarySchema,
  type LibraryPlaylistDetail,
  type LibraryPlaylistView,
} from '@repo/schemas/library-playlists'
import {
  openSmartPlaylist,
  smartPlaylistActions,
  SmartPlaylistActions,
  SmartPlaylistName,
  SmartPlaylistsSection,
  smartPlaylistChoicesKey,
  useLibraryPlaylistSuggestions,
  type OpenSmartPlaylist,
  type SmartPlaylistBrowse,
} from './smart-playlist-controls'
import { libraryPlaylistsKey } from '@/utils/library-playlists'
import { ConfigContext } from './providers'
import type { ResultReport } from './result-line'

function unexpected(): never {
  throw new Error('Rendering does not run smart playlist actions')
}

const ambientView: LibraryPlaylistView = {
  filters: JSON.stringify([{ field: 'genre', value: 'ambient', mode: 'any' }]),
  sortBy: 'dateAdded',
  direction: 'desc',
}

function smart(overrides: Partial<SmartPlaylistBrowse> = {}) {
  const state: SmartPlaylistBrowse = {
    library: 'tracks',
    view: ambientView,
    sentence: 'Tag: Ambient · Added, newest first',
    canSave: true,
    suggestedName: 'Ambient',
    open: null,
    loading: false,
    changed: false,
    save: unexpected,
    update: unexpected,
    close: unexpected,
    choose: unexpected,
    ...overrides,
  }
  return state
}

const open = { id: 'smart-1', name: 'Ambient', view: ambientView }

function render(node: React.ReactNode, client = new QueryClient()) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{ apiBaseUrl: 'http://api.test', appUrl: 'http://app.test' }}
      >
        {node}
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
}

/** Visible text of each button, in document order. */
function buttons(html: string) {
  return [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((match) =>
    (match[1] ?? '').replace(/<[^>]+>/g, ''),
  )
}

test('with nothing to save the rail has no actions and the drawer disables Save current view', () => {
  const state = smart({ canSave: false })
  assert.equal(render(<SmartPlaylistActions smart={state} place="rail" />), '')
  assert.equal(render(<SmartPlaylistName smart={state} place="rail" />), '')
  const drawer = render(<SmartPlaylistsSection smart={state} />)
  assert.match(drawer, /<span>Smart playlists<\/span>/)
  assert.match(drawer, /<span class="ds-label">Saved view<\/span>/)
  assert.match(drawer, /aria-label="Smart playlist"/)
  assert.match(
    drawer,
    /<option value="" selected="">Choose a saved view<\/option>/,
  )
  assert.match(
    drawer,
    /<span class="ds-help">Tag: Ambient · Added, newest first<\/span>/,
  )
  assert.match(
    drawer,
    /<button[^>]*disabled=""[^>]*title="Search or add a filter first"[^>]*>.*Save current view<\/button>/,
  )
  assert.deepEqual(buttons(drawer).slice(-1), ['Save current view'])
})

test('a view with a filter offers Save as smart playlist in the rail and Save current view in the drawer', () => {
  const state = smart()
  const rail = render(<SmartPlaylistActions smart={state} place="rail" />)
  assert.match(rail, /^<div class="ds-rail-actions">/)
  assert.deepEqual(buttons(rail), ['Save as smart playlist'])
  assert.match(rail, /aria-haspopup="dialog"/)
  const row = render(<SmartPlaylistActions smart={state} place="row" />)
  assert.doesNotMatch(row, /ds-rail-actions/)
  assert.deepEqual(buttons(row), ['Save as smart playlist'])
  const drawer = render(<SmartPlaylistsSection smart={state} />)
  assert.match(
    drawer,
    /<button(?![^>]*disabled)[^>]*>.*Save current view<\/button>/,
  )
})

test('an open smart playlist shows its name and Close; nothing to update while unchanged', () => {
  const state = smart({ open })
  const name = render(<SmartPlaylistName smart={state} place="rail" />)
  assert.equal(
    name,
    '<h2 class="ds-rail-label">Smart playlist</h2><div class="ds-rail-view"><span class="ds-view-name"><span title="Ambient">Ambient</span></span></div>',
  )
  assert.equal(
    render(<SmartPlaylistName smart={state} place="row" />),
    '<span class="ds-view-name"><span title="Ambient">Ambient</span></span>',
  )
  const rail = render(<SmartPlaylistActions smart={state} place="rail" />)
  assert.deepEqual(buttons(rail), ['Close'])
  assert.match(rail, /title="Close this smart playlist and clear its filters"/)
  const drawer = render(<SmartPlaylistsSection smart={state} />)
  assert.match(drawer, /<option value="smart-1" selected="">Ambient<\/option>/)
  assert.deepEqual(buttons(drawer), [])
})

test('a changed smart playlist reads Changed and offers Update and Save as new', () => {
  const state = smart({ open, changed: true })
  assert.match(
    render(<SmartPlaylistName smart={state} place="rail" />),
    /<span title="Ambient">Ambient<\/span><span class="ds-muted">Changed<\/span>/,
  )
  const rail = render(<SmartPlaylistActions smart={state} place="rail" />)
  assert.deepEqual(buttons(rail), ['Update', 'Save as new', 'Close'])
  assert.match(rail, /<button[^>]*data-variant="primary"[^>]*>Update<\/button>/)
  const drawer = render(<SmartPlaylistsSection smart={state} />)
  assert.deepEqual(buttons(drawer), ['Update “Ambient”', 'Save as new'])
})

test('while the named smart playlist is read the rail offers nothing yet', () => {
  const state = smart({ loading: true })
  assert.equal(render(<SmartPlaylistActions smart={state} place="rail" />), '')
})

const detail = (overrides: Partial<LibraryPlaylistDetail> = {}) =>
  LibraryPlaylistDetailSchema.parse({
    id: 'smart-1',
    library: 'tracks',
    type: 'smart',
    name: 'Ambient',
    entryCount: null,
    view: ambientView,
    updatedAt: '2026-11-28T00:00:00.000Z',
    createdAt: '2026-11-28T00:00:00.000Z',
    repeatCount: 0,
    ...overrides,
  })

test('only a found smart playlist of the library is open', () => {
  const read = { data: detail(), isError: false }
  assert.deepEqual(openSmartPlaylist('tracks', 'smart-1', read), open)
  assert.equal(openSmartPlaylist('tracks', null, read), null)
  assert.equal(openSmartPlaylist('tracks', 'smart-2', read), null)
  assert.equal(openSmartPlaylist('albums', 'smart-1', read), null)
  // Deleted: the read fails, though it held the playlist before.
  assert.equal(
    openSmartPlaylist('tracks', 'smart-1', { ...read, isError: true }),
    null,
  )
  assert.equal(
    openSmartPlaylist('tracks', 'smart-1', {
      data: detail({ type: 'playlist', view: null, entryCount: 3 }),
      isError: false,
    }),
    null,
  )
  assert.equal(openSmartPlaylist('tracks', 'smart-1', { isError: false }), null)
})

type Request = { method: string; url: string; body: unknown }

function mockApi(t: TestContext, responses: unknown[]) {
  const requests: Request[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: responses.shift(),
      })
    },
  )
  return requests
}

function harness(
  view: LibraryPlaylistView,
  current: OpenSmartPlaylist | null = open,
) {
  const reports: ResultReport[] = []
  const remembered: string[] = []
  const refreshed: string[] = []
  const params = new URLSearchParams({ filters: view.filters ?? '' })
  const actions = smartPlaylistActions({
    apiBaseUrl: 'http://api.test',
    library: 'tracks',
    view,
    open: current,
    remember: (playlist) => remembered.push(playlist.name),
    refresh: async (id) => refreshed.push(id),
    report: (report) => reports.push(report),
    updateBrowse: (apply) => apply(params),
  })
  return { actions, reports, remembered, refreshed, params }
}

test('Save creates the smart playlist with the view, opens it and reports with Playlists and Undo', async (t) => {
  const created = detail({ id: 'smart-9', name: 'Ambient' })
  const requests = mockApi(t, [{ playlist: created, addition: null }, created])
  const run = harness(ambientView, null)
  await run.actions.save('Ambient')
  assert.deepEqual(requests[0], {
    method: 'POST',
    url: 'http://api.test/api/v1/library-playlists',
    body: {
      type: 'smart',
      library: 'tracks',
      name: 'Ambient',
      view: ambientView,
    },
  })
  assert.equal(run.params.get('smartPlaylist'), 'smart-9')
  assert.deepEqual(run.remembered, ['Ambient'])
  const [report] = run.reports
  assert.equal(report?.text, 'Saved smart playlist “Ambient”.')
  assert.deepEqual(report?.action, {
    label: 'Playlists',
    href: '/playlists?mediaType=track',
  })
  await report?.undo?.()
  assert.deepEqual(requests[1], {
    method: 'DELETE',
    url: 'http://api.test/api/v1/library-playlists/smart-9',
    body: null,
  })
  assert.equal(run.params.get('smartPlaylist'), null)
  assert.equal(run.params.get('filters'), ambientView.filters)
})

test('Undo of Save leaves another open smart playlist in the URL', async (t) => {
  const created = detail({ id: 'smart-9' })
  mockApi(t, [{ playlist: created, addition: null }, created])
  const run = harness(ambientView, null)
  await run.actions.save('Ambient')
  run.params.set('smartPlaylist', 'smart-3')
  await run.reports[0]?.undo?.()
  assert.equal(run.params.get('smartPlaylist'), 'smart-3')
})

test('Update saves the current view over the saved one; Undo puts the previous view back', async (t) => {
  const changedView = {
    ...ambientView,
    filters: JSON.stringify([
      { field: 'genre', value: 'ambient', mode: 'any' },
      { field: 'genre', value: 'jazz', mode: 'any' },
    ]),
  }
  const requests = mockApi(t, [
    detail({ view: changedView }),
    detail({ view: ambientView }),
  ])
  const run = harness(changedView)
  await run.actions.update()
  assert.deepEqual(requests[0], {
    method: 'PATCH',
    url: 'http://api.test/api/v1/library-playlists/smart-1',
    body: { view: changedView },
  })
  const [report] = run.reports
  assert.equal(report?.text, 'Updated “Ambient”.')
  assert.deepEqual(report?.action, {
    label: 'Playlists',
    href: '/playlists?mediaType=track',
  })
  await report?.undo?.()
  assert.deepEqual(requests[1], {
    method: 'PATCH',
    url: 'http://api.test/api/v1/library-playlists/smart-1',
    body: { view: ambientView },
  })
  // Browse keeps the changed view.
  assert.equal(run.params.get('filters'), changedView.filters)
  assert.deepEqual(run.refreshed, ['smart-1', 'smart-1'])
})

test('Close clears the view and the ID; choosing a saved view opens it', () => {
  const run = harness(ambientView)
  run.params.set('smartPlaylist', 'smart-1')
  run.params.set('view', 'table')
  run.actions.close()
  assert.deepEqual(Object.fromEntries(run.params), { view: 'table' })
  run.actions.choose(open)
  assert.deepEqual(Object.fromEntries(run.params), {
    view: 'table',
    ...ambientView,
    smartPlaylist: 'smart-1',
  })
})

/** A library's smart playlists in name order, as the server lists them. */
const manySmart = Array.from({ length: 130 }, (_, index) =>
  LibraryPlaylistSummarySchema.parse({
    id: `smart-${index + 1}`,
    library: 'albums',
    type: 'smart',
    name: `Saved view ${String(index + 1).padStart(3, '0')}`,
    entryCount: null,
    view: ambientView,
    updatedAt: '2026-11-28T00:00:00.000Z',
  }),
)

test('Saved view lists every smart playlist of the library, beyond the first page', (t) => {
  const client = new QueryClient()
  client.setQueryData(smartPlaylistChoicesKey('albums'), manySmart)
  const beyond = manySmart[119]
  if (!beyond) throw new Error('Fixture has 130 smart playlists')
  const html = render(
    <SmartPlaylistsSection
      smart={smart({
        library: 'albums',
        open: { id: beyond.id, name: beyond.name, view: ambientView },
      })}
    />,
    client,
  )
  t.after(() => client.clear())
  const options = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)]
  assert.equal(options.length, 131)
  assert.deepEqual(
    options.slice(1).map(([, id]) => id),
    manySmart.map((row) => row.id),
  )
  assert.match(
    html,
    /<option value="smart-120" selected="">Saved view 120<\/option>/,
  )
})

function SuggestionProbe({
  browse,
  search,
}: {
  browse: SmartPlaylistBrowse | null
  search: string
}) {
  const result = useLibraryPlaylistSuggestions(browse, search)
  return (
    <output>
      {JSON.stringify({
        options: result.options.map((option) => option.label),
        smart: result.smartPlaylists.map((playlist) => playlist.href),
        isError: result.isError,
      })}
    </output>
  )
}

test('PL-44: the search box offers the library’s playlists from one cached read, only while text is searched', (t) => {
  const client = new QueryClient()
  t.after(() => client.clear())
  client.setQueryData(
    [...libraryPlaylistsKey, 'suggestions', 'albums'],
    [
      LibraryPlaylistSummarySchema.parse({
        id: 'pl-1',
        library: 'albums',
        type: 'playlist',
        name: 'Desert Island',
        entryCount: 5,
        view: null,
        updatedAt: '2026-11-28T00:00:00.000Z',
      }),
      manySmart[0],
    ],
  )
  const probe = (browse: SmartPlaylistBrowse | null, search: string) =>
    JSON.parse(
      render(<SuggestionProbe browse={browse} search={search} />, client)
        .replace(/^<output>|<\/output>$/g, '')
        .replaceAll('&quot;', '"')
        .replaceAll('&amp;', '&'),
    )
  assert.deepEqual(probe(smart({ library: 'albums' }), 'desert'), {
    options: ['Playlist: Desert Island'],
    smart: [
      `/albums?${new URLSearchParams({ ...ambientView, smartPlaylist: 'smart-1' })}`,
    ],
    isError: false,
  })
  assert.deepEqual(probe(smart({ library: 'albums' }), ' '), {
    options: [],
    smart: [],
    isError: false,
  })
  assert.deepEqual(probe(null, 'desert'), {
    options: [],
    smart: [],
    isError: false,
  })
})
