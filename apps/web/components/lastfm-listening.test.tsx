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
  LastfmLinkReportSchema,
  LastfmSyncStatusSchema,
} from '@repo/schemas/lastfm'
import ImportsWorkspace from './imports-workspace'
import LastfmSyncPageClient from './pages/lastfm-sync-page-client'
import LastfmLinkPanel from './lastfm-link-panel'
import LastfmSearchActions from './lastfm-search-actions'
import { ConfigContext } from './providers'
import { lastfmLinkKey } from '@/utils/lastfm-sync'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const idle = LastfmSyncStatusSchema.parse({
  configured: true,
  state: 'never',
  job: null,
  schedule: 'off',
  nextScheduledAt: null,
  pagesFetched: 0,
  totalPages: null,
  newScrobbles: 0,
  storedScrobbles: 0,
  matchedScrobbles: 0,
  startedAt: null,
  lastCompletedAt: null,
  errorMessage: null,
})

const fixtureAlbum = {
  id: 'album-1',
  slug: 'album-fixture',
  title: 'Album fixture',
  artists: ['Artist fixture'],
}

const report = LastfmLinkReportSchema.parse({
  page: 1,
  size: 50,
  totalCount: 5,
  pageCount: 1,
  summary: [
    { reason: 'linked', groups: 1, scrobbles: 40 },
    { reason: 'ambiguous', groups: 1, scrobbles: 7 },
    { reason: 'no-album', groups: 1, scrobbles: 2 },
  ],
  items: [
    {
      artistName: 'Artist fixture',
      albumName: 'Album fixture',
      scrobbles: 40,
      lastListenedAt: '2026-01-02T00:00:00Z',
      reason: 'linked',
      album: fixtureAlbum,
      strategy: 'edition',
      candidates: [],
    },
    {
      artistName: 'Second artist',
      albumName: 'Chosen title',
      scrobbles: 9,
      lastListenedAt: '2026-01-01T12:00:00Z',
      reason: 'manual',
      album: fixtureAlbum,
      candidates: [],
    },
    {
      artistName: 'Artist fixture',
      albumName: 'Shared title',
      scrobbles: 7,
      lastListenedAt: '2026-01-01T00:00:00Z',
      reason: 'ambiguous',
      album: null,
      spotifySearch: {
        jobId: 'search-fixture',
        status: 'succeeded',
        resultCount: 2,
        errorMessage: null,
      },
      candidates: [
        { ...fixtureAlbum, id: 'album-2', title: 'Shared title' },
        {
          ...fixtureAlbum,
          id: 'album-3',
          title: 'Shared title',
          artists: ['Artist fixture', 'Second artist'],
        },
      ],
    },
    {
      artistName: 'Other artist',
      albumName: null,
      scrobbles: 2,
      lastListenedAt: '2025-12-01T00:00:00Z',
      reason: 'no-album',
      album: null,
      candidates: [],
    },
  ],
})

function render(
  seed: Array<[unknown[], unknown]>,
  children: ReactNode,
  search = 'mediaType=album',
  failedKeys: unknown[][] = [],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['imports'], { sources: [], runs: [] })
  client.setQueryData(['import-formats'], [])
  for (const [key, value] of seed) client.setQueryData(key, value)
  for (const queryKey of failedKeys)
    client
      .getQueryCache()
      .build(client, { queryKey })
      .setState({
        status: 'error',
        error: new Error('Offline'),
        fetchStatus: 'idle',
      })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          <PathnameContext.Provider value="/imports/lastfm">
            <SearchParamsContext.Provider value={new URLSearchParams(search)}>
              {children}
            </SearchParamsContext.Provider>
          </PathnameContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

function syncPage(status: unknown, search?: string, reason = '') {
  return render(
    [
      [['lastfm-sync'], status],
      [
        [
          'lastfm-links',
          JSON.stringify(reason ? [reason] : []),
          '',
          'scrobbles',
          'desc',
          1,
        ],
        report,
      ],
    ],
    <ImportsWorkspace>
      <LastfmSyncPageClient />
    </ImportsWorkspace>,
    search,
  )
}

