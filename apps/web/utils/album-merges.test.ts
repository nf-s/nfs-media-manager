import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AlbumMergePlanSchema,
  type AlbumMergePlan,
} from '@repo/schemas/album-merges'
import { LibraryChangeSchema } from '@repo/schemas/library-changes'
import {
  albumMergeBlockLabels,
  albumNameKey,
  describeAlbumMergeCaution,
  describeAlbumMergeFollows,
  describeAlbumMergeUnmatched,
  mergeAlbums,
  moveAlbumName,
  parseAlbumNameKey,
  planAlbumMerge,
  planAlbumNameMove,
  quotedTitles,
  separateAlbumEdition,
} from './album-merges'

const apiBaseUrl = 'http://localhost:4001'

const album = (id: string, title: string, selected = true) => ({
  id,
  title,
  by: 'Fixture Artist',
  releaseDate: '2020-02-02',
  trackCount: 10,
  scrobbles: 4,
  spotify: false,
  editionOfId: null,
  selected,
})

const albumPlan: AlbumMergePlan = AlbumMergePlanSchema.parse({
  targetId: 'harbour',
  albums: [
    album('harbour', 'Harbour Lights'),
    album('harbour-deluxe', 'Harbour Lights (Deluxe)'),
  ],
  editions: [{ albumId: 'harbour-deluxe', fromId: null }],
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
    {
      artistName: 'Fixture Artist',
      trackName: 'Tide',
      scrobbles: 2,
      fromTrackId: 'tide-live',
      toTrackId: 'tide',
      toTitle: 'Tide',
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

const change = LibraryChangeSchema.parse({
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
  sources: [],
  names: [],
  nameCount: 0,
  scrobbles: 0,
  details: { counts: { edition: 1 } },
  createdAt: '2026-03-04T05:06:00.000Z',
  undoneAt: null,
  reversible: true,
  canUndo: true,
  canRedo: false,
  blocked: null,
})

test('album merge requests go to the journaled endpoints with their bodies', async (t) => {
  const requests: Array<{ url: string; method?: string; body: unknown }> = []
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return Response.json({
        statusCode: 200,
        message: 'OK',
        data: url.endsWith('/plan') ? albumPlan : change,
      })
    },
  )
  assert.deepEqual(
    await planAlbumMerge(apiBaseUrl, {
      albumIds: ['harbour', 'harbour-deluxe'],
    }),
    albumPlan,
  )
  assert.deepEqual(
    await mergeAlbums(apiBaseUrl, {
      albumIds: ['harbour', 'harbour-deluxe'],
      targetId: 'harbour',
      follow: false,
      reviewed: true,
    }),
    change,
  )
  await separateAlbumEdition(apiBaseUrl, 'harbour-deluxe')
  const name = { artistName: 'Fixture Artist', albumName: 'Harbour Lights' }
  await planAlbumNameMove(apiBaseUrl, { ...name, albumId: 'harbour' })
  await moveAlbumName(apiBaseUrl, {
    ...name,
    albumId: 'harbour',
    follow: true,
    reviewed: false,
  })
  const base = `${apiBaseUrl}/api/v1/library-changes`
  assert.deepEqual(requests, [
    {
      url: `${base}/album-merges/plan`,
      method: 'POST',
      body: { albumIds: ['harbour', 'harbour-deluxe'] },
    },
    {
      url: `${base}/album-merges`,
      method: 'POST',
      body: {
        albumIds: ['harbour', 'harbour-deluxe'],
        targetId: 'harbour',
        follow: false,
        reviewed: true,
      },
    },
    {
      url: `${base}/album-merges/separate`,
      method: 'POST',
      body: { albumId: 'harbour-deluxe' },
    },
    {
      url: `${base}/album-names/plan`,
      method: 'POST',
      body: { ...name, albumId: 'harbour' },
    },
    {
      url: `${base}/album-names`,
      method: 'POST',
      body: { ...name, albumId: 'harbour', follow: true, reviewed: false },
    },
  ])
})

test('an album name travels as one record ID and nothing else reads as one', () => {
  const name = { artistName: 'Fixture Artist', albumName: 'Harbour Lights' }
  assert.deepEqual(parseAlbumNameKey(albumNameKey(name)), name)
  assert.equal(parseAlbumNameKey('harbour'), null)
  assert.equal(parseAlbumNameKey('{"artistName":"Fixture Artist"}'), null)
  assert.equal(parseAlbumNameKey('[]'), null)
})

test('each album caution is one sentence naming the albums involved', () => {
  const sentence = (caution: AlbumMergePlan['cautions'][number]) =>
    describeAlbumMergeCaution(caution, albumPlan)
  assert.equal(
    sentence({ code: 'version', words: ['Deluxe'] }),
    '“Deluxe” is in some titles only.',
  )
  assert.equal(
    sentence({ code: 'version', words: ['Deluxe', 'Live'] }),
    '“Deluxe” and “Live” are in some titles only.',
  )
  assert.equal(
    sentence({ code: 'artists', names: ['Fixture Artist', 'Other Artist'] }),
    'The artists differ: Fixture Artist, Other Artist.',
  )
  assert.equal(
    sentence({
      code: 'tracks',
      albums: [{ albumId: 'harbour-deluxe', shared: 2, listed: 9 }],
    }),
    '“Harbour Lights (Deluxe)” and “Harbour Lights” share 2 of 9 track titles.',
  )
  assert.equal(
    sentence({
      code: 'elsewhere',
      count: 1,
      names: [
        {
          artistName: 'Fixture Artist',
          trackName: 'Pier',
          albumTitle: 'Coastline',
        },
      ],
    }),
    '1 track name that would follow is on another album: “Pier” on “Coastline”.',
  )
  assert.equal(
    sentence({
      code: 'elsewhere',
      count: 7,
      names: [
        {
          artistName: 'Fixture Artist',
          trackName: 'Pier',
          albumTitle: 'Coastline',
        },
      ],
    }),
    '7 track names that would follow are on other albums: “Pier” on “Coastline” and 6 more.',
  )
  assert.equal(
    sentence({ code: 'separate', albumIds: ['harbour', 'harbour-deluxe'] }),
    'Some of these albums were kept separate.',
  )
  assert.equal(
    albumMergeBlockLabels.hidden,
    'Albums removed from the library cannot be merged.',
  )
  assert.equal(
    albumMergeBlockLabels['same-record'],
    'These albums are one record already.',
  )
})

test('the names that follow and the names that stay are listed with the album names they come from', () => {
  assert.equal(
    describeAlbumMergeFollows(albumPlan),
    '2 names scrobbled under “Harbour Lights [Live]”, onto the matching tracks of “Harbour Lights”: “Pier” and “Tide”.',
  )
  assert.equal(
    describeAlbumMergeUnmatched(albumPlan),
    '1 name scrobbled under “Harbour Lights [Live]” matches no track of “Harbour Lights” and stays where it is: “Encore”.',
  )
  assert.equal(
    quotedTitles(['A', 'B', 'C', 'D', 'E']),
    '“A”, “B”, “C”, and 2 more',
  )
})
