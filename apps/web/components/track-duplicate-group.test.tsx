import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
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
  merge: {
    keep: { id: 'track-a', title: 'Harbour Lights', by: 'Fixture Artist' },
    versions: 0,
    removed: 1,
    removedRecords: 1,
  },
}

const kept = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'track',
  action: 'keep-separate',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: null,
  sources: [
    { id: 'track-a', title: 'Harbour Lights', by: 'Fixture', exists: true },
    { id: 'track-b', title: 'Harbour Lights', by: 'Fixture', exists: true },
  ],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
  details: null,
})

/** The parts of the group actions the result bar reads, with no change made. */
function reporting(
  change: typeof kept | null,
  error: string | null,
): Parameters<
  typeof import('./track-duplicate-group').TrackDuplicateResultBar
>[0]['actions'] {
  return {
    change,
    error,
    setChange: () => undefined,
    setError: () => undefined,
    dismiss: () => undefined,
  }
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
    /^<div class="ds-notice" role="status"><svg[^>]*>.*?<\/svg><span>Possible duplicate: “Harbour Lights \(Remastered 2011\)” by Fixture Artist\. Same artist · Same title without “Remastered 2011”\. Merge keeps “Harbour Lights”: 1 Last\.fm record is removed and its plays and names move to it\.<\/span><span class="ds-actions"><button class="ds-btn" data-size="xs">Merge<\/button><button class="ds-btn" data-variant="ghost" data-size="xs">Keep separate<\/button><\/span><\/div>$/,
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

test('a group row has Merge and Keep separate, then what Merge does and the evidence', async () => {
  const { TrackDuplicateGroupRow, useTrackDuplicateActions } =
    await import('./track-duplicate-group')
  function Row({ merge = group.merge }: { merge?: typeof group.merge | null }) {
    const actions = useTrackDuplicateActions()
    return (
      <table>
        <tbody>
          <TrackDuplicateGroupRow
            group={{ ...group, merge }}
            colSpan={4}
            rowIndex={2}
            actions={actions}
          />
        </tbody>
      </table>
    )
  }
  const text =
    'Merge keeps “Harbour Lights”: 1 Last.fm record is removed and its plays and names move to it · Same artist · Same title without “Remastered 2011”'
  assert.equal(
    render(new QueryClient(), <Row />),
    `<table><tbody><tr data-group="" aria-rowindex="2"><td colSpan="4"><span class="ds-group-actions"><button class="ds-btn" data-size="xs">Merge</button><button class="ds-btn" data-variant="ghost" data-size="xs">Keep separate</button><span class="ds-group-evidence" title="${text}">${text}</span></span></td></tr></tbody></table>`,
  )
  // A group whose members cannot all be read shows only the evidence.
  assert.match(
    render(new QueryClient(), <Row merge={null} />),
    /title="Same artist · Same title without “Remastered 2011”">Same artist · Same title without “Remastered 2011”<\/span>/,
  )
})

test('with no result the bar under the table is hidden; a result shows with Undo, an error with Dismiss', async () => {
  const { TrackDuplicateResultBar } = await import('./track-duplicate-group')
  assert.equal(
    render(
      new QueryClient(),
      <TrackDuplicateResultBar actions={reporting(null, null)} />,
    ),
    '<div class="ds-selectbar sec-selectbar"></div>',
  )
  const result = render(
    new QueryClient(),
    <TrackDuplicateResultBar actions={reporting(kept, null)} />,
  )
  assert.match(
    result,
    /^<div class="ds-selectbar sec-selectbar">.*Kept 2 tracks separate: “Harbour Lights”, “Harbour Lights”.*<button class="ds-btn">Undo<\/button><button class="ds-btn" data-icon="" aria-label="Dismiss">/,
  )
  const failed = render(
    new QueryClient(),
    <TrackDuplicateResultBar
      actions={reporting(null, 'The tracks could not be kept separate.')}
    />,
  )
  assert.match(
    failed,
    /<span role="alert">The tracks could not be kept separate\.<\/span>.*aria-label="Dismiss"/,
  )
})

test('Merge plans the whole group keeping its first track, and Keep separate posts the group', async (t) => {
  const { useTrackDuplicateActions } = await import('./track-duplicate-group')
  const requests: { url: URL; body: unknown }[] = []
  network.mock.mockImplementation(async (input, init) => {
    requests.push({
      url: new URL(input instanceof Request ? input.url : String(input)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return Response.json(
      { statusCode: 500, message: 'Fixture failure' },
      { status: 500 },
    )
  })
  t.after(() => {
    network.mock.mockImplementation(async () => {
      throw new Error('Network forbidden in UI tests')
    })
    network.mock.resetCalls()
  })
  const client = new QueryClient()
  const captured: ReturnType<typeof useTrackDuplicateActions>[] = []
  function Capture() {
    captured.push(useTrackDuplicateActions())
    return null
  }
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{
          appUrl: 'http://localhost:3001',
          apiBaseUrl: 'http://localhost:4001',
        }}
      >
        <Capture />
      </ConfigContext.Provider>
    </QueryClientProvider>,
  )
  const [actions] = captured
  assert.ok(actions)
  // The plan fails here, so nothing is merged and no review opens.
  assert.equal(await actions.merge(group), null)
  actions.keepSeparate(group)
  while (client.isMutating())
    await new Promise((resolve) => setTimeout(resolve, 0))
  client.clear()
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    [
      '/api/v1/library-changes/track-merges/plan',
      '/api/v1/library-changes/track-separations',
    ],
  )
  assert.deepEqual(requests[0]?.body, {
    trackIds: ['track-a', 'track-b'],
    targetId: 'track-a',
  })
  assert.deepEqual(requests[1]?.body, { trackIds: ['track-a', 'track-b'] })
})
