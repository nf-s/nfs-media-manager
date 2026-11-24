import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { SpotifyCodeMatch, TidalSuggestion } from '@repo/schemas/tidal'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `tidal_similar_library_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const db = drizzle(pool, { schema })
const request = vi
  .fn<typeof fetch>()
  .mockRejectedValue(new Error('Library additions use stored data'))
vi.mock('@/lib/db', () => ({
  get db() {
    return db
  },
}))

import { refreshTrackAddedDates } from '@/services/spotify-playlists'
import { setCatalogMediaAlias } from '@/services/catalog-discoveries'
import { observeTidalSuggestion } from '@/services/music-catalog-observations'
import { getTidalSimilar } from '@/services/tidal-similar'
import { addTidalSimilarToLibrary } from '@/services/tidal-similar-library'
import { getTidalTrackMatch } from '@/services/tidal-track-match'

type AddInput = Parameters<typeof addTidalSimilarToLibrary>[0]

const albumId = 'fixture-source-album'
const trackId = 'fixture-source-track'
const upc = '0000000000048'
const isrc = 'QZFX22800012'
const sonovaultIsrc = 'QZFX22800013'
const spotifyAlbumId = '00000000000000000000AL'
const spotifyTrackId = '00000000000000000000TK'
const sonovaultSpotifyId = '000000000000SONOVAULT1'
const addedBefore = new Date()

function albumSuggestion(
  tidalId: string,
  code: string | null,
): TidalSuggestion {
  return {
    tidalId,
    title: 'Lattice Forms',
    version: null,
    artists: ['Fixture Ensemble'],
    code,
    durationSec: 2400,
    releaseDate: '2025-06-01',
    url: `https://tidal.com/browse/album/${tidalId}`,
  }
}

function trackSuggestion(
  tidalId: string,
  code: string | null,
): TidalSuggestion {
  return {
    tidalId,
    title: 'Curtain Fold',
    version: 'Extended Mix',
    artists: ['Fixture Ensemble'],
    code,
    durationSec: 300,
    releaseDate: null,
    url: `https://tidal.com/browse/track/${tidalId}`,
  }
}

function spotifyMatch(kind: 'album' | 'track'): SpotifyCodeMatch {
  const spotifyId = kind === 'album' ? spotifyAlbumId : spotifyTrackId
  return {
    spotifyId,
    url: `https://open.spotify.com/${kind}/${spotifyId}`,
    title: 'Measured Forms',
    artists: ['Fixture Orchestra'],
    albumName: kind === 'track' ? 'Measured Forms' : null,
    spotifyAlbumId: kind === 'track' ? spotifyAlbumId : null,
    artworkUrl: 'https://example.test/cover.jpg',
    durationSec: null,
    trackCount: kind === 'album' ? 7 : null,
  }
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(db, { migrationsFolder: './drizzle' })
  await db.insert(schema.mediaItem).values([
    { id: albumId, mediaType: 'album', slug: albumId, title: 'Album source' },
    { id: trackId, mediaType: 'track', slug: trackId, title: 'Track source' },
  ])
  await db.insert(schema.album).values({ mediaItemId: albumId })
  await db.insert(schema.libraryTrack).values({ mediaItemId: trackId })
  await db.insert(schema.tidalSimilar).values([
    {
      mediaItemId: albumId,
      kind: 'album',
      readAt: addedBefore,
      items: [
        albumSuggestion('101', upc),
        albumSuggestion('102', null),
        albumSuggestion('103', null),
      ],
    },
    {
      mediaItemId: trackId,
      kind: 'track',
      readAt: addedBefore,
      items: [
        trackSuggestion('201', isrc),
        trackSuggestion('202', null),
        {
          ...trackSuggestion('203', sonovaultIsrc),
          title: 'Curtain Fold (Extended Mix)',
        },
      ],
    },
  ])
  await db.insert(schema.spotifyCodeLookup).values([
    {
      codeType: 'upc',
      code: '48',
      spotifyId: spotifyAlbumId,
      result: spotifyMatch('album'),
      searchedAt: addedBefore,
    },
    {
      codeType: 'isrc',
      code: isrc,
      spotifyId: spotifyTrackId,
      result: spotifyMatch('track'),
      searchedAt: addedBefore,
    },
    {
      codeType: 'isrc',
      code: sonovaultIsrc,
      source: 'sonovault',
      spotifyId: sonovaultSpotifyId,
      result: {
        ...spotifyMatch('track'),
        spotifyId: sonovaultSpotifyId,
        url: `https://open.spotify.com/track/${sonovaultSpotifyId}`,
      },
      searchedAt: addedBefore,
    },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

function references(id: string) {
  return db
    .select()
    .from(schema.providerReference)
    .where(eq(schema.providerReference.mediaItemId, id))
}

it('adds an album with a stored Spotify mapping once and preserves both catalogue IDs', async () => {
  const input = {
    kind: 'albums',
    id: albumId,
    tidalId: '101',
  } satisfies AddInput
  const [first, retry] = await Promise.all([
    addTidalSimilarToLibrary(input),
    addTidalSimilarToLibrary(input),
  ])
  expect(retry.id).toEqual(first.id)
  const [album] = await db
    .select()
    .from(schema.album)
    .where(eq(schema.album.mediaItemId, first.id))
  expect(album).toMatchObject({
    trackCount: 7,
    durationSec: 2400,
    spotifyUrl: spotifyMatch('album').url,
  })
  expect(await references(first.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: 'tidal',
        referenceType: 'album',
        externalId: '101',
      }),
      expect.objectContaining({
        provider: 'tidal',
        referenceType: 'upc',
        externalId: upc,
      }),
      expect.objectContaining({
        provider: 'spotify',
        referenceType: 'album',
        externalId: spotifyAlbumId,
      }),
    ]),
  )
  expect((await getTidalSimilar(input)).items[0]).toMatchObject({
    state: 'library',
    library: { id: first.id, spotifyId: spotifyAlbumId },
  })
  expect(request).not.toHaveBeenCalled()
})

