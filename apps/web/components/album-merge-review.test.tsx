import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  AlbumMergePlanSchema,
  type AlbumMergeBlock,
  type AlbumMergePlan,
} from '@repo/schemas/album-merges'
import {
  LibraryChangeSchema,
  type LibraryChange,
} from '@repo/schemas/library-changes'
import { albumNameKey } from '@/utils/album-merges'
import {
  AlbumChangeNotice,
  albumMergeAdapter,
  albumNameMoveAdapter,
} from './album-merge-review'
import { MergeBar, useMerge, type MergeAdapter } from './merge-bar'
import { describeRowSelection, emptyRowSelection } from '@/utils/row-selection'
import { ConfigContext } from './providers'

const apiBaseUrl = 'http://localhost:4001'

const album = (
  id: string,
  title: string,
  selected = true,
  by = 'Fixture Artist',
) => ({
  id,
  title,
  by,
  releaseDate: '2020-02-02',
  trackCount: 10,
  scrobbles: 4,
  spotify: false,
  editionOfId: null,
  selected,
})

const cleanPlan = AlbumMergePlanSchema.parse({
  targetId: 'harbour',
  albums: [
    album('harbour', 'Harbour Lights'),
    album('harbour-reissue', 'Harbour Lights'),
  ],
  editions: [{ albumId: 'harbour-reissue', fromId: null }],
  names: [],
  also: [],
  unmatched: [],
  scrobbles: { target: 8, added: 4, total: 12 },
  cautions: [],
  blocked: null,
})

const cautionPlan = AlbumMergePlanSchema.parse({
  ...cleanPlan,
  albums: [
    album('harbour', 'Harbour Lights'),
    album('harbour-deluxe', 'Harbour Lights (Deluxe)', true, 'Other Artist'),
    album('harbour-live', 'Harbour Lights (Live)', false),
  ],
  editions: [
    { albumId: 'harbour-deluxe', fromId: null },
    { albumId: 'harbour-live', fromId: 'harbour-deluxe' },
  ],
  cautions: [
    { code: 'version', words: ['Deluxe'] },
    { code: 'artists', names: ['Fixture Artist', 'Other Artist'] },
    {
      code: 'tracks',
      albums: [{ albumId: 'harbour-deluxe', shared: 2, listed: 9 }],
    },
    {
      code: 'elsewhere',
      count: 1,
      names: [
        {
          artistName: 'Fixture Artist',
          trackName: 'Pier',
          albumTitle: 'Coastline',
        },
      ],
    },
    { code: 'separate', albumIds: ['harbour', 'harbour-deluxe'] },
  ],
})

const namePlan = AlbumMergePlanSchema.parse({
  targetId: 'harbour',
  albums: [album('harbour', 'Harbour Lights')],
  editions: [],
  names: [
    {
      artistName: 'Fixture Artist',
      albumName: 'Harbour Lights [Live]',
      scrobbles: 6,
      albumId: null,
    },
  ],
  also: [
    {
      artistName: 'Fixture Artist',
      trackName: 'Pier',
      scrobbles: 3,
      fromTrackId: 'pier-live',
      toTrackId: 'pier',
      toTitle: 'Pier',
    },
  ],
  unmatched: [
    {
      artistName: 'Fixture Artist',
      trackName: 'Encore',
      scrobbles: 1,
      trackId: 'encore',
    },
  ],
  scrobbles: { target: 8, added: 6, total: 14 },
  cautions: [],
  blocked: null,
})

const merged = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'album',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: {
    id: 'harbour',
    title: 'Harbour Lights',
    by: 'Fixture Artist',
    exists: true,
  },
  sources: [
    {
      id: 'harbour-reissue',
      title: 'Harbour Lights',
      by: 'Fixture Artist',
      exists: true,
    },
  ],
  names: [],
  nameCount: 0,
  scrobbles: 4,
  details: { counts: { edition: 1 } },
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

function review(
  adapter: MergeAdapter<AlbumMergePlan>,
  plan: AlbumMergePlan,
  follow = true,
) {
  const { Review } = adapter
  return renderToStaticMarkup(
    <Review
      plan={plan}
      pending={false}
      replan={() => undefined}
      follow={follow}
      setFollow={() => undefined}
      error={<p>Example error</p>}
    />,
  )
}

