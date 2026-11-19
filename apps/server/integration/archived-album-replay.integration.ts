import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import pg from 'pg'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PluginResultSchema } from '@repo/media-plugin-sdk'
import { z } from 'zod'
import {
  archiveSha256,
  ArchivedAlbumReplayPlanSchema,
} from '@/lib/archived-album-replay'
import { checksumJson } from '@/lib/media-utils'
import { nativeProviderReplayRequestKey } from '@/lib/provider-response-history'
import * as schema from '@/schemas/db'

const run = promisify(execFile)
const adminUrl = process.env.DATABASE_URL
const fixtureId = 'archive_replay_' + randomUUID().replaceAll('-', '')
const albumId = 'fixture-album'
const provider = 'fixture-provider'
const originalJobId = 'fixture-job'
const originalItemId = 'fixture-item'
const spotifyId = 'A1B2C3D4E5F6G7H8I9J0KL'
const body = JSON.stringify({ nearby: '42' })
const browseUrl = 'https://example.test/browse'
const detailUrl = 'https://example.test/detail?id=42'
const date = '1999-01-01'
const finishedAt = new Date('2000-01-01T00:00:00.000Z')
const capturedAt = '2000-01-01T00:05:00.000Z'
const requestUrl = new URL(
  '../scripts/commit-archived-album.ts',
  import.meta.url,
)
const tsconfig = fileURLToPath(new URL('../tsconfig.json', import.meta.url))
const loader = createRequire(import.meta.url).resolve('tsx')
let directory: string
let admin: pg.Client | undefined
let pool: pg.Pool | undefined
let fixtureUrl: URL
let database: ReturnType<typeof drizzle<typeof schema>>

beforeEach(async () => {
  if (!adminUrl || process.platform !== 'darwin') return
  const url = new URL(adminUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search)
    throw new Error(
      'The archived replay fixture requires an isolated loopback PostgreSQL server.',
    )
  directory = await mkdtemp(join(tmpdir(), 'metadata-archive-replay-'))
  admin = new pg.Client({ connectionString: url.href })
  await admin.connect()
  await admin.query(`create database ${fixtureId}`)
  fixtureUrl = new URL(
    fixtureId,
    url.href.slice(0, url.href.lastIndexOf('/') + 1),
  )
  pool = new pg.Pool({ connectionString: fixtureUrl.href })
  database = drizzle(pool, { schema })
  await database.transaction(async (tx) => {
    for (const migration of readMigrationFiles({
      migrationsFolder: './drizzle',
    }))
      for (const statement of migration.sql)
        await tx.execute(sql.raw(statement))
  })
  await database.insert(schema.mediaItem).values([
    {
      id: albumId,
      mediaType: 'album',
      title: 'Fixture Album',
      slug: albumId,
      releaseDate: new Date(date),
    },
    {
      id: 'fixture-track',
      mediaType: 'track',
      title: 'Opening Track',
      slug: 'fixture-track',
    },
  ])
  await database.insert(schema.album).values({ mediaItemId: albumId })
  await database
    .insert(schema.libraryTrack)
    .values({ mediaItemId: 'fixture-track' })
  await database.insert(schema.track).values({
    id: 'fixture-membership',
    albumMediaItemId: albumId,
    trackMediaItemId: 'fixture-track',
    position: 0,
    title: 'Opening Track',
  })
  await database
    .insert(schema.artist)
    .values({ id: 'fixture-artist', name: 'Fixture Artist' })
  await database.insert(schema.mediaCredit).values({
    mediaItemId: albumId,
    artistId: 'fixture-artist',
    role: 'artist',
  })
  const payload = {
    id: spotifyId,
    name: 'Fixture Album',
    artists: [{ name: 'Fixture Artist' }],
    release_date: date,
    release_date_precision: 'day',
    album_type: 'album',
    total_tracks: 1,
    tracks: {
      offset: 0,
      total: 1,
      next: null,
      items: [{ name: 'Opening Track', disc_number: 1, track_number: 1 }],
    },
  }
  await database.insert(schema.providerSnapshot).values({
    id: 'fixture-spotify-snapshot',
    mediaItemId: albumId,
    provider: 'spotify',
    source: 'file-import',
    checksum: 'fixture-spotify',
    payload,
  })
  await database.insert(schema.providerCurrentState).values({
    id: 'fixture-spotify-state',
    mediaItemId: albumId,
    provider: 'spotify',
    latestSnapshotId: 'fixture-spotify-snapshot',
    checksum: 'fixture-spotify',
    status: 'ready',
    payload,
  })
  await database.insert(schema.providerReference).values({
    id: 'fixture-spotify-reference',
    mediaItemId: albumId,
    provider: 'spotify',
    referenceType: 'album',
    externalId: spotifyId,
    isPrimary: true,
  })
  await database.insert(schema.scrapeJob).values({
    id: originalJobId,
    provider,
    status: 'failed',
    scope: { mediaType: 'album', limit: 1, mediaItemIds: [albumId] },
    options: { batchId: 'fixture-batch' },
    errorMessage: 'Saved job failure',
    finishedAt,
  })
  await database.insert(schema.scrapeJobItem).values({
    id: originalItemId,
    jobId: originalJobId,
    mediaItemId: albumId,
    provider,
    status: 'failed',
    attemptCount: 1,
  })
  await database.insert(schema.providerResponse).values({
    id: 'fixture-response',
    jobId: originalJobId,
    jobItemId: originalItemId,
    provider,
    attempt: 1,
    ordinal: 1,
    phase: 'media',
    method: 'GET',
    requestUrl: browseUrl,
    requestKey: nativeProviderReplayRequestKey(browseUrl, false),
    status: 200,
    retry: 1,
    receivedAt: finishedAt,
    contentType: 'application/json',
    bodyState: 'captured',
    retainedBytes: Buffer.byteLength(body),
    body: { state: 'captured', text: body },
  })
})

