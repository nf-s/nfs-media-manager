import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '@/env'

const name = `tag_scope_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const database = new pg.Client({ ...connection, database: name })
let created = false
let connected = false
let snapshots: unknown[] = []
let occurrences: unknown[] = []

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await database.connect()
  connected = true
  const migrations = readMigrationFiles({
    migrationsFolder: './drizzle',
  })
  const scopeIndex = migrations.findIndex((migration) =>
    migration.sql.some((statement) =>
      statement.includes('CREATE FUNCTION enforce_tag_media_scope'),
    ),
  )
  const migration = migrations[scopeIndex]
  if (!migration) throw new Error('Missing scoped migration')
  await database.query('begin')
  for (const previous of migrations.slice(0, scopeIndex))
    for (const statement of previous.sql) await database.query(statement)
  await database.query('commit')
  await database.query(`
    insert into media_item (id, media_type, slug, title) values
      ('film', 'film', 'film', 'Film fixture'), ('album', 'album', 'album', 'Album fixture');
    insert into tag (id, name, kind, hidden, created_at, updated_at) values
      ('shared', 'Shared', 'keyword', true, '2020-01-01', '2021-01-01'),
      ('shared-kind', ' SHARED ', 'genre', false, '2020-01-01', '2021-01-01'),
      ('old', 'Old name', 'style', false, '2020-01-01', '2021-01-01'),
      ('older', 'Older name', 'general', true, '2020-01-01', '2021-01-01'),
      ('album-only', 'Album only', 'genre', true, '2020-01-01', '2021-01-01'),
      ('film-only', 'Film only', 'keyword', false, '2020-01-01', '2021-01-01'),
      ('unattached', 'Unattached hidden', 'general', true, '2020-01-01', '2021-01-01'),
      ('provenance-only', 'Provenance only', 'style', true, '2020-01-01', '2021-01-01');
    insert into tag_identity (normalized_name, kind, tag_id) values
      ('shared', 'keyword', 'shared'), ('shared', 'genre', 'shared-kind'),
      ('old name', 'style', 'shared'), ('older name', 'general', 'shared'),
      ('album only', 'genre', 'album-only'), ('film only', 'keyword', 'film-only'),
      ('unattached hidden', 'general', 'unattached'), ('provenance only', 'style', 'provenance-only');
    insert into tag_alias (source_tag_id, target_tag_id, created_at) values
      ('old', 'shared', '2022-01-01'), ('older', 'shared', '2022-01-02');
    insert into tag_merge (id, source_tag_id, target_tag_id, created_at) values
      ('merge-older', 'older', 'old', '2022-01-01'), ('merge-old', 'old', 'shared', '2022-01-02');
    insert into media_item_tag (media_item_id, tag_id) values
      ('film', 'shared'), ('film', 'shared-kind'), ('album', 'shared'),
      ('film', 'film-only'), ('album', 'album-only');
    insert into tag_occurrence (id, media_item_id, tag_id, provider, source, source_id, raw_name, kind, created_at, updated_at) values
      ('occ-film', 'film', 'shared', 'fixture-film', 'upstream', '001', ' Old name ', 'style', '2020-01-01', '2021-01-01'),
      ('occ-album', 'album', 'shared', 'fixture-album', 'upstream', '002', 'Shared', 'keyword', '2020-01-01', '2021-01-01'),
      ('occ-only', 'album', 'provenance-only', null, null, null, 'Provenance only', 'style', '2020-01-01', '2021-01-01');
    insert into provider_snapshot (id, media_item_id, provider, source, payload, normalized_data, checksum) values
      ('snapshot', 'album', 'fixture', 'legacy-import', '{"untouched":true}', '{"tags":[{"name":"Old name","kind":"style"}]}', 'original');
    insert into provider_current_state (id, media_item_id, provider, payload, normalized_data, checksum, status) values
      ('current', 'album', 'fixture', '{"untouched":true}', '{"tags":[{"name":"Old name","kind":"style"}]}', 'original', 'succeeded');
  `)
  // Reproduce the pre-migration leak using the same global tag shared by both media.
  const before = await database.query(
    'select m.media_type, t.id, t.hidden from media_item_tag mt join media_item m on m.id = mt.media_item_id join tag t on t.id = mt.tag_id where t.id = $1 order by m.media_type',
    ['shared'],
  )
  expect(before.rows).toEqual([
    { media_type: 'album', id: 'shared', hidden: true },
    { media_type: 'film', id: 'shared', hidden: true },
  ])
  snapshots = (
    await database.query(
      'select to_jsonb(s) as value from provider_snapshot s union all select to_jsonb(s) from provider_current_state s',
    )
  ).rows
  occurrences = (
    await database.query(
      "select to_jsonb(o) - 'tag_id' as value from tag_occurrence o order by id",
    )
  ).rows
  await database.query('begin')
  try {
    for (const statement of migration.sql) await database.query(statement)
    await database.query('commit')
  } catch (error) {
    await database.query('rollback')
    throw error
  }
})

afterAll(async () => {
  if (connected) await database.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('populated tag media scope migration', () => {
  it('splits every membership and occurrence without changing raw provenance or history', async () => {
    expect(
      (
        await database.query(
          'select to_jsonb(s) as value from provider_snapshot s union all select to_jsonb(s) from provider_current_state s',
        )
      ).rows,
    ).toEqual(snapshots)
    expect(
      (
        await database.query(
          "select to_jsonb(o) - 'tag_id' as value from tag_occurrence o order by id",
        )
      ).rows,
    ).toEqual(occurrences)
    expect(
      (
        await database.query(
          'select m.media_type, t.name, t.hidden from media_item_tag mt join media_item m on m.id = mt.media_item_id join tag t on t.id = mt.tag_id order by m.media_type, t.name collate "C"',
        )
      ).rows,
    ).toEqual([
      { media_type: 'album', name: 'Album only', hidden: true },
      { media_type: 'album', name: 'Shared', hidden: true },
      { media_type: 'film', name: ' SHARED ', hidden: false },
      { media_type: 'film', name: 'Film only', hidden: false },
      { media_type: 'film', name: 'Shared', hidden: true },
    ])
    for (const table of ['media_item_tag', 'tag_occurrence'])
      expect(
        (
          await database.query(
            `select mt.* from ${table} mt join media_item m on m.id = mt.media_item_id join tag t on t.id = mt.tag_id where m.media_type <> t.media_type`,
          )
        ).rows,
      ).toEqual([])
  })

  it('preserves cross-kind alias chains and merge history independently in both media', async () => {
    expect(
      (
        await database.query(
          'select s.media_type, s.name as source, t.name as target, a.created_at::text as created from tag_alias a join tag s on s.id = a.source_tag_id join tag t on t.id = a.target_tag_id order by s.media_type, s.name collate "C"',
        )
      ).rows,
    ).toEqual([
      {
        media_type: 'album',
        source: 'Old name',
        target: 'Shared',
        created: '2022-01-01 00:00:00',
      },
      {
        media_type: 'album',
        source: 'Older name',
        target: 'Shared',
        created: '2022-01-02 00:00:00',
      },
      {
        media_type: 'film',
        source: 'Old name',
        target: 'Shared',
        created: '2022-01-01 00:00:00',
      },
      {
        media_type: 'film',
        source: 'Older name',
        target: 'Shared',
        created: '2022-01-02 00:00:00',
      },
    ])
    expect(
      (await database.query('select count(*)::int as count from tag_merge'))
        .rows,
    ).toEqual([{ count: 4 }])
    expect(
      (
        await database.query(
          "select media_type, kind from tag_identity where normalized_name = 'old name' order by media_type",
        )
      ).rows,
    ).toEqual([
      { media_type: 'album', kind: 'style' },
      { media_type: 'film', kind: 'style' },
    ])
    expect(
      (
        await database.query(
          "select id, media_type from tag where id in ('album-only', 'film-only', 'provenance-only') order by id",
        )
      ).rows,
    ).toEqual([
      { id: 'album-only', media_type: 'album' },
      { id: 'film-only', media_type: 'film' },
      { id: 'provenance-only', media_type: 'album' },
    ])
    expect(
      (
        await database.query(
          "select media_type, hidden from tag where name = 'Unattached hidden' order by media_type",
        )
      ).rows,
    ).toEqual([
      { media_type: 'album', hidden: true },
      { media_type: 'film', hidden: true },
    ])
  })

  it('allows hidden state to diverge but rejects all cross-media writes', async () => {
    await database.query(
      "update tag set hidden = false where name = 'Shared' and media_type = 'album'",
    )
    expect(
      (
        await database.query(
          "select media_type, hidden from tag where name = 'Shared' order by media_type",
        )
      ).rows,
    ).toEqual([
      { media_type: 'album', hidden: false },
      { media_type: 'film', hidden: true },
    ])
    for (const statement of [
      "insert into media_item_tag values ('album', 'film-only')",
      "update tag_occurrence set tag_id = 'film-only' where id = 'occ-album'",
      "update tag_identity set tag_id = 'film-only' where media_type = 'album' and normalized_name = 'old name'",
      "insert into tag_alias (source_tag_id, target_tag_id) values ('album-only', 'film-only')",
      "insert into tag_merge (id, source_tag_id, target_tag_id) values ('bad', 'album-only', 'film-only')",
      "update tag set media_type = 'film' where id = 'album-only'",
      "update media_item set media_type = 'film' where id = 'album'",
    ])
      await expect(database.query(statement)).rejects.toMatchObject({
        code: '23514',
      })
    await expect(
      database.query(
        "insert into tag (id, name) values ('unscoped', 'No scope')",
      ),
    ).rejects.toMatchObject({ code: '23502' })
  })
})
