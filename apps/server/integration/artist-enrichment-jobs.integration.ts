import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { ArtistProfileProvider } from '@repo/schemas/artist-profiles'
import type { JsonValue } from '@repo/schemas/common'
import { env } from '@/env'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import * as schema from '@/schemas/db'

const database = 'artist_jobs_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  getScrapePlugin: async (id: string) =>
    id === 'musicbrainz'
      ? {
          ...musicbrainzPlugin,
          manifest: {
            ...musicbrainzPlugin.manifest,
            rateLimit: {
              ...musicbrainzPlugin.manifest.rateLimit,
              minTimeMs: 0,
            },
          },
        }
      : null,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    appName: 'OfflineFixture',
    appVersion: '2.0',
    contact: 'offline@example.test',
  }),
}))

const artistId = 'artist-fixture'
const artistName = 'Artist Fixture'
const artistMbid = '11111111-1111-4111-8111-111111111111'
const duplicateMbid = '22222222-2222-4222-8222-222222222222'
const spotifyAlbumId = '0123456789abcdefghijkl'
const spotifyTrackId = '0123456789abcdefghijkm'
const spotifyArtistId = '0123456789abcdefghijkn'
const artistProfile = {
  id: artistMbid,
  name: artistName,
  tags: [{ name: 'Ambient' }],
}

async function seedArtistAlbum(id: string, targetArtist = artistId) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title: 'Album fixture',
    mediaType: 'album',
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: id })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: id,
    artistId: targetArtist,
    role: 'artist',
  })
}

