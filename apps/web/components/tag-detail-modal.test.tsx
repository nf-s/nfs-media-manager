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

const nested = TagDetailSchema.parse({
  ...detail,
  tag: {
    ...detail.tag,
    id: 'tag-2',
    name: 'Synthetic parent',
    hidden: false,
    parents: [{ id: 'tag-0', name: 'Synthetic root' }],
  },
  children: [
    { id: 'tag-3', name: 'Synthetic child' },
    { id: 'tag-4', name: 'Synthetic sibling' },
  ],
})

function render(node: React.ReactNode, search = '') {
  const client = new QueryClient()
  client.setQueryData(['tag-detail', 'album', 'tag-1', 1], {
    ...detail.provenance,
    summary: detail,
  })
  client.setQueryData(['tag-detail', 'album', 'tag-2', 1], {
    ...nested.provenance,
    summary: nested,
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

test('the overview lists parent tags and subtags, each removable, with pickers to add one', () => {
  const html = render(<TagDetail id="tag-2" mediaType="album" />)
  assert.match(html, /2 subtags/)
  assert.match(html, /<h3>Parent tags<\/h3>/)
  assert.match(html, /role="group" aria-label="Parent tags"/)
  assert.match(html, /Synthetic root/)
  assert.match(html, /aria-label="Remove parent Synthetic root"/)
  assert.match(html, /aria-label="Find parent tag"/)
  assert.match(html, /<h3>Subtags<\/h3>/)
  assert.match(html, /role="group" aria-label="Subtags"/)
  assert.match(html, /aria-label="Remove subtag Synthetic child"/)
  assert.match(html, /aria-label="Remove subtag Synthetic sibling"/)
  assert.match(html, /aria-label="Find subtag"/)
  const plain = render(<TagDetail id="tag-1" mediaType="album" />)
  assert.match(plain, /No parent tags\./)
  assert.match(plain, /No subtags\./)
  assert.doesNotMatch(plain, /\d subtags?</)
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
