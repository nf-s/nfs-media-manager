import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { replayRymTags } from '../scripts/replay-rym-tags'
import { upsertProviderTags } from '@/services/tag-state'

const dbName = 'rym_replay_' + randomUUID().replaceAll('-', '')
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: dbName })
const database = drizzle(pool, { schema })
const release = 'https://rateyourmusic.com/release/album/fixture-artist/record/'
const priorIssue = release.replace('/record/', '/record.p/')
const item = 'zz-test-album'
const provider = 'serply'
let created = false
let directory: string

function snapshot(
  id: string,
  url: string,
  genre: string,
  jobId: string | null,
) {
  return {
    id,
    mediaItemId: item,
    provider,
    source: 'scrape-job',
    checksum: id,
    scrapeJobId: jobId,
    normalizedData: {
      references: [{ referenceType: 'rym-url', externalId: url }],
      mediaPatch: {
        metadata: {
          'plugin.serply.provenance': {
            source: 'rym',
            retrievalProvider: 'serply',
            sourceUrl: url,
            releaseUrl: url.replace('.p/', '/'),
            matchStatus: 'rated',
          },
          browse: { ratingRymValue: 4.35, ratingRymVotes: 111 },
        },
      },
    },
    payload: {
      searches: [
        {
          query: 'fixture',
          response: {
            results: [
              {
                title: 'Record by Fixture Artist (Album, Synthpop)',
                link: url,
                description: `Record, an Album by Fixture Artist. Genres: Synthpop, ${genre}.`,
              },
            ],
          },
        },
      ],
    },
  }
}

beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '::1'].includes(connection.host))
    throw new Error('This test requires loopback Postgres')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Provider networking forbidden')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${dbName}`)
  created = true
  directory = await mkdtemp(join(tmpdir(), 'rym-replay-'))
  const url = new URL(`postgresql://localhost:${connection.port}/${dbName}`)
  url.username = connection.user
  url.password = connection.password
  vi.stubEnv('RYM_REPLAY_DATABASE_URL', url.href)
  await database.transaction(async (tx) => {
    for (const migration of readMigrationFiles({
      migrationsFolder: './drizzle',
    }))
      for (const statement of migration.sql)
        await tx.execute(sql.raw(statement))
  })
  const ids = [item, ...Array.from({ length: 50 }, (_, i) => 'empty-' + i)]
  await database.insert(schema.mediaItem).values(
    ids.map((id): typeof schema.mediaItem.$inferInsert => ({
      id,
      title: 'Library title',
      mediaType: 'album',
      slug: id,
      metadata: {
        browse: { ratingRymValue: 2.15, ratingRymVotes: 222 },
        userData: 'preserve me',
      },
    })),
  )
  await database.insert(schema.scrapeJob).values([
    { id: 'yes', provider, status: 'succeeded', scope: {}, options: {} },
    { id: 'no', provider, status: 'failed', scope: {}, options: {} },
  ])
  const latest = snapshot('current', release, 'Art Pop', 'yes')
  latest.payload.searches.push({
    query: 'more saved headers',
    response: {
      results: [
        {
          title: 'Record by Fixture Artist (Album, Synthpop)',
          link: release,
          description:
            'Genres Ambient Dub, Unproven Pair Descriptors atmospheric, rhythmic.',
        },
      ],
    },
  })
  await database.insert(schema.providerCurrentState).values({
    id: 'vocabulary',
    mediaItemId: 'empty-0',
    provider: 'google-custom-search',
    status: 'ready',
    checksum: 'vocabulary',
    payload: {
      rymGoogle: { genres: ['Ambient Dub', 'Never In The Header'] },
      tags: ['Unproven Pair'],
    },
  })
  await database
    .insert(schema.providerSnapshot)
    .values([
      latest,
      snapshot('different', priorIssue, 'Not This', 'yes'),
      snapshot('failed', release, 'Failed', 'no'),
      snapshot('unconfirmed', release, 'Not Confirmed', null),
      ...Array.from({ length: 51 }, (_, i) =>
        snapshot('old-' + i, release, 'New Wave', 'yes'),
      ),
    ])
  await database.insert(schema.providerCurrentState).values(
    ids.map((id) => ({
      id,
      mediaItemId: id,
      provider,
      status: 'ready',
      lastSuccessfulAt: new Date(),
      checksum: latest.checksum,
      latestSnapshotId: latest.id,
      payload: latest.payload,
      normalizedData: latest.normalizedData,
    })),
  )
  await database.insert(schema.providerReference).values({
    id: 'reference',
    mediaItemId: item,
    provider,
    referenceType: 'rym-url',
    externalId: release,
  })
  await database.insert(schema.providerReferenceOverride).values([
    {
      id: 'old',
      mediaItemId: item,
      provider,
      referenceType: 'rym-url',
      externalId: priorIssue,
      createdAt: new Date('2020-01-01'),
    },
    {
      id: 'new',
      mediaItemId: item,
      provider,
      referenceType: 'rym-url',
      externalId: release,
      createdAt: new Date('2020-01-02'),
    },
  ])
  await database.insert(schema.tag).values({
    id: 'canonical',
    mediaType: 'album',
    kind: 'general',
    name: 'Merged label',
    hidden: true,
  })
  await database.insert(schema.tagIdentity).values({
    tagId: 'canonical',
    mediaType: 'album',
    kind: 'genre',
    normalizedName: 'art pop',
  })
  await database.transaction(async (tx) => {
    await upsertProviderTags(tx, item, 'discogs', 'album', [
      { name: 'Art Pop', kind: 'genre' },
    ])
    await upsertProviderTags(tx, item, provider, 'album', [
      { name: 'Synthpop', source: 'rym', kind: 'genre' },
    ])
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await pool.end()
  if (created) await admin.query(`drop database ${dbName}`)
  await admin.end()
  if (directory) await rm(directory, { recursive: true, force: true })
})

