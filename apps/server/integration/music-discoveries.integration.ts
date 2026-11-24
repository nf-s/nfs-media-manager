import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import { createProviderResponseRecorder } from '@/lib/provider-response-history'
import { SpotifySavedPageSchema } from '@/lib/spotify-api'
import { spotifyAlbumFixture } from '@/plugins/builtin/__tests__/fixtures/spotify'
import * as schema from '@/schemas/db'
import {
  commitQueuedAlbumImportRow,
  prepareAlbumCsv,
  prepareAlbumCandidates,
} from '@/services/album-imports'
import { observeSpotifySavedAlbumPage } from '@/services/album-import-observations'
import { observeCatalogMedia } from '@/services/catalog-discoveries'
import { observeLastfmScrobbles } from '@/services/lastfm-catalog-observations'
import { linkScrobblesToAlbums } from '@/services/lastfm-album-links'
import { getAlbumDetail } from '@/services/media'
import {
  backfillPublicMusicResponses,
  backfillMusicAlbumSnapshots,
} from '@/services/music-provider-backfill'
import { saveProviderResponseCapture } from '@/services/provider-response-history'
import { observeSpotifyArtistAlbumPage } from '@/services/spotify-artist-album-discoveries'
import { normalizeSpotifyAlbum } from '@/lib/spotify-api'

