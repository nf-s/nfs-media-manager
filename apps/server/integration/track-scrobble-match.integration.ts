import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { TrackScrobbleNamesQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { standaloneLastfmTrackId } from '@/lib/track-matching'
import * as schema from '@/schemas/db'

const database = 'scrobble_match_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        if (!headers.has('cookie')) return null
        return {
          user: { id: 'fixture-owner', email: 'owner@example.test' },
          session: { userId: 'fixture-owner' },
        }
      },
    },
  },
}))

import {
  matchScrobbleTrack,
  mergeLastfmTrack,
  removeScrobbleTrackMatch,
} from '@/services/track-merges'
import { importLastfmLibraryTracks } from '@/services/lastfm-library-tracks'
import { listLastfmTrackNames } from '@/services/lastfm-track-names'
import { linkScrobblesToTracks } from '@/services/track-links'
import { getTrackDetail } from '@/services/tracks'

const account = 'fixture-history'
const otherAccount = 'second-history'
const artistKey = 'fixture artist'
const trackKey = 'first song'
const original = 'original-track'
const target = 'album-track'
const alternate = 'alternate-track'
const unknown = 'unmatched-track'
const hidden = 'hidden-track'
const albumId = 'fixture-album'
const input = { artistKey, trackKey, targetId: target }
const selectName = and(
  eq(schema.lastfmTrackSource.username, account),
  eq(schema.lastfmTrackSource.artistKey, artistKey),
  eq(schema.lastfmTrackSource.trackKey, trackKey),
)
async function refreshHistory() {
  await importLastfmLibraryTracks(account)
  await linkScrobblesToTracks(account)
}

const mockFetch = vi.fn<typeof fetch>(async () => {
  throw new Error('Unexpected provider request')
})
let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', mockFetch)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  mockFetch.mockClear()
  await fixture.delete(schema.scrapeJob)
  await fixture.delete(schema.playlist)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.delete(schema.artist)
  await fixture.insert(schema.mediaItem).values([
    { id: albumId, slug: albumId, title: 'Fixture Album', mediaType: 'album' },
    {
      id: original,
      slug: original,
      title: 'Original',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
    {
      id: alternate,
      slug: alternate,
      title: 'Alternate',
      mediaType: 'track',
      sourceLabel: 'spotify',
    },
    {
      id: target,
      slug: target,
      title: 'Album Track',
      mediaType: 'track',
      sourceLabel: 'album',
    },
    { id: unknown, slug: unknown, title: 'Unknown', mediaType: 'track' },
    {
      id: hidden,
      slug: hidden,
      title: 'Hidden',
      mediaType: 'track',
      metadata: { legacyHidden: true },
    },
  ])
  await fixture.insert(schema.album).values({ mediaItemId: albumId })
  const nativeIds = {
    [original]: 'Original'.padEnd(22, '0'),
    [target]: 'AlbumTrack'.padEnd(22, '0'),
    [alternate]: 'Alternate'.padEnd(22, '0'),
    [hidden]: 'Hidden'.padEnd(22, '0'),
  }
  await fixture.insert(schema.libraryTrack).values([
    ...Object.entries(nativeIds).map(([mediaItemId, spotifyTrackId]) => ({
      mediaItemId,
      spotifyTrackId,
    })),
    { mediaItemId: unknown },
  ])
  await fixture.insert(schema.track).values({
    id: 'fixture-position',
    albumMediaItemId: albumId,
    trackMediaItemId: target,
    externalId: nativeIds[target],
    title: 'Album Track',
    position: 2,
  })
  await fixture.insert(schema.artist).values([
    { id: 'original-artist', name: 'Original Artist' },
    { id: 'target-artist', name: 'Target Artist' },
  ])
  await fixture.insert(schema.mediaCredit).values([
    { mediaItemId: original, artistId: 'original-artist', role: 'artist' },
    { mediaItemId: target, artistId: 'target-artist', role: 'artist' },
  ])
  await fixture.insert(schema.playlist).values({
    id: 'fixture-playlist',
    name: 'Fixture Playlist',
    kind: 'playlist',
  })
  await fixture.insert(schema.playlistItem).values([
    {
      playlistId: 'fixture-playlist',
      mediaItemId: original,
      position: 0,
      addedAt: new Date('2024-01-01'),
    },
    {
      playlistId: 'fixture-playlist',
      mediaItemId: alternate,
      position: 1,
      addedAt: new Date('2024-02-01'),
    },
  ])
  const names = [
    {
      id: 'first-event',
      username: account,
      trackKey,
      trackName: 'First Song',
      listenedAt: new Date('2022-01-01'),
    },
    {
      id: 'second-event',
      username: account,
      trackKey: 'second song',
      trackName: 'Second Song',
      listenedAt: new Date('2023-01-01'),
    },
    {
      id: 'other-event',
      username: otherAccount,
      trackKey,
      trackName: 'First Song',
      listenedAt: new Date('2020-01-01'),
    },
  ].map((row) => ({ ...row, artistKey, artistName: 'Fixture Artist' }))
  await fixture.insert(schema.lastfmScrobble).values(names)
  const sources = names.map(({ username, artistKey, trackKey }) => ({
    username,
    artistKey,
    trackKey,
    trackMediaItemId: username === account ? original : alternate,
    manuallyMatched: username === account,
  }))
  await fixture.insert(schema.lastfmTrackSource).values(sources)
  await fixture.insert(schema.lastfmTrackLink).values([
    ...sources.map(({ manuallyMatched, ...source }) => ({
      ...source,
      strategy: manuallyMatched ? 'manual' : 'exact',
    })),
    {
      username: account,
      artistKey,
      trackKey,
      trackMediaItemId: alternate,
      strategy: 'exact',
    },
  ])
})

