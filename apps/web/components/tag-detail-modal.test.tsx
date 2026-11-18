import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { TagDetailSchema } from '@repo/schemas/tags'
import TagDetailModal, { TagDetail } from './tag-detail-modal'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const detail = TagDetailSchema.parse({
  tag: {
    mediaType: 'album',
    id: 'tag-1',
    name: 'Synthetic tag',
    kind: 'genre',
    mediaCount: 4,
    hidden: true,
    mergedNames: [],
    sources: [],
    sourceCount: 2,
  },
  aliases: [{ id: 'alias-1', name: 'Synthetic alias', kind: 'genre' }],
  provenance: {
    mediaType: 'album',
    page: 1,
    size: 50,
    pageCount: 0,
    totalCount: 0,
    items: [],
  },
})

function render(node: React.ReactNode, search = '') {
  const client = new QueryClient()
  client.setQueryData(['tag-detail', 'album', 'tag-1', 1], {
    ...detail.provenance,
    summary: detail,
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{ appUrl: 'http://localhost', apiBaseUrl: 'http://localhost' }}
        >
          <SearchParamsContext.Provider value={new URLSearchParams(search)}>
            {node}
          </SearchParamsContext.Provider>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('a tag has the shared header and Overview and Sources tabs', () => {
  const html = render(<TagDetail id="tag-1" mediaType="album" />)
  assert.match(html, /<div class="ds-kicker">Tag<\/div>/)
  assert.match(html, /<h2 class="ds-detail-title">Synthetic tag<\/h2>/)
  assert.match(html, /4 items/)
  assert.match(html, /data-status="paused">Hidden</)
  const tabs = [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map(
    (match) => match[1],
  )
  assert.deepEqual(tabs, ['Overview', 'Sources'])
  assert.match(html, /Synthetic alias/)
  assert.match(html, /<h3>Manage tag<\/h3>/)
  assert.match(html, />Unhide</)
  assert.match(
    html,
    /href="\/albums\?filters=[^"]+">Browse albums with this tag/,
  )
  const sources = render(
    <TagDetail id="tag-1" mediaType="album" />,
    'tab=sources',
  )
  assert.match(sources, /<h3>Detailed provenance<\/h3>/)
  assert.match(sources, /aria-label="Find tag to merge"/)
})

test('outside the app drawer a tag opens in a drawer frame of its own', () => {
  const html = render(
    <TagDetailModal id="tag-1" mediaType="album" onClose={() => {}} />,
  )
  assert.match(html, /<aside aria-label="Tag details" class="media-inspector"/)
  assert.match(html, /aria-label="Close tag details"/)
  assert.doesNotMatch(html, /<dialog/)
  assert.match(html, /Synthetic tag/)
})
