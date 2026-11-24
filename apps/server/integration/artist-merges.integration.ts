import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  ArtistQuerySchema,
  ArtistTrackQuerySchema,
} from '@repo/schemas/creators'
import { LibraryChangeListQuerySchema } from '@repo/schemas/library-changes'
import { env } from '@/env'
import { albumNameKey } from '@/lib/album-import-candidates'
import { createStableId } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = 'artist_merges_' + randomUUID().replaceAll('-', '')
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

import { mergeArtists } from '@/services/artist-merges'
import { planArtistMerge } from '@/services/artist-merge-plan'
import {
  countArtistBrowse,
  listArtistBrowsePage,
} from '@/services/artist-browse'
import { refreshArtistListeningTotals } from '@/services/artist-listening'
import {
  listCatalogObservations,
  observeCatalogOccurrences,
  promoteNativeResource,
} from '@/services/catalog-discoveries'
import { getArtist, listArtistTracks } from '@/services/creators'
import { importLastfmLibraryTracks } from '@/services/lastfm-library-tracks'
import {
  listLibraryChanges,
  redoLibraryChange,
  undoLibraryChange,
} from '@/services/library-changes'
import { replaceSpotifyTrackCredits } from '@/services/spotify-playlists'
import { linkScrobblesToTracks } from '@/services/track-links'

const account = 'fixture-artist-merges'
// Synthetic names: an accented artist with a Spotify profile, and the
// unaccented spelling Last.fm scrobbles create.
const KEPT = 'Fixture Beyoncé'
const SPELLING = 'Fixture Beyonce'
const keptId = 'artist-kept'
const spellingId = createStableId('artist', SPELLING.toLowerCase())
const otherId = 'artist-other'
const spotifyTrack = 'track-spotify'
const spellingAlbum = 'album-spelling'
const playlistId = 'fixture-playlist'

const scrobbles = (
  artistName: string,
  trackName: string,
  count: number,
  albumMediaItemId: string | null = null,
) =>
  Array.from({ length: count }, (_, index) => ({
    id: `${artistName}-${trackName}-${index}`,
    username: account,
    artistName,
    artistKey: albumNameKey(artistName),
    trackName,
    trackKey: albumNameKey(trackName),
    albumName: albumMediaItemId ? 'Spelling Album' : null,
    albumKey: albumMediaItemId ? albumNameKey('Spelling Album') : null,
    albumMediaItemId,
    listenedAt: new Date(Date.UTC(2023, 0, 1 + index)),
  }))

const credits = () =>
  fixture
    .select()
    .from(schema.mediaCredit)
    .orderBy(
      asc(schema.mediaCredit.mediaItemId),
      asc(schema.mediaCredit.artistId),
      asc(schema.mediaCredit.role),
    )

const artistRows = () =>
  fixture
    .select({
      id: schema.artist.id,
      name: schema.artist.name,
      mergedIntoId: schema.artist.mergedIntoId,
      scrobbleCount: schema.artist.scrobbleCount,
    })
    .from(schema.artist)
    .orderBy(asc(schema.artist.id))

const artistOf = async (id: string) =>
  (await artistRows()).find((row) => row.id === id)

const browseIds = async () => {
  const query = ArtistQuerySchema.parse({ size: 100 })
  const [page, count] = await Promise.all([
    listArtistBrowsePage(query),
    countArtistBrowse(query),
  ])
  return {
    ids: page.items.map((item) => item.id).sort(),
    count: count.totalCount,
  }
}

const artistChanges = (recordId?: string) =>
  listLibraryChanges(
    LibraryChangeListQuerySchema.parse({ kind: 'artist', recordId }),
  )

async function addProfile(
  artistId: string,
  provider: string,
  externalId: string,
) {
  const id = `${artistId}-${provider}`
  await fixture.insert(schema.artistProviderSnapshot).values({
    id,
    artistId,
    provider,
    payload: {},
    normalizedData: { externalId, tags: [] },
  })
  await fixture
    .insert(schema.artistProviderCurrentState)
    .values({ artistId, provider, latestSnapshotId: id })
}