async function providerEvidence(
  mediaItemId: string,
  provider: ArtistProfileProvider,
  payload: JsonValue,
  snapshotId?: string,
) {
  await databaseClient.insert(schema.providerCurrentState).values({
    id: provider + '-' + mediaItemId,
    mediaItemId,
    provider,
    payload,
    checksum: 'fixture',
    status: 'ready',
    latestSnapshotId: snapshotId,
  })
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query('create database ' + database)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient
    .insert(schema.artist)
    .values({ id: artistId, name: artistName })
  await seedArtistAlbum('album-fixture')
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('artist enrichment through queued jobs and stored evidence', () => {
  it('compares stored artist names, retains conflicting IDs, and pages provider sorts', async () => {
    const secondArtist = 'second-artist'
    await databaseClient.insert(schema.artist).values({
      id: secondArtist,
      name: 'The Second Fixture',
    })
    await seedArtistAlbum('second-album', secondArtist)
    await providerEvidence('album-fixture', 'discogs', {
      release: {
        artists: [
          { id: 100, name: 'Artist Fixture (2)' },
          { id: 200, name: 'Artist Fixture (3)' },
          { id: 300, name: 'Another Artist' },
        ],
      },
    })
    const snapshots = [
      {
        id: 'fixture-profile',
        artistId,
        provider: 'musicbrainz',
        normalizedData: {
          name: 'Zulu Artist',
          externalId: artistMbid,
          tags: [],
        },
        payload: { fixturePrivateField: 'stored-payload-only' },
      },
      {
        id: 'second-profile',
        artistId: secondArtist,
        provider: 'musicbrainz',
        normalizedData: {
          name: 'Alpha Artist',
          externalId: duplicateMbid,
          tags: [],
        },
        payload: {},
      },
    ] satisfies (typeof schema.artistProviderSnapshot.$inferInsert)[]
    await databaseClient.insert(schema.artistProviderSnapshot).values(snapshots)
    await databaseClient.insert(schema.artistProviderCurrentState).values(
      snapshots.map((snapshot) => ({
        artistId: snapshot.artistId,
        provider: snapshot.provider,
        latestSnapshotId: snapshot.id,
      })),
    )

    const { listArtistMatchDiagnostics } =
      await import('@/services/artist-match-diagnostics')
    const first = await listArtistMatchDiagnostics({
      page: 1,
      size: 1,
      direction: 'asc',
      sortBy: 'name',
    })
    expect(first).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      items: [
        {
          id: artistId,
          name: artistName,
          matches: [
            {
              provider: 'discogs',
              name: 'Artist Fixture (2)',
              identifier: '100',
            },
            {
              provider: 'discogs',
              name: 'Artist Fixture (3)',
              identifier: '200',
            },
            {
              provider: 'musicbrainz',
              name: 'Zulu Artist',
              identifier: artistMbid,
            },
          ],
        },
      ],
    })
    expect(JSON.stringify(first)).not.toContain('stored-payload-only')
    const query = {
      page: 1,
      size: 1,
      direction: 'asc',
      sortBy: 'musicbrainz',
    } satisfies Parameters<typeof listArtistMatchDiagnostics>[0]
    expect(await listArtistMatchDiagnostics(query)).toMatchObject({
      items: [{ id: secondArtist }],
    })
    expect(
      await listArtistMatchDiagnostics({ ...query, page: 2 }),
    ).toMatchObject({ items: [{ id: artistId }] })
    expect(
      await listArtistMatchDiagnostics({ ...query, page: 3 }),
    ).toMatchObject({ items: [], totalCount: 2 })
    expect(
      await listArtistMatchDiagnostics({ ...query, q: 'zulu' }),
    ).toMatchObject({ items: [{ id: artistId }], totalCount: 1 })
    expect(
      await listArtistMatchDiagnostics({ ...query, q: 'Another Artist' }),
    ).toMatchObject({ items: [], totalCount: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('shows stored album artist identifiers before any artist enrichment', async () => {
    await providerEvidence('album-fixture', 'spotify', {
      id: spotifyAlbumId,
      artists: [{ id: spotifyArtistId, name: artistName }],
    })
    const { getArtist } = await import('@/services/creators')
    expect(
      await getArtist(artistId, { includeHistory: 'false' }),
    ).toMatchObject({
      providers: [],
      identifiers: expect.arrayContaining([
        {
          provider: 'spotify',
          externalId: spotifyArtistId,
          status: 'inferred',
          url: 'https://open.spotify.com/artist/' + spotifyArtistId,
        },
      ]),
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('recovers wrapped imports and paginates exact album provenance without scraping', async () => {
    await seedArtistAlbum('second-album')
    const payload = {
      source: 'spotify',
      data: {
        id: spotifyAlbumId,
        artists: [
          { id: spotifyArtistId, name: artistName },
          { id: '0123456789abcdefghijkp', name: 'Other Artist' },
        ],
      },
    }
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'source-job',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    })
    await databaseClient.insert(schema.providerSnapshot).values({
      id: 'source-snapshot',
      provider: 'spotify',
      mediaItemId: 'album-fixture',
      source: 'import',
      checksum: 'fixture',
      payload,
      scrapeJobId: 'source-job',
    })
    await providerEvidence(
      'album-fixture',
      'spotify',
      payload,
      'source-snapshot',
    )
    await providerEvidence('second-album', 'spotify', payload)
    const { getArtist } = await import('@/services/creators')
    const { listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    expect((await getArtist(artistId)).identifiers).toContainEqual({
      provider: 'spotify',
      externalId: spotifyArtistId,
      status: 'inferred',
      url: 'https://open.spotify.com/artist/' + spotifyArtistId,
    })
    const first = await listArtistIdentifierSources(artistId, 'spotify', {
      page: 1,
      size: 1,
    })
    const second = await listArtistIdentifierSources(artistId, 'spotify', {
      page: 2,
      size: 1,
    })
    expect(first).toMatchObject({
      page: 1,
      size: 1,
      totalCount: 2,
      pageCount: 2,
    })
    expect(first.items).toHaveLength(1)
    expect(second.items).toHaveLength(1)
    expect([...first.items, ...second.items]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: spotifyArtistId,
          kind: 'album',
          provider: 'spotify',
          id: 'album-fixture',
          title: 'Album fixture',
          snapshotId: 'source-snapshot',
          jobId: 'source-job',
        }),
        expect.objectContaining({
          id: 'second-album',
          externalId: spotifyArtistId,
        }),
      ]),
    )
    expect(
      (
        await listArtistIdentifierSources(artistId, 'spotify', {
          page: 3,
          size: 1,
        })
      ).items,
    ).toEqual([])
    expect(request).not.toHaveBeenCalled()
  })

  it('shows conflicts and keeps confirmed artist profiles authoritative with both sources visible', async () => {
    await seedArtistAlbum('second-album')
    await providerEvidence('album-fixture', 'musicbrainz', {
      releaseGroup: {
        id: duplicateMbid,
        'artist-credit': [
          {
            name: artistName,
            artist: { id: artistMbid, name: 'Canonical Artist' },
          },
        ],
      },
    })
    await providerEvidence('second-album', 'musicbrainz', {
      releaseGroup: {
        'artist-credit': [{ artist: { id: duplicateMbid, name: artistName } }],
      },
    })
    const { getArtist } = await import('@/services/creators')
    const { listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    expect((await getArtist(artistId)).identifiers).toContainEqual({
      provider: 'musicbrainz',
      externalId: null,
      status: 'conflict',
      url: null,
    })
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'profile-job',
      provider: 'musicbrainz',
      status: 'succeeded',
      scope: {},
      options: {},
    })
    const { saveArtistProviderResult } =
      await import('@/services/artist-profiles')
    await saveArtistProviderResult(artistId, 'musicbrainz', {
      profile: { externalId: artistMbid, tags: [] },
      payload: {},
      scrapeJobId: 'profile-job',
    })
    expect((await getArtist(artistId)).identifiers).toContainEqual({
      provider: 'musicbrainz',
      externalId: artistMbid,
      status: 'confirmed',
      url: 'https://musicbrainz.org/artist/' + artistMbid,
    })
    expect(
      await listArtistIdentifierSources(artistId, 'musicbrainz', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 3,
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'artist',
          externalId: artistMbid,
          jobId: 'profile-job',
        }),
        expect.objectContaining({
          kind: 'album',
          id: 'second-album',
          externalId: duplicateMbid,
        }),
      ]),
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('shares only artist MBIDs across MusicBrainz and Last.fm and excludes release IDs and invalid credits', async () => {
    await providerEvidence('album-fixture', 'musicbrainz', {
      releaseGroup: {
        id: duplicateMbid,
        'artist-credit': [
          { artist: { id: artistMbid.toUpperCase(), name: artistName } },
          { artist: { id: duplicateMbid, name: 'Other Artist' } },
        ],
      },
    })
    await providerEvidence('album-fixture', 'spotify', {
      id: spotifyAlbumId,
      artists: [{ id: 'invalid-id', name: artistName }],
    })
    await providerEvidence('album-fixture', 'lastfm', {
      album: {
        mbid: duplicateMbid,
        artist: artistName,
      },
    })
    const { getArtist } = await import('@/services/creators')
    const { listArtistIdentifierSources, listStoredArtistProviderCandidates } =
      await import('@/services/artist-provider-evidence')
    const detail = await getArtist(artistId)
    expect(detail.identifiers).toEqual(
      expect.arrayContaining([
        {
          provider: 'musicbrainz',
          externalId: artistMbid,
          status: 'inferred',
          url: 'https://musicbrainz.org/artist/' + artistMbid,
        },
        {
          provider: 'lastfm',
          externalId: artistMbid,
          status: 'inferred',
          url: null,
        },
        { provider: 'spotify', externalId: null, status: 'missing', url: null },
      ]),
    )
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'lastfm'),
    ).toEqual([{ id: artistMbid, name: artistName, exact: true }])
    expect(
      await listArtistIdentifierSources(artistId, 'lastfm', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          provider: 'musicbrainz',
          id: 'album-fixture',
          externalId: artistMbid,
        },
      ],
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('reads imported track credits with their import job independently of album enrichment', async () => {
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'track-import-job',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    })
    await databaseClient.insert(schema.mediaItem).values({
      id: 'track-import',
      slug: 'track-import',
      title: 'Imported Track',
      mediaType: 'track',
      metadata: {
        spotifyArtistCredits: [{ id: spotifyArtistId, name: artistName }],
        spotifyArtistCreditsSource: {
          source: 'spotify-liked',
          jobId: 'track-import-job',
        },
      },
    })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: 'track-import', spotifyTrackId })
    await databaseClient
      .insert(schema.mediaCredit)
      .values({ mediaItemId: 'track-import', artistId, role: 'artist' })
    const { getArtist } = await import('@/services/creators')
    const { listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    expect((await getArtist(artistId)).identifiers).toContainEqual({
      provider: 'spotify',
      externalId: spotifyArtistId,
      status: 'inferred',
      url: 'https://open.spotify.com/artist/' + spotifyArtistId,
    })
    expect(
      await listArtistIdentifierSources(artistId, 'spotify', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          provider: 'spotify',
          kind: 'track',
          id: 'track-import',
          title: 'Imported Track',
          jobId: 'track-import-job',
        },
      ],
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('retains the latest stored track credit after a partial import and prefers subsequent current credits', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'retained-track',
      slug: 'retained-track',
      title: 'Retained Track',
      mediaType: 'track',
    })
    await databaseClient.insert(schema.libraryTrack).values({
      mediaItemId: 'retained-track',
      spotifyTrackId,
      albumMediaItemId: 'album-fixture',
    })
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: 'retained-track',
      artistId,
      role: 'artist',
    })
    const payload = (id: string) => ({
      id: spotifyAlbumId,
      tracks: {
        items: [{ id: spotifyTrackId, artists: [{ id, name: artistName }] }],
      },
    })
    const partial = { source: 'spotify', data: { id: spotifyAlbumId } }
    await databaseClient.insert(schema.scrapeJob).values({
      id: 'retained-credit-job',
      provider: 'spotify',
      status: 'succeeded',
      scope: {},
      options: {},
    })
    await databaseClient.insert(schema.providerSnapshot).values([
      {
        id: 'stale-track-credit',
        mediaItemId: 'album-fixture',
        provider: 'spotify',
        source: 'scrape',
        checksum: 'stale',
        payload: payload('0123456789abcdefghijkp'),
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        id: 'retained-track-credit',
        mediaItemId: 'album-fixture',
        provider: 'spotify',
        source: 'scrape',
        checksum: 'retained',
        payload: { source: 'spotify', data: payload(spotifyArtistId) },
        scrapeJobId: 'retained-credit-job',
        createdAt: new Date('2025-01-02T00:00:00Z'),
      },
      {
        id: 'unrelated-track-credit',
        mediaItemId: 'album-fixture',
        provider: 'spotify',
        source: 'scrape',
        checksum: 'unrelated',
        payload: {
          id: spotifyAlbumId,
          tracks: {
            items: [
              {
                id: '0123456789abcdefghijko',
                artists: [{ id: '0123456789abcdefghijkp', name: artistName }],
              },
            ],
          },
        },
        createdAt: new Date('2025-01-02T12:00:00Z'),
      },
      {
        id: 'partial-track-credit',
        mediaItemId: 'album-fixture',
        provider: 'spotify',
        source: 'import',
        checksum: 'partial',
        payload: partial,
        createdAt: new Date('2025-01-03T00:00:00Z'),
      },
    ])
    await providerEvidence(
      'album-fixture',
      'spotify',
      partial,
      'partial-track-credit',
    )
    const { listStoredArtistProviderCandidates, listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'spotify'),
    ).toEqual([{ id: spotifyArtistId, name: artistName, exact: true }])
    expect(
      await listArtistIdentifierSources(artistId, 'spotify', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          externalId: spotifyArtistId,
          snapshotId: 'retained-track-credit',
          jobId: 'retained-credit-job',
          createdAt: '2025-01-02T00:00:00.000Z',
        },
      ],
    })
    const replacement = payload('0123456789abcdefghijkq')
    await databaseClient.insert(schema.providerSnapshot).values({
      id: 'current-track-credit',
      mediaItemId: 'album-fixture',
      provider: 'spotify',
      source: 'scrape',
      checksum: 'current',
      payload: replacement,
      createdAt: new Date('2025-01-04T00:00:00Z'),
    })
    await databaseClient
      .update(schema.providerCurrentState)
      .set({
        payload: replacement,
        latestSnapshotId: 'current-track-credit',
      })
      .where(eq(schema.providerCurrentState.id, 'spotify-album-fixture'))
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'spotify'),
    ).toEqual([{ id: '0123456789abcdefghijkq', name: artistName, exact: true }])
    expect(
      await listArtistIdentifierSources(artistId, 'spotify', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          externalId: '0123456789abcdefghijkq',
          snapshotId: 'current-track-credit',
        },
      ],
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('uses one MBID with its matching Last.fm artist URL and keeps distinct URLs ambiguous', async () => {
    await providerEvidence('album-fixture', 'musicbrainz', {
      releaseGroup: {
        'artist-credit': [{ artist: { id: artistMbid, name: artistName } }],
      },
    })
    await providerEvidence('album-fixture', 'lastfm', {
      album: {
        artist: artistName,
        tracks: {
          track: [
            {
              artist: {
                name: artistName,
                url: 'https://www.last.fm/music/Artist+Fixture',
              },
            },
          ],
        },
      },
    })
    const { listStoredArtistProviderCandidates, listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'lastfm'),
    ).toEqual([{ id: artistMbid, name: artistName, exact: true }])
    expect(
      await listArtistIdentifierSources(artistId, 'lastfm', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({ totalCount: 2 })
    await seedArtistAlbum('other-lastfm-album')
    await providerEvidence('other-lastfm-album', 'lastfm', {
      album: {
        artist: {
          name: artistName,
          url: 'https://www.last.fm/music/Other+Artist+Fixture',
        },
      },
    })
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'lastfm'),
    ).toHaveLength(3)
    const { getArtist } = await import('@/services/creators')
    expect((await getArtist(artistId)).identifiers).toContainEqual({
      provider: 'lastfm',
      externalId: null,
      status: 'conflict',
      url: null,
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('reads a wrapped track credit through any album membership and ignores unrelated track IDs', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'member-track',
      slug: 'member-track',
      title: 'Member Track',
      mediaType: 'track',
    })
    await databaseClient
      .insert(schema.libraryTrack)
      .values({ mediaItemId: 'member-track' })
    await databaseClient
      .insert(schema.mediaCredit)
      .values({ mediaItemId: 'member-track', artistId, role: 'artist' })
    await databaseClient.insert(schema.track).values({
      id: 'membership',
      albumMediaItemId: 'album-fixture',
      trackMediaItemId: 'member-track',
      externalId: spotifyTrackId,
      title: 'Member Track',
      position: 1,
    })
    await providerEvidence('album-fixture', 'spotify', {
      source: 'spotify',
      data: {
        id: spotifyAlbumId,
        tracks: {
          items: [
            {
              id: spotifyTrackId,
              artists: [{ id: spotifyArtistId, name: artistName }],
            },
            {
              id: '0123456789abcdefghijko',
              artists: [{ id: '0123456789abcdefghijkp', name: artistName }],
            },
          ],
        },
      },
    })
    const { listStoredArtistProviderCandidates, listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'spotify'),
    ).toEqual([{ id: spotifyArtistId, name: artistName, exact: true }])
    expect(
      await listArtistIdentifierSources(artistId, 'spotify', {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [
        {
          provider: 'spotify',
          kind: 'album',
          id: 'album-fixture',
          externalId: spotifyArtistId,
        },
      ],
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('queues one job per artist and provider, reads the stored native artist ID, and keeps album evidence intact', async () => {
    const albumEvidence = {
      releaseGroup: {
        id: duplicateMbid,
        title: 'Album fixture',
        'artist-credit': [{ artist: { id: artistMbid, name: artistName } }],
      },
    }
    await providerEvidence('album-fixture', 'musicbrainz', albumEvidence)
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, listJobs, processQueuedJobs } =
      await import('@/services/jobs')
    const input = { artistId, provider: 'musicbrainz' } satisfies {
      artistId: string
      provider: ArtistProfileProvider
    }
    const queued = await enqueueArtistEnrichment(input, null)
    expect((await enqueueArtistEnrichment(input, null)).id).toBe(queued.id)
    expect(queued.items).toEqual([])
    expect(queued.options).toMatchObject({
      task: 'artist-enrichment',
      artistId,
      artistName,
    })
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(request).toHaveBeenCalledTimes(1)
    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe(
      '/ws/2/artist/' + artistMbid,
    )
    expect(await getJob(queued.id)).toMatchObject({
      status: 'succeeded',
      options: { progress: { pagesRead: 1, totalPages: 1 } },
    })
    expect(
      (
        await listJobs({ artistId, mediaType: 'artist', sortBy: 'title' })
      ).items.map((item) => item.id),
    ).toEqual([queued.id])
    const [snapshot] = await databaseClient
      .select()
      .from(schema.artistProviderSnapshot)
    expect(snapshot).toMatchObject({
      artistId,
      scrapeJobId: queued.id,
      normalizedData: { externalId: artistMbid, tags: ['Ambient'] },
      payload: { artist: artistProfile },
    })
    expect(
      await databaseClient.select().from(schema.artistProviderCurrentState),
    ).toMatchObject([{ latestSnapshotId: snapshot?.id }])
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toMatchObject([{ payload: albumEvidence }])
    expect(await databaseClient.select().from(schema.tagOccurrence)).toEqual([])
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
  })

  it('retains conflicting linked IDs as job diagnostics and lets a direct correction bypass the conflict', async () => {
    await seedArtistAlbum('other-album')
    const credits = [
      { album: 'album-fixture', id: artistMbid },
      { album: 'other-album', id: duplicateMbid },
    ]
    for (const { album, id } of credits)
      await providerEvidence(album, 'musicbrainz', {
        releaseGroup: {
          'artist-credit': [{ artist: { id, name: artistName } }],
        },
      })
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobById, processQueuedJobs, retryJob } =
      await import('@/services/jobs')
    const unresolved = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz' },
      null,
    )
    const recordOutcome = vi.fn(async () => {})
    await processQueuedJobById(unresolved.id, 'musicbrainz', {
      canContinue: async () => true,
      recordOutcome,
    })
    expect(request).not.toHaveBeenCalled()
    expect(recordOutcome).not.toHaveBeenCalled()
    expect(await getJob(unresolved.id)).toMatchObject({
      status: 'failed',
      logs: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            classification: 'ambiguous',
            diagnostics: [
              expect.objectContaining({
                stage: 'artist.stored-candidates',
                evidence: expect.objectContaining({ total: 2 }),
              }),
            ],
          }),
        }),
      ]),
    })
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toEqual([])
    const corrected = await enqueueArtistEnrichment(
      {
        artistId,
        provider: 'musicbrainz',
        providerArtistId: artistMbid,
      },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await getJob(corrected.id)).toMatchObject({ status: 'succeeded' })
    await expect(retryJob(unresolved.id, null, false)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('records a missing match without counting it as a dispatcher failure', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobById } = await import('@/services/jobs')
    const job = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz' },
      null,
    )
    request.mockResolvedValueOnce(Response.json({ count: 0, artists: [] }))
    const recordOutcome = vi.fn(async () => {})
    await processQueuedJobById(job.id, 'musicbrainz', {
      canContinue: async () => true,
      recordOutcome,
    })
    expect(await getJob(job.id)).toMatchObject({
      status: 'failed',
      logs: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ classification: 'not-found' }),
        }),
      ]),
    })
    expect(recordOutcome).not.toHaveBeenCalled()
  })

  it('refuses to retry a failed explicit artist ID after a newer profile succeeds', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobs, retryJob } =
      await import('@/services/jobs')
    const stale = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz', providerArtistId: duplicateMbid },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await getJob(stale.id)).toMatchObject({ status: 'failed' })

    const current = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz', providerArtistId: artistMbid },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await getJob(current.id)).toMatchObject({ status: 'succeeded' })
    await expect(retryJob(stale.id, null, false)).rejects.toMatchObject({
      response: { statusCode: 409 },
    })
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toMatchObject([
      { scrapeJobId: current.id, normalizedData: { externalId: artistMbid } },
    ])
  })

  it('corrects a confirmed artist profile and keeps its earlier identity in history', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { processQueuedJobs } = await import('@/services/jobs')
    const { listCurrentArtistProfiles, listArtistProfileHistory } =
      await import('@/services/artist-profiles')
    const { listArtistMatchDiagnostics } =
      await import('@/services/artist-match-diagnostics')

    const provider = 'musicbrainz'
    const previous = await enqueueArtistEnrichment(
      { artistId, provider, providerArtistId: duplicateMbid },
      null,
    )
    request.mockResolvedValueOnce(
      Response.json({
        ...artistProfile,
        id: duplicateMbid,
        name: 'Namesake Fixture',
      }),
    )
    await processQueuedJobs()
    expect(await listCurrentArtistProfiles(artistId)).toMatchObject([
      { scrapeJobId: previous.id, profile: { externalId: duplicateMbid } },
    ])

    const correction = await enqueueArtistEnrichment(
      { artistId, provider, providerArtistId: artistMbid },
      null,
    )
    request.mockResolvedValueOnce(Response.json(artistProfile))
    await processQueuedJobs()
    expect(await listCurrentArtistProfiles(artistId)).toMatchObject([
      { scrapeJobId: correction.id, profile: { externalId: artistMbid } },
    ])
    expect(
      (await listArtistProfileHistory(artistId, 2))
        .map((snapshot) => snapshot.scrapeJobId)
        .sort(),
    ).toEqual([correction.id, previous.id].sort())
    expect(
      await listArtistMatchDiagnostics({
        page: 1,
        size: 10,
        direction: 'asc',
        sortBy: 'name',
      }),
    ).toMatchObject({
      items: [
        {
          id: artistId,
          matches: [{ provider, name: artistName, identifier: artistMbid }],
        },
      ],
    })
  })

  it('uses track-linked Spotify credits, Discogs credits and the Last.fm scrobble artist MBID', async () => {
    await databaseClient.insert(schema.mediaItem).values({
      id: 'track-fixture',
      slug: 'track-fixture',
      title: 'Track Fixture',
      mediaType: 'track',
    })
    await databaseClient.insert(schema.libraryTrack).values({
      mediaItemId: 'track-fixture',
      spotifyTrackId,
      albumMediaItemId: 'album-fixture',
    })
    await databaseClient.insert(schema.mediaCredit).values({
      mediaItemId: 'track-fixture',
      artistId,
      role: 'artist',
    })
    await providerEvidence('album-fixture', 'spotify', {
      id: spotifyAlbumId,
      name: 'Album fixture',
      tracks: {
        items: [
          {
            id: '0123456789abcdefghijko',
            artists: [{ id: '0123456789abcdefghijkp', name: artistName }],
          },
          {
            id: spotifyTrackId,
            artists: [{ id: spotifyArtistId, name: artistName }],
          },
        ],
      },
    })
    await providerEvidence('album-fixture', 'discogs', {
      release: { id: 601, artists: [{ id: 71, name: artistName }] },
    })
    await databaseClient.insert(schema.lastfmScrobble).values({
      id: 'scrobble-fixture',
      username: 'listener-fixture',
      artistName,
      artistKey: artistName.toLowerCase(),
      trackName: 'Track Fixture',
      trackKey: 'track fixture',
      listenedAt: new Date('2025-01-01T00:00:00Z'),
      artistMbid,
      albumMbid: duplicateMbid,
      albumMediaItemId: 'album-fixture',
    })
    const { listStoredArtistProviderCandidates } =
      await import('@/services/artist-provider-evidence')
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'spotify'),
    ).toEqual([{ id: spotifyArtistId, name: artistName, exact: true }])
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'discogs'),
    ).toEqual([{ id: '71', name: artistName, exact: true }])
    expect(
      await listStoredArtistProviderCandidates(artistId, artistName, 'lastfm'),
    ).toEqual([{ id: artistMbid, name: artistName, exact: true }])
    expect(
      await listStoredArtistProviderCandidates(
        artistId,
        artistName,
        'musicbrainz',
      ),
    ).toEqual([{ id: artistMbid, name: artistName, exact: true }])
  })

  it('discards an artist response received after job cancellation', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { bulkCancelJobs, getJob, processQueuedJobs } =
      await import('@/services/jobs')
    const job = await enqueueArtistEnrichment(
      {
        artistId,
        provider: 'musicbrainz',
        providerArtistId: artistMbid,
      },
      null,
    )
    let notifyRequestStarted: () => void = () => undefined
    const requestStarted = new Promise<void>((resolve) => {
      notifyRequestStarted = resolve
    })
    let releaseResponse: () => void = () => undefined
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    request.mockImplementationOnce(async () => {
      notifyRequestStarted()
      await release
      return Response.json(artistProfile)
    })
    const jobFinished = processQueuedJobs()
    try {
      await Promise.race([requestStarted, jobFinished])
      expect(request).toHaveBeenCalledTimes(1)
      const cancelled = await bulkCancelJobs(
        { jobIds: [job.id], confirmRunning: true },
        null,
      )
      expect(cancelled.cancelled).toBe(1)
    } finally {
      releaseResponse()
      await jobFinished
    }
    expect(await getJob(job.id)).toMatchObject({ status: 'cancelled' })
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toEqual([])
    expect(
      await databaseClient.select().from(schema.artistProviderCurrentState),
    ).toEqual([])
  })
})
