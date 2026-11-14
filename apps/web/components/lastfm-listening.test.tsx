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
  AlbumListeningSchema,
  LastfmLinkReportSchema,
  LastfmSyncStatusSchema,
} from '@repo/schemas/lastfm'
import ImportsWorkspace from './imports-workspace'
import LastfmSyncPageClient from './pages/lastfm-sync-page-client'
import AlbumListening from './album-listening'
import LastfmLinkPanel from './lastfm-link-panel'
import LastfmSearchActions from './lastfm-search-actions'
import { ListeningChart } from './listening-chart'
import { ConfigContext } from './providers'
import { monthBars, yearBars } from '@/utils/listening-chart'
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
        ],
        { pages: [report], pageParams: [1] },
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
  assert.match(html, /Not synced/)
  assert.match(html, />Sync now</)
  assert.match(html, /runs as a background job; this page can be closed/)
  assert.doesNotMatch(
    html,
    /<progress|>Stop<|Resume sync|View (current|last) job/,
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
  assert.match(html, /Not synced/)
  assert.match(html, />Sync now</)
})

test('album listening retains cached scrobbles after a failed background refresh', () => {
  const html = render(
    [
      [
        ['album-listening', 'one', ''],
        AlbumListeningSchema.parse({
          total: 12,
          firstListenedAt: '2026-01-01T00:00:00Z',
          lastListenedAt: '2026-01-02T00:00:00Z',
          months: [{ month: '2026-01', count: 12 }],
          tracks: [],
        }),
      ],
    ],
    <AlbumListening albumId="one" />,
    'mediaType=album',
    [['album-listening', 'one', '']],
  )
  assert.match(html, /<dd>12<\/dd>/)
  assert.match(html, /aria-label="Scrobbles by month"/)
})

test('unconfigured Last.fm links to provider settings and disables sync and schedule', () => {
  const html = syncPage({ ...idle, configured: false })
  assert.match(
    html,
    /href="\/providers\?provider=lastfm&amp;mediaType=album">Last\.fm provider settings/,
  )
  assert.match(html, /disabled=""[^>]*>Sync now/)
  assert.match(html, /<select disabled=""><option value="off" selected="">Off/)
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
  assert.match(html, /<progress[^>]*value="12"[^>]*max="340"/)
  assert.match(html, /<dt>Pages fetched<\/dt><dd>12 of 340<\/dd>/)
  assert.match(html, /<dt>New scrobbles this run<\/dt><dd>2,400<\/dd>/)
  assert.match(html, /1,800 of 2,400/)
  assert.match(html, />Stop</)
  assert.match(html, /disabled=""[^>]*>Sync now/)
  assert.match(
    html,
    /href="\/jobs\?jobId=job-1&amp;mediaType=album">View current job/,
  )
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
  assert.match(failed, /role="alert">Last\.fm returned an error/)
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
    /aria-sort="descending"><div[^>]*><button[^>]*>Scrobbles<span aria-hidden="true"> ↓/,
  )
  assert.match(html, /aria-sort="none"><div[^>]*><button[^>]*>Scrobbled artist/)
  assert.match(
    html,
    /aria-label="Select Artist fixture — Album fixture" disabled=""/,
  )
  assert.match(html, /aria-label="Select Artist fixture — Shared title"\/>/)
  assert.match(
    html,
    /href="\/jobs\?jobId=search-fixture&amp;mediaType=album">2 matches/,
  )
  assert.match(html, /Shift-click to select a range/)
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
  const actions = html.indexOf('class="job-selection-toolbar"')
  assert.ok(search > -1)
  assert.ok(search < count && count < columns && columns < filter)
  assert.ok(filter < actions)
  assert.ok(html.lastIndexOf('</table>') < actions)
  assert.equal(html.match(/class="table-column-controls"/g)?.length, 1)
  assert.equal(html.match(/class="secondary-table-toolbar"/g)?.length, 1)
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
  assert.match(html, /Confirm 6 Spotify album searches/)
  assert.match(html, /disabled=""[^>]*>Search Spotify albums/)
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
    /Confirm \d+ Spotify|disabled=""[^>]*>Search Spotify albums/,
  )
})

