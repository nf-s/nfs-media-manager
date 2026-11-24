import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = `shadow_track_repair_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const client = new pg.Client({ ...connection, database: name })
const fixture = drizzle(client, { schema })
let created = false
let connected = false

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

import { repairShadowTrackDetails } from '@/services/shadow-track-repair'

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await client.connect()
  connected = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
})

afterAll(async () => {
  if (connected) await client.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const spotifyId = (label: string) => label.padEnd(22, '0')
const shownArtwork = 'https://images.example.test/shown'
const retainedArtwork = 'https://images.example.test/retained'
const originalArtwork = 'https://images.example.test/original'

it('uses exact album identities and verified track membership without overwriting stored details', async () => {
  await fixture.insert(schema.mediaItem).values([
    {
      id: 'shown',
      title: 'Shown',
      slug: 'shown',
      mediaType: 'album',
      artworkUrl: shownArtwork,
    },
    { id: 'retained', title: 'Retained', slug: 'retained', mediaType: 'album' },
    {
      id: 'duplicate',
      title: 'Duplicate',
      slug: 'duplicate',
      mediaType: 'album',
    },
    { id: 'other', title: 'Other', slug: 'other', mediaType: 'album' },
    ...[
      'direct',
      'snapshot',
      'response',
      'cover-only',
      'unverified',
      'ambiguous',
      'existing',
      'blocked',
      'hidden',
      'library',
    ].map((id) => ({
      id,
      title: id,
      slug: id,
      mediaType: 'track',
      inLibrary: id === 'library',
      artworkUrl: id === 'existing' ? originalArtwork : null,
      metadata: id === 'hidden' ? { legacyHidden: true } : {},
    })),
  ])
  await fixture.insert(schema.album).values(
    ['shown', 'retained', 'duplicate', 'other'].map((mediaItemId) => ({
      mediaItemId,
    })),
  )
  await fixture.insert(schema.providerReference).values(
    [
      { mediaItemId: 'shown', externalId: spotifyId('shown') },
      { mediaItemId: 'retained', externalId: spotifyId('retained') },
      { mediaItemId: 'shown', externalId: spotifyId('ambiguous') },
      { mediaItemId: 'duplicate', externalId: spotifyId('ambiguous') },
      {
        mediaItemId: 'other',
        externalId: spotifyId('blocked'),
        metadata: { rejected: true },
      },
    ].map((entry, index) => ({
      ...entry,
      id: `reference-${index}`,
      provider: 'spotify',
      referenceType: 'spotify',
    })),
  )
  await fixture.insert(schema.libraryTrack).values([
    { mediaItemId: 'direct', spotifyAlbumId: spotifyId('shown') },
    { mediaItemId: 'snapshot', spotifyTrackId: spotifyId('snapshot') },
    { mediaItemId: 'response', spotifyTrackId: spotifyId('response') },
    {
      mediaItemId: 'cover-only',
      spotifyAlbumId: spotifyId('retained'),
      albumMediaItemId: 'retained',
    },
    { mediaItemId: 'unverified', spotifyTrackId: spotifyId('unverified') },
    { mediaItemId: 'ambiguous', spotifyAlbumId: spotifyId('ambiguous') },
    {
      mediaItemId: 'existing',
      spotifyAlbumId: spotifyId('shown'),
      albumMediaItemId: 'other',
    },
    { mediaItemId: 'blocked', spotifyAlbumId: spotifyId('blocked') },
    { mediaItemId: 'hidden', spotifyAlbumId: spotifyId('shown') },
    { mediaItemId: 'library', spotifyAlbumId: spotifyId('shown') },
  ])
  await fixture.insert(schema.providerSnapshot).values({
    id: 'spotify-album-snapshot',
    mediaItemId: 'retained',
    provider: 'spotify',
    source: 'legacy-import',
    checksum: 'fixture',
    normalizedData: {},
    payload: {
      id: spotifyId('retained'),
      name: 'Retained',
      artists: [{ name: 'Fixture Artist' }],
      images: [{ url: retainedArtwork }],
      tracks: {
        items: [
          {
            id: spotifyId('snapshot'),
            name: 'Snapshot',
            artists: [{ name: 'Fixture Artist' }],
            disc_number: 1,
            track_number: 1,
            duration_ms: 120000,
          },
        ],
        total: 1,
        offset: 0,
        next: null,
      },
    },
  })
  await fixture.insert(schema.catalogObservation).values(
    ['snapshot', 'unverified'].map((targetId) => ({
      id: `observation-${targetId}`,
      targetId,
      targetKind: 'track',
      provider: 'spotify',
      operation: 'album-tracks',
      subjectKind: 'album',
      subjectId: 'retained',
      relationshipRole: 'track-on-album',
      snapshotId: 'spotify-album-snapshot',
    })),
  )
  await fixture.insert(schema.scrapeJob).values({
    id: 'spotify-album-job',
    provider: 'spotify',
    scope: {},
    options: {},
  })
  const body = JSON.stringify({
    id: spotifyId('shown'),
    artists: [{ name: 'Fixture Artist' }],
    name: 'Shown',
    tracks: {
      items: [
        {
          id: spotifyId('response'),
          name: 'Response',
          artists: [{ name: 'Fixture Artist' }],
          disc_number: 1,
          track_number: 1,
          duration_ms: 120000,
        },
      ],
      total: 1,
      offset: 0,
      next: null,
    },
  })
  await fixture.insert(schema.providerResponse).values({
    id: 'spotify-album-response',
    jobId: 'spotify-album-job',
    provider: 'spotify',
    attempt: 1,
    ordinal: 1,
    phase: 'media',
    method: 'GET',
    requestUrl: `https://api.spotify.com/v1/albums/${spotifyId('shown')}`,
    status: 200,
    bodyState: 'captured',
    retainedBytes: Buffer.byteLength(body),
    body: { state: 'captured', text: body },
  })
  await fixture.insert(schema.catalogObservation).values({
    id: 'observation-response',
    targetKind: 'track',
    targetId: 'response',
    provider: 'spotify',
    operation: 'provider-result',
    subjectKind: 'album',
    subjectId: 'shown',
    relationshipRole: 'track_on_edition',
    responseId: 'spotify-album-response',
  })

  const stored = () =>
    client.query(`
    select t.media_item_id as id, t.album_media_item_id as album, t.spotify_album_id as native_id,
      t.album_link_strategy as strategy, m.artwork_url as artwork
    from library_track t join media_item m on m.id=t.media_item_id
    order by t.media_item_id`)

  const before = (await stored()).rows
  const counts = {
    albumLinks: 3,
    artwork: 2,
    inheritedArtwork: 2,
    albumsCreated: 0,
  }
  expect(await repairShadowTrackDetails(false, fixture)).toEqual(counts)
  expect((await stored()).rows).toEqual(before)
  expect(await repairShadowTrackDetails(true, fixture)).toEqual(counts)
  expect((await stored()).rows).toEqual(
    before.map((row) =>
      row.id === 'direct'
        ? { ...row, album: 'shown', strategy: 'spotify-album' }
        : row.id === 'snapshot'
          ? {
              ...row,
              album: 'retained',
              native_id: spotifyId('retained'),
              strategy: 'spotify-album',
              artwork: retainedArtwork,
            }
          : row.id === 'response'
            ? {
                ...row,
                album: 'shown',
                native_id: spotifyId('shown'),
                strategy: 'spotify-album',
              }
            : row.id === 'cover-only'
              ? { ...row, artwork: retainedArtwork }
              : row,
    ),
  )
  expect(await repairShadowTrackDetails(true, fixture)).toEqual({
    albumLinks: 0,
    artwork: 0,
    inheritedArtwork: 0,
    albumsCreated: 0,
  })
})