async function addArtist(id: string, name: string, items: string[]) {
  await fixture.insert(schema.artist).values({ id, name, sortName: name })
  await fixture.insert(schema.mediaItem).values(
    items.map((item) => ({
      id: item,
      slug: item,
      title: item,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })),
  )
  await fixture.insert(schema.libraryTrack).values(
    items.map((mediaItemId) => ({
      mediaItemId,
      spotifyTrackId: mediaItemId.replace(/\W/g, '').padEnd(22, '0'),
    })),
  )
  // A Spotify track stays in the library through its playlist entry.
  await fixture.insert(schema.playlistItem).values(
    items.map((mediaItemId, position) => ({
      playlistId,
      mediaItemId,
      position,
      addedAt: new Date('2024-01-01'),
    })),
  )
  await fixture.insert(schema.mediaCredit).values(
    items.map((mediaItemId) => ({
      mediaItemId,
      artistId: id,
      role: 'artist',
    })),
  )
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
  await fixture.delete(schema.libraryChange)
  await fixture.delete(schema.libraryKeepSeparate)
  await fixture.delete(schema.lastfmScrobble)
  await fixture.delete(schema.track)
  await fixture.delete(schema.mediaItem)
  await fixture.execute('update artist set merged_into_id = null')
  await fixture.delete(schema.artist)
  await fixture.delete(schema.playlist)
  await fixture
    .insert(schema.playlist)
    .values({ id: playlistId, name: 'Fixture', kind: 'playlist' })
  await addArtist(keptId, KEPT, [spotifyTrack])
  await addProfile(keptId, 'spotify', 'spotify-kept')
  await fixture.insert(schema.mediaItem).values({
    id: spellingAlbum,
    slug: spellingAlbum,
    title: 'Spelling Album',
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({ mediaItemId: spellingAlbum })
  await fixture
    .insert(schema.lastfmScrobble)
    .values([
      ...scrobbles(SPELLING, 'Halo', 3),
      ...scrobbles(SPELLING, 'Baby Boy', 2, spellingAlbum),
    ])
  // The Last.fm import creates the spelling as an artist of its own.
  await importLastfmLibraryTracks(account)
  await linkScrobblesToTracks(account)
  await fixture.insert(schema.mediaCredit).values({
    mediaItemId: spellingAlbum,
    artistId: spellingId,
    role: 'artist',
  })
  await refreshArtistListeningTotals(fixture)
})

it('plans a merge into the artist with a Spotify profile', async () => {
  const plan = await planArtistMerge({ artistIds: [spellingId, keptId] })
  expect(plan).toMatchObject({
    targetId: keptId,
    blocked: false,
    cautions: [],
    moves: { credits: 3, albums: 1, tracks: 2, shared: 0, names: [SPELLING] },
    scrobbles: { target: 0, total: 5 },
  })
  expect(plan.artists.map(({ id, spotify }) => ({ id, spotify }))).toEqual([
    { id: keptId, spotify: true },
    { id: spellingId, spotify: false },
  ])
})

it('merges, undoes and makes the merge again', async () => {
  const before = await credits()
  const artistsBefore = await artistRows()
  expect((await browseIds()).ids).toEqual([keptId, spellingId].sort())

  const merged = await mergeArtists({
    artistIds: [spellingId, keptId],
    reviewed: false,
  })
  expect(merged).toMatchObject({
    kind: 'artist',
    action: 'merge',
    target: { id: keptId, title: KEPT, exists: true },
    sources: [{ id: spellingId, title: SPELLING, exists: true }],
    details: { counts: { credit: 3, 'artist-name': 1 }, labels: [SPELLING] },
    canUndo: true,
  })
  const after = await credits()
  expect(after.filter((row) => row.artistId === spellingId)).toEqual([])
  expect(after.filter((row) => row.creditedAs === SPELLING)).toHaveLength(3)
  expect(await artistOf(spellingId)).toMatchObject({
    mergedIntoId: keptId,
    scrobbleCount: 0,
  })
  expect((await artistOf(keptId))?.scrobbleCount).toBe(5)
  expect(await browseIds()).toEqual({ ids: [keptId], count: 1 })
  // An old link reads as the artist kept.
  const read = await getArtist(spellingId)
  expect(read).toMatchObject({
    id: keptId,
    name: KEPT,
    trackCount: 3,
    albumCount: 1,
    keptNames: [{ id: spellingId, name: SPELLING }],
  })
  expect(
    (await listArtistTracks(spellingId, ArtistTrackQuerySchema.parse({})))
      .totalCount,
  ).toBe(3)
  expect((await artistChanges(spellingId)).items.map(({ id }) => id)).toEqual([
    merged.id,
  ])

  const undone = await undoLibraryChange(merged.id)
  expect(undone).toMatchObject({ canUndo: false, canRedo: true })
  expect(await credits()).toEqual(before)
  expect(await artistRows()).toEqual(artistsBefore)
  expect((await browseIds()).ids).toEqual([keptId, spellingId].sort())

  await redoLibraryChange(merged.id)
  expect(await credits()).toEqual(after)
  expect(await artistOf(spellingId)).toMatchObject({ mergedIntoId: keptId })
  expect((await artistOf(keptId))?.scrobbleCount).toBe(5)
  await undoLibraryChange(merged.id)
  expect(await credits()).toEqual(before)
})

it('opens both names’ Sources and adds the current artist through an old address', async () => {
  await fixture.transaction((tx) =>
    observeCatalogOccurrences(tx, [
      {
        target: { kind: 'artist', id: keptId },
        origin: {
          provider: 'spotify',
          operation: 'album-credits',
          occurrenceKey: keptId,
        },
      },
      {
        target: { kind: 'artist', id: spellingId },
        origin: {
          provider: 'lastfm',
          operation: 'scrobbled-credit',
          occurrenceKey: spellingId,
        },
      },
      {
        target: { kind: 'person', id: spellingId },
        origin: {
          provider: 'tmdb',
          operation: 'film-credits',
          occurrenceKey: spellingId,
        },
      },
    ]),
  )
  const change = await mergeArtists({
    artistIds: [spellingId, keptId],
    reviewed: false,
  })
  const sources = (id: string, kind: 'artist' | 'person') =>
    listCatalogObservations(id, { page: 1, size: 10 }, kind)
  expect((await sources(keptId, 'artist')).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetId: keptId, provider: 'spotify' }),
      expect.objectContaining({ targetId: spellingId, provider: 'lastfm' }),
    ]),
  )
  expect(await sources(spellingId, 'artist')).toMatchObject({ totalCount: 2 })
  expect(await sources(keptId, 'person')).toMatchObject({
    totalCount: 1,
    items: [{ targetId: spellingId, provider: 'tmdb' }],
  })
  expect(await promoteNativeResource('artist', spellingId)).toEqual({
    mediaItemId: keptId,
    created: true,
  })
  expect(await promoteNativeResource('artist', keptId)).toEqual({
    mediaItemId: keptId,
    created: false,
  })
  expect(await promoteNativeResource('person', spellingId)).toEqual({
    mediaItemId: keptId,
    created: true,
  })
  expect(await fixture.select().from(schema.catalogNativeAddition)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ targetKind: 'artist', targetId: keptId }),
      expect.objectContaining({ targetKind: 'person', targetId: keptId }),
    ]),
  )

  await undoLibraryChange(change.id)
  expect(await sources(keptId, 'artist')).toMatchObject({
    totalCount: 1,
    items: [{ targetId: keptId }],
  })
  expect(await sources(spellingId, 'artist')).toMatchObject({
    totalCount: 1,
    items: [{ targetId: spellingId }],
  })
  await redoLibraryChange(change.id)
  expect(await sources(spellingId, 'artist')).toMatchObject({ totalCount: 2 })
})

