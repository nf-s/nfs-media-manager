import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TrackTagGroups } from '@repo/schemas/tracks'
import { ConfigContext } from './providers'
import { TrackTagEditor, useTrackTagEdits } from './track-tag-editor'

const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

function Editor({ tags }: { tags: TrackTagGroups }) {
  return <TrackTagEditor tags={tags} edits={useTrackTagEdits('track-1')} />
}

function render(tags: TrackTagGroups) {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <ConfigContext.Provider
          value={{ appUrl: 'http://localhost', apiBaseUrl: 'http://localhost' }}
        >
          <Editor tags={tags} />
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    assert.equal(network.mock.callCount(), 0)
  }
}

const sonovaultOnly: TrackTagGroups = {
  own: [{ id: 'tag-1', name: 'Deep Current', added: false, sonovault: true }],
  unverified: [],
  removed: [],
}

test('Edit tags adds a tag through the album tag picker', () => {
  const html = render(sonovaultOnly)
  assert.match(html, /<span class="ds-label">Add a tag<\/span>/)
  assert.match(html, /aria-label="Find a tag to add"/)
  // Nothing of the owner's to clear.
  assert.doesNotMatch(html, /Reset to Sonovault/)
})

test('Reset to Sonovault appears once the owner has added or removed a tag', () => {
  assert.match(
    render({
      ...sonovaultOnly,
      own: [
        ...sonovaultOnly.own,
        { id: 'tag-2', name: 'Harbour Bass', added: true, sonovault: false },
      ],
    }),
    />Reset to Sonovault</,
  )
  assert.match(
    render({ ...sonovaultOnly, removed: [{ id: 'tag-3', name: 'Glass Pop' }] }),
    />Reset to Sonovault</,
  )
})