test('scrobble link panel shows current album, library search and manual controls', () => {
  const group = report.items.find((item) => item.reason === 'manual')
  assert.ok(group)
  const html = render([], <LastfmLinkPanel group={group} onClose={() => {}} />)
  assert.match(html, /<dialog[^>]*class="tag-drawer"[^>]*aria-labelledby=/)
  assert.match(html, /aria-label="Close scrobble link"/)
  assert.match(html, />Chosen title<\/h1>/)
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

test('listening tab summarises scrobbles with a year chart and track selector', () => {
  const listening = AlbumListeningSchema.parse({
    total: 12,
    firstListenedAt: '2019-11-02T10:00:00Z',
    lastListenedAt: '2022-01-05T10:00:00Z',
    months: [
      { month: '2019-11', count: 4 },
      { month: '2022-01', count: 8 },
    ],
    tracks: [
      {
        key: 'opening',
        title: 'Opening',
        position: 1,
        count: 12,
        lastListenedAt: '2022-01-05T10:00:00Z',
      },
    ],
    sources: [
      { artistName: 'Artist fixture', albumName: 'Album fixture', count: 9 },
      {
        artistName: 'Second artist',
        albumName: 'Other title',
        count: 3,
        manual: true,
      },
    ],
  })
  const html = render(
    [[['album-listening', 'one', ''], listening]],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /<dd>12<\/dd>/)
  assert.match(html, /<option value="" selected="">All tracks<\/option>/)
  assert.match(html, /<option value="opening">1\. Opening \(12\)<\/option>/)
  assert.match(html, /aria-label="Scrobbles by month"/)
  for (const label of [
    '2019-11: 4 scrobbles',
    '2019-12: 0 scrobbles',
    '2021-12: 0 scrobbles',
    '2022-01: 8 scrobbles',
  ])
    assert.ok(html.includes(label), label)
  assert.match(html, /aria-pressed="true"[^>]*>Month</)
  assert.match(html, /<polyline/)
  assert.match(html, /Linked scrobble names/)
  assert.match(
    html,
    /aria-label="Remove Artist fixture — Album fixture"[^>]*>Remove</,
  )
  assert.match(html, /Artist fixture — Album fixture ·/)
  assert.match(html, /Second artist — Other title ·.*Linked manually/)
  assert.match(html, />Add scrobbled name</)
  assert.doesNotMatch(html, /Similar unlinked names/)
  assert.doesNotMatch(html, /Loading/)
})

test('albums without linked scrobbles show a plain empty state', () => {
  const html = render(
    [
      [
        ['album-listening', 'one', ''],
        AlbumListeningSchema.parse({
          total: 0,
          firstListenedAt: null,
          lastListenedAt: null,
          months: [],
          tracks: [],
        }),
      ],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /No scrobbles linked to this album\./)
  assert.doesNotMatch(html, /<select|Scrobbles by|Linked scrobble names/)
  assert.doesNotMatch(html, /Similar unlinked names/)
})

test('albums without linked scrobbles list similar unlinked names', () => {
  const html = render(
    [
      [
        ['album-listening', 'one', ''],
        AlbumListeningSchema.parse({
          total: 0,
          firstListenedAt: null,
          lastListenedAt: null,
          months: [],
          tracks: [],
          similarUnlinked: [
            {
              artistName: 'Artist fixture',
              albumName: 'Album fixture (Deluxe)',
              count: 3,
            },
          ],
        }),
      ],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /No scrobbles linked to this album\./)
  assert.match(html, /Similar unlinked names/)
  assert.match(html, /Artist fixture — Album fixture \(Deluxe\) ·/)
  assert.match(
    html,
    /aria-label="Add Artist fixture — Album fixture \(Deluxe\)"[^>]*>Add</,
  )
  assert.match(
    html,
    /href="\/imports\/lastfm\?mediaType=album&amp;reason=unlinked">Review scrobble links/,
  )
})

test('chart lists every period for assistive technology without count labels on bars', () => {
  const html = renderToStaticMarkup(
    <ListeningChart
      period="year"
      style="bar"
      bars={yearBars([{ month: '2024-03', count: 1 }])}
    />,
  )
  assert.match(html, /aria-label="Scrobbles by year"/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /<li>2024: 1 scrobble<\/li>/)
  assert.match(html, /<rect /)
  assert.doesNotMatch(html, /<polyline/)
  assert.doesNotMatch(html, />0\.5</)
})

test('line chart draws a polyline with markers and labels January years in month view', () => {
  const html = renderToStaticMarkup(
    <ListeningChart
      period="month"
      style="line"
      bars={monthBars([
        { month: '2019-11', count: 3 },
        { month: '2020-02', count: 4 },
      ])}
    />,
  )
  assert.match(html, /aria-label="Scrobbles by month"/)
  assert.match(html, /<polyline /)
  assert.match(html, /<polygon /)
  assert.equal(html.match(/<circle /g)?.length, 4)
  assert.match(html, /<li>2019-12: 0 scrobbles<\/li>/)
  assert.match(html, />2020<\/text>/)
})

test('listening tab offers bar and line chart styles', () => {
  const html = render(
    [
      [
        ['album-listening', 'one', ''],
        AlbumListeningSchema.parse({
          total: 2,
          firstListenedAt: '2024-03-02T10:00:00Z',
          lastListenedAt: '2024-03-05T10:00:00Z',
          months: [{ month: '2024-03', count: 2 }],
          tracks: [],
        }),
      ],
    ],
    <AlbumListening albumId="one" />,
  )
  assert.match(html, /role="group" aria-label="Chart style"/)
  assert.match(html, /aria-pressed="false"[^>]*>Bar</)
  assert.match(html, /aria-pressed="true"[^>]*>Line</)
})
