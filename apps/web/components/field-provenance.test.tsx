import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MediaProvenanceSchema } from '@repo/schemas/provenance'
import { columnWidth, columnsWidth } from '@repo/ui/components/ui/table'
import { FieldProvenance } from './field-provenance'
import { ConfigContext } from './providers'
import { formatFieldValue } from '@/utils/field-provenance'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in field provenance tests')
})

const queryKey = ['history', 'album-1', 'provenance']
const source = {
  snapshotId: 'snap-1',
  snapshotSource: 'scrape-job',
  jobId: 'job-1',
}
const provenance = MediaProvenanceSchema.parse({
  mediaItemId: 'album-1',
  mediaType: 'album',
  fields: [
    {
      key: 'title',
      label: 'Title',
      value: 'Harbour Lights',
      override: null,
      sources: [
        {
          ...source,
          provider: 'spotify',
          scrapedAt: '2026-11-13T09:12:00.000Z',
          value: 'Harbour Lights',
          matchesCurrent: true,
        },
        {
          ...source,
          provider: 'discogs',
          scrapedAt: '2026-11-04T08:00:00.000Z',
          value: 'Harbour Lights (Deluxe)',
          matchesCurrent: false,
        },
      ],
    },
    {
      key: 'releaseDate',
      label: 'Released',
      value: '2019-03-08T00:00:00.000Z',
      override: { at: '2026-10-04T10:00:00.000Z', by: null, note: null },
      sources: [],
    },
    {
      key: 'browse.ratingDiscogsValue',
      label: 'Discogs rating',
      value: 4.4,
      override: null,
      sources: [],
    },
    {
      key: 'watched',
      label: 'Watched',
      value: true,
      override: null,
      sources: [],
    },
    {
      key: 'credits.artist',
      label: 'Artists',
      value: ['Mira Kestrel', 'Second <artist>'],
      override: null,
      sources: [],
    },
    {
      key: 'summary',
      label: 'Summary',
      value: null,
      override: null,
      sources: [],
    },
    {
      key: 'browse.extra',
      label: 'Extra',
      value: { nested: ['value'] },
      override: null,
      sources: [],
    },
  ],
})

function render(data?: unknown, failed = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  })
  if (data !== undefined) client.setQueryData(queryKey, data)
  if (failed)
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
            appUrl: 'https://app.example.test',
            apiBaseUrl: 'https://api.example.test',
          }}
        >
          <FieldProvenance mediaItemId="album-1" />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('All fields lists each value with the providers that supply it and marks edits', () => {
  const html = render(provenance)
  assert.ok(
    html.includes(
      `<table class="ds-table" data-layout="fixed" aria-label="All fields" style="min-width:${columnsWidth([130, 160, 170, 100])}"><colgroup><col style="width:${columnWidth(130)}"/><col/><col style="width:${columnWidth(170)}"/><col style="width:${columnWidth(100)}"/></colgroup>`,
    ),
  )
  for (const header of ['Field', 'Value', 'Source', 'Updated'])
    assert.match(
      html,
      new RegExp(`>${header}<span class="ds-th-resizer" role="separator"`),
    )
  assert.match(html, /title="Harbour Lights">Harbour Lights</)
  assert.match(html, /class="ds-mark" title="Spotify">SP</)
  assert.match(html, /\+1 differs/)
  assert.match(
    html,
    /Discogs · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · supplies Harbour Lights \(Deluxe\)/,
  )
  assert.match(html, />2019-03-08</)
  assert.match(
    html,
    /<span class="ds-pill" data-tone="outline" title="Edited 2026-10-04/,
  )
  assert.match(html, />Edited</)
  assert.match(html, /class="ds-mono" title="4.4">4.4</)
  assert.match(html, />Yes</)
  assert.match(html, />Mira Kestrel</)
  assert.match(html, />Second &lt;artist&gt;</)
  assert.match(html, /class="ds-empty-value">–</)
  assert.match(html, /\{&quot;nested&quot;:\[&quot;value&quot;\]\}/)
})

test('All fields shows a skeleton, an empty state and a retryable error', () => {
  const loading = render()
  assert.match(loading, /aria-busy="true"/)
  assert.match(loading, /class="ds-skel"/)
  assert.doesNotMatch(loading, /<table/)
  assert.match(render({ ...provenance, fields: [] }), /No stored fields/)
  const failed = render(undefined, true)
  assert.match(failed, /role="alert"/)
  assert.match(failed, /Could not load fields/)
  assert.match(failed, />Retry</)
})

test('values of every JSON type format for one cell', () => {
  assert.deepEqual(formatFieldValue(null), { kind: 'empty' })
  assert.deepEqual(formatFieldValue(''), { kind: 'empty' })
  assert.deepEqual(formatFieldValue([]), { kind: 'empty' })
  assert.deepEqual(formatFieldValue('2019-03-08T00:00:00.000Z'), {
    kind: 'text',
    text: '2019-03-08',
  })
  assert.deepEqual(formatFieldValue(2538), { kind: 'number', text: '2,538' })
  assert.deepEqual(formatFieldValue(false), { kind: 'text', text: 'No' })
  assert.deepEqual(formatFieldValue(['a', 2]), {
    kind: 'list',
    items: ['a', '2'],
  })
  assert.deepEqual(formatFieldValue([{ a: 1 }]), {
    kind: 'json',
    text: '[{"a":1}]',
  })
})
