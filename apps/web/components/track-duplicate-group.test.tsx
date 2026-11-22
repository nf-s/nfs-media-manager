import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  LibraryChangeSchema,
  type LibraryChangeAction,
} from '@repo/schemas/library-changes'
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
  function Row({
    merge = group.merge,
    cautions = group.cautions,
  }: {
    merge?: typeof group.merge | null
    cautions?: Parameters<typeof TrackDuplicateGroupRow>[0]['group']['cautions']
  }) {
    const actions = useTrackDuplicateActions()
    return (
      <table>
        <tbody>
          <TrackDuplicateGroupRow
            group={{ ...group, merge, cautions }}
            colSpan={4}
            rowIndex={2}
            actions={actions}
          />
        </tbody>
      </table>
    )
  }
  const html = render(new QueryClient(), <Row />)
  assert.match(
    html,
    /^<table><tbody><tr data-group="" aria-rowindex="2"><td colSpan="4"><span class="ds-group-actions"><button class="ds-btn" data-size="xs">Merge<\/button><button class="ds-btn" data-variant="ghost" data-size="xs">Keep separate<\/button><div class="secondary-cell-details">.*aria-label="What Merge does".*<div>Merge keeps “Harbour Lights”: 1 Last\.fm record is removed and its plays and names move to it\.<\/div><div>Same artist<\/div><div>Same title without “Remastered 2011”<\/div><\/div><\/div><\/span><\/td><\/tr><\/tbody><\/table>$/,
  )
  // With nothing against merging the row has no line of its own.
  assert.doesNotMatch(html, /ds-group-evidence/)
  assert.match(
    render(
      new QueryClient(),
      <Row cautions={[{ code: 'duration', seconds: 30 }]} />,
    ),
    /<span class="ds-group-evidence" title="Against merging: [^"]+">Against merging: /,
  )
  // A group whose members cannot all be read still shows the evidence.
  assert.match(
    render(new QueryClient(), <Row merge={null} />),
    /<div>Same artist<\/div><div>Same title without “Remastered 2011”<\/div>/,
  )
})

test('only the pressed group’s actions are off, and its row says what is happening to it', async () => {
  const { TrackDuplicateGroupRow } = await import('./track-duplicate-group')
  type Item = ReturnType<
    Parameters<typeof TrackDuplicateGroupRow>[0]['actions']['status']
  >
  const row = (item: Item) =>
    render(
      new QueryClient(),
      <table>
        <tbody>
          <TrackDuplicateGroupRow
            group={{ ...group, cautions: [{ code: 'duration', seconds: 30 }] }}
            colSpan={4}
            actions={{
              merge: async () => undefined,
              keepSeparate: async () => undefined,
              status: () => item,
            }}
          />
        </tbody>
      </table>,
    )
  const off =
    /<button class="ds-btn" data-size="xs" disabled="">Merge<\/button><button class="ds-btn" data-variant="ghost" data-size="xs" disabled="">Keep separate<\/button>/
  const on =
    /<button class="ds-btn" data-size="xs">Merge<\/button><button class="ds-btn" data-variant="ghost" data-size="xs">Keep separate<\/button>/
  const line = (text: string) =>
    new RegExp(`<span class="ds-group-evidence" title="${text}">${text}</span>`)
  // Another group is being merged: this one is untouched and usable.
  const idle = row(undefined)
  assert.match(idle, on)
  assert.match(idle, line('Against merging: [^"]+'))
  for (const [item, text] of [
    [{ status: 'queued', action: 'merge' }, 'Merging…'],
    [{ status: 'running', action: 'merge' }, 'Merging…'],
    [{ status: 'running', action: 'keep-separate' }, 'Keeping separate…'],
    [{ status: 'review', action: 'merge' }, 'Needs review'],
    [{ status: 'done', action: 'merge', change: kept }, 'Merged'],
    [
      { status: 'done', action: 'keep-separate', change: kept },
      'Kept separate',
    ],
  ] satisfies [Item, string][]) {
    const html = row(item)
    assert.match(html, off)
    assert.match(html, line(text))
  }
  // A failed group can be tried again; its row says why it failed.
  const failed = row({
    status: 'failed',
    action: 'merge',
    message: 'The tracks could not be merged.',
  })
  assert.match(failed, on)
  assert.match(failed, line('The tracks could not be merged\\.'))
})

