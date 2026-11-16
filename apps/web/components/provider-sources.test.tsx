import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  PathnameContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { JobSchema } from '@repo/schemas/job'
import { InspectorEntryContext } from './detail-inspector-context'
import { ProviderSources, type ProviderSourceRow } from './provider-sources'
import {
  jobState,
  mergeHistory,
  providerMarkText,
  sourceMatch,
  sourcesSummary,
} from '@/utils/source-rows'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in source navigation rendering tests')
})

const createdAt = '2026-01-01T00:00:00.000Z'
const queuedJob = JobSchema.parse({
  id: 'job-active',
  provider: 'queued-provider',
  status: 'queued',
  createdAt,
  startedAt: null,
  finishedAt: null,
  errorMessage: null,
  scope: {},
  options: {},
  confirmBroadRun: false,
  items: [],
  logs: [],
})
const noJob = async () => queuedJob

function render(
  view: string,
  initialProvider?: string,
  rows: ProviderSourceRow[] = [{ id: 'example', label: 'Example provider' }],
  activeJobs = [queuedJob],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  const scope: { kind: 'film'; id: string } = { kind: 'film', id: 'film-1' }
  client.setQueryData(['jobs', 'source-refresh-active', scope], {
    page: 1,
    size: 100,
    items: activeJobs,
    totalCount: activeJobs.length,
    pageCount: 1,
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <PathnameContext.Provider value="/films">
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <InspectorEntryContext.Provider
              value={{
                active: { kind: 'film', id: 'film-1', view },
                replaceView: () => {},
              }}
            >
              <ProviderSources
                scope={scope}
                rows={rows}
                initialProvider={initialProvider}
              />
            </InspectorEntryContext.Provider>
          </SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

const openRow = /<details class="ds-source" open="">/

test('returning to a saved Sources entry reopens its row with the history', () => {
  const html = render('tab=sources&sourceProvider=example&sourceMode=history')
  assert.match(html, openRow)
  assert.match(html, /<h4>History<\/h4>/)
  assert.match(html, /aria-label="Example provider history"/)
  assert.match(html, /class="ds-skel"/)
})

test('closing a legacy source row stays closed after restoring its entry', () => {
  const html = render('tab=sources&sourceMode=closed', 'example')
  assert.doesNotMatch(html, openRow)
  assert.doesNotMatch(html, /Example provider history/)
  assert.match(render('tab=sources', 'example'), openRow)
})

test('each provider is one row with its mark, match, identifier, age, state and actions', () => {
  const html = render('tab=sources', undefined, [
    {
      id: 'matched',
      label: 'Matched provider',
      href: '/providers/matched',
      identifier: 'release/42',
      updatedAt: createdAt,
      refresh: noJob,
      links: [
        {
          provider: 'matched',
          label: 'Matched provider',
          url: 'https://provider.example.test/release/42',
        },
      ],
      editor: () => <span>editor</span>,
    },
    {
      id: 'missing',
      label: 'Missing provider',
      unavailable: 'Identifier required',
      refresh: noJob,
      editor: () => <span>editor</span>,
    },
    {
      id: 'waiting',
      label: 'Waiting provider',
      identifier: 'w-1',
      unavailable: 'Provider cooling down',
      refresh: noJob,
    },
    {
      id: 'queued-provider',
      label: 'Queued provider',
      identifier: 'q-1',
      refresh: noJob,
    },
  ])
  assert.match(html, /4 sources · 3 matched · 1 needs an ID/)
  assert.match(html, />Refresh all</)
  assert.match(html, /class="ds-mark" title="Matched provider">MP</)
  assert.match(html, /href="\/providers\/matched"/)
  assert.match(html, /data-status="done">Matched by ID</)
  assert.match(html, /release\/42/)
  assert.match(html, /<time dateTime="2026-01-01T00:00:00.000Z"/)
  assert.match(html, /aria-label="Edit Matched provider identifier"/)
  assert.match(html, /aria-label="Refresh Matched provider"/)
  assert.match(
    html,
    /href="https:\/\/provider.example.test\/release\/42"[^>]*aria-label="Open on Matched provider \(opens in a new tab\)"/,
  )
  assert.match(html, /data-status="attention">Needs ID</)
  assert.match(html, />Add ID</)
  assert.match(html, />Never</)
  assert.match(html, /data-status="waiting">Provider cooling down</)
  assert.match(html, /disabled=""[^>]*aria-label="Refresh Waiting provider"/)
  assert.match(html, /data-status="queued">Queued</)
  assert.match(html, /disabled=""[^>]*aria-label="Refresh Queued provider"/)
  assert.doesNotMatch(html, openRow)
})

test('an open row shows the identifier editor, what the provider supplies, extra blocks and stored data', () => {
  const rows: ProviderSourceRow[] = [
    {
      id: 'example',
      label: 'Example provider',
      identifier: 'id-1',
      editor: (canRefresh) => (
        <span>{canRefresh ? 'editor can refresh' : 'editor'}</span>
      ),
      identifierDetails: () => <span>identifier provenance</span>,
      provides: ['Title', 'Released'],
      blocks: [{ title: 'Scrobble names', content: <span>names</span> }],
      details: <span>stored details</span>,
    },
  ]
  const html = render(
    'sourceProvider=example&sourceMode=history',
    undefined,
    rows,
    [],
  )
  assert.match(html, /<h4>Identifier<\/h4><span>editor<\/span>/)
  assert.match(html, /<h4>Identifier sources<\/h4><span>identifier provenance/)
  assert.match(html, /<h4>Provides<\/h4>/)
  assert.match(html, /aria-label="Supplied by Example provider"/)
  assert.match(html, />Released</)
  assert.match(html, /<h4>Scrobble names<\/h4><span>names/)
  assert.match(html, /<h4>Stored data<\/h4><span>stored details/)
  const editing = render(
    'sourceProvider=example&sourceMode=edit',
    undefined,
    rows,
    [],
  )
  assert.match(editing, /<h4>Identifier<\/h4>/)
  assert.match(
    editing,
    /aria-label="Edit Example provider identifier" aria-expanded="true"/,
  )
  assert.doesNotMatch(editing, /Provides|Stored data|History/)
})

test('read-only rows without a scope offer no refresh and an empty list says so', () => {
  const client = new QueryClient()
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProviderSources
        rows={[
          {
            id: 'spotify',
            label: 'Spotify',
            identifier: 'playlist-1',
            links: [
              {
                provider: 'spotify',
                label: 'Spotify',
                url: 'https://open.spotify.com/playlist/fixture',
              },
            ],
          },
        ]}
      />
    </QueryClientProvider>,
  )
  assert.match(html, /1 source · 1 matched/)
  assert.doesNotMatch(html, /Refresh/)
  const empty = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProviderSources
        rows={[]}
        unavailable="No provider sources are stored."
      />
    </QueryClientProvider>,
  )
  assert.match(empty, /No provider sources are stored\./)
  client.clear()
})

test('source helpers name marks, match states, summaries and merge paged history', () => {
  assert.equal(providerMarkText('MusicBrainz'), 'MB')
  assert.equal(providerMarkText('Last.fm'), 'LF')
  assert.equal(providerMarkText('Spotify'), 'SP')
  assert.equal(providerMarkText('Rate Your Music'), 'RY')
  assert.deepEqual(sourceMatch({ identifier: 'x', refreshable: true }), {
    state: 'done',
    label: 'Matched by ID',
  })
  assert.deepEqual(sourceMatch({ updatedAt: createdAt, refreshable: true }), {
    state: 'done',
    label: 'Matched by name',
  })
  assert.deepEqual(
    sourceMatch({ unavailable: 'Identifier required', refreshable: true }),
    { state: 'attention', label: 'Needs ID' },
  )
  assert.deepEqual(sourceMatch({ refreshable: true }), {
    state: 'never',
    label: 'Not fetched',
  })
  assert.equal(
    sourcesSummary([
      { state: 'done', label: 'Matched by ID' },
      { state: 'attention', label: 'Needs ID' },
      { state: 'attention', label: 'Needs ID' },
    ]),
    '3 sources · 1 matched · 2 need an ID',
  )
  assert.equal(jobState({ status: 'succeeded', waiting: null }), 'done')
  assert.equal(
    jobState({
      status: 'queued',
      waiting: { reason: 'cooldown', until: null, detail: 'Cooling down' },
    }),
    'waiting',
  )
  const merged = mergeHistory([
    {
      items: [
        { at: '2026-01-05T00:00:00Z', id: 'a1' },
        { at: '2026-01-03T00:00:00Z', id: 'a2' },
      ],
      more: true,
    },
    {
      items: [
        { at: '2026-01-04T00:00:00Z', id: 'b1' },
        { at: '2026-01-01T00:00:00Z', id: 'b2' },
      ],
      more: false,
    },
  ])
  assert.deepEqual(
    merged.map((item) => item.id),
    ['a1', 'b1', 'a2'],
  )
})
