import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  LibraryChangeSchema,
  type LibraryChange,
} from '@repo/schemas/library-changes'
import { LibraryChangeRow } from './library-changes'
import { ConfigContext } from './providers'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const record = (id: string, title: string, exists = true) => ({
  id,
  title,
  by: 'Example Artist',
  exists,
})

const merge = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'track',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: record('track-1', 'Night Drive'),
  sources: [record('track-2', 'Nite Drive', false)],
  names: [
    { artistName: 'Example Artist', trackName: 'Nite Drive', scrobbles: 12 },
  ],
  nameCount: 1,
  scrobbles: 1234,
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
  details: null,
})

const columns = ['when', 'change', 'by', 'scrobbles']

function render(change: LibraryChange) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
          <table>
            <tbody>
              <LibraryChangeRow change={change} columns={columns} index={0} />
            </tbody>
          </table>
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('a change row shows when, what, who, scrobbles moved and Undo', () => {
  const html = render(merge)
  assert.match(html, /aria-rowindex="2"/)
  assert.match(html, /<span class="ds-num">2026-03-04 \d{2}:\d{2}<\/span>/)
  assert.match(
    html,
    /<span class="ds-cell-two"><span class="ds-cell-title" title="Merged “Nite Drive” into “Night Drive”">Merged “Nite Drive” into “Night Drive”<\/span><span class="ds-cell-sub" title="Example Artist · Nite Drive">Example Artist · Nite Drive<\/span><\/span>/,
  )
  assert.match(html, /data-status="done"[^>]*>You<\/span>/)
  assert.match(html, />1,234</)
  assert.match(html, /<button[^>]*>Undo<\/button>/)
  assert.doesNotMatch(html, /disabled/)
})

test('the sub line gives the names moved, the rule and why Undo or Redo is not offered', () => {
  const html = render({
    ...merge,
    actor: 'automatic',
    rule: 'Same title and artist',
    nameCount: 3,
    scrobbles: 0,
    canUndo: false,
  })
  const reason = 'A later change moved these names. Undo that change first'
  const note = `Example Artist · Nite Drive and 2 more. Same title and artist. ${reason}`
  assert.ok(
    html.includes(`<span class="ds-cell-sub" title="${note}">${note}</span>`),
  )
  assert.match(html, /data-status="done"[^>]*>Automatic<\/span>/)
  assert.match(html, /–/)
  assert.match(
    html,
    new RegExp(`<button[^>]*disabled=""[^>]*title="${reason}\\.`),
  )
})

test('an undone change shows Undone and offers Redo', () => {
  const html = render({
    ...merge,
    undoneAt: '2026-03-05T05:06:00.000Z',
    canRedo: true,
  })
  assert.match(html, /data-status="cancelled"[^>]*>Undone<\/span>/)
  assert.match(html, /<button[^>]*>Redo<\/button>/)
})