it('recognizes an album whose Spotify release is stored only as a URL', async () => {
  const id = 'fixture-url-only-album'
  const urlOnlySpotifyId = 'ZZZZZZZZZZZZZZZZZZZZZZ'
  const url = `https://open.spotify.com/album/${urlOnlySpotifyId}`
  const sourceId = 'fixture-url-only-source'
  await db.insert(schema.mediaItem).values([
    { id, mediaType: 'album', slug: id, title: 'Saved release' },
    { id: sourceId, mediaType: 'album', slug: sourceId, title: 'Album source' },
  ])
  await db
    .insert(schema.album)
    .values([{ mediaItemId: id, spotifyUrl: url }, { mediaItemId: sourceId }])
  await db.insert(schema.spotifyCodeLookup).values({
    codeType: 'upc',
    code: '82',
    spotifyId: urlOnlySpotifyId,
    result: { ...spotifyMatch('album'), spotifyId: urlOnlySpotifyId, url },
    searchedAt: addedBefore,
  })
  await db.insert(schema.tidalSimilar).values({
    mediaItemId: sourceId,
    kind: 'album',
    readAt: addedBefore,
    items: [albumSuggestion('106', '0000000000082')],
  })
  const input = {
    kind: 'albums',
    id: sourceId,
    tidalId: '106',
  } satisfies AddInput
  expect((await getTidalSimilar(input)).items[0]).toMatchObject({
    state: 'library',
    library: { id, spotifyId: urlOnlySpotifyId },
    libraryMatch: { basis: 'spotify-id', value: urlOnlySpotifyId },
  })
  expect(await addTidalSimilarToLibrary(input)).toEqual({ id })
})

