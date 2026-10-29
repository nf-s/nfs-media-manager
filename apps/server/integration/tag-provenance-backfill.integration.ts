import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '@/env'
import { TagListQuerySchema } from '@repo/schemas/tags'
import * as schema from '@/schemas/db'
import {
  applyTagProvenanceBackfill,
  auditTagProvenance,
  type TagBackfillScope,
} from '@/services/tag-provenance-backfill'

const name = `tag_backfill_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database: name })
const database = drizzle(pool, { schema })
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))
let created = false
const scope: TagBackfillScope = { mediaType: 'album', name: 'Arena Rock' }

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await database.transaction(async (tx) => {
    for (const migration of readMigrationFiles({
      migrationsFolder: './drizzle',
    }))
      for (const statement of migration.sql)
        await tx.execute(sql.raw(statement))
  })
  await database.insert(schema.mediaItem).values([
    { id: 'album', slug: 'album', title: 'Plastic Hearts', mediaType: 'album' },
    { id: 'film', slug: 'film', title: 'Unrelated film', mediaType: 'film' },
  ])
  await database.insert(schema.tag).values([
    {
      id: 'album-tag',
      mediaType: 'album',
      name: 'arena rock',
      kind: 'genre',
      hidden: true,
    },
    { id: 'film-tag', mediaType: 'film', name: 'arena rock', kind: 'genre' },
  ])
  await database.insert(schema.mediaItemTag).values([
    { mediaItemId: 'album', tagId: 'album-tag' },
    { mediaItemId: 'film', tagId: 'film-tag' },
  ])
  await database.insert(schema.tagOccurrence).values([
    {
      id: 'unknown-album',
      mediaItemId: 'album',
      tagId: 'album-tag',
      rawName: 'arena rock',
      kind: 'genre',
    },
    {
      id: 'unknown-film',
      mediaItemId: 'film',
      tagId: 'film-tag',
      rawName: 'arena rock',
      kind: 'genre',
    },
  ])
  await database.insert(schema.providerSnapshot).values([
    {
      id: 'musicbrainz',
      mediaItemId: 'album',
      provider: 'musicbrainz',
      checksum: 'raw-mb',
      source: 'legacy-import',
      payload: {
        releaseGroup: {
          genres: [
            { id: '26af3760-750a-4b5e-a699-78c87697585a', name: 'arena rock' },
          ],
        },
      },
      normalizedData: {},
    },
    {
      id: 'discogs',
      mediaItemId: 'album',
      provider: 'discogs',
      checksum: 'raw-discogs',
      source: 'legacy-import',
      payload: { master: { styles: ['Arena Rock'] } },
      normalizedData: {},
    },
  ])
  await database.insert(schema.externalLink).values([
    {
      id: 'mb-link',
      mediaItemId: 'album',
      provider: 'musicbrainz',
      label: 'MusicBrainz',
      url: 'https://musicbrainz.org/release-group/0663bcbd-e202-4aeb-b003-6d49f0a4d152',
    },
    {
      id: 'discogs-link',
      mediaItemId: 'album',
      provider: 'discogs',
      label: 'Discogs',
      url: 'https://www.discogs.com/master/1847448',
    },
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})
async function audit() {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`set transaction isolation level repeatable read, read only`,
    )
    return auditTagProvenance(tx, scope)
  })
}

describe('offline provenance transaction', () => {
  it('dry-runs in a read-only transaction and refuses an unreviewed plan', async () => {
    const result = await audit()
    expect(result).toMatchObject({
      scannedMemberships: 1,
      missingMemberships: 1,
      snapshotsScanned: 2,
      unresolved: [],
    })
    expect(result.additions).toHaveLength(2)
    await expect(
      database.transaction((tx) =>
        applyTagProvenanceBackfill(tx, scope, 'stale'),
      ),
    ).rejects.toThrow('Dry-run evidence changed')
    expect(await database.select().from(schema.tagOccurrence)).toHaveLength(2)
  })
  it('rolls back all additions on transaction failure', async () => {
    const report = await audit()
    await expect(
      database.transaction(async (tx) => {
        await applyTagProvenanceBackfill(tx, scope, report.review)
        throw new Error('fixture rollback')
      }),
    ).rejects.toThrow('fixture rollback')
    expect(await database.select().from(schema.tagOccurrence)).toHaveLength(2)
  })
  it('inserts only reviewed sources, preserves raw history/hidden state and is idempotent', async () => {
    const snapshots = await database
      .select()
      .from(schema.providerSnapshot)
      .orderBy(asc(schema.providerSnapshot.id))
    const unknowns = await database
      .select()
      .from(schema.tagOccurrence)
      .orderBy(asc(schema.tagOccurrence.id))
    const tags = await database
      .select()
      .from(schema.tag)
      .orderBy(asc(schema.tag.id))
    const memberships = await database
      .select()
      .from(schema.mediaItemTag)
      .orderBy(asc(schema.mediaItemTag.tagId))
    const report = await audit()
    expect(
      await database.transaction((tx) =>
        applyTagProvenanceBackfill(tx, scope, report.review),
      ),
    ).toMatchObject({ inserted: 2 })
    const second = await audit()
    expect(second.additions).toEqual([])
    expect(second.alreadyPresent).toBe(2)
    expect(
      await database.transaction((tx) =>
        applyTagProvenanceBackfill(tx, scope, second.review),
      ),
    ).toMatchObject({ inserted: 0 })
    expect(
      await database
        .select()
        .from(schema.providerSnapshot)
        .orderBy(asc(schema.providerSnapshot.id)),
    ).toEqual(snapshots)
    expect(
      await database.select().from(schema.tag).orderBy(asc(schema.tag.id)),
    ).toEqual(tags)
    expect(
      await database
        .select()
        .from(schema.mediaItemTag)
        .orderBy(asc(schema.mediaItemTag.tagId)),
    ).toEqual(memberships)
    for (const row of unknowns)
      expect(
        await database
          .select()
          .from(schema.tagOccurrence)
          .where(eq(schema.tagOccurrence.id, row.id)),
      ).toEqual([row])
    expect(
      await database
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.mediaItemId, 'film')),
    ).toHaveLength(1)
    const { getTagProvenance } = await import('@/services/tags')
    const response = await getTagProvenance({
      mediaType: 'album',
      name: 'Arena Rock',
      page: 1,
      size: 25,
    })
    expect(response.items).toHaveLength(2)
    expect(response.totalCount).toBe(2)
    expect(
      response.items
        .filter((row) => row.link)
        .map((row) => row.link?.provider)
        .sort(),
    ).toEqual(['discogs', 'musicbrainz'])
    expect(
      response.items.find((row) => row.provider === 'musicbrainz')?.link?.url,
    ).toBe('https://musicbrainz.org/tag/arena%20rock')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps source summaries and pagination consistent while retaining unrelated unknown origins', async () => {
    const { getTagProvenance, listTags } = await import('@/services/tags')
    const before = await listTags(
      TagListQuerySchema.parse({
        mediaType: 'album',
        visibility: 'all',
        q: 'Arena Rock',
      }),
    )
    expect(before.items[0]).toMatchObject({
      sourceCount: 2,
      sources: [expect.anything(), expect.anything()],
    })
    await database.insert(schema.mediaItem).values({
      id: 'other-album',
      slug: 'other-album',
      title: 'Still unresolved',
      mediaType: 'album',
    })
    await database
      .insert(schema.mediaItemTag)
      .values({ mediaItemId: 'other-album', tagId: 'album-tag' })
    await database.insert(schema.tagOccurrence).values([
      {
        id: 'other-unknown',
        mediaItemId: 'other-album',
        tagId: 'album-tag',
        rawName: 'arena rock',
        kind: 'genre',
      },
      {
        id: 'alias-unknown',
        mediaItemId: 'album',
        tagId: 'album-tag',
        rawName: 'old arena alias',
        kind: 'genre',
      },
      {
        id: 'kind-unknown',
        mediaItemId: 'album',
        tagId: 'album-tag',
        rawName: 'arena rock',
        kind: 'keyword',
      },
      {
        id: 'unicode-redundant',
        mediaItemId: 'album',
        tagId: 'album-tag',
        rawName: ' ARENA\u00a0ROCK ',
        kind: 'genre',
      },
      {
        id: 'id-only-unknown',
        mediaItemId: 'album',
        tagId: 'album-tag',
        rawName: 'arena rock',
        kind: 'genre',
        sourceId: 'opaque-unattributed',
      },
    ])
    const query = { mediaType: 'album', name: 'Arena Rock', page: 1, size: 2 }
    const first = await getTagProvenance(query)
    const second = await getTagProvenance({ ...query, page: 2 })
    const third = await getTagProvenance({ ...query, page: 3 })
    expect(first).toMatchObject({ totalCount: 6, pageCount: 3 })
    const origins = [...first.items, ...second.items, ...third.items]
    expect(origins).toHaveLength(6)
    expect(origins.filter((row) => row.provider === null)).toHaveLength(4)
    expect(origins.some((row) => row.rawName === ' ARENA\u00a0ROCK ')).toBe(
      false,
    )
    const onAlbum = await getTagProvenance({
      ...query,
      mediaId: 'album',
      size: 25,
    })
    expect(
      onAlbum.items.find(
        (row) =>
          row.provider === null &&
          row.rawName === 'arena rock' &&
          row.kind === 'genre' &&
          !row.sourceId,
      )?.onMedia,
    ).toBe(false)
    const after = await listTags(
      TagListQuerySchema.parse({
        mediaType: 'album',
        visibility: 'all',
        q: 'Arena Rock',
      }),
    )
    expect(after.items[0]).toMatchObject({ sourceCount: 6, mediaCount: 2 })
    expect(after.items[0]?.sources).toHaveLength(6)
    expect(
      await database
        .select()
        .from(schema.tagOccurrence)
        .where(eq(schema.tagOccurrence.id, 'unicode-redundant')),
    ).toHaveLength(1)
    const film = await getTagProvenance({
      mediaType: 'film',
      name: 'Arena Rock',
      page: 1,
      size: 25,
    })
    expect(film.items).toMatchObject([
      { provider: null, rawName: 'arena rock' },
    ])
  })
  it('does not treat unknown attribution or a different grouped tag ID as corroboration', async () => {
    await database.insert(schema.tag).values([
      {
        id: 'unproven-tag',
        mediaType: 'album',
        name: 'Unproven',
        kind: 'genre',
      },
      {
        id: 'grouped-tag',
        mediaType: 'album',
        name: 'Unproven',
        kind: 'general',
      },
    ])
    await database.insert(schema.mediaItemTag).values([
      { mediaItemId: 'album', tagId: 'unproven-tag' },
      { mediaItemId: 'album', tagId: 'grouped-tag' },
    ])
    await database.insert(schema.tagOccurrence).values([
      {
        id: 'unproven-placeholder',
        mediaItemId: 'album',
        tagId: 'unproven-tag',
        rawName: 'Unproven',
        kind: 'genre',
      },
      {
        id: 'unproven-source',
        mediaItemId: 'album',
        tagId: 'unproven-tag',
        rawName: 'Unproven',
        kind: 'genre',
        source: 'unknown',
      },
      {
        id: 'different-tag-id',
        mediaItemId: 'album',
        tagId: 'grouped-tag',
        rawName: 'Unproven',
        kind: 'genre',
        provider: 'musicbrainz',
      },
    ])
    const { getTagProvenance, listTags } = await import('@/services/tags')
    expect(
      await getTagProvenance({
        mediaType: 'album',
        name: 'Unproven',
        page: 1,
        size: 25,
      }),
    ).toMatchObject({ totalCount: 3 })
    const result = await listTags(
      TagListQuerySchema.parse({ mediaType: 'album', q: 'Unproven' }),
    )
    expect(result.items[0]).toMatchObject({ sourceCount: 3, mediaCount: 1 })
  })
})