afterEach(async () => {
  await pool?.end()
  if (admin) {
    await admin.query(`drop database if exists ${fixtureId}`)
    await admin.end()
  }
  if (directory) await rm(directory, { force: true, recursive: true })
})

it.skipIf(!adminUrl || process.platform !== 'darwin').each([
  { originalOnly: false, local: false, reviewed: false },
  { originalOnly: true, local: false, reviewed: false },
  { originalOnly: false, local: true, reviewed: false },
  { originalOnly: true, local: true, reviewed: false },
  { originalOnly: true, local: true, reviewed: true },
])(
  'commits the reviewed native replay once (original-only: $originalOnly, local: $local, reviewed: $reviewed)',
  async ({ originalOnly, local, reviewed }) => {
    const pin = async (name: string, contents: string) => {
      const path = join(directory, name)
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 })
      return { path, sha256: archiveSha256(contents) }
    }
    const artistUrl = 'https://example.test/artist?name=Fixture+Artist'
    const artistBody = JSON.stringify({ miss: true })
    const artistOffset = local ? 1 : 0
    const sdkUrl = new URL(
      '../../../packages/media-plugin-sdk/dist/index.js',
      import.meta.url,
    ).href
    const adapter = await pin(
      'fixture-adapter.mjs',
      `
    import { createServer } from 'node:net'
    import { ProviderItemNotFoundError } from '${sdkUrl}'
    export default {
      manifest: {
        id: 'fixture-provider', displayName: 'Fixture', description: '', mediaTypes: ['album'],
        localWorkerRequired: true,
        localWorker: { origin: 'https://example.test', paths: ['/artist', '/browse', '/detail'], credentialHeaders: [], queryParameters: ['id', 'name'] },
        bootstrapAlbumArtists: ${local},
        rateLimit: { maxConcurrent: 1, minTimeMs: 0 }, secrets: [],
      },
      async scrapeArtist({ request }) {
        const record = await (await request('${artistUrl}', { method: 'GET' }, { requireLocalTransport: true, notFoundOn404: true })).json()
        if (record.miss) throw new ProviderItemNotFoundError('No exact artist match')
        throw Error('The test archive should contain an artist miss')
      },
      async scrapeMediaItem({ request, secrets, artistProfiles, existingReferences }) {
        if (artistProfiles?.length) throw Error('The artist miss should not add a profile')
        if (Object.keys(secrets).length || process.env.DATABASE_URL) throw Error('Unexpected credentials')
        if (process.platform === 'darwin') await new Promise((resolve, reject) => {
          const server = createServer()
          server.on('error', (error) => ['EPERM', 'EACCES'].includes(error.code) ? resolve() : reject(error))
          server.listen(0, '127.0.0.1', () => server.close(() => reject(Error('Child network is enabled'))))
        })
        if (${originalOnly} && !${reviewed}) await (await request('${detailUrl}', { method: 'GET' }, { requireLocalTransport: true, notFoundOn404: true })).json()
        const { id } = ${reviewed}
          ? { id: existingReferences.find(ref => ref.metadata?.sourceProvider === 'fixture-provider')?.externalId }
          : await (await request('${browseUrl}', { method: 'GET' }, { requireLocalTransport: true })).json()
        if (!id) throw Error('The group reference was not supplied')
        const detail = await (await request('https://example.test/detail?id=' + id, { method: 'GET' }, { requireLocalTransport: true, notFoundOn404: true })).json()
        return { payload: detail, normalized: {
          references: [{ referenceType: 'group', externalId: detail.id, isPrimary: true }],
          tags: [{ name: detail.genre, kind: 'genre' }],
          playlists: [{ name: detail.collection, kind: 'collection' }],
        } }
      },
    }
  `,
    )
    const projector = await pin(
      'fixture-projector.mjs',
      `
    export default (source, url) => url.pathname === '/artist'
      ? { miss: source.miss }
      : url.pathname === '/browse'
      ? { id: source.nearby }
      : { id: source.release.group, genre: source.release.genre, collection: source.release.collection }
  `,
    )
    const detail = JSON.stringify({
      release: {
        group: '42',
        genre: 'Fixture Genre',
        collection: 'Fixture Collection',
      },
    })
    const archiveId = randomUUID()
    const requestKey = archiveSha256(detailUrl)
    const sha256 = archiveSha256(detail)
    const browseSha256 = archiveSha256(body)
    const reference = randomUUID()
    const artistSha256 = archiveSha256(artistBody)
    const artistRequestKey = archiveSha256(artistUrl)
    const localReceipt: {
      state: 'local'
      reference: string
      retainedBytes: number
    } = {
      state: 'local',
      reference,
      retainedBytes: Buffer.byteLength(artistBody),
    }
    let localArchive
    if (local) {
      const file = await pin(
        reference + '.json',
        JSON.stringify({
          version: 1,
          id: reference,
          action: 'artist',
          status: 200,
          capturedAt: +finishedAt,
          requestKey: artistRequestKey,
          retainedBytes: localReceipt.retainedBytes,
          sha256: artistSha256,
          redacted: false,
          text: artistBody,
        }),
      )
      localArchive = {
        archiveId: reference,
        file,
        requestKey: artistRequestKey,
      }
      await database
        .update(schema.providerResponse)
        .set({ ordinal: 2 })
        .where(eq(schema.providerResponse.id, 'fixture-response'))
      await database.insert(schema.providerResponse).values({
        id: 'fixture-artist-response',
        jobId: originalJobId,
        jobItemId: originalItemId,
        provider,
        artistId: 'fixture-artist',
        attempt: 1,
        ordinal: 1,
        phase: 'artist',
        method: 'GET',
        requestUrl: 'https://example.test/artist',
        requestKey: nativeProviderReplayRequestKey(artistUrl, true),
        status: 200,
        retry: 1,
        receivedAt: finishedAt,
        contentType: 'application/json',
        bodyState: 'local',
        retainedBytes: localReceipt.retainedBytes,
        body: localReceipt,
      })
    }
    const planScope = {
      jobId: originalJobId,
      jobItemId: originalItemId,
      attempt: 1,
      provider,
      albumId,
      groupId: '42',
      adapter,
      projector,
      dependencies: [],
      library: {
        title: 'Fixture Album',
        date,
        artists: ['Fixture Artist'],
        tracks: ['Opening Track'],
      },
      originals: [
        ...(localArchive
          ? [
              {
                responseId: 'fixture-artist-response',
                sha256: artistSha256,
                localArchive,
              },
            ]
          : []),
        { responseId: 'fixture-response', sha256: browseSha256 },
      ],
    }
    const detailRequest = {
      requestUrl: detailUrl,
      archiveRequestKey: requestKey,
      notFoundOn404: true,
    }
    function independentPlan(archiveFile: { path: string; sha256: string }) {
      return {
        ...planScope,
        version: 1,
        anchors: [
          {
            provider: 'spotify',
            referenceType: 'album',
            recordId: spotifyId,
            snapshotId: 'fixture-spotify-snapshot',
            snapshotProvider: 'spotify',
          },
        ],
        supplement: {
          ...detailRequest,
          receiptSha256: archiveSha256('fixture-receipt'),
          archiveId,
          archiveFile,
          capturedAt,
          sha256,
        },
      }
    }
    async function originalPlan() {
      // This source edition has a different date from the library and supplies
      // the complete exact sequence independently of Spotify.
      const payload = {
        master: {
          id: 123,
          title: 'Fixture Album',
          year: 2003,
          artists: [{ name: 'Fixture Artist' }],
          tracklist: [{ title: 'Opening Track', type_: 'track' }],
        },
      }
      if (!reviewed) {
        await database
          .update(schema.providerReference)
          .set({
            provider: 'discogs',
            referenceType: 'master',
            externalId: '123',
          })
          .where(eq(schema.providerReference.mediaItemId, albumId))
        await database
          .update(schema.providerSnapshot)
          .set({ provider: 'discogs', payload })
          .where(eq(schema.providerSnapshot.id, 'fixture-spotify-snapshot'))
        await database
          .update(schema.providerCurrentState)
          .set({ provider: 'discogs', payload })
          .where(eq(schema.providerCurrentState.id, 'fixture-spotify-state'))
      }
      await database
        .update(schema.providerResponse)
        .set({ ordinal: 2 + artistOffset })
        .where(eq(schema.providerResponse.id, 'fixture-response'))
      const detailResponse: Omit<
        typeof schema.providerResponse.$inferInsert,
        'id' | 'ordinal'
      > = {
        jobId: originalJobId,
        jobItemId: originalItemId,
        provider,
        attempt: 1,
        phase: 'media',
        method: 'GET',
        requestUrl: 'https://example.test/detail',
        requestKey: nativeProviderReplayRequestKey(detailUrl, true),
        status: 200,
        retry: 1,
        receivedAt: finishedAt,
        contentType: 'application/json',
        bodyState: 'captured',
        retainedBytes: Buffer.byteLength(detail),
        body: { state: 'captured', text: detail },
      }
      await database.insert(schema.providerResponse).values([
        {
          ...detailResponse,
          id: 'fixture-catalogue-detail',
          ordinal: 1 + artistOffset,
        },
        { ...detailResponse, id: 'fixture-detail', ordinal: 3 + artistOffset },
      ])
      const expected = PluginResultSchema.parse({
        payload: {
          id: '42',
          genre: 'Fixture Genre',
          collection: 'Fixture Collection',
        },
        normalized: {
          references: [
            { referenceType: 'group', externalId: '42', isPrimary: true },
          ],
          tags: [{ name: 'Fixture Genre', kind: 'genre' }],
          playlists: [{ name: 'Fixture Collection', kind: 'collection' }],
        },
      })
      const originalVersion = {
        ...planScope,
        version: 2,
        artistLookups: local
          ? [{ artistId: 'fixture-artist', providerArtistId: null }]
          : [],
        originals: [
          ...planScope.originals.slice(0, artistOffset),
          { responseId: 'fixture-catalogue-detail', sha256 },
          ...planScope.originals.slice(artistOffset),
          { responseId: 'fixture-detail', sha256 },
        ],
        anchors: [
          {
            provider: 'discogs',
            referenceType: 'master',
            recordId: '123',
            snapshotId: 'fixture-spotify-snapshot',
            snapshotProvider: 'discogs',
            evidence: {
              title: 'Fixture Album',
              year: 2003,
              artists: ['Fixture Artist'],
              completeTracks: 1,
            },
          },
        ],
        detail: { ...detailRequest, responseId: 'fixture-detail' },
        reviewedResultSha256: checksumJson(expected),
      }
      if (!reviewed) return originalVersion
      const { artistLookups, ...common } = originalVersion
      expect(artistLookups).toHaveLength(1)
      const anchors = [
        {
          provider: 'spotify',
          referenceType: 'album',
          recordId: spotifyId,
          snapshotId: 'fixture-spotify-snapshot',
          snapshotProvider: 'spotify',
          evidence: {
            title: 'Fixture Album',
            artists: ['Fixture Artist'],
            completeTracks: 1,
          },
        },
      ]
      const decisionSha256 = archiveSha256('fixture reviewed decision')
      const ordinal = 3 + artistOffset
      const evidenceFile = await pin(
        'fixture-evidence.json',
        JSON.stringify({
          version: 1,
          jobId: common.jobId,
          jobItemId: common.jobItemId,
          attempt: common.attempt,
          provider: common.provider,
          albumId: common.albumId,
          groupId: common.groupId,
          decisionSha256,
          anchors,
          reviewedResultSha256: common.reviewedResultSha256,
          detail: {
            responseId: 'fixture-detail',
            ordinal,
            requestKey,
            bodySha256: sha256,
          },
        }),
      )
      return {
        ...common,
        version: 3,
        anchors,
        detail: { ...common.detail, ordinal },
        review: { decisionSha256, evidenceFile },
      }
    }
    const plan = ArchivedAlbumReplayPlanSchema.parse(
      originalOnly
        ? await originalPlan()
        : independentPlan(
            await pin(
              archiveId + '.json',
              JSON.stringify({
                version: 1,
                id: archiveId,
                action: 'detail',
                status: 200,
                capturedAt: Date.parse(capturedAt),
                requestKey,
                retainedBytes: Buffer.byteLength(detail),
                sha256,
                redacted: false,
                text: detail,
              }),
            ),
          ),
    )
    expect(
      ArchivedAlbumReplayPlanSchema.safeParse({ ...plan, normalized: {} })
        .success,
    ).toBe(false)
    const planFile = await pin('fixture-plan.json', JSON.stringify(plan))
    const original = () =>
      database.query.scrapeJob.findFirst({
        where: eq(schema.scrapeJob.id, originalJobId),
      })
    const command = async (
      label: string,
      digest = planFile.sha256,
      path = planFile.path,
      evidenceDigest = plan.version === 3
        ? plan.review.evidenceFile.sha256
        : undefined,
    ) => {
      const output = join(directory, label + '.json')
      await run(
        process.execPath,
        [
          '--import',
          loader,
          fileURLToPath(requestUrl),
          '--plan',
          path,
          '--sha256',
          digest,
          ...(evidenceDigest ? ['--evidence-sha256', evidenceDigest] : []),
          '--output',
          output,
        ],
        {
          cwd: directory,
          env: {
            NODE_ENV: 'test',
            DATABASE_URL: fixtureUrl.href,
            DATABASE_SSL: 'disable',
            TSX_TSCONFIG_PATH: tsconfig,
            BETTER_AUTH_SECRET: 'fixture-better-auth-secret-at-least-32',
            MEDIA_ENCRYPTION_KEY: 'fixture-media-encryption-key-at-least-32',
          },
        },
      )
      return z
        .object({ jobId: z.string(), outcome: z.string() })
        .parse(JSON.parse(await readFile(output, 'utf8')))
    }

    await expect(
      command('wrong-digest', archiveSha256('wrong')),
    ).rejects.toThrow('differs from the digest')
    if (plan.version === 3)
      await expect(
        command(
          'wrong-evidence',
          planFile.sha256,
          planFile.path,
          archiveSha256('wrong evidence'),
        ),
      ).rejects.toThrow('separately approved group evidence digest')
    if (plan.version === 2) {
      const changedResult = await pin(
        'different-result.json',
        JSON.stringify({
          ...plan,
          reviewedResultSha256: archiveSha256('a different normalized result'),
        }),
      )
      await expect(
        command('changed-result', changedResult.sha256, changedResult.path),
      ).rejects.toThrow(
        'The archived adapter output differs from the reviewed release metadata.',
      )
    }
    const response = eq(schema.providerResponse.id, 'fixture-response')
    if (local) {
      const artistResponse = eq(
        schema.providerResponse.id,
        'fixture-artist-response',
      )
      await database
        .update(schema.providerResponse)
        .set({
          body: { ...localReceipt, reference: randomUUID() },
        })
        .where(artistResponse)
      await expect(command('changed-receipt')).rejects.toThrow(
        'A local archive differs from its original response receipt.',
      )
      await database
        .update(schema.providerResponse)
        .set({ body: localReceipt })
        .where(artistResponse)
    }
    await database
      .update(schema.providerResponse)
      .set({ retry: 2 })
      .where(response)
    await expect(command('transport-retry')).rejects.toThrow(
      'An original response differs from the reviewed archive.',
    )
    await database
      .update(schema.providerResponse)
      .set({ retry: 1 })
      .where(response)
    await database
      .update(schema.track)
      .set({ title: 'Different Track' })
      .where(eq(schema.track.id, 'fixture-membership'))
    await expect(command('changed-library')).rejects.toThrow(
      'changed after review',
    )
    expect((await original())?.options.retryJobId).toBeUndefined()
    await database
      .update(schema.track)
      .set({ title: 'Opening Track' })
      .where(eq(schema.track.id, 'fixture-membership'))

    const receipt = await command('committed')
    expect(receipt.outcome).toBe('committed')
    expect(await original()).toMatchObject({
      status: 'failed',
      errorMessage: 'Saved job failure',
      options: { retryJobId: receipt.jobId },
    })
    const replacement = await database.query.scrapeJob.findFirst({
      where: eq(schema.scrapeJob.id, receipt.jobId),
    })
    expect(replacement).toMatchObject({
      status: 'succeeded',
      options: {
        retryOf: originalJobId,
        archivedReplay: originalOnly
          ? {
              detail: {
                origin: 'original-failed-attempt',
                responseId: 'fixture-detail',
                ordinal: 3 + artistOffset,
              },
            }
          : { supplement: { origin: 'independent-reviewed-detail' } },
      },
    })
    if (plan.version === 3)
      expect(replacement?.options.archivedReplay).toMatchObject({
        selectionStrategy: 'reviewed-group',
        evidenceSha256: plan.review.evidenceFile.sha256,
        decisionSha256: plan.review.decisionSha256,
        unusedOriginalResponseIds: [
          'fixture-artist-response',
          'fixture-catalogue-detail',
          'fixture-response',
        ],
      })
    if (originalOnly)
      expect(replacement?.options.archivedReplay).not.toHaveProperty(
        'supplement',
      )
    if (local) {
      expect(replacement?.options.archivedReplay).toMatchObject({
        localOriginals: [
          {
            origin: 'paired-worker-local',
            responseId: 'fixture-artist-response',
            archiveId: reference,
            bodySha256: artistSha256,
            requestKey: artistRequestKey,
          },
        ],
      })
      expect(JSON.stringify(replacement?.options.archivedReplay)).not.toContain(
        directory,
      )
    }
    const responseRows = await database.query.providerResponse.findMany()
    expect(responseRows).toHaveLength((originalOnly ? 3 : 1) + artistOffset)
    if (local)
      expect(responseRows).toContainEqual(
        expect.objectContaining({
          id: 'fixture-artist-response',
          jobId: originalJobId,
          body: localReceipt,
        }),
      )
    expect(responseRows).toContainEqual(
      expect.objectContaining({
        id: 'fixture-response',
        jobId: originalJobId,
        body: { state: 'captured', text: body },
      }),
    )
    expect(responseRows.every(({ jobId }) => jobId === originalJobId)).toBe(
      true,
    )
    expect(
      await database.query.providerSnapshot.findMany({
        where: eq(schema.providerSnapshot.provider, provider),
      }),
    ).toMatchObject([
      {
        source: 'archived-replay',
        scrapeJobId: receipt.jobId,
        payload: { id: '42', genre: 'Fixture Genre' },
      },
    ])
    expect(
      await database.query.providerCurrentState.findFirst({
        where: and(
          eq(schema.providerCurrentState.mediaItemId, albumId),
          eq(schema.providerCurrentState.provider, provider),
        ),
      }),
    ).toMatchObject({
      status: 'ready',
      lastScrapedAt: null,
    })
    expect(await database.query.tagOccurrence.findMany()).toHaveLength(1)
    expect(await database.query.playlist.findMany()).toMatchObject([
      { name: 'Fixture Collection' },
    ])
    expect(await command('idempotent')).toMatchObject({
      outcome: 'already-committed',
      jobId: receipt.jobId,
    })
    expect(await database.query.scrapeJob.findMany()).toHaveLength(2)
  },
)
