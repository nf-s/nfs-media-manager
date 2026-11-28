import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  LibraryChangeSchema,
  TrackMergePlanSchema,
  type LibraryChange,
  type TrackMergePlan,
} from '@repo/schemas/library-changes'
import {
  combineLibraryChanges,
  createMergeQueue,
  describeMergeProgress,
  LibraryChangeReport,
  mergeNeedsTickedRows,
  RowSelectAll,
  SelectAllMatching,
  SelectionBar,
  useMerge,
  type MergeAdapter,
  type RowSelection,
} from './merge-bar'
import {
  describeRowSelection,
  emptyRowSelection,
  selectMatchingRows,
  setLoadedRows,
  toggleRow,
  type RowSelectionState,
  type SelectionRows,
} from '@/utils/row-selection'
import { ConfigContext } from './providers'
import { TrackMergeBar } from './track-merge-bar'
import { AddToPlaylistButton } from './library-playlist-picker'
import { trackMergeAdapter } from './track-merge-review'
import type { PlaylistSubject } from '@/utils/library-playlists'

const apiBaseUrl = 'http://localhost:4001'

const planTrack = (
  id: string,
  title: string,
  outcome: 'keep' | 'merge' = 'merge',
) => ({
  id,
  title,
  by: 'Example Artist',
  albumTitle: null,
  durationSec: 200,
  scrobbles: 10,
  spotify: false,
  nameCount: 1,
  identity: null,
  outcome,
  blocked: null,
})

const cleanPlan = TrackMergePlanSchema.parse({
  targetId: 'track-1',
  tracks: [
    planTrack('track-1', 'Night Drive', 'keep'),
    planTrack('track-2', 'Nite Drive'),
  ],
  names: [
    {
      trackId: 'track-2',
      artistName: 'Example Artist',
      trackName: 'Nite Drive',
      count: 10,
      counted: false,
    },
  ],
  scrobbles: { target: 10, added: 10, total: 20 },
  also: { albumNames: [], titles: [] },
  cautions: [],
  blocked: false,
})
const cautionPlan = TrackMergePlanSchema.parse({
  ...cleanPlan,
  cautions: [{ code: 'duration', seconds: 30 }],
})

const merged = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'track',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: {
    id: 'track-1',
    title: 'Night Drive',
    by: 'Example Artist',
    exists: true,
  },
  sources: [
    { id: 'track-2', title: 'Nite Drive', by: 'Example Artist', exists: false },
  ],
  names: [
    { artistName: 'Example Artist', trackName: 'Nite Drive', scrobbles: 10 },
  ],
  nameCount: 1,
  scrobbles: 10,
  details: null,
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
})

function Providers({
  client,
  children,
}: {
  client: QueryClient
  children: ReactNode
}) {
  return (
    <QueryClientProvider client={client}>
      <ConfigContext.Provider
        value={{ appUrl: 'http://localhost:3001', apiBaseUrl }}
      >
        {children}
      </ConfigContext.Provider>
    </QueryClientProvider>
  )
}

function selectionOf(ids: string[]): RowSelection {
  return {
    ...describeRowSelection({ ...emptyRowSelection(), ids }, { ordered: [] }),
    some: ids.length > 0,
    toggle: () => undefined,
    setAll: () => undefined,
    selectMatching: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
  }
}