test('Last.fm page is an album import destination and only shows stored status', () => {
  const html = syncPage(idle)
  assert.match(
    html,
    /aria-current="page"[^>]*href="\/imports\/lastfm\?mediaType=album"/,
  )
  assert.match(html, /Last\.fm scrobbles/)
  assert.match(html, /data-status="never">Never</)
  assert.match(html, />Sync now</)
  assert.match(html, /runs as a background job; this page can be closed/)
  assert.doesNotMatch(
    html,
    /role="progressbar"|>Stop<|Resume sync|View (current|last) job/,
  )
  assert.doesNotMatch(html, /provider settings/)
})

test('Last.fm sync retains cached status after a failed background refresh', () => {
  const html = render(
    [[['lastfm-sync'], idle]],
    <ImportsWorkspace>
      <LastfmSyncPageClient />
    </ImportsWorkspace>,
    'mediaType=album',
    [['lastfm-sync']],
  )
  assert.match(html, /data-status="never">Never</)
  assert.match(html, />Sync now</)
})

test('unconfigured Last.fm links to provider settings and disables sync and schedule', () => {
  const html = syncPage({ ...idle, configured: false })
  assert.match(
    html,
    /href="\/providers\/lastfm">Last\.fm provider settings/,
  )
  assert.match(html, /disabled=""[^>]*>Sync now/)
  assert.match(
    html,
    /<select class="ds-select"[^>]*disabled=""><option value="off" selected="">Off/,
  )
})

test('running sync shows progress, the current job and Stop', () => {
  const html = syncPage({
    ...idle,
    state: 'running',
    job: { id: 'job-1', status: 'running' },
    pagesFetched: 12,
    totalPages: 340,
    newScrobbles: 2400,
    storedScrobbles: 2400,
    matchedScrobbles: 1800,
    startedAt: '2026-01-01T00:00:00Z',
  })
  assert.match(
    html,
    /role="progressbar" aria-valuemin="0" aria-valuemax="340" aria-valuenow="12"/,
  )
  assert.match(html, /<dt>Pages fetched<\/dt><dd>12 of 340<\/dd>/)
  assert.match(html, /<dt>New scrobbles this run<\/dt><dd>2,400<\/dd>/)
  assert.match(html, /1,800 of 2,400/)
  assert.match(html, />Stop</)
  assert.match(html, /disabled=""[^>]*>Sync now/)
  assert.match(html, /href="\/jobs\/job-1">View current job/)
  assert.match(html, /disabled=""[^>]*>Relink/)
})

test('running sync between chained jobs hides Stop for a finished job', () => {
  const html = syncPage({
    ...idle,
    state: 'running',
    job: { id: 'job-1', status: 'succeeded' },
  })
  assert.doesNotMatch(html, />Stop</)
})

test('schedule shows the saved value and next scheduled sync', () => {
  const html = syncPage({
    ...idle,
    state: 'complete',
    job: { id: 'job-2', status: 'succeeded' },
    schedule: 'daily',
    nextScheduledAt: '2026-02-01T00:00:00Z',
  })
  assert.match(html, /<option value="daily" selected="">Daily<\/option>/)
  assert.match(html, /<option value="6h">Every 6 hours<\/option>/)
  assert.match(html, /<option value="10m">Every 10 minutes<\/option>/)
  assert.match(html, /<option value="30m">Every 30 minutes<\/option>/)
  assert.match(html, /<option value="1h">Every hour<\/option>/)
  assert.match(html, /<option value="3h">Every 3 hours<\/option>/)
  assert.match(html, /Next sync /)
  assert.match(html, /does not start the first sync or resume a failed/)
  assert.match(html, />View last job</)
})

test('failed and stopped syncs offer Resume sync with the stored error', () => {
  const failed = syncPage({
    ...idle,
    state: 'failed',
    pagesFetched: 3,
    totalPages: 10,
    errorMessage: 'Last.fm returned an error',
  })
  assert.match(failed, />Resume sync</)
  assert.match(failed, /role="alert">.*<span>Last\.fm returned an error/)
  assert.match(syncPage({ ...idle, state: 'stopped' }), />Resume sync</)
})

