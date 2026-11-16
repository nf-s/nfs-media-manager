import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
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
import { CreateJobSchema } from '@repo/schemas/job'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import * as schema from '@/schemas/db'

const database = 'find_match_' + randomUUID().replaceAll('-', '')
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
const fixturePlugin = {
  ...musicbrainzPlugin,
  manifest: {
    ...musicbrainzPlugin.manifest,
    rateLimit: { ...musicbrainzPlugin.manifest.rateLimit, minTimeMs: 0 },
  },
}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  getScrapePlugin: async (id: string) =>
    id === 'musicbrainz' ? fixturePlugin : null,
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
const albumId = 'album-fixture'
const firstMbid = '11111111-1111-4111-8111-111111111111'
const secondMbid = '22222222-2222-4222-8222-222222222222'
const groupMbid = '33333333-3333-4333-8333-333333333333'

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
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient
    .insert(schema.artist)
    .values({ id: artistId, name: artistName })
  await databaseClient.insert(schema.mediaItem).values({
    id: albumId,
    slug: albumId,
    title: 'Album Fixture',
    mediaType: 'album',
  })
  await databaseClient.insert(schema.album).values({ mediaItemId: albumId })
  await databaseClient
    .insert(schema.mediaCredit)
    .values({ mediaItemId: albumId, artistId, role: 'artist' })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query('drop database ' + database)
  await admin.end()
  vi.unstubAllGlobals()
})

async function runJob(id: string) {
  const { processQueuedJobById } = await import('@/services/jobs')
  await processQueuedJobById(id, 'musicbrainz', {
    canContinue: async () => true,
    recordOutcome: async () => {},
  })
}

describe('find match', () => {
  it('lists the artists an ambiguous lookup kept without a new request', async () => {
    const { enqueueArtistEnrichment } =
      await import('@/services/artist-enrichment')
    const { listUnresolvedMatches } = await import('@/services/find-match')
    const job = await enqueueArtistEnrichment(
      { artistId, provider: 'musicbrainz' },
      null,
    )
    request.mockResolvedValueOnce(
      Response.json({
        count: 2,
        artists: [
          { id: firstMbid, name: artistName, disambiguation: 'Band' },
          { id: secondMbid, name: artistName },
        ],
      }),
    )
    await runJob(job.id)
    expect(request).toHaveBeenCalledTimes(1)
    expect(
      await listUnresolvedMatches({ kind: 'artist', id: artistId }),
    ).toEqual({
      query: artistName,
      items: [
        {
          provider: 'musicbrainz',
          jobId: job.id,
          outcome: 'ambiguous',
          candidates: [
            {
              referenceType: 'artist',
              externalId: firstMbid,
              title: artistName,
              subtitle: 'Band',
              releaseDate: null,
              artworkUrl: null,
              url: `https://musicbrainz.org/artist/${firstMbid}`,
              current: false,
            },
            expect.objectContaining({
              externalId: secondMbid,
              subtitle: null,
            }),
          ],
        },
      ],
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(await listUnresolvedMatches({ kind: 'album', id: albumId })).toEqual(
      { query: null, items: [] },
    )
  })

  it('reports an album lookup that found nothing until a newer job replaces it', async () => {
    const { createJob } = await import('@/services/jobs')
    const { listUnresolvedMatches } = await import('@/services/find-match')
    const job = await createJob(
      CreateJobSchema.parse({
        provider: 'musicbrainz',
        scope: { mediaItemIds: [albumId] },
      }),
      null,
    )
    request.mockResolvedValueOnce(
      Response.json({ count: 0, 'release-groups': [] }),
    )
    await runJob(job.id)
    expect(await listUnresolvedMatches({ kind: 'album', id: albumId })).toEqual(
      {
        query: `${artistName} Album Fixture`,
        items: [
          {
            provider: 'musicbrainz',
            jobId: job.id,
            outcome: 'not-found',
            candidates: [],
          },
        ],
      },
    )
    await createJob(
      CreateJobSchema.parse({
        provider: 'musicbrainz',
        scope: { mediaItemIds: [albumId] },
      }),
      null,
    )
    expect(await listUnresolvedMatches({ kind: 'album', id: albumId })).toEqual(
      { query: null, items: [] },
    )
    const missing = {
      response: { statusCode: 404, message: 'Item not found.' },
    }
    await expect(
      listUnresolvedMatches({ kind: 'album', id: 'missing-album' }),
    ).rejects.toMatchObject(missing)
    await expect(
      listUnresolvedMatches({ kind: 'film', id: albumId }),
    ).rejects.toMatchObject(missing)
    await expect(
      listUnresolvedMatches({ kind: 'artist', id: 'missing-artist' }),
    ).rejects.toMatchObject(missing)
  })

  it('searches through the request policy and records the request', async () => {
    const { searchMatchCandidates } = await import('@/services/find-match')
    request.mockResolvedValueOnce(
      Response.json({
        count: 1,
        'release-groups': [
          {
            id: groupMbid,
            title: 'Album Fixture',
            'artist-credit': [{ artist: { id: firstMbid, name: artistName } }],
          },
        ],
      }),
    )
    await databaseClient.insert(schema.providerReferenceOverride).values({
      id: 'override-fixture',
      mediaItemId: albumId,
      provider: 'musicbrainz',
      referenceType: 'release-group',
      externalId: groupMbid,
    })
    const result = await searchMatchCandidates({
      kind: 'album',
      id: albumId,
      provider: 'musicbrainz',
    })
    expect(result).toMatchObject({
      query: `${artistName} Album Fixture`,
      items: [{ externalId: groupMbid, subtitle: artistName, current: true }],
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toMatchObject([{ provider: 'musicbrainz' }])
  })

  it('refuses while the provider is cooling down or halted, without a request', async () => {
    const { searchMatchCandidates } = await import('@/services/find-match')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'musicbrainz',
      cooldownUntil: new Date(Date.now() + 3600000),
    })
    const refusal = await searchMatchCandidates({
      kind: 'artist',
      id: artistId,
      provider: 'musicbrainz',
    }).catch((error: unknown) => error)
    if (!(refusal instanceof ServerError)) throw new Error('Expected refusal')
    expect(refusal.response).toMatchObject({
      statusCode: 422,
      message: expect.stringMatching(/cooldown/i),
    })
    await databaseClient
      .update(schema.providerRequestState)
      .set({ cooldownUntil: null, halted: true })
    await expect(
      searchMatchCandidates({
        kind: 'album',
        id: albumId,
        provider: 'musicbrainz',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    expect(request).not.toHaveBeenCalled()
    expect(
      await databaseClient.select().from(schema.providerRequestEvent),
    ).toEqual([])
  })
})