test('the track Merge bar stays empty, asks for two tracks, then offers Merge', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const render = (ids: string[]) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <TrackMergeBar selection={selectionOf(ids)} total={250} />
      </Providers>,
    )
  try {
    assert.equal(render([]), '<div class="ds-selectbar sec-selectbar"></div>')
    const one = render(['track-1'])
    assert.match(
      one,
      /<button[^>]*disabled=""[^>]*title="Select two or more tracks to merge"[^>]*>Merge<\/button>/,
    )
    assert.match(one, /aria-label="Clear selection"/)
    const two = render(['track-1', 'track-2'])
    assert.match(two, /<button[^>]*>Merge<\/button>/)
    assert.doesNotMatch(two, /disabled=""[^>]*>Merge</)
    assert.doesNotMatch(two, /Select two or more tracks to merge/)
    assert.doesNotMatch(two, /<dialog/)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

test('the track review shows the evidence, the track to keep and the error after the notices', () => {
  const { Review } = trackMergeAdapter
  const replans: unknown[] = []
  const html = renderToStaticMarkup(
    <Review
      plan={cautionPlan}
      pending={false}
      replan={(request) => replans.push(request)}
      follow
      setFollow={() => undefined}
      error={<p>Example error</p>}
    />,
  )
  assert.match(html, /Check before merging\. Lengths differ by 0:30\./)
  assert.match(html, /<\/div><p>Example error<\/p>/)
  assert.match(html, /aria-label="Shown as"/)
  assert.match(html, /aria-label="Tracks to merge"/)
  assert.equal(trackMergeAdapter.wording.title(cautionPlan), 'Merge 2 tracks')
  assert.equal(trackMergeAdapter.needsReview(cleanPlan), false)
  assert.equal(trackMergeAdapter.needsReview(cautionPlan), true)
  assert.deepEqual(trackMergeAdapter.request(cleanPlan), {
    ids: ['track-1', 'track-2'],
    keepId: 'track-1',
  })
  assert.deepEqual(replans, [])
})

async function mergeWithoutSelection(t: TestContext, plan: TrackMergePlan) {
  const requests: Array<{ url: string; body: unknown }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: url.endsWith('/plan') ? plan : merged,
      })
    },
  )
  const invalidated: LibraryChange[] = []
  const finished: LibraryChange[] = []
  const adapter: MergeAdapter<TrackMergePlan> = {
    ...trackMergeAdapter,
    invalidate: async (_client, change) => {
      invalidated.push(change)
    },
  }
  let merge: ((ids: readonly string[]) => Promise<unknown>) | undefined
  function GroupMerge() {
    merge = useMerge(adapter, {
      onMerge: (change) => finished.push(change),
    }).merge
    return null
  }
  const client = new QueryClient()
  try {
    renderToStaticMarkup(
      <Providers client={client}>
        <GroupMerge />
      </Providers>,
    )
    assert.ok(merge)
    const outcome = await merge(['track-1', 'track-2'])
    return { outcome, requests, invalidated, finished }
  } finally {
    client.clear()
  }
}

test('merge(ids) merges at once without a selection when the plan is clean', async (t) => {
  const { outcome, requests, invalidated, finished } =
    await mergeWithoutSelection(t, cleanPlan)
  assert.deepEqual(requests, [
    {
      url: `${apiBaseUrl}/api/v1/library-changes/track-merges/plan`,
      body: { trackIds: ['track-1', 'track-2'] },
    },
    {
      url: `${apiBaseUrl}/api/v1/library-changes/track-merges`,
      body: { trackIds: ['track-1', 'track-2'], reviewed: false },
    },
  ])
  assert.deepEqual(outcome, { status: 'merged', change: merged })
  assert.deepEqual(finished, [merged])
  assert.deepEqual(invalidated, [merged])
})

test('merge(ids) opens the review without a selection when the plan has a caution', async (t) => {
  const { outcome, requests, invalidated, finished } =
    await mergeWithoutSelection(t, cautionPlan)
  assert.deepEqual(
    requests.map((request) => request.url),
    [`${apiBaseUrl}/api/v1/library-changes/track-merges/plan`],
  )
  assert.deepEqual(outcome, { status: 'review', plan: cautionPlan })
  assert.deepEqual(finished, [])
  assert.deepEqual(invalidated, [])
})

/** A queue over the track adapter whose requests each take a moment. */
function queueWith(
  t: TestContext,
  respond: (url: string, body: unknown) => unknown,
) {
  const requests: Array<{ url: string; body: unknown }> = []
  const most = { running: 0, at: 0 }
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(apiBaseUrl, '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      requests.push({ url, body })
      most.running += 1
      most.at = Math.max(most.at, most.running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      most.running -= 1
      const data = respond(url, body)
      return data === null
        ? Response.json(
            { statusCode: 500, message: 'Fixture failure' },
            { status: 500 },
          )
        : Response.json({ statusCode: 200, message: 'OK', data })
    },
  )
  const drained: LibraryChange[][] = []
  const done: LibraryChange[] = []
  const failed: Array<{ message: string; ids: readonly string[] }> = []
  const cancelled: Array<readonly string[]> = []
  const queue = createMergeQueue(trackMergeAdapter, apiBaseUrl, () => ({
    onDone: (change) => done.push(change),
    onFail: (message, ids) => failed.push({ message, ids }),
    onCancel: (ids) => cancelled.push(ids),
    onDrain: async (changes) => {
      drained.push([...changes])
    },
  }))
  return { queue, requests, most, drained, done, failed, cancelled }
}