test('scrobble links show reason totals and link library albums', () => {
  const html = syncPage(idle)
  assert.match(html, /by title,\s+credited artist and shared track titles/)
  assert.match(html, /Links are recomputed after every sync/)
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
  const linkedSummary = rows.find((row) =>
    row.includes('aria-pressed="false">Linked</button>'),
  )
  assert.ok(linkedSummary)
  assert.match(linkedSummary, />1</)
  assert.match(linkedSummary, />40</)
  const unlinkedSummary = rows.find((row) =>
    row.includes('Kept unlinked</button>'),
  )
  assert.ok(unlinkedSummary)
  assert.equal(unlinkedSummary.match(/>0</g)?.length, 2)
  assert.match(
    html,
    /aria-label="Link status for Artist fixture — Album fixture"/,
  )
  assert.match(html, /Another edition or artist credit/)
  assert.match(html, /type="checkbox"\/><span>Unlinked<\/span>/)
  assert.match(html, /href="\/albums\/album-1">Album fixture<\/a>/)
  assert.match(html, />Several albums match</)
  assert.match(html, />2 possible albums</)
  assert.doesNotMatch(html, /href="\/albums\/album-[23]"/)
  // Labelled icons retain the editing actions while keeping the row compact.
  assert.equal(html.match(/aria-label="Change album link"/g)?.length, 2)
  assert.doesNotMatch(html, />Unlink<|>Automatic<|Search library albums/)
  assert.match(
    html,
    /aria-label="Link album" title="Link album" aria-haspopup="dialog"/,
  )
  assert.equal(html.match(/aria-label="Add new album"/g)?.length, 1)
  const withoutAlbum = rows.find((row) =>
    row.includes('Select Other artist — No album'),
  )
  assert.ok(withoutAlbum)
  assert.match(withoutAlbum, /Scrobbled without an album/)
  assert.match(withoutAlbum, /Not searched/)
  assert.doesNotMatch(
    withoutAlbum,
    /aria-label="Change album link"|aria-label="Link album"|aria-label="Add new album"/,
  )
  assert.match(html, />Relink</)
  assert.doesNotMatch(html, /disabled=""[^>]*>Relink/)
  assert.match(html, /aria-label="Select all loaded unlinked albums"/)
  assert.match(
    html,
    /aria-sort="descending"><div[^>]*><button[^>]*>Scrobbles<svg/,
  )
  assert.match(html, /aria-sort="none"><div[^>]*><button[^>]*>Scrobbled artist/)
  assert.match(
    html,
    /aria-label="Select Artist fixture — Album fixture" disabled=""/,
  )
  assert.match(html, /aria-label="Select Artist fixture — Shared title"\/>/)
  assert.match(
    html,
    /href="\/jobs\/search-fixture"><span class="ds-status" data-status="done">2 matches/,
  )
  assert.doesNotMatch(html, /0 selected/)
})

test('scrobble matching explanations are in a detail popup rather than a second row line', () => {
  const html = syncPage(idle)
  const popovers =
    html.match(/<div[^>]*popover="auto"[^>]*>[\s\S]*?<\/div>/g) ?? []
  assert.ok(
    popovers.some(
      (popover) =>
        popover.includes('Another edition or artist credit') &&
        popover.includes(
          'aria-label="Link status for Artist fixture — Album fixture"',
        ),
    ),
  )
  const inline = html.replace(
    /<div[^>]*popover="auto"[^>]*>[\s\S]*?<\/div>/g,
    '',
  )
  assert.doesNotMatch(inline, /Another edition or artist credit/)
  assert.match(inline, />Linked</)
})

test('scrobble links use one ordered toolbar and keep the three-column summary simple', () => {
  const html = syncPage(idle)
  const search = html.indexOf('aria-label="Search scrobbled names"')
  const filter = html.indexOf('aria-label="Filter Link status"')
  const count = html.indexOf('5 names')
  const columns = html.indexOf('class="table-column-controls"')
  const bar = html.indexOf('class="ds-selectbar sec-selectbar"')
  assert.ok(search > -1)
  assert.ok(search < count && count < columns && columns < filter)
  assert.ok(filter < bar)
  assert.ok(html.lastIndexOf('</table>') < bar)
  assert.equal(html.match(/class="table-column-controls"/g)?.length, 1)
  assert.equal(html.match(/class="ds-toolbar"/g)?.length, 1)
  const summary = html.slice(0, search)
  assert.match(summary, /aria-sort="ascending"><div[^>]*><button[^>]*>Status/)
  assert.match(
    summary,
    /aria-sort="none"><div[^>]*><button[^>]*>Scrobbled names/,
  )
  assert.match(summary, /aria-sort="none"><div[^>]*><button[^>]*>Scrobbles/)
})

