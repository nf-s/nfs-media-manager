import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  ArtistMergePlanSchema,
  type ArtistMergePlan,
} from '@repo/schemas/artist-merges'
import {
  LibraryChangeSchema,
  type LibraryChange,
} from '@repo/schemas/library-changes'
import { artistMergeAdapter } from './artist-merge-review'
import { MergeBar, useMerge, type MergeAdapter } from './merge-bar'
import type { MergeRequest, RowSelection } from './merge-bar'
import { describeRowSelection, emptyRowSelection } from '@/utils/row-selection'
import { ConfigContext } from './providers'

const apiBaseUrl = 'http://localhost:4001'

const planArtist = (id: string, name: string, extra = {}) => ({
  id,
  name,
  scrobbles: 120,
  albumCount: 2,
  trackCount: 9,
  creditCount: 11,
  spotify: true,
  providers: ['spotify', 'musicbrainz'],
  names: [],
  blocked: null,
  ...extra,
})

const cleanPlan = ArtistMergePlanSchema.parse({
  targetId: 'artist-1',
  artists: [
    planArtist('artist-1', 'The Lowlands'),
    planArtist('artist-2', 'Lowlands', {
      scrobbles: 23,
      albumCount: 0,
      trackCount: 2,
      creditCount: 2,
      spotify: false,
      providers: [],
      names: ['The Low Lands'],
    }),
  ],
  moves: {
    credits: 2,
    albums: 0,
    tracks: 2,
    shared: 1,
    names: ['Lowlands', 'The Low Lands'],
  },
  scrobbles: { target: 120, total: 143 },
  also: [],
  cautions: [],
  blocked: false,
})

const cautionPlan = ArtistMergePlanSchema.parse({
  ...cleanPlan,
  cautions: [
    { code: 'profiles', providers: ['spotify'] },
    { code: 'together', items: 3 },
    { code: 'names', names: ['The Lowlands', 'Harbour Lights'] },
    { code: 'separate', names: ['The Lowlands', 'Lowlands'] },
  ],
})

const filmPlan = ArtistMergePlanSchema.parse({
  ...cleanPlan,
  artists: [
    ...cleanPlan.artists,
    planArtist('artist-3', 'June Okafor', { blocked: 'film' }),
  ],
  blocked: true,
})

const followPlan = ArtistMergePlanSchema.parse({
  ...cleanPlan,
  also: [
    {
      artistName: 'Lowlands',
      trackName: 'Harbour',
      scrobbles: 4,
      fromTrackId: 'track-2',
      toTrackId: 'track-1',
      toTitle: 'Harbour',
    },
  ],
})

const merged = LibraryChangeSchema.parse({
  id: 'change-1',
  kind: 'artist',
  action: 'merge',
  actor: 'owner',
  rule: null,
  batchId: null,
  target: { id: 'artist-1', title: 'The Lowlands', by: '', exists: true },
  sources: [{ id: 'artist-2', title: 'Lowlands', by: '', exists: false }],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  details: { counts: { credit: 2, 'artist-name': 1 }, labels: ['Lowlands'] },
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
})

function review(
  plan: ArtistMergePlan,
  {
    follow = true,
    replans = [],
  }: { follow?: boolean; replans?: MergeRequest[] } = {},
) {
  const { Review } = artistMergeAdapter
  return renderToStaticMarkup(
    <Review
      plan={plan}
      pending={false}
      replan={(request) => replans.push(request)}
      follow={follow}
      setFollow={() => undefined}
      error={<p>Example error</p>}
    />,
  )
}

