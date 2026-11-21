import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ArtistMergePlanArtistSchema,
  ArtistMergePlanSchema,
} from '@repo/schemas/artist-merges'
import {
  artistMergeBlockLabels,
  describeArtistMergeBlock,
  describeArtistMergeCaution,
  describeArtistMergeFollows,
  mergeArtists,
  planArtistMerge,
} from './artist-merges'

const apiBaseUrl = 'http://localhost:4001'

const artist = (id: string, name: string) => ({
  id,
  name,
  scrobbles: 10,
  albumCount: 1,
  trackCount: 3,
  creditCount: 4,
  spotify: false,
  providers: [],
  names: [],
  blocked: null,
})

const plan = ArtistMergePlanSchema.parse({
  targetId: 'artist-1',
  artists: [artist('artist-1', 'The Lowlands'), artist('artist-2', 'Lowlands')],
  moves: { credits: 4, albums: 1, tracks: 3, shared: 0, names: ['Lowlands'] },
  scrobbles: { target: 10, total: 20 },
  also: [],
  cautions: [],
  blocked: false,
})

test('artist merges are planned and made through the library change endpoints', async (t) => {
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
        data: url.endsWith('/plan')
          ? plan
          : {
              id: 'change-1',
              kind: 'artist',
              action: 'merge',
              actor: 'owner',
              rule: null,
              batchId: null,
              target: {
                id: 'artist-1',
                title: 'The Lowlands',
                by: '',
                exists: true,
              },
              sources: [
                { id: 'artist-2', title: 'Lowlands', by: '', exists: false },
              ],
              names: [],
              nameCount: 0,
              scrobbles: 0,
              details: null,
              createdAt: '2026-03-04T05:06:00.000Z',
              undoneAt: null,
              reversible: true,
              canUndo: true,
              canRedo: false,
              blocked: null,
            },
      })
    },
  )
  assert.deepEqual(
    await planArtistMerge(apiBaseUrl, { artistIds: ['artist-1', 'artist-2'] }),
    plan,
  )
  const change = await mergeArtists(apiBaseUrl, {
    artistIds: ['artist-1', 'artist-2'],
    targetId: 'artist-1',
    follow: false,
    reviewed: true,
  })
  assert.equal(change.kind, 'artist')
  assert.deepEqual(requests, [
    {
      url: `${apiBaseUrl}/api/v1/library-changes/artist-merges/plan`,
      method: 'POST',
      body: { artistIds: ['artist-1', 'artist-2'] },
    },
    {
      url: `${apiBaseUrl}/api/v1/library-changes/artist-merges`,
      method: 'POST',
      body: {
        artistIds: ['artist-1', 'artist-2'],
        targetId: 'artist-1',
        follow: false,
        reviewed: true,
      },
    },
  ])
})

test('each artist merge caution reads as one sentence', () => {
  assert.equal(
    describeArtistMergeCaution({
      code: 'profiles',
      providers: ['spotify', 'musicbrainz'],
    }),
    'They have different profiles on Spotify and MusicBrainz.',
  )
  assert.equal(
    describeArtistMergeCaution({ code: 'together', items: 1 }),
    'They are credited together on 1 track or album, so they are likely different artists.',
  )
  assert.equal(
    describeArtistMergeCaution({ code: 'together', items: 12 }),
    'They are credited together on 12 tracks or albums, so they are likely different artists.',
  )
  assert.equal(
    describeArtistMergeCaution({
      code: 'names',
      names: ['The Lowlands', 'Harbour Lights'],
    }),
    'The names are not alike: “The Lowlands”, “Harbour Lights”.',
  )
  assert.equal(
    describeArtistMergeCaution({
      code: 'separate',
      names: ['The Lowlands', 'Lowlands'],
    }),
    '“The Lowlands” and “Lowlands” were kept separate.',
  )
})

test('an artist with film credits says why it cannot be merged', () => {
  const film = ArtistMergePlanArtistSchema.parse({
    ...artist('artist-3', 'June Okafor'),
    blocked: 'film',
  })
  assert.equal(artistMergeBlockLabels.film, 'Has film credits')
  assert.equal(
    describeArtistMergeBlock([film]),
    '“June Okafor” has film credits and cannot be merged. People in films and music artists share one record.',
  )
  assert.equal(
    describeArtistMergeBlock([film, { ...film, id: 'artist-4' }]),
    '2 artists have film credits and cannot be merged. People in films and music artists share one record.',
  )
})

test('the titles that follow the merged names are counted and named', () => {
  const title = (artistName: string, trackName: string) => ({
    artistName,
    trackName,
    scrobbles: 3,
    fromTrackId: `from-${trackName}`,
    toTrackId: `to-${trackName}`,
    toTitle: trackName,
  })
  assert.equal(
    describeArtistMergeFollows(
      [
        title('Lowlands', 'Harbour'),
        title('Lowlands', 'Quay'),
        title('The Low Lands', 'Tide'),
      ],
      'The Lowlands',
    ),
    '3 track names scrobbled under “Lowlands” and “The Low Lands” move to the matching tracks of “The Lowlands”: “Harbour”, “Quay”, “Tide”.',
  )
  assert.equal(
    describeArtistMergeFollows([title('Lowlands', 'Harbour')]),
    '1 track name scrobbled under “Lowlands” moves to the matching tracks: “Harbour”.',
  )
})