const otherMerged = LibraryChangeSchema.parse({
  ...merged,
  id: 'change-2',
  target: { ...merged.target, id: 'track-3' },
  sources: [{ ...merged.sources[0], id: 'track-4' }],
})

test('queued merges go out one at a time in the order pressed, a failure does not stop the next, and one refresh follows when the queue is empty', async (t) => {
  const { queue, requests, most, drained, done, failed } = queueWith(
    t,
    (url, body) => {
      const ids =
        body && typeof body === 'object' && 'trackIds' in body
          ? body.trackIds
          : null
      if (url.endsWith('/plan'))
        return Array.isArray(ids) && ids.includes('track-5') ? null : cleanPlan
      return Array.isArray(ids) && ids.includes('track-3')
        ? otherMerged
        : merged
    },
  )
  const first = queue.merge('a', { ids: ['track-1', 'track-2'] })
  const second = queue.merge('b', { ids: ['track-5', 'track-6'] })
  const third = queue.merge('c', { ids: ['track-3', 'track-4'] })
  // Pressing returns at once; nothing has been sent yet and each is queued.
  assert.equal(requests.length, 0)
  assert.deepEqual(
    queue.getSnapshot().waiting.map((entry) => entry.key),
    ['a', 'b', 'c'],
  )
  assert.equal(queue.getSnapshot().items.get('b')?.status, 'queued')
  // A group already queued is not queued twice.
  assert.equal(queue.busy('a'), true)
  await queue.merge('a', { ids: ['track-1', 'track-2'] })
  await first
  assert.equal(queue.getSnapshot().items.get('a')?.status, 'done')
  assert.equal(queue.getSnapshot().items.get('c')?.status, 'queued')
  assert.deepEqual(drained, [])
  await Promise.all([second, third])
  await queue.settled()
  assert.equal(most.at, 1)
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      '/api/v1/library-changes/track-merges/plan',
      '/api/v1/library-changes/track-merges',
      '/api/v1/library-changes/track-merges/plan',
      '/api/v1/library-changes/track-merges/plan',
      '/api/v1/library-changes/track-merges',
    ],
  )
  assert.deepEqual(done, [merged, otherMerged])
  assert.deepEqual(failed, [
    {
      message: 'Fixture failure',
      ids: ['track-5', 'track-6'],
    },
  ])
  // One refresh for both merges; the finished ones then leave the queue.
  assert.deepEqual(drained, [[merged, otherMerged]])
  assert.deepEqual([...queue.getSnapshot().items.keys()], ['b'])
  assert.deepEqual(queue.getSnapshot().items.get('b'), {
    status: 'failed',
    action: 'merge',
    message: 'Fixture failure',
  })
  assert.equal(queue.busy('b'), false)
})

test('Confirm closes the review at once and queues its merge; Cancel leaves the records untouched', async (t) => {
  const { queue, requests, drained, cancelled } = queueWith(t, (url) =>
    url.endsWith('/plan') ? cautionPlan : merged,
  )
  await queue.merge('a', { ids: ['track-1', 'track-2'] })
  await queue.merge('b', { ids: ['track-1', 'track-2'] })
  assert.deepEqual(
    queue.getSnapshot().reviews.map((review) => review.key),
    ['a', 'b'],
  )
  assert.equal(queue.getSnapshot().items.get('a')?.status, 'review')
  assert.equal(queue.busy('a'), true)
  const sent = requests.length
  const confirmed = queue.confirm('a', false)
  // The review is closed before the merge is sent.
  assert.equal(requests.length, sent)
  assert.deepEqual(
    queue.getSnapshot().reviews.map((review) => review.key),
    ['b'],
  )
  assert.equal(queue.getSnapshot().items.get('a')?.status, 'queued')
  queue.cancel('b')
  assert.deepEqual(queue.getSnapshot().reviews, [])
  assert.equal(queue.getSnapshot().items.get('b'), undefined)
  assert.deepEqual(cancelled, [['track-1', 'track-2']])
  await confirmed
  await queue.settled()
  assert.deepEqual(requests.at(-1), {
    url: '/api/v1/library-changes/track-merges',
    body: {
      trackIds: ['track-1', 'track-2'],
      targetId: 'track-1',
      reviewed: true,
      follow: false,
    },
  })
  assert.deepEqual(drained, [[merged]])
  assert.equal(queue.getSnapshot().items.size, 0)
})

