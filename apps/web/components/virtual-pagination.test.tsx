import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
        `data-height="${(known ? total : 100) * 32}" data-counting="${!known}"`,
      ),
    )
    assert.doesNotMatch(html, /Fixture 80/)
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