it.each([
  {
    reason: 'another library edition matches the exact name',
    catalogTitle: 'First Song',
    recordedArtist: 'Fixture Artist',
    anotherExactMatch: true,
  },
  {
    reason: 'the recorded name has a different spelling',
    catalogTitle: 'Fírst Song',
    recordedArtist: 'Fixture Artist',
    anotherExactMatch: false,
  },
  {
    reason: 'the recorded artist includes a combined guest credit',
    catalogTitle: 'First Song',
    recordedArtist: 'Fixture Artist, Fixture Guest',
    anotherExactMatch: false,
  },
  {
    reason: 'the name has listens from more than one ordinary release',
    catalogTitle: 'First Song',
    recordedArtist: 'Fixture Artist',
    anotherExactMatch: false,
    multipleAlbums: true,
  },
])(
  'retains an accepted Spotify recording when $reason',
  async ({
    catalogTitle,
    recordedArtist,
    anotherExactMatch,
    multipleAlbums,
  }) => {
    const acceptedId = alternate
    const artistName = 'Fixture Artist'
    const spotifyTrackId = 'Alternate'.padEnd(22, '0')
    await fixture
      .update(schema.mediaItem)
      .set({ title: catalogTitle })
      .where(eq(schema.mediaItem.id, acceptedId))
    if (multipleAlbums)
      await fixture
        .update(schema.libraryTrack)
        .set({ albumName: 'Fixture Album' })
        .where(eq(schema.libraryTrack.mediaItemId, acceptedId))
    await fixture.insert(schema.artist).values([
      { id: 'fixture-search-artist', name: artistName },
      { id: 'fixture-search-guest', name: 'Fixture Guest' },
    ])
    await fixture.insert(schema.mediaCredit).values([
      {
        mediaItemId: acceptedId,
        artistId: 'fixture-search-artist',
        role: 'artist',
      },
      ...(recordedArtist !== artistName
        ? [
            {
              mediaItemId: acceptedId,
              artistId: 'fixture-search-guest',
              role: 'artist',
              billingOrder: 1,
            },
          ]
        : []),
    ])
    if (anotherExactMatch) {
      await fixture
        .update(schema.mediaItem)
        .set({ title: 'First Song' })
        .where(eq(schema.mediaItem.id, original))
      await fixture
        .update(schema.mediaCredit)
        .set({ artistId: 'fixture-search-artist' })
        .where(eq(schema.mediaCredit.mediaItemId, original))
    }
    const recordedArtistKey = recordedArtist.toLowerCase()
    const sourceId = standaloneLastfmTrackId(account, {
      artistKey: recordedArtistKey,
      trackKey,
    })
    await fixture
      .update(schema.lastfmScrobble)
      .set({
        artistName: recordedArtist,
        artistKey: recordedArtistKey,
        ...(multipleAlbums
          ? {
              albumName: 'Fixture Album',
              albumKey: 'fixture album',
              albumMediaItemId: albumId,
            }
          : {}),
      })
      .where(eq(schema.lastfmScrobble.id, 'first-event'))
    await fixture
      .update(schema.lastfmTrackSource)
      .set({
        artistKey: recordedArtistKey,
        trackMediaItemId: acceptedId,
        manuallyMatched: false,
      })
      .where(selectName)
    const otherName = and(
      eq(schema.lastfmTrackSource.username, account),
      eq(schema.lastfmTrackSource.artistKey, artistKey),
      eq(schema.lastfmTrackSource.trackKey, 'second song'),
    )
    await fixture
      .update(schema.lastfmTrackSource)
      .set({ trackMediaItemId: acceptedId, manuallyMatched: false })
      .where(otherName)
    await fixture.insert(schema.scrapeJob).values({
      id: 'fixture-accepted-search',
      provider: 'spotify',
      status: 'succeeded',
      scope: { mediaType: 'track', mediaItemIds: [sourceId] },
      options: {
        task: SPOTIFY_TRACK_SEARCH_TASK,
        trackId: sourceId,
        acceptedTrackId: acceptedId,
        acceptedSpotifyTrackId: spotifyTrackId,
        matchMethod: 'automatic',
      },
    })
    await fixture.insert(schema.lastfmScrobble).values({
      id: 'another-listen-to-accepted-name',
      username: account,
      artistKey: recordedArtistKey,
      artistName: recordedArtist,
      trackKey,
      trackName: 'First Song',
      listenedAt: new Date('2024-01-01'),
      ...(multipleAlbums
        ? { albumName: 'Fixture Single', albumKey: 'fixture single' }
        : {}),
    })
    await refreshHistory()
    const originalName = and(
      eq(schema.lastfmTrackSource.username, account),
      eq(schema.lastfmTrackSource.artistKey, recordedArtistKey),
      eq(schema.lastfmTrackSource.trackKey, trackKey),
    )
    expect(
      await fixture.select().from(schema.lastfmTrackSource).where(originalName),
    ).toMatchObject([{ trackMediaItemId: acceptedId, manuallyMatched: false }])
    expect(
      await fixture
        .select()
        .from(schema.lastfmTrackLink)
        .where(
          and(
            eq(schema.lastfmTrackLink.username, account),
            eq(schema.lastfmTrackLink.artistKey, recordedArtistKey),
            eq(schema.lastfmTrackLink.trackKey, trackKey),
            eq(schema.lastfmTrackLink.trackMediaItemId, acceptedId),
          ),
        ),
    ).toMatchObject([{ strategy: 'exact' }])
    expect(
      await fixture.select().from(schema.lastfmTrackSource).where(otherName),
    ).toMatchObject([
      {
        trackMediaItemId: standaloneLastfmTrackId(account, {
          artistKey,
          trackKey: 'second song',
        }),
        manuallyMatched: false,
      },
    ])

    if (anotherExactMatch) {
      await fixture
        .update(schema.lastfmTrackSource)
        .set({ trackMediaItemId: original })
        .where(eq(schema.lastfmTrackSource.username, otherAccount))
      // An explicit reset recomputes the name instead of reusing the job.
      await expect(
        removeScrobbleTrackMatch(acceptedId, {
          artistKey: recordedArtistKey,
          trackKey,
          mode: 'automatic',
        }),
      ).resolves.toEqual({ targetId: sourceId })
      await refreshHistory()
      expect(
        await fixture
          .select()
          .from(schema.lastfmTrackSource)
          .where(originalName),
      ).toMatchObject([{ trackMediaItemId: sourceId, manuallyMatched: false }])
    }
  },
)