it('credits the artist kept when an import names the merged artist', async () => {
  const merged = await mergeArtists({
    artistIds: [spellingId, keptId],
    reviewed: false,
  })
  await fixture
    .insert(schema.lastfmScrobble)
    .values(scrobbles(SPELLING, 'Irreplaceable', 2))
  await importLastfmLibraryTracks(account)
  await fixture.transaction((tx) =>
    replaceSpotifyTrackCredits(tx, [
      { id: spotifyTrack, artists: [SPELLING, 'Fixture Guest'] },
    ]),
  )
  const now = await credits()
  const imported = now.filter((row) => row.mediaItemId !== spellingAlbum)
  expect(
    imported
      .filter((row) => row.artistId === keptId)
      .map((row) => row.creditedAs),
  ).toEqual([SPELLING, SPELLING, SPELLING, SPELLING])
  expect(now.some((row) => row.artistId === spellingId)).toBe(false)
  const guest = now.find(
    (row) => row.mediaItemId === spotifyTrack && row.artistId !== keptId,
  )
  expect(guest).toMatchObject({ billingOrder: 1, creditedAs: null })

  // Undo returns what was credited under the spelling since, too.
  await undoLibraryChange(merged.id)
  const undone = await credits()
  expect(undone.filter((row) => row.artistId === keptId)).toEqual([])
  expect(
    undone
      .filter((row) => row.artistId === spellingId)
      .map((row) => row.creditedAs),
  ).toEqual([null, null, null, null, null])
})

