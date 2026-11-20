import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query'
import { z } from 'zod'
import { useVirtualBrowse } from '@/hooks/useVirtualBrowse'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { SecondaryVirtualRows } from './secondary-table'

const firstKey = ['tracks', 'browse', 'fixture view', 1]
const countKey = ['tracks', 'browse-count', 'filters=%5B%5D']
const params = new URLSearchParams({
  filters: '[]',
  sortBy: 'title',
  direction: 'desc',
})

function render(client: QueryClient, node: React.ReactNode) {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    )
  } finally {
    client.clear()
  }
}

test('Browse renders ready rows before the count and reserves the full extent only when known', () => {
  function View() {
    const window = useVirtualBrowse({
      apiBaseUrl: 'https://example.test',
      collection: 'tracks',
      identity: 'fixture view',
      params,
      enabled: true,
      columns: 1,
      rowHeight: 32,
      scrollTop: 0,
      viewportHeight: 96,
      headerHeight: 24,
      itemSchema: z.string(),
    })
    return (
      <table data-height={window.height} data-counting={window.isCounting}>
        <tbody>
          <SecondaryVirtualRows
            window={{ ...window, rowHeight: 32 }}
            colSpan={1}
            renderRow={(item) => (
              <tr>
                <td>{item}</td>
              </tr>
            )}
          />
        </tbody>
      </table>
    )
  }
  for (const total of [undefined, 40, 100, 305]) {
    const client = new QueryClient()
    client.setQueryData(firstKey, {
      page: 1,
      size: 100,
      hasMore: true,
      items: Array.from({ length: 100 }, (_, index) => `Fixture ${index + 1}`),
    })
    if (total) client.setQueryData(countKey, { totalCount: total })
    const html = render(client, <View />)
    assert.match(html, /Fixture 1<\/td>/)
    const known = total !== undefined && total > 100
    assert.match(
      html,
      new RegExp(
        `data-height="${(known ? total : 101) * 32}" data-counting="${!known}"`,
      ),
    )
    assert.doesNotMatch(html, /Fixture 80/)
  }
})

test('Browse follows page lookahead while the exact count is pending or failed', async () => {
  const pageKey = firstKey.slice(0, -1)
  const page = (number: number, length: number, hasMore: boolean) => ({
    items: Array.from(
      { length },
      (_, i) => `Row ${(number - 1) * 100 + i + 1}`,
    ),
    hasMore,
  })
  function View({ top }: { top: number }) {
    const rows = useVirtualBrowse({
      apiBaseUrl: 'https://example.test',
      collection: 'tracks',
      identity: 'fixture view',
      params,
      enabled: true,
      columns: 1,
      rowHeight: 32,
      scrollTop: top,
      viewportHeight: 96,
      headerHeight: 0,
      itemSchema: z.string(),
    })
    return (
      <div
        data-pages={rows.pages.join(',')}
        data-total={rows.hasTotal ? rows.total : 'unknown'}
      >
        {rows.slots.map((slot) => slot.item).join('|')}
      </div>
    )
  }
  for (const failed of [false, true]) {
    const client = new QueryClient()
    if (failed)
      await assert.rejects(
        client.fetchQuery({
          queryKey: countKey,
          queryFn: async () => {
            throw new Error('fixture count unavailable')
          },
          retry: false,
        }),
      )
    client.setQueryData(firstKey, page(1, 100, true))
    const at = (top: number) =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <View top={top} />
        </QueryClientProvider>,
      )
    try {
      assert.match(at(0), /data-pages="1" data-total="unknown"/)
      assert.match(at(99 * 32), /data-pages="1,2" data-total="unknown"/)
      client.setQueryData([...pageKey, 2], page(2, 100, true))
      if (!failed) client.setQueryData(countKey, { totalCount: 120 })
      assert.match(at(100 * 32), /Row 101/)
      assert.match(at(199 * 32), /data-pages="2,3" data-total="unknown"/)
      client.setQueryData([...pageKey, 3], page(3, 3, false))
      const end = at(202 * 32)
      assert.match(end, /data-pages="2,3" data-total="203"/)
      assert.match(end, /Row 203/)
      assert.doesNotMatch(end, /Row 204/)
    } finally {
      client.clear()
    }
  }
})

test('an explicitly requested playback total completes when Browse unmounts', async () => {
  const client = new QueryClient()
  const captured: { resolve?: (index: number) => Promise<number> } = {}
  function Capture() {
    captured.resolve = useVirtualBrowse({
      apiBaseUrl: 'https://example.test',
      collection: 'tracks',
      identity: 'fixture view',
      params,
      enabled: true,
      columns: 1,
      rowHeight: 32,
      scrollTop: 0,
      viewportHeight: 96,
      headerHeight: 0,
      itemSchema: z.string(),
    }).resolveTotal
    return null
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Capture />
    </QueryClientProvider>,
  )
  assert.ok(captured.resolve)
  let finish: () => void = () => {
    throw new Error('Count never started')
  }
  const countOptions = {
    queryKey: countKey,
    retry: false,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      new Promise<{ totalCount: number }>((resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('Count was canceled')),
        )
        finish = () => {
          resolve({ totalCount: 250 })
        }
      }),
  }
  const leaveBrowse = new QueryObserver(client, countOptions).subscribe(
    () => undefined,
  )
  try {
    const exactTotal = captured.resolve(5)
    leaveBrowse()
    finish()
    assert.equal(await exactTotal, 250)
    assert.equal(
      client.getQueryCache().find({ queryKey: countKey })?.getObserversCount(),
      0,
    )
  } finally {
    leaveBrowse()
    client.clear()
  }
})

test('a secondary pager retains visited pages for selection without rendering them in the active window', () => {
  const scopes = ['test-pager', []]
  function View() {
    const window = useVirtualTable({
      queryKey: scopes,
      pageSize: 25,
      loadPage: async () => ({
        items: ['unexpected network result'],
        totalCount: 250,
      }),
    })
    return (
      <table data-loaded={window.loadedSlots.map(({ item }) => item).join(',')}>
        <tbody>
          <SecondaryVirtualRows
            window={window}
            colSpan={1}
            renderRow={(item) => (
              <tr>
                <td>{item}</td>
              </tr>
            )}
          />
        </tbody>
      </table>
    )
  }
  const client = new QueryClient()
  client.setQueryData([...scopes, 10], {
    items: ['Visited final page'],
    totalCount: 250,
  })
  client.setQueryData([...scopes, 1], {
    items: ['Initial page'],
    totalCount: 250,
  })
  client.setQueryData(['test-pager', ['old'], 1], {
    items: ['Other filter'],
    totalCount: 10,
  })
  const html = render(client, <View />)
  assert.match(html, /data-loaded="Initial page,Visited final page"/)
  assert.doesNotMatch(html, />Visited final page<|Other filter/)
  assert.match(html, /Initial page<\/td>/)
  assert.match(html, /virtual-browse-placeholder/)
})