it('promotes an outside suggestion in place and preserves its discovery origin', async () => {
  const input = {
    kind: 'albums',
    id: albumId,
    tidalId: '107',
  } satisfies AddInput
  const suggestion = albumSuggestion(input.tidalId, null)
  const id = await db.transaction(async (tx) => {
    const catalogMediaItemId = await observeTidalSuggestion(
      tx,
      'album',
      suggestion,
      {
        operation: 'similar',
        key: 'fixture-outside-origin',
        subjectKind: 'album',
        subjectId: albumId,
        page: 1,
        position: 1,
      },
    )
    const source = await tx.query.tidalSimilar.findFirst({
      where: eq(schema.tidalSimilar.mediaItemId, albumId),
    })
    await tx
      .update(schema.tidalSimilar)
      .set({
        items: [
          ...(source?.items ?? []),
          { ...suggestion, catalogMediaItemId },
        ],
      })
      .where(eq(schema.tidalSimilar.mediaItemId, albumId))
    return catalogMediaItemId
  })
  const read = async () =>
    (await getTidalSimilar(input)).items.find(
      (item) => item.tidalId === input.tidalId,
    )
  expect(await read()).toMatchObject({ catalogMediaItemId: id, library: null })
  expect((await read())?.hiddenLibraryMatch).toBeUndefined()
  expect(await addTidalSimilarToLibrary(input)).toEqual({ id })
  expect(await read()).toMatchObject({ state: 'library', library: { id } })
  expect(
    await db
      .select()
      .from(schema.catalogObservation)
      .where(eq(schema.catalogObservation.mediaItemId, id)),
  ).toContainEqual(
    expect.objectContaining({ operation: 'similar', subjectId: albumId }),
  )
})

it('adds a TIDAL-only album without a barcode and recognizes it by TIDAL ID', async () => {
  const input = {
    kind: 'albums',
    id: albumId,
    tidalId: '102',
  } satisfies AddInput
  const added = await addTidalSimilarToLibrary(input)
  expect(await addTidalSimilarToLibrary(input)).toEqual(added)
  const [item] = await db
    .select()
    .from(schema.mediaItem)
    .where(eq(schema.mediaItem.id, added.id))
  expect(item).toMatchObject({
    title: 'Lattice Forms',
    releaseDate: new Date('2025-06-01'),
  })
  const [snapshot] = await db
    .select()
    .from(schema.providerSnapshot)
    .where(eq(schema.providerSnapshot.mediaItemId, added.id))
  expect(snapshot?.payload).not.toHaveProperty('suggestion.genres')
  expect((await getTidalSimilar(input)).items[1]).toMatchObject({
    state: 'library',
    library: { id: added.id, spotifyId: null },
  })
})

it('adds a Spotify-mapped track with the TIDAL ISRC and a fallback duration', async () => {
  const input = {
    kind: 'tracks',
    id: trackId,
    tidalId: '201',
  } satisfies AddInput
  const added = await addTidalSimilarToLibrary(input)
  expect(await addTidalSimilarToLibrary(input)).toEqual(added)
  const [track] = await db
    .select()
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, added.id))
  expect(track).toMatchObject({
    spotifyTrackId,
    spotifyAlbumId,
    isrc,
    durationSec: 300,
  })
  expect(await references(added.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        provider: 'tidal',
        referenceType: 'track',
        externalId: '201',
      }),
      expect.objectContaining({
        provider: 'tidal',
        referenceType: 'isrc',
        externalId: isrc,
      }),
    ]),
  )
  expect((await getTidalSimilar(input)).items[0]).toMatchObject({
    state: 'library',
    library: { id: added.id, spotifyId: spotifyTrackId },
  })
})

it('adds a TIDAL-only track without an ISRC and keeps its version and added date', async () => {
  const input = {
    kind: 'tracks',
    id: trackId,
    tidalId: '202',
  } satisfies AddInput
  const added = await addTidalSimilarToLibrary(input)
  expect(await addTidalSimilarToLibrary(input)).toEqual(added)
  await db.transaction((tx) => refreshTrackAddedDates(tx, [added.id]))
  const [track] = await db
    .select()
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, added.id))
  expect(track).toMatchObject({
    spotifyTrackId: null,
    isrc: null,
    dateAdded: expect.any(Date),
  })
  expect((await getTidalTrackMatch(added.id)).match).toMatchObject({
    tidalTrackId: '202',
    source: 'tidal-similar',
    version: 'Extended Mix',
  })
  expect((await getTidalSimilar(input)).items[1]).toMatchObject({
    state: 'library',
    library: { id: added.id, spotifyId: null },
  })
})