test('the artist review shows the artist to keep, its names, what moves and the totals', () => {
  const html = review(cleanPlan)
  assert.match(
    html,
    /<select class="ds-select" aria-label="Artist to keep"><option value="artist-1" selected="">The Lowlands<\/option><option value="artist-2">Lowlands<\/option><\/select>/,
  )
  assert.match(html, /Also known as<\/dt><dd>“Lowlands”, “The Low Lands”<\/dd>/)
  assert.match(
    html,
    /Credits moved<\/dt><dd><span class="ds-num">2 on 2 tracks · 1 where “The Lowlands” is already credited<\/span>/,
  )
  assert.match(
    html,
    /Scrobbles<\/dt><dd><span class="ds-num">120 \+ 23 = <b>143<\/b><\/span>/,
  )
  // The parts table lists each artist with its counts and profiles.
  assert.match(html, /aria-label="Artists to merge"/)
  assert.match(html, /data-status="done"[^>]*>Kept<\/span>/)
  assert.match(
    html,
    /<span class="ds-cell-sub">2 credits · “The Low Lands”<\/span>/,
  )
  assert.match(html, /Spotify, MusicBrainz/)
  // Two artists are the fewest a merge takes: none can be left out.
  assert.doesNotMatch(html, /Leave out/)
  assert.doesNotMatch(html, /Check before merging|Also merged/)
  assert.match(html, /<p>Example error<\/p>/)
})

test('the artist review words every caution in one notice', () => {
  const html = review(cautionPlan)
  assert.match(
    html,
    /Check before merging\. They have different profiles on Spotify\. They are credited together on 3 tracks or albums, so they are likely different artists\. The names are not alike: “The Lowlands”, “Harbour Lights”\. “The Lowlands” and “Lowlands” were kept separate\./,
  )
  assert.equal(artistMergeAdapter.needsReview(cleanPlan), false)
  assert.equal(artistMergeAdapter.needsReview(cautionPlan), true)
  assert.equal(artistMergeAdapter.blocked(cautionPlan), false)
})

test('an artist with film credits blocks Merge until it is left out', () => {
  const replans: MergeRequest[] = []
  const html = review(filmPlan, { replans })
  assert.match(
    html,
    /“June Okafor” has film credits and cannot be merged\. People in films and music artists share one record\./,
  )
  assert.match(html, /<button[^>]*>Leave it out<\/button>/)
  assert.match(html, /data-status="attention"[^>]*>Has film credits<\/span>/)
  // With three artists any one but the kept one can be left out.
  assert.equal(html.match(/>Leave out<\/button>/g)?.length, 2)
  assert.match(html, /aria-label="Leave out June Okafor"/)
  assert.doesNotMatch(html, /aria-label="Leave out The Lowlands"/)
  assert.equal(artistMergeAdapter.needsReview(filmPlan), true)
  assert.equal(artistMergeAdapter.blocked(filmPlan), true)
  assert.equal(artistMergeAdapter.wording.title(filmPlan), 'Merge 2 artists')
  assert.deepEqual(artistMergeAdapter.request(filmPlan), {
    ids: ['artist-1', 'artist-2', 'artist-3'],
    keepId: 'artist-1',
  })
})

test('titles that follow the merged names are a check row bound to follow', () => {
  const on = review(followPlan)
  assert.match(on, />Also merged</)
  assert.match(
    on,
    /<label class="ds-checkrow"><input type="checkbox" class="ds-check" checked=""\/><span>1 track name scrobbled under “Lowlands” moves to the matching tracks of “The Lowlands”: “Harbour”\.<\/span><\/label>/,
  )
  const off = review(followPlan, { follow: false })
  assert.match(
    off,
    /<label class="ds-checkrow"><input type="checkbox" class="ds-check"\/>/,
  )
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

test('the artist Merge bar asks for two artists, then offers Merge', (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Network forbidden in UI tests')
  })
  const client = new QueryClient()
  const render = (ids: string[]) =>
    renderToStaticMarkup(
      <Providers client={client}>
        <MergeBar
          selection={selectionOf(ids)}
          total={250}
          adapter={artistMergeAdapter}
        />
      </Providers>,
    )
  try {
    assert.equal(render([]), '<div class="ds-selectbar sec-selectbar"></div>')
    assert.match(
      render(['artist-1']),
      /<button[^>]*disabled=""[^>]*title="Select two or more artists to merge"[^>]*>Merge<\/button>/,
    )
    const two = render(['artist-1', 'artist-2'])
    assert.match(two, /<b>2 selected<\/b>/)
    assert.doesNotMatch(two, /disabled=""[^>]*>Merge</)
    assert.equal(network.mock.callCount(), 0)
  } finally {
    client.clear()
  }
})

