import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createElement, type RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  WorkspaceBrowseNavigation,
  useRestoreBrowsePreferences,
} from '@/components/workspace-tab-context'
import {
  captureScroll,
  forgetWorkspace,
  locationHref,
  makeWorkspaceTab,
  readWorkspace,
  saveWorkspace,
  workspaceRoute,
  type WorkspaceState,
  type WorkspaceTab,
} from './workspace-tabs'

function replaceGlobal(
  t: TestContext,
  name: 'document' | 'window',
  value: object,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  })
}

function useSessionStorage(t: TestContext, href: string) {
  const storage = new Map<string, string>()
  replaceGlobal(t, 'window', {
    location: new URL(href, 'https://fixture.test'),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  return storage
}

test('workspace labels follow the route, browse search and known detail title', () => {
  assert.deepEqual(workspaceRoute('/tracks?q=Night+Cities&view=table'), {
    area: 'tracks',
    label: 'Tracks · Night Cities',
    isDetail: false,
  })
  assert.deepEqual(
    workspaceRoute('/films/fixture-7?tab=history', 'Fixture film'),
    { area: 'films', label: 'Fixture film', isDetail: true },
  )
  assert.deepEqual(workspaceRoute('/films/fixture-7'), {
    area: 'films',
    label: 'Films',
    isDetail: true,
  })
  assert.deepEqual(workspaceRoute('/subscriptions/channels'), {
    area: 'subscriptions',
    label: 'Channels',
    isDetail: false,
  })
  assert.deepEqual(
    workspaceRoute('/mixes/shows/fixture?tab=episodes&q=night', 'Fixture show'),
    { area: 'mixes', label: 'Fixture show', isDetail: true },
  )
  assert.equal(
    workspaceRoute('/jobs/metadata?mediaType=artist').label,
    'Metadata',
  )
  assert.equal(workspaceRoute('/tags/hierarchy').label, 'Hierarchy')
  assert.equal(
    workspaceRoute('/films/toString', 'Fixture title').label,
    'Fixture title',
  )
  assert.equal(
    workspaceRoute('/imports/spotify-podcasts').label,
    'Spotify podcasts',
  )
  assert.equal(
    workspaceRoute('/tags?mediaType=film&tag=example', 'Example').label,
    'Example',
  )
  assert.equal(workspaceRoute('/user?mediaType=track').label, 'Account')
})

test('a workspace entry uses its assigned ID and preserves the full filtered destination', () => {
  const href = '/albums?q=Night+Cities&view=table&sortBy=added#results'
  const tab = makeWorkspaceTab('fixture-1', href)
  const copy = makeWorkspaceTab('fixture-2', href)
  assert.deepEqual(tab, {
    id: 'fixture-1',
    href,
    label: 'Albums · Night Cities',
    scroll: [],
    library: 'album',
  })
  assert.equal(copy.id, 'fixture-2')
  assert.equal(copy.href, tab.href)
  assert.notEqual(copy.scroll, tab.scroll)

  assert.equal(
    makeWorkspaceTab('fixture-3', '/playlists?mediaType=album').library,
    'album',
  )
  assert.equal(
    makeWorkspaceTab('fixture-4', '/jobs?mediaType=album', undefined, 'track')
      .library,
    'track',
  )
})

test('workspace storage restores only the current owner and active address', (t) => {
  const href = '/films?q=Night+Cities&view=list#results'
  useSessionStorage(t, href)
  const owner = 'owner-fixture'
  const scroll: WorkspaceTab['scroll'] = [
    { area: 'browse', index: 0, top: 384, left: 0 },
    { area: 'table', index: 1, top: 0, left: -12 },
  ]
  const open = { ...makeWorkspaceTab('one', href), scroll }
  const other = makeWorkspaceTab('two', '/films/fixture?tab=history')
  const state = { activeId: open.id, tabs: [open, other] }

  assert.equal(locationHref(), href)
  assert.equal(readWorkspace(owner, href), null)
  saveWorkspace(owner, state)
  assert.deepEqual(readWorkspace(owner, href), state)
  assert.equal(readWorkspace('different-owner', href), null)
  assert.equal(readWorkspace(owner, other.href), null)
  assert.equal(readWorkspace(owner, '/films?q=Night+Cities&view=list'), null)

  forgetWorkspace()
  assert.equal(readWorkspace(owner, href), null)
})

test('malformed workspace state is discarded before a tab can be restored', (t) => {
  const href = '/tracks?view=table'
  const storage = useSessionStorage(t, href)
  const owner = 'owner-fixture'
  const tab = makeWorkspaceTab('one', href)
  saveWorkspace(owner, { activeId: tab.id, tabs: [tab] })
  const [key] = storage.keys()
  assert.ok(key)

  storage.set(key, '{')
  assert.equal(readWorkspace(owner, href), null)

  const malformed: WorkspaceState[] = [
    { activeId: tab.id, tabs: [] },
    { activeId: 'missing', tabs: [tab] },
    { activeId: tab.id, tabs: [tab, tab] },
    {
      activeId: tab.id,
      tabs: [tab, { ...tab, id: 'two', href: 'https://other.test/films' }],
    },
    {
      activeId: tab.id,
      tabs: [
        {
          ...tab,
          scroll: [{ area: 'browse', index: -1, top: 30, left: 0 }],
        },
      ],
    },
  ]
  for (const state of malformed) {
    storage.set(key, JSON.stringify({ owner, state }))
    assert.equal(readWorkspace(owner, href), null)
  }
})

test('tab operations tolerate an unavailable session store', (t) => {
  replaceGlobal(t, 'window', {
    get sessionStorage() {
      throw new Error('Storage is unavailable')
    },
  })
  const owner = 'owner-fixture'
  const tab = makeWorkspaceTab('one', '/tracks')
  assert.doesNotThrow(() =>
    saveWorkspace(owner, { activeId: tab.id, tabs: [tab] }),
  )
  assert.equal(readWorkspace(owner, tab.href), null)
  assert.doesNotThrow(() => forgetWorkspace())
})

test('a bare tab restored after first render keeps its own Browse settings', (t) => {
  useSessionStorage(t, '/films')
  const restored: RefObject<WorkspaceTab | null> = { current: null }
  const replacements: string[] = []
  const navigation = {
    restored,
    replace: (href: string) => replacements.push(href),
  }
  let restorePreferences: (href: string) => void = () =>
    assert.fail('Browse did not render')
  function Browse() {
    restorePreferences = useRestoreBrowsePreferences()
    return null
  }
  renderToStaticMarkup(
    createElement(
      WorkspaceBrowseNavigation.Provider,
      { value: navigation },
      createElement(Browse),
    ),
  )
  const preference = '/films?view=list'
  restorePreferences(preference)
  assert.deepEqual(replacements, [preference])
  // Workspace hydration selects the saved tab before Browse runs its mount effect.
  restored.current = makeWorkspaceTab('original', '/films')
  restorePreferences(preference)
  assert.deepEqual(replacements, [preference])
  restored.current = null
  restorePreferences(preference)
  assert.deepEqual(replacements, [preference, preference])
})

test('scroll capture keeps area and index for independent scroll regions', (t) => {
  const scrollRegions: Record<
    string,
    { scrollTop: number; scrollLeft: number }[]
  > = {
    '.app-main': [{ scrollTop: 12, scrollLeft: 0 }],
    '.app-main :is(.browse-scroller, .browse-scroll):not([data-inspector-scroll])':
      [
        { scrollTop: 0, scrollLeft: 0 },
        { scrollTop: 300, scrollLeft: 0 },
      ],
    '.media-inspector:not(.player-sheet) [data-inspector-scroll]': [
      { scrollTop: 0, scrollLeft: 24 },
    ],
  }
  replaceGlobal(t, 'document', {
    querySelectorAll: (selector: string) => scrollRegions[selector] ?? [],
  })

  assert.deepEqual(captureScroll(), [
    { area: 'page', index: 0, top: 12, left: 0 },
    { area: 'browse', index: 1, top: 300, left: 0 },
    { area: 'detailTable', index: 0, top: 0, left: 24 },
  ])
})
