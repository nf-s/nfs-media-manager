import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { env } from '@/env'
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

import { matchScrobbleTrack } from '@/services/track-merges'
import { importLastfmLibraryTracks } from '@/services/lastfm-library-tracks'
import { linkScrobblesToTracks } from '@/services/track-links'

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

it('requires visible Spotify targets and an unambiguous current recorded name', async () => {
  for (const { targetId, statusCode } of [
    { targetId: unknown, statusCode: 409 },
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
