import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { TagListQuerySchema } from '@repo/schemas/tags'
import type { BrowseFilter } from '@repo/schemas/browse'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = `tag_browse_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  connectionTimeoutMillis: 5000,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({
  ...connection,
  database: name,
  max: 2,
  // Bound regressions in PostgreSQL itself so timed-out tests cannot saturate its pool.
  statement_timeout: 5000,
  options: '-c work_mem=64kB',
})
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

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network requests are forbidden in integration tests')
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
  const mediaTypes: ('film' | 'album')[] = ['film', 'album']
  for (const mediaType of mediaTypes) {
    const items = ['a', 'b', 'c', 'd'].map((suffix) => ({
      id: `${mediaType}-${suffix}`,
      slug: `${mediaType}-${suffix}`,
      title: `${mediaType}-${suffix}`,
      mediaType,
    }))
    await database.insert(schema.mediaItem).values(items)
    const details = items.map((item) => ({ mediaItemId: item.id }))
    if (mediaType === 'film') await database.insert(schema.film).values(details)
    else await database.insert(schema.album).values(details)
  }
  await database.insert(schema.tag).values([
    { id: 'film-shared', mediaType: 'film', name: 'Shared', kind: 'genre' },
    {
      id: 'film-duplicate',
      mediaType: 'film',
      name: ' SHARED\u00a0 ',
      kind: 'keyword',
    },
    { id: 'film-old', mediaType: 'film', name: 'Old shared', kind: 'genre' },
    { id: 'film-extra', mediaType: 'film', name: 'Extra', kind: 'keyword' },
    {
      id: 'film-alias-only',
      mediaType: 'film',
      name: 'Historical shared',
      kind: 'keyword',
    },
    { id: 'album-shared', mediaType: 'album', name: 'Shared', kind: 'genre' },
    { id: 'album-other', mediaType: 'album', name: 'Other', kind: 'keyword' },
    { id: 'album-old', mediaType: 'album', name: 'Old shared', kind: 'genre' },
  ])
  await database.insert(schema.tagIdentity).values([
    {
      mediaType: 'film',
      normalizedName: 'shared',
      kind: 'genre',
      tagId: 'film-shared',
    },
    {
      mediaType: 'film',
      normalizedName: 'old shared',
      kind: 'genre',
      tagId: 'film-shared',
    },
    {
      mediaType: 'film',
      normalizedName: 'identity shared',
      kind: 'keyword',
      tagId: 'film-shared',
    },
    {
      mediaType: 'album',
      normalizedName: 'shared',
      kind: 'genre',
      tagId: 'album-shared',
    },
    {
      mediaType: 'album',
      normalizedName: 'old shared',
      kind: 'genre',
      tagId: 'album-other',
    },
  ])
  await database.insert(schema.tagAlias).values([
    { sourceTagId: 'film-old', targetTagId: 'film-shared' },
    { sourceTagId: 'film-alias-only', targetTagId: 'film-shared' },
    { sourceTagId: 'album-old', targetTagId: 'album-other' },
  ])
  // The legacy keyword duplicate deliberately has no identity or alias row.
  await database.insert(schema.mediaItemTag).values([
    { mediaItemId: 'film-a', tagId: 'film-shared' },
    { mediaItemId: 'film-a', tagId: 'film-duplicate' },
    { mediaItemId: 'film-a', tagId: 'film-extra' },
    { mediaItemId: 'film-b', tagId: 'film-duplicate' },
    { mediaItemId: 'film-c', tagId: 'film-extra' },
    { mediaItemId: 'album-a', tagId: 'album-shared' },
    { mediaItemId: 'album-b', tagId: 'album-other' },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function matches(mediaType: 'film' | 'album', filters: BrowseFilter[]) {
  const { queryBrowseIds } = await import('@/services/browse')
  const query = {
    filters: JSON.stringify(filters),
    sortBy: 'title',
    direction: 'asc',
    size: 100,
  }
  return queryBrowseIds(
    mediaType,
    mediaType === 'film'
      ? FilmQuerySchema.parse(query)
      : AlbumQuerySchema.parse(query),
  )
}

describe('tag browse predicate regression', () => {
  it('keeps same-name identities and merged aliases scoped to their library', async () => {
    for (const field of ['genre', 'keyword', 'tag']) {
      expect(
        await matches('film', [{ field, value: 'Old shared' }]),
      ).toMatchObject({
        ids: ['film-a', 'film-b'],
        totalCount: 2,
      })
      expect(
        await matches('album', [{ field, value: 'Old shared' }]),
      ).toMatchObject({
        ids: ['album-b'],
        totalCount: 1,
      })
      expect(
        await matches('album', [{ field, value: 'Shared' }]),
      ).toMatchObject({
        ids: ['album-a'],
        totalCount: 1,
      })
      expect(await matches('film', [{ field, value: 'Other' }])).toMatchObject({
        ids: [],
        totalCount: 0,
      })
    }
  })

  it('resolves identity-only and alias-only names to all equivalent legacy memberships without duplicate results', async () => {
    for (const value of [
      ' SHARED\u2003 ',
      'Old shared',
      'Historical shared',
      'Identity shared',
    ]) {
      expect(await matches('film', [{ field: 'genre', value }])).toMatchObject({
        ids: ['film-a', 'film-b'],
        totalCount: 2,
      })
    }
    expect(
      await matches('album', [{ field: 'genre', value: 'Historical shared' }]),
    ).toMatchObject({
      ids: [],
      totalCount: 0,
    })
  })

  const cases: { name: string; filters: BrowseFilter[]; ids: string[] }[] = [
    {
      name: 'any unions tags',
      filters: [
        { field: 'genre', value: 'Old shared', mode: 'any' },
        { field: 'genre', value: 'Extra' },
      ],
      ids: ['film-a', 'film-b', 'film-c'],
    },
    {
      name: 'any unions across fields',
      filters: [
        { field: 'genre', value: 'Old shared' },
        { field: 'title', value: 'film-d' },
      ],
      ids: ['film-a', 'film-b', 'film-d'],
    },
    {
      name: 'required intersects tags',
      filters: [
        { field: 'genre', value: 'Old shared', mode: 'required' },
        { field: 'genre', value: 'Extra', mode: 'required' },
      ],
      ids: ['film-a'],
    },
    {
      name: 'exclude removes matching aliases',
      filters: [
        { field: 'genre', value: 'Extra' },
        { field: 'genre', value: 'Historical shared', mode: 'exclude' },
      ],
      ids: ['film-c'],
    },
    {
      name: 'exclude alone retains untagged films',
      filters: [{ field: 'genre', value: 'Old shared', mode: 'exclude' }],
      ids: ['film-c', 'film-d'],
    },
    {
      name: 'missing any matches nothing',
      filters: [{ field: 'genre', value: 'Missing' }],
      ids: [],
    },
    {
      name: 'missing required prevents any matches',
      filters: [
        { field: 'genre', value: 'Shared' },
        { field: 'genre', value: 'Missing', mode: 'required' },
      ],
      ids: [],
    },
    {
      name: 'missing exclude removes nothing',
      filters: [{ field: 'genre', value: 'Missing', mode: 'exclude' }],
      ids: ['film-a', 'film-b', 'film-c', 'film-d'],
    },
    {
      name: 'empty filters include untagged films',
      filters: [],
      ids: ['film-a', 'film-b', 'film-c', 'film-d'],
    },
  ]
  it.each(cases)('$name', async ({ filters, ids }) => {
    expect(await matches('film', filters)).toMatchObject({
      ids,
      totalCount: ids.length,
    })
  })

  it('bounds tag filtering on 2500 films and 50000 memberships with a statement timeout', async () => {
    expect((await database.execute(sql`show statement_timeout`)).rows).toEqual([
      { statement_timeout: '5s' },
    ])
    await database.execute(sql`insert into media_item (id, slug, title, media_type)
      select 'load-' || n, 'load-' || n, 'Load ' || n, 'film' from generate_series(0, 2499) n`)
    await database.execute(sql`insert into film (media_item_id)
      select 'load-' || n from generate_series(0, 2499) n`)
    await database.execute(sql`insert into tag (id, media_type, name, kind)
      select 'load-tag-' || n, 'film'::media_type, 'Load tag ' || n, 'keyword' from generate_series(0, 999) n
      union all select 'load-old-' || n, 'film'::media_type, 'Load old ' || n, 'genre' from generate_series(0, 999) n`)
    await database.execute(sql`insert into tag_identity (media_type, normalized_name, kind, tag_id)
      select 'film'::media_type, 'load tag ' || n, 'keyword', 'load-tag-' || n from generate_series(0, 999) n
      union all select 'film'::media_type, 'load old ' || n, 'genre', 'load-tag-' || n from generate_series(0, 999) n`)
    await database.execute(sql`insert into tag_alias (source_tag_id, target_tag_id)
      select 'load-old-' || n, 'load-tag-' || n from generate_series(0, 999) n`)
    await database.execute(sql`insert into media_item_tag (media_item_id, tag_id)
      select 'load-' || n, 'load-tag-' || ((n + offset_value) % 1000)
      from generate_series(0, 2499) n cross join generate_series(0, 19) offset_value`)
    for (const table of [
      schema.mediaItem,
      schema.film,
      schema.tag,
      schema.tagIdentity,
      schema.tagAlias,
      schema.mediaItemTag,
    ])
      await database.execute(sql`analyze ${table}`)

    const expected = Array.from({ length: 2500 }, (_, index) => index)
      .filter((index) =>
        Array.from(
          { length: 20 },
          (_, offset) => (index + offset) % 1000,
        ).includes(123),
      )
      .map((index) => `load-${index}`)
      .sort()
    for (const value of ['Load tag 123', 'Load old 123']) {
      const result = await matches('film', [{ field: 'genre', value }])
      expect(result.ids.sort()).toEqual(expected)
      expect(result.totalCount).toBe(expected.length)
    }
    expect(
      await matches('film', [
        { field: 'genre', value: 'Missing large fixture' },
      ]),
    ).toMatchObject({
      ids: [],
      totalCount: 0,
    })
    const excluded = await matches('film', [
      { field: 'genre', value: 'Load old 123', mode: 'exclude' },
    ])
    expect(excluded.totalCount).toBe(2504 - expected.length)
    expect(excluded.ids.some((id) => expected.includes(id))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('bounds broad tag search when matching IDs exceed the hash memory budget', async () => {
    const { listTags } = await import('@/services/tags')
    await database.execute(sql`insert into tag (id, media_type, name, kind)
      select 'search-load-' || n, 'film'::media_type, 'Search load ' || n, 'keyword'
      from generate_series(0, 11999) n`)
    await database.execute(sql`insert into media_item_tag (media_item_id, tag_id)
      select 'film-a', 'search-load-' || n from generate_series(0, 11999) n`)
    await database.execute(sql`insert into tag_occurrence
      (id, media_item_id, tag_id, provider, source, raw_name, kind)
      select 'search-origin-' || n, 'film-a', 'search-load-' || n,
        'fixture', 'fixture', 'Source token ' || n, 'keyword'
      from generate_series(0, 11999) n`)
    for (const table of [schema.tag, schema.mediaItemTag, schema.tagOccurrence])
      await database.execute(sql`analyze ${table}`)

    const query = TagListQuerySchema.parse({
      mediaType: 'film',
      q: 'Search load',
    })
    const page = await listTags(query)
    expect(page).toMatchObject({ totalCount: 12000, pageCount: 480 })
    expect(page.items).toHaveLength(25)
    expect(
      page.items.every(
        (item) => item.mediaCount === 1 && item.sourceCount === 1,
      ),
    ).toBe(true)
    expect(await listTags({ ...query, q: 'Source token' })).toMatchObject({
      items: page.items,
      totalCount: 12000,
    })
    expect(await listTags({ ...query, page: 481 })).toMatchObject({
      items: [],
      totalCount: 12000,
      pageCount: 480,
    })
    const index = await database.execute(sql`
      select indexdef from pg_indexes where tablename = 'media_item_tag'
        and indexname = 'media_item_tag_tag_media_idx'
    `)
    expect(index.rows).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })
})