async function mergeArtists(
  t: TestContext,
  plan: ArtistMergePlan,
  merge: (
    merge: ReturnType<typeof useMerge<ArtistMergePlan>>['merge'],
  ) => Promise<unknown>,
  requireReview = false,
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
  const adapter: MergeAdapter<ArtistMergePlan> = {
    ...artistMergeAdapter,
    invalidate: async (_client, change) => {
      invalidated.push(change)
    },
  }
  let started: ReturnType<typeof useMerge<ArtistMergePlan>> | undefined
  function ArtistMerge() {
    started = useMerge(adapter, { requireReview })
    return null
  }
  const client = new QueryClient()
  try {
    renderToStaticMarkup(
      <Providers client={client}>
        <ArtistMerge />
      </Providers>,
    )
    assert.ok(started)
    const outcome = await merge(started.merge)
    return { outcome, requests, invalidated }
  } finally {
    client.clear()
  }
}

test('a clean artist merge is planned, then made at once', async (t) => {
  const { outcome, requests, invalidated } = await mergeArtists(
    t,
    cleanPlan,
    (merge) => merge(['artist-1', 'artist-2']),
  )
  assert.deepEqual(requests, [
    {
      url: `${apiBaseUrl}/api/v1/library-changes/artist-merges/plan`,
      body: { artistIds: ['artist-1', 'artist-2'] },
    },
    {
      url: `${apiBaseUrl}/api/v1/library-changes/artist-merges`,
      body: { artistIds: ['artist-1', 'artist-2'], reviewed: false },
    },
  ])
  assert.deepEqual(outcome, { status: 'merged', change: merged })
  assert.deepEqual(invalidated, [merged])
})

test('an artist inspector merge waits for review even on a clean plan', async (t) => {
  const { outcome, requests, invalidated } = await mergeArtists(
    t,
    cleanPlan,
    (merge) => merge(['artist-1', 'artist-2']),
    true,
  )
  assert.deepEqual(requests, [
    {
      url: `${apiBaseUrl}/api/v1/library-changes/artist-merges/plan`,
      body: { artistIds: ['artist-1', 'artist-2'] },
    },
  ])
  assert.deepEqual(outcome, { status: 'review', plan: cleanPlan })
  assert.deepEqual(invalidated, [])
})

test('an artist merge with a caution or a film block opens the review first', async (t) => {
  for (const plan of [cautionPlan, filmPlan]) {
    const { outcome, requests, invalidated } = await mergeArtists(
      t,
      plan,
      (merge) => merge(['artist-1', 'artist-2'], 'artist-1'),
    )
    assert.deepEqual(requests, [
      {
        url: `${apiBaseUrl}/api/v1/library-changes/artist-merges/plan`,
        body: { artistIds: ['artist-1', 'artist-2'], targetId: 'artist-1' },
      },
    ])
    assert.deepEqual(outcome, { status: 'review', plan })
    assert.deepEqual(invalidated, [])
  }
})

test('a reviewed artist merge sends the artist to keep and follow', async (t) => {
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
  await artistMergeAdapter.merge(apiBaseUrl, {
    ids: ['artist-1', 'artist-2'],
    keepId: 'artist-2',
    follow: false,
    reviewed: true,
  })
  assert.deepEqual(requests, [
    {
      artistIds: ['artist-1', 'artist-2'],
      targetId: 'artist-2',
      follow: false,
      reviewed: true,
    },
  ])
})

test('a finished artist merge refreshes the artists, their lists and the changes', async () => {
  const client = new QueryClient()
  const keys = [
    ['artist', 'artist-1'],
    ['artist', 'artist-2'],
    ['artists', 'browse', '{}', 1],
    ['library-changes', { kind: 'artist' }],
  ]
  for (const key of keys) client.setQueryData(key, {})
  try {
    await artistMergeAdapter.invalidate(client, merged)
    const stale = keys.map(
      (queryKey) => client.getQueryState(queryKey)?.isInvalidated,
    )
    assert.deepEqual(stale, [true, true, true, true])
  } finally {
    client.clear()
  }
})