it('materializes one outside album for an unambiguous stored release', async () => {
  const nativeId = spotifyId('missinglocal')
  const conflictId = spotifyId('conflictingtitle')
  const trackIds = [
    'first-seed',
    'second-seed',
    'first-conflict',
    'second-conflict',
  ]
  await fixture.insert(schema.mediaItem).values(
    trackIds.map((id) => ({
      id,
      mediaType: 'track',
      inLibrary: false,
      slug: id,
      title: id,
      artworkUrl: originalArtwork,
    })),
  )
  await fixture.insert(schema.libraryTrack).values([
    {
      mediaItemId: 'first-seed',
      spotifyAlbumId: nativeId,
      albumName: 'Unavailable Locally',
    },
    {
      mediaItemId: 'second-seed',
      spotifyAlbumId: nativeId,
      albumName: 'Unavailable Locally',
    },
    {
      mediaItemId: 'first-conflict',
      spotifyAlbumId: conflictId,
      albumName: 'Original',
    },
    {
      mediaItemId: 'second-conflict',
      spotifyAlbumId: conflictId,
      albumName: 'Different title',
    },
  ])
  const albumRows = () =>
    fixture
      .select({
        id: schema.mediaItem.id,
        inLibrary: schema.mediaItem.inLibrary,
        title: schema.mediaItem.title,
        artworkUrl: schema.mediaItem.artworkUrl,
        spotifyUrl: schema.album.spotifyUrl,
      })
      .from(schema.providerReference)
      .innerJoin(
        schema.mediaItem,
        eq(schema.mediaItem.id, schema.providerReference.mediaItemId),
      )
      .innerJoin(
        schema.album,
        eq(schema.album.mediaItemId, schema.mediaItem.id),
      )
      .where(
        inArray(schema.providerReference.externalId, [nativeId, conflictId]),
      )
  const observations = () =>
    fixture
      .select({
        subjectId: schema.catalogObservation.subjectId,
        targetId: schema.catalogObservation.targetId,
      })
      .from(schema.catalogObservation)
      .where(eq(schema.catalogObservation.operation, 'stored-track-album'))
      .orderBy(schema.catalogObservation.subjectId)
  const tracks = () =>
    fixture
      .select({
        id: schema.libraryTrack.mediaItemId,
        albumId: schema.libraryTrack.albumMediaItemId,
      })
      .from(schema.libraryTrack)
      .where(inArray(schema.libraryTrack.mediaItemId, trackIds))
      .orderBy(schema.libraryTrack.mediaItemId)

  const counts = {
    albumLinks: 2,
    artwork: 0,
    inheritedArtwork: 0,
    albumsCreated: 1,
  }
  expect(await repairShadowTrackDetails(false, fixture)).toEqual(counts)
  expect(await albumRows()).toEqual([])
  expect(await observations()).toEqual([])
  expect((await tracks()).every(({ albumId }) => albumId === null)).toBe(true)

  expect(await repairShadowTrackDetails(true, fixture)).toEqual(counts)
  const albums = await albumRows()
  expect(albums).toHaveLength(1)
  const [stored] = albums
  if (!stored) throw new Error('Expected the recovered album')
  expect(stored).toMatchObject({
    inLibrary: false,
    title: 'Unavailable Locally',
    artworkUrl: originalArtwork,
    spotifyUrl: `https://open.spotify.com/album/${nativeId}`,
  })
  expect(await tracks()).toEqual([
    { id: 'first-conflict', albumId: null },
    { id: 'first-seed', albumId: stored.id },
    { id: 'second-conflict', albumId: null },
    { id: 'second-seed', albumId: stored.id },
  ])
  expect(await observations()).toEqual([
    { subjectId: 'first-seed', targetId: stored.id },
    { subjectId: 'second-seed', targetId: stored.id },
  ])
  expect(await repairShadowTrackDetails(true, fixture)).toEqual({
    albumLinks: 0,
    artwork: 0,
    inheritedArtwork: 0,
    albumsCreated: 0,
  })
})