test('one change stands for several so one refresh covers them', () => {
  assert.equal(combineLibraryChanges([]), null)
  const combined = combineLibraryChanges([merged, otherMerged])
  // The earlier change's kept record is among the sources too.
  assert.deepEqual(
    combined?.sources.map((source) => source.id),
    ['track-2', 'track-1', 'track-4'],
  )
  assert.equal(combined?.target?.id, 'track-3')
})

test('a busy track merge restores the same review and follow choice for a manual retry', async () => {
  const busy = new Error('The library is busy. Try the merge again.')
  const requests: unknown[] = []
  const adapter: MergeAdapter<TrackMergePlan> = {
    ...trackMergeAdapter,
    plan: async () => cautionPlan,
    merge: async (_base, request) => {
      requests.push(request)
      if (requests.length === 1) throw busy
      return merged
    },
    canRetry: (error) => error === busy,
  }
  const queue = createMergeQueue(adapter, apiBaseUrl, () => ({}))
  await queue.merge('pair', { ids: ['track-1', 'track-2'] })
  await queue.confirm('pair', false)
  const [review] = queue.getSnapshot().reviews
  assert.ok(review)
  assert.equal(review.plan, cautionPlan)
  assert.equal(review.follow, false)
  assert.equal(review.error, busy.message)
  assert.equal(requests.length, 1)
  await queue.confirm('pair', review.follow)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], requests[1])
  assert.deepEqual(queue.getSnapshot().reviews, [])
})

test('the Merge bar says how many selections are still to go', () => {
  assert.equal(describeMergeProgress(0), null)
  assert.equal(describeMergeProgress(1), 'Merging…')
  assert.equal(describeMergeProgress(3), 'Merging 3 selections…')
  const html = renderToStaticMarkup(
    <Providers client={new QueryClient()}>
      <LibraryChangeReport
        progress="Merging 3 selections…"
        change={merged}
        describe={trackMergeAdapter.describe}
        error={null}
        onChanged={() => undefined}
        onError={() => undefined}
        onDismiss={() => undefined}
      />
    </Providers>,
  )
  assert.match(
    html,
    /^<span role="status">Merging 3 selections…<\/span><span class="ds-selectbar-result" role="status">.*<button class="ds-btn">Undo<\/button>/,
  )
})