test('bulk Spotify search requires confirmation above five explicit unlinked albums', () => {
  const source = report.items.find((item) => item.reason === 'ambiguous')
  assert.ok(source)
  const groups = Array.from({ length: 6 }, (_, index) => ({
    ...source,
    albumName: `Album fixture ${index}`,
  }))
  const html = render(
    [],
    <LastfmSearchActions
      groups={groups}
      selectedIds={groups.map(lastfmLinkKey)}
      onSelect={() => {}}
      onPending={() => {}}
      disabled={false}
    />,
  )
  assert.doesNotMatch(html, />Clear</)
  assert.match(
    html,
    /aria-haspopup="dialog" aria-expanded="false"[^>]*>Search Spotify albums/,
  )
  assert.doesNotMatch(html, /disabled=""[^>]*>Search Spotify albums/)
  const small = render(
    [],
    <LastfmSearchActions
      groups={groups}
      selectedIds={groups.slice(0, 5).map(lastfmLinkKey)}
      onSelect={() => {}}
      onPending={() => {}}
      disabled={false}
    />,
  )
  assert.doesNotMatch(
    small,
    /aria-haspopup="dialog"[^>]*>Search Spotify albums|disabled=""[^>]*>Search Spotify albums/,
  )
})

test('scrobble link panel shows current album, library search and manual controls', () => {
  const group = report.items.find((item) => item.reason === 'manual')
  assert.ok(group)
  const html = render([], <LastfmLinkPanel group={group} onClose={() => {}} />)
  assert.match(html, /<dialog[^>]*class="sec-drawer"[^>]*aria-labelledby=/)
  assert.match(html, /aria-label="Close scrobble link"/)
  assert.match(html, />Chosen title<\/span><\/h2>/)
  assert.match(html, /Library album:/)
  assert.match(html, /href="\/albums\/album-1">Album fixture — Artist fixture/)
  assert.match(html, />Unlink</)
  assert.match(html, />Automatic</)
  assert.match(html, /aria-label="Album for Second artist — Chosen title"/)
  assert.match(html, /value="Chosen title"/)
  assert.match(html, /role="tab"[^>]*>Add new album</)
})

test('ambiguous scrobble matches are available in the panel', () => {
  const group = report.items.find((item) => item.reason === 'ambiguous')
  assert.ok(group)
  const html = render([], <LastfmLinkPanel group={group} onClose={() => {}} />)
  assert.match(html, /aria-label="Possible library albums"/)
  assert.match(html, /href="\/albums\/album-2">Shared title — Artist fixture/)
  assert.match(
    html,
    /href="\/albums\/album-3">Shared title — Artist fixture, Second artist/,
  )
  assert.equal(html.match(/>Link</g)?.length, 2)
  assert.doesNotMatch(html, />Unlink<|>Automatic</)
})

test('new album panel prefills Spotify search without requests during server rendering', () => {
  const group = report.items.find((item) => item.reason === 'ambiguous')
  assert.ok(group)
  const html = render(
    [],
    <LastfmLinkPanel group={group} initialMode="new" onClose={() => {}} />,
  )
  assert.match(html, /value="Artist fixture Shared title"/)
  assert.match(html, /Spotify/)
  assert.doesNotMatch(html, /aria-label="Possible library albums"/)
  assert.equal(network.mock.callCount(), 0)
})

test('scrobble link filter is read from the URL', () => {
  const html = syncPage(idle, 'mediaType=album&reason=unlinked', 'unlinked')
  assert.match(html, /type="checkbox" checked=""\/><span>Unlinked<\/span>/)
  const unknown = syncPage(idle, 'mediaType=album&reason=unknown')
  assert.match(unknown, /disabled="">All values<\/button>/)
})