it('recovers the exact selected Spotify lookup album and cover and skips conflicting lookup rows', async () => {
  const albumId = 'lookup-album'
  const albumNativeId = spotifyId('lookuprelease')
  const newNativeId = spotifyId('lookupnewrelease')
  const trackIds = [
    'lookup-exact',
    'lookup-new',
    'lookup-conflict',
    'lookup-mismatch',
    'lookup-other-source',
    'lookup-stored-conflict',
  ]
  await fixture.insert(schema.mediaItem).values([
    {
      id: albumId,
      slug: albumId,
      title: 'Lookup Release',
      mediaType: 'album',
    },
    ...trackIds.map((id) => ({
      id,
      slug: id,
      title: id,
      mediaType: 'track',
      inLibrary: false,
    })),
  ])
  await fixture.insert(schema.album).values({ mediaItemId: albumId })
  await fixture.insert(schema.providerReference).values({
    id: 'lookup-album-reference',
    mediaItemId: albumId,
    provider: 'spotify',
    referenceType: 'spotify',
    externalId: albumNativeId,
  })
  await fixture.insert(schema.libraryTrack).values(
    trackIds.map((id) => ({
      mediaItemId: id,
      spotifyTrackId: spotifyId(id.replaceAll('-', '')),
      spotifyAlbumId:
        id === 'lookup-stored-conflict' ? spotifyId('blocked') : null,
    })),
  )
  const entries: {
    id: string
    release?: string
    resultId?: string
    source?: 'sonovault'
  }[] = [
    { id: 'lookupexact' },
    { id: 'lookupnew', release: newNativeId },
    { id: 'lookupconflict' },
    { id: 'lookupconflict', release: newNativeId },
    { id: 'lookupmismatch', resultId: spotifyId('unrelatedrecording') },
    { id: 'lookupothersource', source: 'sonovault' },
    { id: 'lookupstoredconflict' },
  ]
  await fixture.insert(schema.spotifyCodeLookup).values(
    entries.map(
      (
        { id, release = albumNativeId, resultId = spotifyId(id), source },
        index,
      ) => ({
        codeType: 'isrc',
        code: `USXYZ240000${index}`,
        source,
        spotifyId: spotifyId(id),
        searchedAt: new Date('2024-01-01'),
        result: {
          spotifyId: resultId,
          url: `https://open.spotify.com/track/${resultId}`,
          title: 'Fixture Recording',
          artists: ['Fixture Artist'],
          albumName:
            release === albumNativeId ? 'Lookup Release' : 'New Lookup Release',
          spotifyAlbumId: release,
          artworkUrl: retainedArtwork,
          durationSec: 120,
          trackCount: null,
        },
      }),
    ),
  )
  const tracks = () =>
    fixture
      .select({
        id: schema.libraryTrack.mediaItemId,
        albumId: schema.libraryTrack.albumMediaItemId,
        albumNativeId: schema.libraryTrack.spotifyAlbumId,
        artworkUrl: schema.mediaItem.artworkUrl,
      })
      .from(schema.libraryTrack)
      .innerJoin(
        schema.mediaItem,
        eq(schema.mediaItem.id, schema.libraryTrack.mediaItemId),
      )
      .where(inArray(schema.libraryTrack.mediaItemId, trackIds))
      .orderBy(schema.libraryTrack.mediaItemId)
  const before = await tracks()
  const counts = {
    albumLinks: 2,
    artwork: 1,
    inheritedArtwork: 1,
    albumsCreated: 1,
  }
  expect(await repairShadowTrackDetails(false, fixture)).toEqual(counts)
  expect(await tracks()).toEqual(before)
  expect(await repairShadowTrackDetails(true, fixture)).toEqual(counts)
  const after = await tracks()
  expect(after.find(({ id }) => id === 'lookup-exact')).toEqual({
    id: 'lookup-exact',
    albumId,
    albumNativeId,
    artworkUrl: retainedArtwork,
  })
  expect(after.find(({ id }) => id === 'lookup-new')).toMatchObject({
    albumId: expect.any(String),
    albumNativeId: newNativeId,
  })
  expect(
    after.filter(({ id }) => !['lookup-exact', 'lookup-new'].includes(id)),
  ).toEqual(
    before.filter(({ id }) => !['lookup-exact', 'lookup-new'].includes(id)),
  )
  expect(
    await fixture
      .select({ id: schema.catalogObservation.targetId })
      .from(schema.catalogObservation)
      .where(
        eq(schema.catalogObservation.operation, 'stored-spotify-code-lookup'),
      )
      .orderBy(schema.catalogObservation.targetId),
  ).toEqual([{ id: 'lookup-exact' }, { id: 'lookup-new' }])
  expect(await repairShadowTrackDetails(true, fixture)).toEqual({
    albumLinks: 0,
    artwork: 0,
    inheritedArtwork: 0,
    albumsCreated: 0,
  })
})