test('the Tracks bar offers Add to playlist, then Merge, then Clear selection', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const ids = ['track-1', 'track-2']
  try {
    const html = renderToStaticMarkup(
      <Providers client={client}>
        <TrackMergeBar
          selection={selectionOf(ids)}
          total={250}
          actions={
            <AddToPlaylistButton
              subject={{
                library: 'tracks',
                selection: { ids },
                count: 2,
                title: null,
              }}
            />
          }
        />
      </Providers>,
    )
    assert.match(html, /<b>2 selected<\/b>/)
    assert.deepEqual(
      [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(
        (match) => match[1]?.replace(/<[^>]+>/g, '') || 'icon',
      ),
      ['Add to playlist', 'Merge', 'icon'],
    )
    assert.match(html, /aria-label="Clear selection"/)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

const loaded = ['track-1', 'track-2', 'track-3']
const matchingRows: SelectionRows = {
  ordered: loaded,
  result: { ids: loaded, total: 128 },
}

function selectionFrom(state: RowSelectionState): RowSelection {
  return {
    ...describeRowSelection(state, matchingRows),
    toggle: () => undefined,
    setAll: () => undefined,
    selectMatching: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
  }
}

const noun = { one: 'track', other: 'tracks' }

test('Select all matching follows the count until the whole result is selected', () => {
  const link = (state: RowSelectionState) =>
    renderToStaticMarkup(
      <SelectAllMatching selection={selectionFrom(state)} noun={noun} />,
    )
  const empty = emptyRowSelection()
  assert.equal(
    link(empty),
    '<button class="ds-btn" data-variant="link" type="button" title="Select all 128 tracks that match, including rows not loaded yet">Select all matching</button>',
  )
  const whole = selectMatchingRows(empty, matchingRows)
  assert.equal(link(whole), '')
  // Unticking a row offers it again, to take every match back.
  assert.match(
    link(toggleRow(whole, matchingRows, 'track-2', false, false)),
    />Select all matching</,
  )
})

test('the header checkbox names its scope: loaded tracks, or all matching tracks', () => {
  const header = (state: RowSelectionState) =>
    renderToStaticMarkup(
      <RowSelectAll
        selection={selectionFrom(state)}
        label="Select loaded tracks"
        matchingLabel="Select all matching tracks"
      />,
    )
  assert.match(header(emptyRowSelection()), /aria-label="Select loaded tracks"/)
  const whole = selectMatchingRows(emptyRowSelection(), matchingRows)
  assert.match(header(whole), /aria-label="Select all matching tracks"/)
  assert.match(header(whole), /checked=""/)
  const unticked = toggleRow(whole, matchingRows, 'track-2', false, false)
  assert.match(header(unticked), /aria-label="Select loaded tracks"/)
  assert.doesNotMatch(header(unticked), /checked=""/)
})

test('the bar offers all 128 matching once every loaded row is ticked, and reads the whole result once selected', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const bar = (state: RowSelectionState) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <TrackMergeBar selection={selectionFrom(state)} total={128} />
      </Providers>,
    )
  try {
    const one = bar(
      toggleRow(emptyRowSelection(), matchingRows, 'track-1', true, false),
    )
    assert.doesNotMatch(one, /matching/)
    const loadedRows = bar(
      setLoadedRows(emptyRowSelection(), matchingRows, true),
    )
    assert.match(
      loadedRows,
      /<b>3 selected<\/b><span class="ds-muted"> of 128<\/span><\/span><button class="ds-btn ds-selectbar-offer" type="button">Select all 128 matching<\/button>/,
    )
    const whole = selectMatchingRows(emptyRowSelection(), matchingRows)
    const all = bar(whole)
    assert.match(all, /<b>128 selected<\/b><span class="ds-muted"> of 128/)
    assert.doesNotMatch(all, /ds-selectbar-offer/)
    assert.match(
      all,
      new RegExp(
        `<button[^>]*disabled=""[^>]*title="${mergeNeedsTickedRows}"[^>]*>Merge</button>`,
      ),
    )
    assert.match(
      bar(toggleRow(whole, matchingRows, 'track-2', false, false)),
      /<b>127 selected<\/b><span class="ds-muted"> of 128/,
    )
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

test('Add to playlist is disabled with the reason a whole-result selection cannot be added', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const subject: PlaylistSubject = {
    library: 'tracks',
    selection: { query: { libraryScope: 'outside' }, excludeIds: [] },
    count: 0,
    title: null,
  }
  const button = (blocked: string | null, counting = false) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <AddToPlaylistButton
          subject={subject}
          blocked={blocked}
          counting={counting}
        />
      </Providers>,
    )
  try {
    assert.match(
      button('Items outside the library cannot be added to a playlist.'),
      /<button[^>]*disabled=""[^>]*title="Items outside the library cannot be added to a playlist\."/,
    )
    assert.match(
      button('Count timed out', true),
      /<button[^>]*disabled=""[^>]*title="Count timed out"/,
    )
    // While counting, it waits without a reason.
    const counting = button(null, true)
    assert.match(counting, /<button[^>]*disabled=""/)
    assert.doesNotMatch(counting, /title=/)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

test('without Merge the bar has Add to playlist as its primary button, the offer and Clear selection', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const subject: PlaylistSubject = {
    library: 'films',
    selection: { ids: loaded },
    count: 3,
    title: null,
  }
  const bar = (state: RowSelectionState) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <SelectionBar
          selection={selectionFrom(state)}
          total={128}
          actions={<AddToPlaylistButton subject={subject} primary />}
        />
      </Providers>,
    )
  try {
    assert.equal(bar(emptyRowSelection()), '')
    const loadedRows = bar(
      setLoadedRows(emptyRowSelection(), matchingRows, true),
    )
    assert.match(
      loadedRows,
      /<b>3 selected<\/b><span class="ds-muted"> of 128<\/span><\/span><button class="ds-btn ds-selectbar-offer" type="button">Select all 128 matching<\/button>/,
    )
    assert.deepEqual(
      [...loadedRows.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(
        (match) => match[1]?.replace(/<[^>]+>/g, '') || 'icon',
      ),
      ['Select all 128 matching', 'Add to playlist', 'icon'],
    )
    assert.match(loadedRows, /data-variant="primary"[^>]*>Add to playlist/)
    assert.match(loadedRows, /aria-label="Clear selection"/)
    assert.doesNotMatch(loadedRows, />Merge</)
    const all = bar(selectMatchingRows(emptyRowSelection(), matchingRows))
    assert.match(all, /<b>128 selected<\/b><span class="ds-muted"> of 128/)
    assert.doesNotMatch(all, /ds-selectbar-offer/)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})
