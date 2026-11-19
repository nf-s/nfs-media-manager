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
import type { EntityRelationshipCandidate } from '@repo/schemas/entity-relationships'
import {
  PluginResultSchema,
  ProviderArtistSearchAmbiguousError,
  ProviderItemNotFoundError,
  ProviderRequestError,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { env } from '@/env'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import { spotifyPlugin } from '@/plugins/builtin/spotify'
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
const fixtureArtist = vi.fn<NonNullable<MediaProviderPlugin['scrapeArtist']>>()
const fixtureAlbum =
  vi.fn<NonNullable<MediaProviderPlugin['scrapeMediaItem']>>()
const fixturePlugin: MediaProviderPlugin = {
  manifest: {
    id: 'fixture-plugin',
    displayName: 'Fixture plugin',
    description: '',
    mediaTypes: ['album'],
    supportsNameLookup: true,
    bootstrapAlbumArtists: true,
    secrets: [],
    rateLimit: { maxConcurrent: 1, minTimeMs: 0 },
  },
  scrapeArtist: fixtureArtist,
  scrapeMediaItem: fixtureAlbum,
}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  getScrapePlugin: async (id: string) => {
    if (id === fixturePlugin.manifest.id) return fixturePlugin
    const plugin = [musicbrainzPlugin, spotifyPlugin].find(
      ({ manifest }) => manifest.id === id,
    )
    return (
      plugin && {
        ...plugin,
        manifest: {
          ...plugin.manifest,
          rateLimit: { ...plugin.manifest.rateLimit, minTimeMs: 0 },
        },
      }
    )
  },
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    appName: 'OfflineFixture',
    appVersion: '2.0',
    contact: 'offline@example.test',
    clientId: 'fixture-client',
    clientSecret: 'fixture-client-secret',
    market: 'AU',
  }),
}))

const artistId = 'artist-fixture'
const artistName = 'Artist Fixture'
const artistMbid = '11111111-1111-4111-8111-111111111111'
const duplicateMbid = '22222222-2222-4222-8222-222222222222'
const spotifyAlbumId = '0123456789abcdefghijkl'
const spotifyTrackId = '0123456789abcdefghijkm'
const spotifyArtistId = '0123456789abcdefghijkn'
const duplicateSpotifyArtistId = '0123456789abcdefghijko'
const spotifyRecordings = [
  { spotifyTrackId, title: 'Fixture Recording A' },
  { spotifyTrackId: '0123456789abcdefghijkp', title: 'Fixture Recording B' },
  { spotifyTrackId: '0123456789abcdefghijkq', title: 'Fixture Recording C' },
]
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