describe('reviewed offline RYM replay', () => {
  it('rejects changed evidence, inserts only canonical memberships and missing origins, and reruns with zero changes', async () => {
    const file = (name: string) => '--report=' + join(directory, name + '.json')
    const preview = await replayRymTags([file('preview')])
    expect(preview).toMatchObject({
      mode: 'preview',
      scanned: 51,
      skippedAlbums: 50,
      affectedAlbums: 1,
      historical: {
        scanned: 54,
        sameIssue: 51,
        differentOrUnproven: 1,
        unconfirmed: 2,
      },
      planned: { tags: 4, memberships: 4, occurrences: 5 },
      inserted: { tags: 0, memberships: 0, occurrences: 0 },
    })
    const report = await readFile(join(directory, 'preview.json'), 'utf8')
    expect((await stat(join(directory, 'preview.json'))).mode & 0o777).toBe(
      0o600,
    )
    expect(report).toContain('"sourceUrl": "' + release + '"')
    expect(report).not.toContain('Not This')
    expect(report).not.toContain('Never In The Header')
    expect(report).not.toContain('Unproven Pair')
    const originalOrigins = await database.select().from(schema.tagOccurrence)
    const metadata = await database
      .select()
      .from(schema.mediaItem)
      .where(eq(schema.mediaItem.id, item))
    const history = await database
      .select()
      .from(schema.providerSnapshot)
      .orderBy(schema.providerSnapshot.id)
    const current = await database
      .select()
      .from(schema.providerCurrentState)
      .where(eq(schema.providerCurrentState.id, item))
    const apply = ['--apply', '--review=' + preview.review]
    await database
      .update(schema.providerReference)
      .set({ externalId: priorIssue })
      .where(eq(schema.providerReference.id, 'reference'))
    await expect(replayRymTags([...apply, file('stale')])).rejects.toThrow(
      'Dry-run evidence changed',
    )
    expect(await database.select().from(schema.tagOccurrence)).toEqual(
      originalOrigins,
    )
    await database
      .update(schema.providerReference)
      .set({ externalId: release })
      .where(eq(schema.providerReference.id, 'reference'))
    await expect(replayRymTags([...apply, file('preview')])).rejects.toThrow(
      'EEXIST',
    )
    expect(await database.select().from(schema.tagOccurrence)).toEqual(
      originalOrigins,
    )
    const applied = await replayRymTags([...apply, file('apply')])
    expect(applied.inserted).toEqual(preview.planned)
    const origins = await database.select().from(schema.tagOccurrence)
    expect(origins).toHaveLength(originalOrigins.length + 5)
    expect(origins).toEqual(
      expect.arrayContaining([
        ...originalOrigins,
        expect.objectContaining({
          provider,
          source: 'rym',
          rawName: 'Ambient Dub',
          kind: 'genre',
        }),
        expect.objectContaining({
          provider,
          source: 'rym',
          rawName: 'atmospheric',
          kind: 'descriptor',
        }),
        expect.objectContaining({
          provider,
          source: 'rym',
          rawName: 'Art Pop',
          kind: 'genre',
          tagId: 'canonical',
        }),
      ]),
    )
    const after = await replayRymTags([file('after')])
    expect(after.planned).toEqual({ tags: 0, memberships: 0, occurrences: 0 })
    expect(
      (
        await replayRymTags([
          '--apply',
          '--review=' + after.review,
          file('noop'),
        ])
      ).inserted,
    ).toEqual(after.planned)
    expect(await database.select().from(schema.tagOccurrence)).toEqual(origins)
    expect(
      await database
        .select()
        .from(schema.mediaItem)
        .where(eq(schema.mediaItem.id, item)),
    ).toEqual(metadata)
    expect(
      await database
        .select()
        .from(schema.providerSnapshot)
        .orderBy(schema.providerSnapshot.id),
    ).toEqual(history)
    expect(
      await database
        .select()
        .from(schema.providerCurrentState)
        .where(eq(schema.providerCurrentState.id, item)),
    ).toEqual(current)
    expect(fetch).not.toHaveBeenCalled()
  })
})