test('the album Merge bar asks for two albums, then offers Merge', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const selection = (ids: string[]) => ({
    ...describeRowSelection({ ...emptyRowSelection(), ids }, { ordered: [] }),
    some: ids.length > 0,
    toggle: () => undefined,
    setAll: () => undefined,
    selectMatching: () => undefined,
    replace: () => undefined,
    clear: () => undefined,
  })
  const render = (ids: string[]) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <MergeBar
          selection={selection(ids)}
          total={40}
          adapter={albumMergeAdapter}
        />
      </Providers>,
    )
  try {
    assert.equal(render([]), '<div class="ds-selectbar sec-selectbar"></div>')
    assert.match(
      render(['harbour']),
      /<button[^>]*disabled=""[^>]*title="Select two or more albums to merge"[^>]*>Merge<\/button>/,
    )
    const two = render(['harbour', 'harbour-reissue'])
    assert.match(two, /<b>2 selected<\/b><span class="ds-muted"> of 40/)
    assert.doesNotMatch(two, /disabled=""[^>]*>Merge</)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

test('the album review names every caution, the album to keep and what the others become', () => {
  const html = review(albumMergeAdapter, cautionPlan)
  assert.match(
    html,
    /Check before merging\. “Deluxe” is in some titles only\. The artists differ: Fixture Artist, Other Artist\. “Harbour Lights \(Deluxe\)” and “Harbour Lights” share 2 of 9 track titles\. 1 track name that would follow is on another album: “Pier” on “Coastline”\. Some of these albums were kept separate\./,
  )
  // The error follows the plan's notices.
  assert.match(html, /<\/div><p>Example error<\/p>/)
  // The album to keep is chosen from the selected albums only.
  assert.match(html, /<select class="ds-select" aria-label="Album to keep">/)
  assert.match(
    html,
    /<option value="harbour" selected="">Harbour Lights · Fixture Artist \(2020\)<\/option><option value="harbour-deluxe">Harbour Lights \(Deluxe\) · Other Artist \(2020\)<\/option><\/select>/,
  )
  assert.match(html, /<dt>Editions<\/dt><dd><span class="ds-num">2<\/span>/)
  assert.match(html, /8 \+ 4 = <b>12<\/b>/)
  assert.match(html, /aria-label="Albums to merge"/)
  assert.match(html, /<span class="ds-status"[^>]*>.*?Kept<\/span>/)
  assert.match(html, /Edition · Other Artist/)
  assert.doesNotMatch(html, /Also merged|Album names/)
  assert.equal(albumMergeAdapter.needsReview(cleanPlan), false)
  assert.equal(albumMergeAdapter.needsReview(cautionPlan), true)
  assert.equal(albumMergeAdapter.blocked(cautionPlan), false)
  assert.equal(albumMergeAdapter.wording.title(cautionPlan), 'Merge 2 albums')
  // An edition brought along with its first album is not part of the request.
  assert.deepEqual(albumMergeAdapter.request(cautionPlan), {
    ids: ['harbour', 'harbour-deluxe'],
    keepId: 'harbour',
  })
})

test('a blocked album plan says why and Merge is off', () => {
  const reasons: [AlbumMergeBlock, string][] = [
    ['hidden', 'Albums removed from the library cannot be merged.'],
    ['same-record', 'These albums are one record already.'],
  ]
  for (const [blocked, reason] of reasons) {
    const plan = AlbumMergePlanSchema.parse({ ...cleanPlan, blocked })
    assert.match(review(albumMergeAdapter, plan), new RegExp(reason))
    assert.equal(albumMergeAdapter.blocked(plan), true)
    assert.equal(albumMergeAdapter.needsReview(plan), true)
  }
})

test('the album to keep is kept in the request when the server resolved it to the first album', () => {
  const plan = AlbumMergePlanSchema.parse({
    ...cleanPlan,
    albums: [
      album('harbour', 'Harbour Lights', false),
      album('harbour-deluxe', 'Harbour Lights (Deluxe)'),
      album('coastline', 'Coastline'),
    ],
  })
  assert.deepEqual(albumMergeAdapter.request(plan), {
    ids: ['harbour', 'harbour-deluxe', 'coastline'],
    keepId: 'harbour',
  })
})

test('a name move review lists the names that follow with the check row, and those that stay', () => {
  const html = review(albumNameMoveAdapter, namePlan)
  assert.match(html, /<h3>Also merged<\/h3>/)
  assert.match(
    html,
    /<label class="ds-checkrow"><input type="checkbox" class="ds-check" checked=""\/><span>1 name scrobbled under “Harbour Lights \[Live\]”, onto the matching tracks of “Harbour Lights”: “Pier”\.<\/span><\/label>/,
  )
  assert.match(
    review(albumNameMoveAdapter, namePlan, false),
    /<input type="checkbox" class="ds-check"\/><span>1 name/,
  )
  assert.match(
    html,
    /<p class="ds-help">1 name scrobbled under “Harbour Lights \[Live\]” matches no track of “Harbour Lights” and stays where it is: “Encore”\.<\/p>/,
  )
  assert.match(html, /<dt>Album names<\/dt><dd>“Harbour Lights \[Live\]”/)
  assert.match(html, /<b>Harbour Lights<\/b>/)
  assert.doesNotMatch(html, /aria-label="Albums to merge"|Check before/)
  assert.equal(
    albumNameMoveAdapter.wording.title(namePlan),
    'Merge “Harbour Lights [Live]” into “Harbour Lights”',
  )
  // Names that would follow are shown before the move is made.
  assert.equal(albumNameMoveAdapter.needsReview(namePlan), true)
  assert.equal(
    albumNameMoveAdapter.needsReview({ ...namePlan, also: [] }),
    false,
  )
  assert.equal(albumMergeAdapter.needsReview(namePlan), false)
  assert.deepEqual(albumNameMoveAdapter.request(namePlan), {
    ids: [
      albumNameKey({
        artistName: 'Fixture Artist',
        albumName: 'Harbour Lights [Live]',
      }),
    ],
    keepId: 'harbour',
  })
})

async function mergeWith(
  t: TestContext,
  adapter: MergeAdapter<AlbumMergePlan>,
  plan: AlbumMergePlan,
  ids: string[],
  keepId?: string,
) {
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
  const counted: MergeAdapter<AlbumMergePlan> = {
    ...adapter,
    invalidate: async (_client, change) => {
      invalidated.push(change)
    },
  }
  let merge:
    | ((ids: readonly string[], keepId?: string) => Promise<unknown>)
    | undefined
  function Merge() {
    merge = useMerge(counted).merge
    return null
  }
  const client = new QueryClient()
  try {
    renderToStaticMarkup(
      <Providers client={client}>
        <Merge />
      </Providers>,
    )
    assert.ok(merge)
    const outcome = await merge(ids, keepId)
    return { outcome, requests, invalidated }
  } finally {
    client.clear()
  }
}

test('albums merge at once when the plan is clean', async (t) => {
  const { outcome, requests, invalidated } = await mergeWith(
    t,
    albumMergeAdapter,
    cleanPlan,
    ['harbour', 'harbour-reissue'],
  )
  const base = `${apiBaseUrl}/api/v1/library-changes/album-merges`
  assert.deepEqual(requests, [
    {
      url: `${base}/plan`,
      body: { albumIds: ['harbour', 'harbour-reissue'] },
    },
    {
      url: base,
      body: { albumIds: ['harbour', 'harbour-reissue'], reviewed: false },
    },
  ])
  assert.deepEqual(outcome, { status: 'merged', change: merged })
  assert.deepEqual(invalidated, [merged])
})

test('albums with a caution open the review before anything is merged', async (t) => {
  const { outcome, requests, invalidated } = await mergeWith(
    t,
    albumMergeAdapter,
    cautionPlan,
    ['harbour', 'harbour-deluxe'],
  )
  assert.equal(requests.length, 1)
  assert.deepEqual(outcome, { status: 'review', plan: cautionPlan })
  assert.deepEqual(invalidated, [])
})

test('a name move plans the name onto the album and opens the review when names follow', async (t) => {
  const name = {
    artistName: 'Fixture Artist',
    albumName: 'Harbour Lights [Live]',
  }
  const { outcome, requests } = await mergeWith(
    t,
    albumNameMoveAdapter,
    namePlan,
    [albumNameKey(name)],
    'harbour',
  )
  assert.deepEqual(requests, [
    {
      url: `${apiBaseUrl}/api/v1/library-changes/album-names/plan`,
      body: { ...name, albumId: 'harbour' },
    },
  ])
  assert.deepEqual(outcome, { status: 'review', plan: namePlan })
  const clean = await mergeWith(
    t,
    albumNameMoveAdapter,
    { ...namePlan, also: [] },
    [albumNameKey(name)],
    'harbour',
  )
  assert.deepEqual(clean.requests.at(-1), {
    url: `${apiBaseUrl}/api/v1/library-changes/album-names`,
    body: { ...name, albumId: 'harbour', reviewed: false },
  })
})

test('the reviewed name move passes the follow choice', async (t) => {
  const requests: unknown[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(
        typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      )
      return Response.json({ statusCode: 200, message: 'OK', data: merged })
    },
  )
  const name = { artistName: 'Fixture Artist', albumName: 'Harbour Lights' }
  await albumNameMoveAdapter.merge(apiBaseUrl, {
    ids: [albumNameKey(name)],
    keepId: 'harbour',
    follow: false,
    reviewed: true,
  })
  await albumMergeAdapter.merge(apiBaseUrl, {
    ids: ['harbour', 'harbour-deluxe'],
    keepId: 'harbour',
    follow: false,
    reviewed: true,
  })
  assert.deepEqual(requests, [
    { ...name, albumId: 'harbour', follow: false, reviewed: true },
    {
      albumIds: ['harbour', 'harbour-deluxe'],
      targetId: 'harbour',
      follow: false,
      reviewed: true,
    },
  ])
  await assert.rejects(
    albumNameMoveAdapter.plan(apiBaseUrl, { ids: ['harbour'] }),
    /Choose one album name and the album it moves to\./,
  )
})

test('the change notice says what changed with Undo, then Redo once undone', () => {
  const client = new QueryClient()
  const render = (change: LibraryChange) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <AlbumChangeNotice
          change={change}
          onChange={() => undefined}
          onDismiss={() => undefined}
        />
      </Providers>,
    )
  try {
    const done = render(merged)
    assert.match(done, /<div class="ds-notice" role="status">/)
    assert.match(done, /Merged “Harbour Lights” into “Harbour Lights”/)
    assert.match(done, />Undo<\/button>/)
    assert.match(done, /aria-label="Dismiss"/)
    const undone = render({
      ...merged,
      undoneAt: '2026-03-04T06:00:00.000Z',
      canRedo: true,
    })
    assert.match(undone, /Undone: Merged/)
    assert.match(undone, />Redo<\/button>/)
  } finally {
    client.clear()
  }
})