async function seedArtistRecording(
  id: string,
  spotifyTrackId: string,
  title: string,
) {
  await databaseClient.insert(schema.mediaItem).values({
    id,
    slug: id,
    title,
    mediaType: 'track',
  })
  await databaseClient
    .insert(schema.libraryTrack)
    .values({ mediaItemId: id, spotifyTrackId })
  await databaseClient
    .insert(schema.mediaCredit)
    .values({ mediaItemId: id, artistId, role: 'artist' })
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
  fixtureArtist.mockReset()
  fixtureAlbum.mockReset().mockImplementation(async ({ request }) => {
    await request('https://example.test/album')
    return PluginResultSchema.parse({ payload: { album: 'fixture' } })
  })
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
  async function queueFixtureAlbum(mediaItemId: string) {
    const { createJob } = await import('@/services/jobs')
    return createJob(
      {
        provider: fixturePlugin.manifest.id,
        scope: { mediaItemIds: [mediaItemId], mediaType: 'album', limit: 1 },
        options: {},
        confirmBroadRun: false,
      },
      null,
    )
  }

  async function fixtureAlbumJob(mediaItemId: string) {
    const { getJob, processQueuedJobs } = await import('@/services/jobs')
    const job = await queueFixtureAlbum(mediaItemId)
    await processQueuedJobs()
    return getJob(job.id)
  }

  it('saves the first album artist before the album lookup and reuses its current same-provider payload', async () => {
    await seedArtistAlbum('next-album')
    const related = { id: 'related-artist', name: 'Related Artist' }
    const fromId = { id: 'identified-artist', name: 'Identified Artist' }
    const duplicates = [
      { id: 'dupe-first', name: 'Duplicate Artist' },
      { id: 'dupe-second', name: 'DUPLICATE ARTIST' },
    ]
    await databaseClient
      .insert(schema.artist)
      .values([related, fromId, ...duplicates])
    await seedArtistAlbum('related-album', related.id)
    await seedArtistAlbum('identified-album', fromId.id)
    for (const { id } of duplicates) await seedArtistAlbum(id + '-album', id)
    const payload = { releases: ['fixture-release'] }
    fixtureArtist.mockImplementation(async ({ artist, request }) => {
      expect(artist).toEqual({ id: artistId, name: artistName })
      await request('https://example.test/artist')
      return {
        payload,
        profile: {
          tags: ['Ambient'],
          externalId: 'saved-artist-id',
          similarArtists: [
            { name: related.name },
            { name: 'No local credit' },
            { name: 'Alternate source name', externalId: 'identified-id' },
            { name: fromId.name, externalId: 'conflicting-id' },
            { name: 'duplicate artist' },
          ],
        },
      }
    })
    fixtureAlbum.mockImplementation(async ({ request, artistProfiles }) => {
      expect(artistProfiles).toEqual([{ artistId, name: artistName, payload }])
      const state =
        await databaseClient.query.artistProviderCurrentState.findFirst({
          where: (table, operators) =>
            operators.and(
              operators.eq(table.provider, fixturePlugin.manifest.id),
              operators.eq(table.artistId, artistId),
            ),
        })
      expect(state?.artistId).toBe(artistId)
      await request('https://example.test/album')
      return PluginResultSchema.parse({ payload: { album: 'fixture' } })
    })
    const prior = [
      {
        id: 'different-provider',
        artistId,
        provider: 'musicbrainz',
        normalizedData: { tags: [] },
        payload: { releases: ['different-release'] },
      },
      {
        id: 'known-provider-identity',
        artistId: fromId.id,
        provider: fixturePlugin.manifest.id,
        normalizedData: { tags: [], externalId: 'identified-id' },
        payload: {},
      },
    ]
    await databaseClient.insert(schema.artistProviderSnapshot).values(prior)
    await databaseClient.insert(schema.artistProviderCurrentState).values(
      prior.map((snapshot) => ({
        artistId: snapshot.artistId,
        provider: snapshot.provider,
        latestSnapshotId: snapshot.id,
      })),
    )
    request.mockImplementation(async () => Response.json({}))
    const { getJob, processQueuedJobs } = await import('@/services/jobs')
    const firstQueued = await queueFixtureAlbum('album-fixture')
    const secondQueued = await queueFixtureAlbum('next-album')
    await processQueuedJobs()
    const first = await getJob(firstQueued.id)
    const second = await getJob(secondQueued.id)
    expect(first?.status).toBe('succeeded')
    expect(second?.status).toBe('succeeded')
    expect(fixtureArtist).toHaveBeenCalledOnce()
    expect(
      request.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual(['/artist', '/album', '/album'])
    const { listArtistSourceSnapshots } =
      await import('@/services/artist-profiles')
    expect(
      await listArtistSourceSnapshots(artistId, fixturePlugin.manifest.id, {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({ items: [{ jobId: firstQueued.id }] })
    const snapshots = (
      await databaseClient
        .select()
        .from(schema.artistProviderSnapshot)
        .where(
          eq(schema.artistProviderSnapshot.provider, fixturePlugin.manifest.id),
        )
    ).filter((snapshot) => snapshot.artistId === artistId)
    expect(snapshots).toMatchObject([
      {
        scrapeJobId: first?.id,
        normalizedData: {
          tags: ['Ambient'],
          similarArtists: [
            { name: related.name, artistId: related.id },
            { name: 'No local credit' },
            {
              name: 'Alternate source name',
              externalId: 'identified-id',
              artistId: fromId.id,
            },
            { name: fromId.name, externalId: 'conflicting-id' },
            { name: 'duplicate artist' },
          ],
        },
      },
    ])
    const { getArtist } = await import('@/services/creators')
    expect(
      (await getArtist(artistId)).providers.find(
        (snapshot) => snapshot.provider === fixturePlugin.manifest.id,
      )?.profile.relationships,
    ).toEqual([
      {
        kind: 'similar',
        targetType: 'artist',
        name: related.name,
        targetId: related.id,
      },
      { kind: 'similar', targetType: 'artist', name: 'No local credit' },
      {
        kind: 'similar',
        targetType: 'artist',
        name: 'Alternate source name',
        externalId: 'identified-id',
        targetId: fromId.id,
      },
      {
        kind: 'similar',
        targetType: 'artist',
        name: fromId.name,
        externalId: 'conflicting-id',
      },
      { kind: 'similar', targetType: 'artist', name: 'duplicate artist' },
    ])
  })

  it.each([
    new ProviderItemNotFoundError('No confirmed artist match'),
    new ProviderArtistSearchAmbiguousError(),
  ])(
    'continues with album fallback after a definitive artist lookup miss',
    async (error) => {
      fixtureArtist.mockRejectedValue(error)
      request.mockImplementation(async () => Response.json({}))
      expect((await fixtureAlbumJob('album-fixture'))?.status).toBe('succeeded')
      expect(fixtureAlbum).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          artistProfiles: [],
        }),
      )
      expect(
        await databaseClient.select().from(schema.artistProviderSnapshot),
      ).toEqual([])
    },
  )

  it('stops before album lookup when the shared artist request receives a rate limit', async () => {
    fixtureArtist.mockImplementation(async ({ request }) => {
      await request('https://example.test/artist')
      return { payload: {}, profile: { tags: [] } }
    })
    request.mockImplementation(
      async () =>
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '60' },
        }),
    )
    expect((await fixtureAlbumJob('album-fixture'))?.status).toBe('failed')
    expect(request).toHaveBeenCalledOnce()
    expect(fixtureAlbum).not.toHaveBeenCalled()
    expect(
      await databaseClient.select().from(schema.artistProviderSnapshot),
    ).toEqual([])
  })

  it.each(['available', 'absent', 'expired'])(
    'uses the paired transport exclusively when it is %s',
    async (state) => {
      const { processQueuedJobById, getJob } = await import('@/services/jobs')
      const { withProviderTransport } =
        await import('@/services/provider-transport')
      const job = await queueFixtureAlbum('album-fixture')
      fixtureArtist.mockImplementation(async ({ request }) => {
        await request('https://example.test/artist')
        return { payload: {}, profile: { tags: [] } }
      })
      const execute = vi.fn(async () => {
        if (state === 'expired')
          throw new ProviderRequestError(
            'Fixture worker request expired',
            'request-failed',
            null,
            true,
          )
        return Response.json({})
      })
      const local = fixturePlugin.manifest.localWorkerRequired
      fixturePlugin.manifest.localWorkerRequired = true
      try {
        await withProviderTransport(
          async () => (state === 'absent' ? null : { execute }),
          () =>
            processQueuedJobById(job.id, fixturePlugin.manifest.id, {
              canContinue: async () => true,
              recordOutcome: async () => {},
            }),
        )
      } finally {
        fixturePlugin.manifest.localWorkerRequired = local
      }
      expect(request).not.toHaveBeenCalled()
      expect((await getJob(job.id))?.status).toBe(
        state === 'available' ? 'succeeded' : 'failed',
      )
      expect(execute).toHaveBeenCalledTimes(
        state === 'available' ? 2 : state === 'expired' ? 1 : 0,
      )
      expect(fixtureAlbum).toHaveBeenCalledTimes(state === 'available' ? 1 : 0)
    },
  )

  it('projects artist and album relationships from the current source snapshots and retains history', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { processQueuedJobs } = await import('@/services/jobs')
    const { getArtist } = await import('@/services/creators')
    const { getAlbumDetail } = await import('@/services/media')
    const { getArtistSourceSnapshot } =
      await import('@/services/artist-profiles')
    const { getMediaSourceSnapshot } = await import('@/services/history')
    const { applyProviderResult } = await import('@/services/provider-state')
    const provider = fixturePlugin.manifest.id
    const candidates = [
      {
        kind: 'similar',
        targetType: 'album',
        name: 'Preferred edition',
        externalId: 'shared-id',
        referenceType: 'edition',
      },
      {
        kind: 'similar',
        targetType: 'album',
        name: 'Ambiguous edition',
        externalId: 'shared-id',
      },
      {
        kind: 'similar',
        targetType: 'album',
        name: 'Unrelated provider',
        externalId: 'other-provider',
      },
      {
        kind: 'similar',
        targetType: 'album',
        name: 'Archived album',
        externalId: 'archived-id',
      },
      { kind: 'similar', targetType: 'album', name: 'Name-only album' },
      { kind: 'similar', targetType: 'artist', name: 'Another Artist' },
    ] satisfies EntityRelationshipCandidate[]
    const second = { id: 'another-artist', name: 'Another Artist' }
    await databaseClient.insert(schema.artist).values(second)
    await seedArtistAlbum('target-album', second.id)
    await seedArtistAlbum('other-album')
    await seedArtistAlbum('archived-album')
    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(eq(schema.mediaItem.id, 'archived-album'))
    await databaseClient.insert(schema.providerReference).values([
      {
        id: 'target-reference',
        mediaItemId: 'target-album',
        provider,
        referenceType: 'edition',
        externalId: 'shared-id',
      },
      {
        id: 'other-reference',
        mediaItemId: 'other-album',
        provider,
        referenceType: 'release',
        externalId: 'shared-id',
      },
      {
        id: 'unrelated-reference',
        mediaItemId: 'target-album',
        provider: 'unrelated',
        referenceType: 'edition',
        externalId: 'other-provider',
      },
      {
        id: 'archived-reference',
        mediaItemId: 'archived-album',
        provider,
        referenceType: 'edition',
        externalId: 'archived-id',
      },
    ])
    const related = candidates.map((candidate) =>
      candidate.referenceType === 'edition'
        ? { ...candidate, targetId: 'target-album' }
        : candidate.targetType === 'artist'
          ? { ...candidate, targetId: second.id }
          : candidate,
    )
    const artistJob = await enqueueArtistEnrichment(
      { artistId, provider },
      null,
    )
    fixtureArtist.mockResolvedValue({
      payload: {},
      profile: { tags: [], relationships: candidates },
    })
    await processQueuedJobs()
    const [artistSource] = (await getArtist(artistId)).providers
    expect(artistSource).toMatchObject({
      provider,
      scrapeJobId: artistJob.id,
      profile: { relationships: related },
    })
    expect(artistSource?.profile.relationships).toEqual(related)
    expect(artistSource?.id).toBeDefined()
    if (!artistSource) throw new Error('Missing artist source')
    const artistHistory = await getArtistSourceSnapshot(
      artistId,
      provider,
      artistSource.id,
    )
    expect(artistHistory.normalizedData).toMatchObject({
      relationships: candidates,
    })
    expect(JSON.stringify(artistHistory.normalizedData)).not.toContain(
      'targetId',
    )

    async function saveAlbumRelationships(relationships: typeof candidates) {
      const result = PluginResultSchema.parse({
        payload: {},
        normalized: { relationships },
      })
      await applyProviderResult({
        ...result,
        provider,
        mediaType: 'album',
        mediaItemId: 'album-fixture',
        source: 'scrape-job',
      })
    }
    await saveAlbumRelationships(candidates)
    const album = await getAlbumDetail('album-fixture')
    const [source] = album?.relationshipSources ?? []
    expect(source).toMatchObject({ provider, relationships: related })
    expect(source?.relationships).toEqual(related)
    if (!source) throw new Error('Missing album source')
    await databaseClient
      .update(schema.mediaItem)
      .set({ metadata: { legacyHidden: true } })
      .where(eq(schema.mediaItem.id, 'target-album'))
    expect(
      (await getAlbumDetail('album-fixture'))?.relationshipSources?.[0]
        ?.relationships[0],
    ).toEqual(candidates[0])
    expect(
      (await getArtist(artistId)).providers[0]?.profile.relationships?.[0],
    ).toEqual(candidates[0])
    await saveAlbumRelationships([])
    expect(
      (await getAlbumDetail('album-fixture'))?.relationshipSources,
    ).toEqual([])
    const history = await getMediaSourceSnapshot(
      'album-fixture',
      provider,
      source.snapshotId,
    )
    expect(history.normalizedData).toMatchObject({ relationships: candidates })
    expect(JSON.stringify(history.normalizedData)).not.toContain('targetId')
  })

  it('queues an explicit artist job for a plugin and exposes saved source provenance', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobs } = await import('@/services/jobs')
    const { getArtist } = await import('@/services/creators')
    const { listArtistIdentifierSources } =
      await import('@/services/artist-provider-evidence')
    const provider = fixturePlugin.manifest.id
    const providerArtistId = 'confirmed-fixture-id'
    const url = 'https://example.test/artist/confirmed-fixture-id'
    fixtureArtist.mockResolvedValue({
      payload: { result: 'fixture' },
      profile: { externalId: providerArtistId, url, tags: ['Ambient'] },
    })
    const job = await enqueueArtistEnrichment(
      { provider, artistId, providerArtistId },
      null,
    )
    await processQueuedJobs()
    expect((await getJob(job.id))?.status).toBe('succeeded')
    expect(fixtureArtist).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ providerArtistId }),
    )
    expect((await getArtist(artistId)).identifiers).toContainEqual({
      provider,
      externalId: providerArtistId,
      status: 'confirmed',
      url,
    })
    expect(
      await listArtistIdentifierSources(artistId, provider, {
        page: 1,
        size: 10,
      }),
    ).toMatchObject({
      totalCount: 1,
      items: [{ jobId: job.id, externalId: providerArtistId }],
    })
    await expect(
      enqueueArtistEnrichment({ provider: 'youtube', artistId }, null),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    expect(fixtureAlbum).not.toHaveBeenCalled()
  })

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

  it('identifies an otherwise ambiguous Spotify artist from two distinct recordings', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { getJob, processQueuedJobs } = await import('@/services/jobs')
    for (const recording of spotifyRecordings)
      await seedArtistRecording(
        recording.spotifyTrackId,
        recording.spotifyTrackId,
        recording.title,
      )
    const profile = { id: spotifyArtistId, name: artistName, type: 'artist' }
    request.mockImplementation(async (url) => {
      const requestUrl = new URL(String(url))
      const path = requestUrl.pathname
      if (path === '/api/token')
        return Response.json({
          access_token: 'fixture-token',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      if (path === '/v1/search')
        return Response.json({
          artists: {
            total: 2,
            items: [profile, { ...profile, id: duplicateSpotifyArtistId }],
          },
        })
      if (path === '/v1/artists/' + spotifyArtistId)
        return Response.json(profile)
      const recording = spotifyRecordings.find(
        ({ spotifyTrackId }) => path === '/v1/tracks/' + spotifyTrackId,
      )
      if (recording) {
        expect(requestUrl.searchParams.get('market')).toBe('AU')
        return Response.json({
          id: recording.spotifyTrackId,
          name: recording.title,
          artists: [
            { id: duplicateSpotifyArtistId, name: 'Fixture Collaborator' },
            profile,
          ],
        })
      }
      throw new Error('Unexpected request')
    })
    const queued = await enqueueArtistEnrichment(
      { provider: 'spotify', artistId },
      null,
    )
    await processQueuedJobs()
    expect(await getJob(queued.id)).toMatchObject({ status: 'succeeded' })
    expect(
      request.mock.calls.map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      '/api/token',
      ...spotifyRecordings
        .slice(0, 2)
        .map(({ spotifyTrackId }) => '/v1/tracks/' + spotifyTrackId),
      '/v1/artists/' + spotifyArtistId,
    ])
    const [snapshot] = await databaseClient
      .select()
      .from(schema.artistProviderSnapshot)
    expect(snapshot).toMatchObject({
      artistId,
      scrapeJobId: queued.id,
      normalizedData: { externalId: spotifyArtistId },
      payload: {
        artist: profile,
        recordingVerification: spotifyRecordings
          .slice(0, 2)
          .map((recording) => ({ ...recording, artistId: spotifyArtistId })),
      },
    })
    expect(
      await databaseClient.select().from(schema.libraryTrack),
    ).toHaveLength(3)
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
