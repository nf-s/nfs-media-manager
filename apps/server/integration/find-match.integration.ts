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
import { eq } from 'drizzle-orm'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import { discogsPlugin } from '@/plugins/builtin/discogs'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'
import { musicbrainzPlugin } from '@/plugins/builtin/musicbrainz'
import * as schema from '@/schemas/db'

vi.mock('@/lib/load-workspace-env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/load-workspace-env')>()),
  loadWorkspaceEnv: () => {},
}))

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
const discogsFixturePlugin = {
  ...discogsPlugin,
  manifest: {
    ...discogsPlugin.manifest,
    rateLimit: { ...discogsPlugin.manifest.rateLimit, minTimeMs: 0 },
  },
}
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  getScrapePlugin: async (id: string) => {
    if (id === 'musicbrainz') return fixturePlugin
    if (id === 'discogs') return discogsFixturePlugin
    if (id === 'lastfm') return lastfmPlugin
    return null
  },
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    token: 'discogs-fixture-token',
    apiKey: 'fixture-lastfm',
    username: 'fixture-listener',
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
  it('previews an alternate album tracklist through the request gate without saving data or sending a username', async () => {
    const { previewAlbumCandidate } =
      await import('@/services/album-candidate-preview')
    const url = 'https://www.last.fm/music/Fixture+Artist/Alternate'
    request.mockResolvedValueOnce(
      Response.json({
        album: {
          name: 'Alternate',
          artist: 'Fixture Artist',
          url,
          tracks: { track: [{ name: 'First Track', duration: '200' }] },
        },
      }),
    )
    const result = await previewAlbumCandidate({
      albumId,
      provider: 'lastfm',
      referenceType: 'url',
      externalId: url,
    })
    expect(result).toEqual({
      title: 'Alternate',
      artists: ['Fixture Artist'],
      url,
      date: null,
      masterId: null,
      mainReleaseId: null,
      trackCount: 1,
      tracks: [{ position: 1, title: 'First Track', durationSec: 200 }],
    })
    expect(request).toHaveBeenCalledTimes(1)
    const outgoing = new URL(String(request.mock.calls[0]?.[0]))
    expect(outgoing.searchParams.get('method')).toBe('album.getInfo')
    expect(outgoing.searchParams.has('username')).toBe(false)
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(0)
    expect(
      await databaseClient.select().from(schema.providerReference),
    ).toHaveLength(0)
    await databaseClient.insert(schema.mediaOverride).values({
      id: 'fixture-match-rejection',
      mediaItemId: albumId,
      field: 'albumMatchRejection',
      value: {
        provider: 'lastfm',
        sourceProvider: 'lastfm',
        snapshotId: 'archive',
        referenceType: 'url',
        identifier: url,
      },
    })
    await expect(
      previewAlbumCandidate({
        albumId,
        provider: 'lastfm',
        referenceType: 'url',
        externalId: url,
      }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValueOnce(
      Response.json({
        album: { name: 'Alternate', artist: 'Fixture Artist', url },
      }),
    )
    await expect(
      previewAlbumCandidate({
        albumId,
        provider: 'lastfm',
        referenceType: 'url',
        externalId: url + '+edition',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 409 } })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('returns Discogs master and main release IDs with the inspected track names', async () => {
    const { previewAlbumCandidate } =
      await import('@/services/album-candidate-preview')
    const artist = { id: 3, name: 'Fixture Artist' }
    const record = {
      title: 'Album Fixture',
      artists: [artist],
      tracklist: [
        {
          position: 'A1',
          type_: 'track',
          title: 'First Track',
          duration: '3:10',
        },
      ],
    }
    request.mockResolvedValueOnce(
      Response.json({ ...record, id: 11, main_release: 22, year: 2020 }),
    )
    request.mockResolvedValueOnce(
      Response.json({ ...record, id: 22, master_id: 11 }),
    )
    const result = await previewAlbumCandidate({
      albumId,
      provider: 'discogs',
      referenceType: 'master',
      externalId: '11',
    })
    expect(result).toMatchObject({
      title: 'Album Fixture',
      masterId: '11',
      mainReleaseId: '22',
      date: '2020',
      tracks: [{ title: 'First Track', durationSec: 190 }],
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(
      await databaseClient.select().from(schema.providerSnapshot),
    ).toHaveLength(0)
  })

  it('keeps rejected evidence through a concurrent refresh and retries with a different exact match', async () => {
    const { rejectAlbumMatch } =
      await import('@/services/album-match-rejections')
    const { createJob, getJob, retryJob } = await import('@/services/jobs')
    const { patchAlbum } = await import('@/services/media')
    const reference = (externalId: string) => ({
      provider: 'musicbrainz',
      referenceType: 'release-group',
      externalId,
    })
    const releaseGroup = (id: string) => ({
      id,
      title: 'Album Fixture',
      'artist-credit': [{ artist: { id: firstMbid, name: artistName } }],
    })
    const enqueue = () =>
      createJob(
        CreateJobSchema.parse({
          provider: 'musicbrainz',
          scope: { mediaItemIds: [albumId] },
          options: { force: true },
        }),
        null,
      )
    await databaseClient.insert(schema.providerReferenceOverride).values({
      ...reference(firstMbid),
      id: 'prior-override',
      mediaItemId: albumId,
      createdAt: new Date('2001-01-01T00:00:00Z'),
    })
    await patchAlbum(
      albumId,
      { referenceOverrides: [reference(groupMbid)] },
      null,
    )
    const initial = await enqueue()
    request.mockResolvedValueOnce(Response.json(releaseGroup(groupMbid)))
    await runJob(initial.id)
    const original = await databaseClient.query.providerSnapshot.findFirst({
      where: eq(schema.providerSnapshot.scrapeJobId, initial.id),
    })
    if (!original) throw new Error('Expected original fixture snapshot.')

    const queued = await enqueue()
    let finishRequest = () => {}
    const requestHold = new Promise<void>((resolve) => {
      finishRequest = resolve
    })
    request.mockImplementationOnce(async () => {
      await requestHold
      return Response.json(releaseGroup(groupMbid))
    })
    const pending = runJob(queued.id)
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
      await rejectAlbumMatch(
        albumId,
        {
          provider: 'musicbrainz',
          sourceProvider: 'musicbrainz',
          snapshotId: original.id,
          referenceType: 'release-group',
          identifier: groupMbid,
        },
        null,
      )
    } finally {
      finishRequest()
      await pending
    }
    expect(await getJob(queued.id)).toMatchObject({
      status: 'failed',
      errorMessage: expect.stringContaining('previously rejected'),
    })
    await expect(
      patchAlbum(albumId, { referenceOverrides: [reference(groupMbid)] }, null),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        message: expect.stringContaining('previously rejected'),
      },
    })

    const onlyRejected = await retryJob(queued.id, null)
    request.mockResolvedValueOnce(
      Response.json({ count: 1, 'release-groups': [releaseGroup(groupMbid)] }),
    )
    await runJob(onlyRejected.id)
    expect(await getJob(onlyRejected.id)).toMatchObject({ status: 'failed' })
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [original],
    )

    const replacement = await retryJob(onlyRejected.id, null)
    request
      .mockResolvedValueOnce(
        Response.json({
          count: 2,
          'release-groups': [releaseGroup(groupMbid), releaseGroup(secondMbid)],
        }),
      )
      .mockResolvedValueOnce(Response.json(releaseGroup(secondMbid)))
    await runJob(replacement.id)
    expect(await getJob(replacement.id)).toMatchObject({ status: 'succeeded' })
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshots).toHaveLength(2)
    expect(snapshots).toEqual(
      expect.arrayContaining([
        original,
        expect.objectContaining({ scrapeJobId: replacement.id }),
      ]),
    )
    expect(
      await databaseClient.select().from(schema.providerReference),
    ).toEqual([
      expect.objectContaining({
        ...reference(secondMbid),
        mediaItemId: albumId,
      }),
    ])
    expect(
      request.mock.calls.slice(2).map(([url]) => new URL(String(url)).pathname),
    ).toEqual([
      '/ws/2/release-group/',
      '/ws/2/release-group/',
      `/ws/2/release-group/${secondMbid}`,
    ])
  })

  it('keeps bounded Discogs matches in review without tripping the provider stop', async () => {
    const { createJob, getJob, processQueuedJobById } =
      await import('@/services/jobs')
    const { getProviderSafety } = await import('@/services/provider-requests')
    const recordOutcome = vi.fn(async () => {})
    const execute = async () => {
      const job = await createJob(
        CreateJobSchema.parse({
          provider: 'discogs',
          scope: { mediaItemIds: [albumId] },
        }),
        null,
      )
      await processQueuedJobById(job.id, 'discogs', {
        canContinue: async () => true,
        recordOutcome,
      })
      return getJob(job.id)
    }

    for (let index = 0; index < 5; index += 1) {
      request.mockResolvedValueOnce(
        Response.json({
          pagination: { items: 6 },
          results: [
            { id: 11, type: 'master', title: 'Artist Fixture - Album Fixture' },
          ],
        }),
      )
      const failed = await execute()
      expect(failed).toMatchObject({
        status: 'failed',
        summary: { actions: ['find-match', 'retry'] },
      })
      expect(failed?.logs).toContainEqual(
        expect.objectContaining({
          level: 'error',
          canMarkBenign: false,
          metadata: expect.objectContaining({
            classification: 'ambiguous',
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ stage: 'discogs.response' }),
            ]),
          }),
        }),
      )
    }
    expect(recordOutcome).not.toHaveBeenCalled()
    expect(await getProviderSafety('discogs')).toMatchObject({
      consecutiveFailures: 0,
      cooldownUntil: null,
      halted: false,
    })
    expect(request).toHaveBeenCalledTimes(5)
    expect(
      await databaseClient
        .select()
        .from(schema.providerSnapshot)
        .where(eq(schema.providerSnapshot.provider, 'discogs')),
    ).toEqual([])

    request.mockResolvedValueOnce(
      Response.json({ message: 'Fixture service error' }, { status: 500 }),
    )
    expect((await execute())?.status).toBe('failed')
    expect(recordOutcome).toHaveBeenCalledExactlyOnceWith('stopped')
    expect(await getProviderSafety('discogs')).toMatchObject({
      consecutiveFailures: 1,
      cooldownUntil: expect.any(String),
      halted: false,
    })
  })

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
