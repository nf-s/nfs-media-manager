import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigContext } from './providers'

require.extensions['.css'] = (module) => {
  module.exports = {}
}
const network = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Network forbidden in UI tests')
})

const group = {
  id: 'group-1',
  rule: 'key' as const,
  evidence: ['Same artist', 'Same title without “Remastered 2011”'],
  cautions: [],
  memberCount: 2,
  scrobbles: 12,
  memberIds: ['track-a', 'track-b'],
}

function render(client: QueryClient, children: ReactNode) {
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConfigContext.Provider
          value={{
            appUrl: 'http://localhost:3001',
            apiBaseUrl: 'http://localhost:4001',
          }}
        >
          {children}
        </ConfigContext.Provider>
      </QueryClientProvider>,
    )
  } finally {
    client.clear()
    assert.equal(network.mock.callCount(), 0)
  }
}

test('an open track in a group shows one notice naming the other track and the evidence, with Merge and Keep separate', async () => {
  const { TrackDuplicateNotice } = await import('./track-duplicate-group')
  const client = new QueryClient()
  client.setQueryData(['track', 'track-a', 'duplicates'], {
    items: [
      {
        ...group,
        others: [
          {
            id: 'track-b',
            title: 'Harbour Lights (Remastered 2011)',
            by: 'Fixture Artist',
          },
        ],
      },
    ],
  })
  const html = render(client, <TrackDuplicateNotice trackId="track-a" />)
  assert.match(
    html,
    /^<div class="ds-notice" role="status"><svg[^>]*>.*?<\/svg><span>Possible duplicate: “Harbour Lights \(Remastered 2011\)” by Fixture Artist\. Same artist · Same title without “Remastered 2011”<\/span><span class="ds-actions"><button class="ds-btn" data-size="xs">Merge<\/button><button class="ds-btn" data-variant="ghost" data-size="xs">Keep separate<\/button><\/span><\/div>$/,
  )
})

test('a track in no group shows no notice', async () => {
  const { TrackDuplicateNotice } = await import('./track-duplicate-group')
  const client = new QueryClient()
  client.setQueryData(['track', 'track-a', 'duplicates'], { items: [] })
  assert.equal(render(client, <TrackDuplicateNotice trackId="track-a" />), '')
  // Nothing shows while the groups load.
  assert.equal(
    render(new QueryClient(), <TrackDuplicateNotice trackId="track-a" />),
    '',
  )
})

test('with nothing selected and no result, the bar under the table is the merge bar, hidden', async () => {
  const { TrackDuplicateMergeBar, useTrackDuplicateActions } =
    await import('./track-duplicate-group')
  const { useRowSelection } = await import('./merge-bar')
  function Bar() {
    const actions = useTrackDuplicateActions()
    const selection = useRowSelection(['track-a', 'track-b'])
    return (
      <TrackDuplicateMergeBar
        actions={actions}
        selection={selection}
        total={2}
      />
    )
  }
  assert.equal(
    render(new QueryClient(), <Bar />),
    '<div class="ds-selectbar sec-selectbar"></div>',
  )
})