it('rejects suggestions outside the source album or track’s stored read', async () => {
  await expect(
    addTidalSimilarToLibrary({ kind: 'albums', id: albumId, tidalId: '201' }),
  ).rejects.toMatchObject({
    statusCode: 404,
    message: 'Similar item not found.',
  })
  await expect(
    addTidalSimilarToLibrary({ kind: 'tracks', id: albumId, tidalId: '201' }),
  ).rejects.toMatchObject({
    statusCode: 404,
    message: 'Library track not found.',
  })
})

it('keeps a Sonovault Spotify claim separate from the library identity', async () => {
  const input = {
    kind: 'tracks',
    id: trackId,
    tidalId: '203',
  } satisfies AddInput
  expect((await getTidalSimilar(input)).items[2]).toMatchObject({
    state: 'spotify',
  })
  const added = await addTidalSimilarToLibrary(input)
  const [track] = await db
    .select()
    .from(schema.libraryTrack)
    .where(eq(schema.libraryTrack.mediaItemId, added.id))
  expect(track).toMatchObject({
    spotifyTrackId: null,
    isrc: sonovaultIsrc,
  })
  expect((await getTidalSimilar(input)).items[2]).toMatchObject({
    state: 'library',
    library: {
      id: added.id,
      title: 'Curtain Fold (Extended Mix)',
      spotifyId: null,
    },
  })
  expect(request).not.toHaveBeenCalled()
})

it('leaves a hidden suggestion hidden', async () => {
  const input = {
    kind: 'albums',
    id: albumId,
    tidalId: '103',
  } satisfies AddInput
  const { id } = await addTidalSimilarToLibrary(input)
  await db
    .update(schema.mediaItem)
    .set({ metadata: { legacyHidden: true } })
    .where(eq(schema.mediaItem.id, id))
  expect(
    (await getTidalSimilar(input)).items.find(
      (item) => item.tidalId === input.tidalId,
    ),
  ).toMatchObject({
    library: null,
    hiddenLibraryMatch: true,
  })
  await expect(addTidalSimilarToLibrary(input)).rejects.toMatchObject({
    statusCode: 409,
  })
})

it('presents a discovered track with its recorded credits and release after alias resolution', async () => {
  const input = {
    kind: 'tracks',
    id: trackId,
    tidalId: '299',
  } satisfies AddInput
  const alias = 'fixture-discovery-alias'
  const artistCredits = [
    { id: '901', name: 'Fixture Ensemble' },
    { id: '902', name: 'Fixture Orchestra' },
  ]
  const suggestion = {
    ...trackSuggestion(input.tidalId, null),
    artistCredits,
    linkedAlbums: [
      { id: '991', title: 'Harbour Current', releaseDate: null, artistCredits },
    ],
  }
  const track = await db.transaction(async (tx) => {
    const track = await observeTidalSuggestion(tx, 'track', suggestion, {
      operation: 'similar',
      key: 'fixture-discovery-with-release',
      subjectKind: 'track',
      subjectId: trackId,
      position: 1,
    })
    await setCatalogMediaAlias(tx, alias, track)
    return track
  })
  await db
    .update(schema.tidalSimilar)
    .set({ items: [{ ...suggestion, catalogMediaItemId: alias }] })
    .where(eq(schema.tidalSimilar.mediaItemId, trackId))

  const before = (await getTidalSimilar(input)).items[0]?.track
  expect(before).toMatchObject({
    id: track,
    inLibrary: false,
    title: 'Curtain Fold (Extended Mix)',
    artistCredits: [
      { id: expect.any(String), name: 'Fixture Ensemble' },
      { id: expect.any(String), name: 'Fixture Orchestra' },
    ],
    album: { id: expect.any(String), title: 'Harbour Current' },
  })
  expect(before?.artistCredits[0]?.id).not.toBe(before?.artistCredits[1]?.id)
  expect(await addTidalSimilarToLibrary(input)).toEqual({ id: track })
  expect(await addTidalSimilarToLibrary(input)).toEqual({ id: track })
  expect((await getTidalSimilar(input)).items[0]?.track).toEqual({
    ...before,
    inLibrary: true,
  })
})