const database = `music_discoveries_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })
const ownerId = 'music-fixture-owner'
let created = false

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

beforeAll(async () => {
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  await fixture.insert(schema.user).values({
    id: ownerId,
    name: 'Fixture Owner',
    email: 'fixture@example.test',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

async function capture(
  provider: string,
  jobId: string,
  path: string,
  payload: unknown,
  artistId?: string,
) {
  await fixture.insert(schema.scrapeJob).values({
    id: jobId,
    provider,
    status: 'failed',
    scope: {},
    options: { task: 'fixture-discovery' },
  })
  const recorder = createProviderResponseRecorder(
    (entry) =>
      saveProviderResponseCapture({
        jobId,
        artistId,
        provider,
        attempt: 1,
        capture: entry,
      }),
    [],
  )
  const record = recorder(artistId ? 'artist' : 'task')(path)
  if (!record) throw new Error('Missing fixture recorder')
  await record({
    status: 200,
    receivedAt: '2026-01-02T00:00:00Z',
    contentType: 'application/json',
    body: { state: 'captured', text: JSON.stringify(payload) },
  })
}

it('keeps raw evidence from failed jobs, replays idempotently and opens noncanonical release positions', async () => {
  const job = 'failed-discogs-discovery'
  await capture('discogs', job, 'https://api.discogs.com/releases/4096', {
    id: 4096,
    title: 'Orbit Pressing',
    artists: [{ id: 713, name: 'Orbit Ensemble' }],
    tracklist: [
      { title: 'Reprise', position: 'A1', duration: '2:31' },
      { title: 'Reprise', position: 'B1', duration: '2:40' },
    ],
  })
  const [response] = await fixture
    .select()
    .from(schema.providerResponse)
    .where(eq(schema.providerResponse.jobId, job))
  const [record] = await fixture
    .select()
    .from(schema.catalogObservation)
    .where(
      and(
        eq(schema.catalogObservation.jobId, job),
        eq(schema.catalogObservation.targetKind, 'album'),
      ),
    )
  if (!response || !record) throw new Error('Missing failed job discoveries')
  expect(record.responseId).toBe(response.id)
  const album = await getAlbumDetail(record.targetId)
  expect(album?.inLibrary).toBe(false)
  expect(album?.tracks).toMatchObject([
    {
      position: 1,
      track: { title: 'Reprise', durationSec: 151, inLibrary: false },
    },
    {
      position: 2,
      track: { title: 'Reprise', durationSec: 160, inLibrary: false },
    },
  ])
  expect(album?.tracks[0]?.track.id).not.toBe(album?.tracks[1]?.track.id)
  const before = await fixture.$count(
    schema.catalogObservation,
    eq(schema.catalogObservation.jobId, job),
  )
  await backfillPublicMusicResponses({ apply: true, limit: 12 })
  expect(
    await fixture.$count(
      schema.catalogObservation,
      eq(schema.catalogObservation.jobId, job),
    ),
  ).toBe(before)
})

it('retains Spotify verification recordings and reuses a musician verified by multiple providers', async () => {
  const artistId = 'confirmed-musician'
  const spotifyId = 'fixtureArtist'.padEnd(22, '0')
  const discogsId = '5719'
  const trackId = 'fixtureVerify'.padEnd(22, '0')
  await fixture
    .insert(schema.artist)
    .values({ id: artistId, name: 'Confirmed Musician' })
  for (const [provider, externalId] of [
    ['spotify', spotifyId],
    ['discogs', discogsId],
  ]) {
    if (!provider || !externalId) throw new Error('Missing fixture profile')
    const latestSnapshotId = `${artistId}-${provider}`
    await fixture.insert(schema.artistProviderSnapshot).values({
      id: latestSnapshotId,
      artistId,
      provider,
      normalizedData: { name: 'Confirmed Musician', externalId, tags: [] },
      payload: {},
    })
    await fixture
      .insert(schema.artistProviderCurrentState)
      .values({ artistId, provider, latestSnapshotId })
  }
  const job = 'failed-artist-verification'
  await capture(
    'spotify',
    job,
    'https://api.spotify.com/v1/search?type=track&q=fixture',
    {
      tracks: {
        offset: 0,
        items: [
          {
            id: trackId,
            name: 'Verification Recording',
            artists: [{ id: spotifyId, name: 'Confirmed Musician' }],
          },
        ],
      },
    },
    artistId,
  )
  const [observed] = await fixture
    .select()
    .from(schema.catalogObservation)
    .where(
      and(
        eq(schema.catalogObservation.targetKind, 'track'),
        eq(schema.catalogObservation.jobId, job),
      ),
    )
  if (!observed) throw new Error('Missing verification result')
  expect(observed.subjectId).toBe(artistId)
  expect(
    await fixture
      .select()
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, observed.targetId)),
  ).toMatchObject([{ artistId }])
  const outsideAlbum = await fixture.transaction((tx) =>
    observeCatalogMedia(
      tx,
      {
        kind: 'album',
        title: 'Music Profile Fixture',
        provider: 'discogs',
        referenceType: 'release',
        externalId: '7159',
        credits: [{ externalId: discogsId, name: 'Confirmed Musician' }],
      },
      {
        provider: 'discogs',
        operation: 'test',
        occurrenceKey: 'verified-credits',
      },
    ),
  )
  expect(
    await fixture
      .select()
      .from(schema.mediaCredit)
      .where(eq(schema.mediaCredit.mediaItemId, outsideAlbum)),
  ).toMatchObject([{ artistId }])
  expect(
    await fixture.$count(
      schema.artist,
      eq(schema.artist.name, 'Confirmed Musician'),
    ),
  ).toBe(1)
})

it('keeps filtered CSV rows and promotes the stable UPC preview with its saved date', async () => {
  await fixture.insert(schema.mediaItem).values([
    {
      id: 'ambiguous-a',
      slug: 'ambiguous-a',
      title: 'Uncertain Edition',
      mediaType: 'album',
    },
    {
      id: 'ambiguous-b',
      slug: 'ambiguous-b',
      title: 'Uncertain Edition',
      mediaType: 'album',
    },
  ])
  await fixture
    .insert(schema.album)
    .values([{ mediaItemId: 'ambiguous-a' }, { mediaItemId: 'ambiguous-b' }])
  await fixture.insert(schema.providerReference).values([
    {
      id: 'ambiguous-upc-a',
      mediaItemId: 'ambiguous-a',
      provider: 'fixture',
      referenceType: 'upc',
      externalId: '123456789012',
    },
    {
      id: 'ambiguous-upc-b',
      mediaItemId: 'ambiguous-b',
      provider: 'fixture',
      referenceType: 'upc',
      externalId: '123456789012',
    },
  ])
  const preview = await prepareAlbumCsv(
    {
      format: 'upc-csv',
      fileName: 'fixture.csv',
      content:
        'title,artist,upc,date\nNew Edition,Fixture Artist,098765432109,2021-03-04\nNew Edition,Fixture Artist,098765432109,2021-03-04\nUncertain Edition,Fixture Artist,123456789012,',
    },
    ownerId,
  )
  expect(preview.items).toHaveLength(1)
  expect(preview.skipped).toBe(2)
  const id = preview.items[0]?.catalogMediaItemId
  if (!id) throw new Error('Missing preview item ID')
  const discoveries = await fixture
    .select()
    .from(schema.catalogObservation)
    .where(
      and(
        eq(schema.catalogObservation.importId, preview.id),
        eq(schema.catalogObservation.targetKind, 'album'),
      ),
    )
    .orderBy(schema.catalogObservation.position)
  expect(
    discoveries.map(({ targetId, position }) => [targetId, position]),
  ).toEqual([
    [id, 1],
    [id, 2],
    [expect.any(String), 3],
  ])
  expect(['ambiguous-a', 'ambiguous-b']).not.toContain(discoveries[2]?.targetId)
  const stored = await fixture.query.filmImportPreview.findFirst({
    where: eq(schema.filmImportPreview.id, preview.id),
  })
  expect(
    await fixture.transaction((tx) =>
      commitQueuedAlbumImportRow(stored?.records, 0, tx, ownerId),
    ),
  ).toEqual({ id, action: 'new' })
  expect(
    await fixture.query.catalogAddition.findFirst({
      where: eq(schema.catalogAddition.mediaItemId, id),
    }),
  ).toMatchObject({ ownerId })
  expect(
    await fixture.query.album.findFirst({
      where: eq(schema.album.mediaItemId, id),
    }),
  ).toMatchObject({ dateAdded: new Date('2021-03-04') })
  expect(
    await fixture.$count(
      schema.catalogObservation,
      and(
        eq(schema.catalogObservation.targetId, id),
        eq(schema.catalogObservation.operation, 'import'),
      ),
    ),
  ).toBe(1)
  await backfillMusicAlbumSnapshots({ apply: true, limit: 12 })
  expect(
    await fixture.$count(
      schema.catalogObservation,
      and(
        eq(schema.catalogObservation.targetId, id),
        eq(schema.catalogObservation.operation, 'import'),
      ),
    ),
  ).toBe(1)
})

it('retains tracklists for Spotify saved albums outside the selected preview and promotes only the selected album', async () => {
  const previewId = 'spotify-saved-fixture'
  const release = spotifyAlbumFixture()
  const otherId = 'anotherRelease'.padEnd(22, '0')
  const page = SpotifySavedPageSchema.parse({
    items: [
      { album: release, added_at: '2021-02-03T00:00:00Z' },
      {
        album: { ...release, id: otherId, name: 'Another Release' },
        added_at: '2020-08-09T00:00:00Z',
      },
    ],
    offset: 0,
    total: 2,
    next: null,
  })
  const ids = await observeSpotifySavedAlbumPage(fixture, page, previewId)
  const preview = await prepareAlbumCandidates(
    {
      records: [
        {
          provider: 'spotify',
          source: 'Spotify saved albums',
          result: normalizeSpotifyAlbum(release, '2021-02-03T00:00:00Z'),
        },
      ],
      skipped: 0,
      warnings: [],
    },
    ownerId,
    {
      kind: 'spotify',
      source: 'Spotify saved albums',
      previewId,
      catalogIds: ids,
    },
  )
  const id = preview.items[0]?.catalogMediaItemId
  const other = ids.get(otherId)
  if (!id || !other) throw new Error('Missing Spotify preview IDs')
  expect((await getAlbumDetail(other))?.tracks).toMatchObject([
    { position: 1, track: { title: 'Opening', inLibrary: false } },
  ])
  const stored = await fixture.query.filmImportPreview.findFirst({
    where: eq(schema.filmImportPreview.id, previewId),
  })
  expect(
    await fixture.transaction((tx) =>
      commitQueuedAlbumImportRow(stored?.records, 0, tx, ownerId),
    ),
  ).toEqual({ id, action: 'new' })
  expect(await getAlbumDetail(other)).toMatchObject({ inLibrary: false })
  expect(await getAlbumDetail(id)).toMatchObject({
    inLibrary: true,
    storedDateAdded: '2021-02-03T00:00:00.000Z',
  })
})

it('never uses an outside album for automatic Last.fm relinking', async () => {
  const username = 'fixture-listener'
  const id = 'lastfm-fixture-event'
  const row = {
    id,
    artistName: 'Logging Ensemble',
    albumName: 'Logging Release',
    trackName: 'Logging Track',
    artistMbid: null,
    albumMbid: null,
    trackMbid: null,
  }
  await fixture.insert(schema.lastfmScrobble).values({
    ...row,
    username,
    listenedAt: new Date('2021-01-01'),
    artistKey: 'logging ensemble',
    albumKey: 'logging release',
    trackKey: 'logging track',
  })
  await fixture.transaction((tx) => observeLastfmScrobbles(tx, [row]))
  await linkScrobblesToAlbums(username)
  expect(
    await fixture.query.lastfmScrobble.findFirst({
      where: eq(schema.lastfmScrobble.id, id),
    }),
  ).toMatchObject({ albumMediaItemId: null })
  await fixture.execute(
    sql`update media_item set in_library = true where title = ${row.albumName}`,
  )
  await linkScrobblesToAlbums(username)
  const result = await fixture.query.lastfmScrobble.findFirst({
    where: eq(schema.lastfmScrobble.id, id),
  })
  expect(result?.albumMediaItemId).toEqual(expect.any(String))
})

it('keeps rejected and uncertain Spotify references off the linked library album', async () => {
  const ids = ['rejectedRelease', 'uncertainRelease'].map((id) =>
    id.padEnd(22, '0'),
  )
  for (const [index, externalId] of ids.entries()) {
    const member = `spotify-reference-member-${index}`
    const spotifyUrl = `https://open.spotify.com/album/${externalId}`
    await fixture.insert(schema.mediaItem).values({
      id: member,
      slug: member,
      title: 'Incorrect Local Match',
      mediaType: 'album',
    })
    await fixture
      .insert(schema.album)
      .values({ mediaItemId: member, spotifyUrl })
    await fixture.insert(schema.providerReference).values({
      id: `${member}-reference`,
      mediaItemId: member,
      provider: 'spotify',
      referenceType: 'spotify',
      externalId,
      metadata: index ? { verified: false } : { rejected: true },
    })
    const projected = await fixture.transaction((tx) =>
      observeCatalogMedia(
        tx,
        {
          kind: 'album',
          title: 'External Album',
          provider: 'spotify',
          referenceType: 'spotify',
          externalId,
          spotifyUrl,
        },
        {
          provider: 'spotify',
          operation: 'test',
          occurrenceKey: `rejected-${index}`,
        },
      ),
    )
    expect(projected).not.toBe(member)
    const batched = await fixture.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
      return observeSpotifyArtistAlbumPage(
        tx,
        [
          {
            externalId,
            spotifyUrl,
            title: 'External Album',
            position: 1,
            relationshipRole: 'album',
            primary: false,
            credits: [],
          },
        ],
        { occurrencePrefix: `reference-${index}`, page: 1 },
      )
    })
    expect(batched.get(externalId)).toBe(projected)
    expect(await getAlbumDetail(projected)).toMatchObject({ inLibrary: false })
  }
})