it('can assign an imported name to a stored track without a Spotify ID', async () => {
  await expect(
    matchScrobbleTrack(original, { ...input, targetId: unknown }),
  ).resolves.toEqual({ targetId: unknown })
  expect(
    await fixture.select().from(schema.lastfmTrackSource).where(selectName),
  ).toMatchObject([{ trackMediaItemId: unknown, manuallyMatched: true }])
})

it('replaces a previous manual match and keeps the correction across history refreshes', async () => {
  const playlists = await fixture.select().from(schema.playlistItem)
  const positions = await fixture.select().from(schema.track)
  expect(
    await Promise.all([
      matchScrobbleTrack(original, input),
      matchScrobbleTrack(original, input),
    ]),
  ).toEqual([{ targetId: target }, { targetId: target }])
  await expect(
    matchScrobbleTrack(original, { ...input, targetId: alternate }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  for (let count = 0; count < 2; count += 1) {
    await importLastfmLibraryTracks(account)
    await linkScrobblesToTracks(account)
  }
  expect(
    await fixture.select().from(schema.lastfmTrackSource).where(selectName),
  ).toMatchObject([{ trackMediaItemId: target, manuallyMatched: true }])
  expect(await fixture.select().from(schema.lastfmTrackLink)).toEqual(
    expect.arrayContaining([
      {
        username: account,
        artistKey,
        trackKey,
        trackMediaItemId: target,
        strategy: 'manual',
      },
      {
        username: account,
        artistKey,
        trackKey: 'second song',
        trackMediaItemId: original,
        strategy: 'manual',
      },
      {
        username: otherAccount,
        artistKey,
        trackKey,
        trackMediaItemId: alternate,
        strategy: 'exact',
      },
    ]),
  )
  expect(await fixture.select().from(schema.lastfmTrackLink)).toHaveLength(3)
  expect(await fixture.select().from(schema.playlistItem)).toEqual(playlists)
  expect(await fixture.select().from(schema.track)).toEqual(positions)
  expect(await fixture.select().from(schema.libraryTrack)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mediaItemId: original,
        scrobbleCount: 1,
        dateAdded: new Date('2023-01-01'),
      }),
      expect.objectContaining({
        mediaItemId: target,
        scrobbleCount: 1,
        dateAdded: new Date('2022-01-01'),
      }),
      expect.objectContaining({ mediaItemId: alternate, scrobbleCount: 1 }),
    ]),
  )
  expect(await fixture.select().from(schema.artist)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'original-artist', scrobbleCount: 1 }),
      expect.objectContaining({ id: 'target-artist', scrobbleCount: 1 }),
    ]),
  )
  expect(mockFetch).not.toHaveBeenCalled()
})