it('removes a credit both artists share and restores it on Undo', async () => {
  await fixture
    .update(schema.mediaCredit)
    .set({ billingOrder: 1 })
    .where(eq(schema.mediaCredit.mediaItemId, spotifyTrack))
  await fixture.insert(schema.mediaCredit).values({
    mediaItemId: spotifyTrack,
    artistId: spellingId,
    role: 'artist',
    billingOrder: 0,
  })
  const before = await credits()
  const plan = await planArtistMerge({ artistIds: [keptId, spellingId] })
  expect(plan.cautions).toEqual([{ code: 'together', items: 1 }])
  expect(plan.moves.shared).toBe(1)
  await expect(
    mergeArtists({ artistIds: [keptId, spellingId], reviewed: false }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  const merged = await mergeArtists({
    artistIds: [keptId, spellingId],
    reviewed: true,
  })
  expect(
    (await credits()).filter((row) => row.mediaItemId === spotifyTrack),
  ).toEqual([
    {
      mediaItemId: spotifyTrack,
      artistId: keptId,
      role: 'artist',
      billingOrder: 0,
      creditedAs: null,
    },
  ])
  await undoLibraryChange(merged.id)
  expect(await credits()).toEqual(before)
})

it('opens the review for profiles, names and a decision to keep separate', async () => {
  await addProfile(spellingId, 'spotify', 'spotify-spelling')
  // Last.fm profiles are keyed by name, so they never differ by identity.
  await addProfile(spellingId, 'lastfm', SPELLING)
  await addProfile(keptId, 'lastfm', KEPT)
  expect(
    (await planArtistMerge({ artistIds: [spellingId, keptId] })).cautions,
  ).toEqual([{ code: 'profiles', providers: ['spotify'] }])
  await expect(
    mergeArtists({ artistIds: [spellingId, keptId], reviewed: false }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  await addArtist(otherId, 'Fixture Other Band', ['track-other'])
  const names = await planArtistMerge({
    artistIds: [otherId, keptId],
    targetId: keptId,
  })
  expect(names.cautions).toEqual([
    { code: 'names', names: [KEPT, 'Fixture Other Band'] },
  ])
  await expect(
    mergeArtists({
      artistIds: [otherId, keptId],
      targetId: keptId,
      reviewed: false,
    }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })

  await addArtist('artist-national', 'Fixture National, The', ['track-n1'])
  await addArtist('artist-the-national', 'The Fixture National', ['track-n2'])
  const alike = await planArtistMerge({
    artistIds: ['artist-national', 'artist-the-national'],
  })
  expect(alike.cautions).toEqual([])
  await fixture.insert(schema.libraryKeepSeparate).values({
    kind: 'artist',
    lowId: 'artist-national',
    highId: 'artist-the-national',
  })
  const separate = await planArtistMerge({
    artistIds: ['artist-national', 'artist-the-national'],
  })
  expect(separate.cautions).toEqual([
    {
      code: 'separate',
      names: ['Fixture National, The', 'The Fixture National'],
    },
  ])
  await expect(
    mergeArtists({
      artistIds: ['artist-national', 'artist-the-national'],
      targetId: 'artist-the-national',
      reviewed: false,
    }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  const merged = await mergeArtists({
    artistIds: ['artist-national', 'artist-the-national'],
    targetId: 'artist-the-national',
    reviewed: true,
  })
  expect(await fixture.select().from(schema.libraryKeepSeparate)).toEqual([])
  await undoLibraryChange(merged.id)
  expect(
    (await fixture.select().from(schema.libraryKeepSeparate)).map(
      ({ lowId, highId }) => ({ lowId, highId }),
    ),
  ).toEqual([{ lowId: 'artist-national', highId: 'artist-the-national' }])
})

it('keeps no chains and undoes merges newest first', async () => {
  const before = await credits()
  const artistsBefore = await artistRows()
  const first = await mergeArtists({
    artistIds: [spellingId, keptId],
    reviewed: false,
  })
  const outerId = 'artist-outer'
  await addArtist(outerId, 'Fixture Beyoncé Knowles', ['track-outer'])
  const withMerged = await planArtistMerge({
    artistIds: [spellingId, outerId],
    targetId: outerId,
  })
  // The merged name counts as the artist it was merged into.
  expect(withMerged.artists.map(({ id }) => id)).toEqual([outerId, keptId])
  expect(withMerged.moves.names).toEqual([KEPT, SPELLING])
  const second = await mergeArtists({
    artistIds: [keptId, outerId],
    targetId: outerId,
    reviewed: true,
  })
  expect(await artistOf(spellingId)).toMatchObject({ mergedIntoId: outerId })
  expect(await artistOf(keptId)).toMatchObject({ mergedIntoId: outerId })
  const chained = await credits()
  expect(
    chained.filter(
      (row) => row.artistId !== outerId && row.mediaItemId !== 'track-outer',
    ),
  ).toEqual([])
  expect(
    chained
      .filter((row) => row.mediaItemId === spotifyTrack)
      .map((row) => row.creditedAs),
  ).toEqual([KEPT])

  const [blocked] = (await artistChanges(spellingId)).items.filter(
    ({ id }) => id === first.id,
  )
  expect(blocked).toMatchObject({
    canUndo: false,
    blocked:
      'The artist kept was merged into another artist since. Undo that change first.',
  })
  await expect(undoLibraryChange(first.id)).rejects.toMatchObject({
    response: {
      statusCode: 409,
      message:
        'The artist kept was merged into another artist since. Undo that change first.',
    },
  })
  await undoLibraryChange(second.id)
  expect(await artistOf(spellingId)).toMatchObject({ mergedIntoId: keptId })
  expect(await artistOf(keptId)).toMatchObject({ mergedIntoId: null })
  await undoLibraryChange(first.id)
  expect(
    (await credits()).filter((row) => row.mediaItemId !== 'track-outer'),
  ).toEqual(before)
  expect((await artistRows()).filter((row) => row.id !== outerId)).toEqual(
    artistsBefore,
  )
  // Made again oldest first, the second merge resolves no chain either.
  await redoLibraryChange(first.id)
  await redoLibraryChange(second.id)
  expect(await artistOf(spellingId)).toMatchObject({ mergedIntoId: outerId })
})

it('refuses to merge an artist with film credits', async () => {
  await fixture.insert(schema.mediaItem).values({
    id: 'film-fixture',
    slug: 'film-fixture',
    title: 'Fixture Film',
    mediaType: 'film',
  })
  await fixture.insert(schema.mediaCredit).values({
    mediaItemId: 'film-fixture',
    artistId: spellingId,
    role: 'director',
  })
  const plan = await planArtistMerge({ artistIds: [spellingId, keptId] })
  expect(plan.blocked).toBe(true)
  expect(plan.artists.find(({ id }) => id === spellingId)?.blocked).toBe('film')
  await expect(
    mergeArtists({ artistIds: [spellingId, keptId], reviewed: true }),
  ).rejects.toMatchObject({ response: { statusCode: 409 } })
  expect(await artistOf(spellingId)).toMatchObject({ mergedIntoId: null })
})
