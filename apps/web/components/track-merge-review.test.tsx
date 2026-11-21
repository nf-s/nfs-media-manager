import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  LibraryChangeSchema,
  TrackMergePlanSchema,
  type TrackMergePlan,
} from '@repo/schemas/library-changes'
import {
  describeTrackMergeFollows,
  trackMergeAdapter,
} from './track-merge-review'

const apiBaseUrl = 'http://localhost:4001'

const planTrack = (
  id: string,
  title: string,
  outcome: 'keep' | 'merge' | 'version',
  albumTitle: string | null = null,
) => ({
  id,
  title,
  by: 'Example Artist',
  albumTitle,
  durationSec: 200,
  scrobbles: 10,
  spotify: outcome !== 'merge',
  nameCount: 1,
  identity: outcome === 'merge' ? null : 'spotify',
  outcome,
  blocked: null,
})

const plan = TrackMergePlanSchema.parse({
  targetId: 'track-1',
  tracks: [
    planTrack('track-1', 'Night Drive', 'keep', 'Example Album'),
    planTrack('track-2', 'Night Drive', 'version', 'Example Album (Reissue)'),
    planTrack('track-3', 'Nite Drive', 'merge'),
  ],
  names: [
    {
      trackId: 'track-3',
      artistName: 'Example Artist',
      trackName: 'Nite Drive',
      count: 10,
      counted: false,
    },
  ],
  scrobbles: { target: 10, added: 20, total: 30 },
  also: { albumNames: [], titles: [] },
  cautions: [
    { code: 'same-album', albums: ['Example Album'] },
    { code: 'separate', trackIds: ['track-1', 'track-3'] },
  ],
  blocked: false,
})

const albumName = {
  artistName: 'Example Artist',
  albumName: 'Example Album (Deluxe)',
  scrobbles: 40,
  toAlbumId: 'album-1',
  toAlbumTitle: 'Example Album',
}
const title = (trackName: string) => ({
  artistName: 'Example Artist',
  trackName,
  scrobbles: 5,
  fromTrackId: `from-${trackName}`,
  toTrackId: `to-${trackName}`,
  toTitle: trackName,
})

function render(next: TrackMergePlan, follow = true) {
  const { Review } = trackMergeAdapter
  return renderToStaticMarkup(
    <Review
      plan={next}
      pending={false}
      replan={() => undefined}
      follow={follow}
      setFollow={() => undefined}
      error={null}
    />,
  )
}

test('the review names each caution, the version shown and what each track becomes', () => {
  const html = render(plan)
  assert.match(
    html,
    /Check before merging\. Two tracks are different positions on “Example Album”\. “Night Drive” and “Nite Drive” were kept separate\./,
  )
  assert.doesNotMatch(html, /stays? a track|Leave (it|them) out|cannot/)
  assert.match(html, /<dt>Shown as<\/dt>/)
  assert.match(html, /<select[^>]*aria-label="Shown as"/)
  assert.match(
    html,
    /<option value="track-2">Night Drive · Example Album \(Reissue\) · Example Artist<\/option>/,
  )
  assert.match(html, /10 \+ 20 = <b>30<\/b>/)
  assert.match(html, /<th scope="col">Becomes/)
  const outcomes = [
    ...html.matchAll(
      /<td>(<span class="ds-status"[^>]*>)?(Shown|Version|Merged)</g,
    ),
  ].map((match) => match[2])
  assert.deepEqual(outcomes, ['Shown', 'Version', 'Merged'])
  assert.match(html, /<span class="ds-status" data-status="done">Shown<\/span>/)
  assert.equal(trackMergeAdapter.wording.title(plan), 'Merge 3 tracks')
  assert.equal(trackMergeAdapter.blocked(plan), false)
  assert.equal(trackMergeAdapter.needsReview(plan), true)
})

test('Also merged appears only when something follows, checked until turned off', () => {
  assert.doesNotMatch(render(plan), /Also merged/)
  const following = TrackMergePlanSchema.parse({
    ...plan,
    also: { albumNames: [albumName], titles: [title('Intro'), title('Outro')] },
  })
  const on = render(following)
  assert.match(on, /<h3>Also merged<\/h3>/)
  assert.match(
    on,
    /<label class="ds-checkrow"><input type="checkbox" class="ds-check" checked=""\/><span>Album name “Example Album \(Deluxe\)” into “Example Album”, with 2 names scrobbled under it\.<\/span><\/label>/,
  )
  const off = render(following, false)
  assert.match(off, /<h3>Also merged<\/h3>/)
  assert.match(off, /<input type="checkbox" class="ds-check"\/>/)
})

test('what follows a merge reads as sentences with counts', () => {
  assert.equal(
    describeTrackMergeFollows({ albumNames: [albumName], titles: [] }),
    'Album name “Example Album (Deluxe)” into “Example Album”.',
  )
  assert.equal(
    describeTrackMergeFollows({ albumNames: [], titles: [title('Intro')] }),
    '1 name scrobbled under the same album name.',
  )
  assert.equal(
    describeTrackMergeFollows({
      albumNames: [
        albumName,
        { ...albumName, albumName: 'Example Album (Live)' },
      ],
      titles: [title('Intro'), title('Outro'), title('Coda')],
    }),
    'Album name “Example Album (Deluxe)” into “Example Album”. Album name “Example Album (Live)” into “Example Album”. 3 names scrobbled under them.',
  )
})

test('the track merge sends follow when the review says, and leaves it out otherwise', async (t) => {
  const change = LibraryChangeSchema.parse({
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
      {
        id: 'track-2',
        title: 'Night Drive',
        by: 'Example Artist',
        exists: true,
      },
    ],
    names: [],
    nameCount: 0,
    scrobbles: 0,
    details: { counts: { version: 1, 'album-name': 1 } },
    createdAt: '2026-03-04T05:06:00.000Z',
    undoneAt: null,
    reversible: true,
    canUndo: true,
    canRedo: false,
    blocked: null,
  })
  const bodies: unknown[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null)
      return Response.json({ statusCode: 200, message: 'OK', data: change })
    },
  )
  await trackMergeAdapter.merge(apiBaseUrl, {
    ids: ['track-1', 'track-2'],
    keepId: 'track-1',
    reviewed: true,
    follow: false,
  })
  await trackMergeAdapter.merge(apiBaseUrl, {
    ids: ['track-1', 'track-2'],
    reviewed: false,
  })
  assert.deepEqual(bodies, [
    {
      trackIds: ['track-1', 'track-2'],
      targetId: 'track-1',
      reviewed: true,
      follow: false,
    },
    { trackIds: ['track-1', 'track-2'], reviewed: false },
  ])
  assert.equal(
    trackMergeAdapter.describe(change),
    'Merged “Night Drive” into “Night Drive”. Also merged 1 version and 1 album name',
  )
})