it('requires visible targets and an unambiguous current recorded name', async () => {
  for (const { targetId, statusCode } of [
    { targetId: hidden, statusCode: 404 },
    { targetId: 'missing', statusCode: 404 },
  ]) {
    await expect(
      matchScrobbleTrack(original, { ...input, targetId }),
    ).rejects.toMatchObject({ response: { statusCode } })
  }
  await expect(matchScrobbleTrack(unknown, input)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  await expect(
    matchScrobbleTrack(original, { ...input, trackKey: 'missing title' }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  await expect(matchScrobbleTrack(alternate, input)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  await fixture
    .update(schema.lastfmScrobble)
    .set({ trackName: 'Unrelated name' })
    .where(eq(schema.lastfmScrobble.id, 'first-event'))
  await expect(matchScrobbleTrack(original, input)).rejects.toMatchObject({
    response: { statusCode: 409 },
  })
  expect(
    await fixture.select().from(schema.lastfmTrackSource).where(selectName),
  ).toMatchObject([{ trackMediaItemId: original, manuallyMatched: true }])
  expect(mockFetch).not.toHaveBeenCalled()
})

it('allows correction from an attributed track and rejects a competing stale choice', async () => {
  await fixture
    .delete(schema.lastfmTrackLink)
    .where(eq(schema.lastfmTrackLink.username, otherAccount))
  await fixture
    .update(schema.lastfmTrackSource)
    .set({
      trackMediaItemId: unknown,
    })
    .where(eq(schema.lastfmTrackSource.username, otherAccount))
  const results = await Promise.allSettled([
    matchScrobbleTrack(alternate, input),
    matchScrobbleTrack(alternate, { ...input, targetId: original }),
  ])
  const accepted = results.find((result) => result.status === 'fulfilled')
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1)
  expect(results).toContainEqual(
    expect.objectContaining({
      status: 'rejected',
      reason: expect.objectContaining({
        response: expect.objectContaining({ statusCode: 409 }),
      }),
    }),
  )
  expect(
    await fixture.select().from(schema.lastfmTrackSource).where(selectName),
  ).toMatchObject([
    { trackMediaItemId: accepted?.value.targetId, manuallyMatched: true },
  ])
  expect(mockFetch).not.toHaveBeenCalled()
})

it('separates a name, preserves its plays through another import, and restores automatic matching', async () => {
  await fixture
    .update(schema.mediaItem)
    .set({ title: 'First Song' })
    .where(eq(schema.mediaItem.id, original))
  await fixture
    .update(schema.artist)
    .set({ name: 'Fixture Artist' })
    .where(eq(schema.artist.id, 'original-artist'))
  await fixture
    .update(schema.libraryTrack)
    .set({ albumName: 'Fixture Album' })
    .where(eq(schema.libraryTrack.mediaItemId, original))
  await fixture
    .update(schema.lastfmScrobble)
    .set({
      albumKey: 'fixture album',
      albumName: 'Fixture Album',
      albumMediaItemId: albumId,
    })
    .where(eq(schema.lastfmScrobble.id, 'first-event'))

  const selection = { artistKey, trackKey }
  const { targetId: standalone } = await removeScrobbleTrackMatch(original, {
    ...selection,
    mode: 'separate',
  })
  expect(standalone).not.toBe(original)
  // A later delivery of this name keeps the standalone choice.
  await fixture.insert(schema.lastfmScrobble).values({
    id: 'new-first-event',
    username: account,
    artistKey,
    artistName: 'Fixture Artist',
    trackKey,
    trackName: 'First Song',
    listenedAt: new Date('2024-01-02'),
  })
  const raw = await fixture
    .select()
    .from(schema.lastfmScrobble)
    .orderBy(schema.lastfmScrobble.id)
  await refreshHistory()
  expect(await getTrackDetail(standalone)).toMatchObject({
    scrobbles: 2,
    dateAdded: '2022-01-01T00:00:00.000Z',
    lastfmSources: [{ ...selection, count: 2, keptSeparate: true }],
    listening: {
      total: 2,
      lastListenedAt: '2024-01-02T00:00:00.000Z',
      sources: [{ ...selection, count: 2, strategy: 'manual' }],
    },
  })
  expect(await getTrackDetail(original)).toMatchObject({
    scrobbles: 1,
    lastfmSources: [{ trackKey: 'second song', count: 1 }],
  })

  await expect(
    removeScrobbleTrackMatch(standalone, { ...selection, mode: 'automatic' }),
  ).resolves.toEqual({ targetId: original, sourceRemoved: true })
  await refreshHistory()
  expect(await getTrackDetail(standalone)).toBeNull()
  expect(await getTrackDetail(original)).toMatchObject({
    scrobbles: 3,
    lastfmSources: [
      { ...selection, count: 2, keptSeparate: false, manuallyMatched: false },
      { trackKey: 'second song' },
    ],
  })
  expect(
    await fixture
      .select()
      .from(schema.lastfmScrobble)
      .orderBy(schema.lastfmScrobble.id),
  ).toEqual(raw)
  expect(mockFetch).not.toHaveBeenCalled()
})

it('merges all recorded names into a local Last.fm track without moving releases or playlists', async () => {
  await fixture
    .update(schema.libraryTrack)
    .set({ spotifyTrackId: null })
    .where(eq(schema.libraryTrack.mediaItemId, original))
  await fixture.insert(schema.track).values({
    id: 'fixture-original-position',
    albumMediaItemId: albumId,
    trackMediaItemId: original,
    title: 'Original',
    position: 1,
  })
  await fixture.insert(schema.lastfmScrobble).values(
    [
      {
        id: 'local-edit-event',
        trackKey: 'local edit',
        trackName: 'Local Edit',
      },
      {
        id: 'local-take-event',
        trackKey: 'local take',
        trackName: 'Local Take',
      },
    ].map((name) => ({
      ...name,
      username: account,
      artistKey,
      artistName: 'Fixture Artist',
      listenedAt: new Date('2024-01-02'),
    })),
  )
  await refreshHistory()
  const [local, take] = (
    await listLastfmTrackNames(
      original,
      TrackScrobbleNamesQuerySchema.parse({ q: 'local' }),
    )
  ).items
  if (!local || !take) throw new Error('Expected two local Last.fm fixtures')
  const positions = await fixture.select().from(schema.track)
  const playlists = await fixture.select().from(schema.playlistItem)
  await expect(
    mergeLastfmTrack(take.trackId, {
      targetId: local.trackId,
      namesOnly: true,
    }),
  ).resolves.toEqual({ targetId: local.trackId, sourceRemoved: true })
  await expect(
    mergeLastfmTrack(original, { targetId: local.trackId, namesOnly: true }),
  ).resolves.toEqual({ targetId: local.trackId })
  await refreshHistory()
  expect(await getTrackDetail(take.trackId)).toBeNull()
  expect(await getTrackDetail(local.trackId)).toMatchObject({
    scrobbles: 4,
    spotifyTrackId: null,
    lastfmSources: expect.arrayContaining([
      expect.objectContaining({
        trackKey: 'first song',
        manuallyMatched: true,
      }),
      expect.objectContaining({
        trackKey: 'second song',
        manuallyMatched: true,
      }),
      expect.objectContaining({
        trackKey: 'local edit',
        manuallyMatched: false,
      }),
      expect.objectContaining({
        trackKey: 'local take',
        manuallyMatched: true,
      }),
    ]),
  })
  expect(await getTrackDetail(original)).toMatchObject({
    id: original,
    scrobbles: 0,
  })
  expect(await fixture.select().from(schema.track)).toEqual(positions)
  expect(await fixture.select().from(schema.playlistItem)).toEqual(playlists)
  expect(mockFetch).not.toHaveBeenCalled()
})

it('searches recorded names across the library without exposing Last.fm usernames', async () => {
  const query = TrackScrobbleNamesQuerySchema.parse({
    q: 'song ARTIST',
    size: 1,
  })
  const first = await listLastfmTrackNames(original, query)
  const second = await listLastfmTrackNames(original, { ...query, page: 2 })
  expect(first).toMatchObject({
    totalCount: 3,
    pageCount: 3,
    items: [{ artistKey, trackKey, count: 1, trackId: original }],
  })
  expect(second).toMatchObject({
    totalCount: 3,
    items: [{ artistKey, trackKey, count: 1, trackId: alternate }],
  })
  expect(JSON.stringify(first)).not.toContain(account)
  expect(JSON.stringify(second)).not.toContain(otherAccount)
  const wildcard = await listLastfmTrackNames(original, { ...query, q: '%' })
  expect(wildcard).toMatchObject({ totalCount: 0, items: [] })
  await expect(listLastfmTrackNames(hidden, query)).rejects.toMatchObject({
    response: { statusCode: 404 },
  })
  expect(mockFetch).not.toHaveBeenCalled()
})

it('can keep an alias separate where it is displayed only by listening attribution', async () => {
  await fixture
    .delete(schema.lastfmTrackLink)
    .where(eq(schema.lastfmTrackLink.username, otherAccount))
  await fixture
    .update(schema.lastfmTrackSource)
    .set({ trackMediaItemId: unknown })
    .where(eq(schema.lastfmTrackSource.username, otherAccount))
  const selection = { artistKey, trackKey }
  await expect(
    removeScrobbleTrackMatch(alternate, { ...selection, mode: 'automatic' }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  const { targetId } = await removeScrobbleTrackMatch(alternate, {
    ...selection,
    mode: 'separate',
  })
  await refreshHistory()
  expect(await getTrackDetail(targetId)).toMatchObject({
    lastfmSources: [{ ...selection, keptSeparate: true }],
    scrobbles: 1,
  })
  expect(await getTrackDetail(alternate)).toMatchObject({ scrobbles: 0 })
  expect(await getTrackDetail(original)).toMatchObject({ scrobbles: 1 })
})

it('serves name search and authenticated, validated match removal through the tracks API', async () => {
  const { default: app } = await import('@/app')
  const path = `/api/v1/tracks/${original}`
  const headers = {
    'content-type': 'application/json',
    cookie: 'session=fixture',
    origin: 'http://localhost:3000',
  }
  const match = { artistKey, trackKey }
  const anonymous = await app.request(`${path}/scrobble-names?q=first`)
  expect(anonymous.status).toBe(401)
  const listed = await app.request(`${path}/scrobble-names?q=first`, {
    headers,
  })
  expect(listed.status).toBe(200)
  expect(
    (await app.request(`${path}/scrobble-names?q=bad%00input`, { headers }))
      .status,
  ).toBe(422)
  expect(await listed.json()).toMatchObject({
    data: {
      items: [expect.objectContaining(match), expect.objectContaining(match)],
      totalCount: 2,
    },
  })
  const remove = (body: unknown, origin = headers.origin) =>
    app.request(`${path}/scrobble-match`, {
      method: 'DELETE',
      headers: { ...headers, origin },
      body: JSON.stringify(body),
    })
  expect((await remove(match, 'https://untrusted.example')).status).toBe(403)
  expect((await remove({ ...match, mode: 'invalid' })).status).toBe(422)
  const removed = await remove(match)
  expect(removed.status).toBe(200)
  expect(await removed.json()).toMatchObject({
    data: { targetId: expect.stringMatching(/^library-track_/) },
  })
})