test('the bar says how many groups are still to go, in words', async () => {
  const { describeTrackDuplicateProgress } =
    await import('./track-duplicate-group')
  const merge: { action: LibraryChangeAction } = { action: 'merge' }
  const separate: { action: LibraryChangeAction } = { action: 'keep-separate' }
  assert.equal(describeTrackDuplicateProgress([]), null)
  assert.equal(describeTrackDuplicateProgress([merge]), 'Merging 1 group…')
  assert.equal(
    describeTrackDuplicateProgress([merge, merge, merge]),
    'Merging 3 groups…',
  )
  assert.equal(
    describeTrackDuplicateProgress([separate, separate]),
    'Keeping 2 groups separate…',
  )
  assert.equal(
    describeTrackDuplicateProgress([merge, separate, merge]),
    'Merging 2 groups, keeping 1 separate…',
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
  // While groups are still to go the bar says how many, before the result.
  assert.match(
    render(
      new QueryClient(),
      <TrackDuplicateResultBar
        actions={{ ...reporting(kept, null), progress: 'Merging 3 groups…' }}
      />,
    ),
    /^<div class="ds-selectbar sec-selectbar"><span role="status">Merging 3 groups…<\/span><span class="ds-selectbar-result" role="status">.*Kept 2 tracks separate/,
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

test('Merge plans the whole group keeping its first track, and Keep separate posts the group, one request at a time in the order pressed', async (t) => {
  const { useTrackDuplicateActions } = await import('./track-duplicate-group')
  const requests: { url: URL; body: unknown }[] = []
  let running = 0
  let most = 0
  network.mock.mockImplementation(async (input, init) => {
    requests.push({
      url: new URL(input instanceof Request ? input.url : String(input)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    running += 1
    most = Math.max(most, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running -= 1
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
  const other = { memberIds: ['track-c', 'track-d'] }
  // Both return at once; the second waits for the first. The plan fails
  // here, so nothing is merged and no review opens, and the next goes on.
  const merging = actions.merge(group)
  const separating = actions.keepSeparate(other)
  assert.equal(requests.length, 0)
  await Promise.all([merging, separating])
  // A failed group can be tried again.
  await actions.keepSeparate(group)
  client.clear()
  assert.equal(most, 1)
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    [
      '/api/v1/library-changes/track-merges/plan',
      '/api/v1/library-changes/track-separations',
      '/api/v1/library-changes/track-separations',
    ],
  )
  assert.deepEqual(requests[0]?.body, {
    trackIds: ['track-a', 'track-b'],
    targetId: 'track-a',
  })
  assert.deepEqual(requests[1]?.body, { trackIds: ['track-c', 'track-d'] })
  assert.deepEqual(requests[2]?.body, { trackIds: ['track-a', 'track-b'] })
})

test('after a merge from the notice, onChange gets the change', async (t) => {
  const { useTrackDuplicateActions } = await import('./track-duplicate-group')
  const merged = LibraryChangeSchema.parse({
    ...kept,
    id: 'change-2',
    action: 'merge',
    target: kept.sources[0],
    sources: [{ ...kept.sources[1], exists: false }],
  })
  const plan = {
    targetId: 'track-a',
    tracks: ['track-a', 'track-b'].map((id, index) => ({
      id,
      title: 'Harbour Lights',
      by: 'Fixture',
      albumTitle: null,
      durationSec: 200,
      scrobbles: 6,
      spotify: false,
      nameCount: 1,
      identity: null,
      outcome: index === 0 ? 'keep' : 'merge',
      blocked: null,
    })),
    names: [],
    scrobbles: { target: 6, added: 6, total: 12 },
    also: { albumNames: [], titles: [] },
    cautions: [],
    blocked: false,
  }
  network.mock.mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: url.endsWith('/plan') ? plan : merged,
    })
  })
  t.after(() => {
    network.mock.mockImplementation(async () => {
      throw new Error('Network forbidden in UI tests')
    })
    network.mock.resetCalls()
  })
  const changes: unknown[] = []
  const captured: ReturnType<typeof useTrackDuplicateActions>[] = []
  function Capture() {
    captured.push(
      useTrackDuplicateActions({ onChange: (next) => changes.push(next) }),
    )
    return null
  }
  const client = new QueryClient()
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
  await actions.merge(group)
  client.clear()
  assert.deepEqual(changes, [merged])
})
