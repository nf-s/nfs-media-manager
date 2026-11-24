import { randomUUID } from 'node:crypto'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const name = `shadow_catalog_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const database = new pg.Client({ ...connection, database: name })
const fixture = drizzle(database, { schema })
let created = false
let connected = false

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))

import { runNonMusicCatalogBackfill } from '@/services/nonmusic-catalog-backfill'

async function migrate(migrations: ReturnType<typeof readMigrationFiles>) {
  await database.query('begin')
  try {
    for (const migration of migrations)
      for (const statement of migration.sql) await database.query(statement)
    await database.query('commit')
  } catch (error) {
    await database.query('rollback')
    throw error
  }
}

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await database.connect()
  connected = true
  const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
  const first = migrations.findIndex((migration) =>
    migration.sql.some((statement) =>
      statement.includes('CREATE TABLE "catalog_observation"'),
    ),
  )
  if (first < 0) throw new Error('Missing catalog migration')
  await migrate(migrations.slice(0, first))
  await database.query(`
    insert into media_item (id, media_type, slug, title, metadata) values
      ('album', 'album', 'album', 'Fixture Album', null),
      ('film', 'film', 'film', 'Fixture Film', null),
      ('track', 'track', 'track', 'Fixture Track', null),
      ('archived', 'track', 'archived', 'Archived Fixture', '{"legacyHidden":true}');
    insert into album (media_item_id, date_added) values ('album', '2024-01-01');
    insert into film (media_item_id, date_added, date_added_source)
      values ('film', '2024-02-01', 'Fixture import');
    insert into library_track (media_item_id, date_added) values
      ('track', '2024-03-01'), ('archived', '2024-04-01');
    insert into artist (id, name) values ('artist', 'Fixture Artist');
    insert into media_credit (media_item_id, artist_id, role)
      values ('track', 'artist', 'artist'), ('film', 'artist', 'director');
    insert into playlist (id, kind, name) values
      ('playlist', 'playlist', 'Fixture List'), ('collection', 'collection', 'Fixture List');
    insert into playlist_item (playlist_id, media_item_id, position, added_at) values
      ('playlist', 'track', 3, '2024-05-01'), ('collection', 'film', 9, '2024-06-01');
    insert into subscription_source (id, type, title, subscribed) values
      ('followed', 'youtube', 'Fixture Channel', true),
      ('unfollowed', 'youtube', 'Fixture Archive', false);
    insert into subscription_item (id, source_id, type, title, published_at, watched_at, search) values
      ('video', 'unfollowed', 'youtube', 'Fixture Video', '2024-07-01', '2024-08-01', to_tsvector('Fixture Video'));
    insert into provider_snapshot (id, media_item_id, provider, source, payload, normalized_data, checksum)
      values ('fixture-snapshot', 'film', 'tmdb', 'legacy-import',
        '{"belongs_to_collection":{"id":654321,"name":"Fixture Provider Collection"}}',
        '{"playlists":[{"kind":"collection","name":"Fixture Provider Collection","position":4}]}', 'fixture');
  `)
  await migrate(migrations.slice(first, first + 1))
  await database.query(`insert into catalog_observation (id, media_item_id, provider, operation)
    values ('old-discovery', 'track', 'fixture', 'album-track-list')`)
  await migrate(migrations.slice(first + 1))
})

afterAll(async () => {
  if (connected) await database.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

it('preserves existing membership, dates, archive flags and playlist admission', async () => {
  const memberships = await database.query(`
    select m.id, m.in_library, m.metadata->>'legacyHidden' as hidden,
      coalesce(a.date_added, f.date_added, t.date_added)::date::text as added
    from media_item m
    left join album a on a.media_item_id = m.id
    left join film f on f.media_item_id = m.id
    left join library_track t on t.media_item_id = m.id
    order by m.id`)
  expect(memberships.rows).toEqual([
    { id: 'album', in_library: true, hidden: null, added: '2024-01-01' },
    { id: 'archived', in_library: true, hidden: 'true', added: '2024-04-01' },
    { id: 'film', in_library: true, hidden: null, added: '2024-02-01' },
    { id: 'track', in_library: true, hidden: null, added: '2024-03-01' },
  ])
  const positions = await database.query(`
    select playlist_id, media_item_id, position, admits_to_library, added_at::date::text as added
    from playlist_item order by playlist_id`)
  expect(positions.rows).toEqual([
    {
      playlist_id: 'collection',
      media_item_id: 'film',
      position: 9,
      admits_to_library: true,
      added: '2024-06-01',
    },
    {
      playlist_id: 'playlist',
      media_item_id: 'track',
      position: 3,
      admits_to_library: true,
      added: '2024-05-01',
    },
  ])
  expect(
    (
      await database.query(
        'select id, subscribed, added_to_library from subscription_source order by id',
      )
    ).rows,
  ).toEqual([
    { id: 'followed', subscribed: true, added_to_library: false },
    { id: 'unfollowed', subscribed: false, added_to_library: false },
  ])
  expect(
    (
      await database.query(
        'select id, target_kind, target_id from catalog_observation',
      )
    ).rows,
  ).toEqual([{ id: 'old-discovery', target_kind: 'track', target_id: 'track' }])
})

it('keeps legacy and native identity constraints separate for artists and lists', async () => {
  await database.query(`
    insert into artist (id, name, catalog_provider, catalog_external_id) values
      ('native-artist', 'Fixture Artist', 'fixture', 'artist');
    insert into playlist (id, kind, name, catalog_provider, catalog_external_id) values
      ('native-playlist', 'playlist', 'Fixture List', 'fixture', 'list'),
      ('native-collection', 'collection', 'Fixture List', 'fixture', 'list');
  `)
  await expect(
    database.query(
      `insert into artist (id, name) values ('duplicate', 'Fixture Artist')`,
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'artist_name_uidx' })
  await expect(
    database.query(`insert into artist (id, name, catalog_provider, catalog_external_id)
    values ('duplicate', 'Different Name', 'fixture', 'artist')`),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'artist_catalog_native_uidx',
  })
  await expect(
    database.query(`insert into playlist (id, kind, name)
    values ('duplicate', 'playlist', 'Fixture List')`),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'playlist_name_kind_uidx',
  })
  await expect(
    database.query(`insert into playlist (id, kind, name, catalog_provider, catalog_external_id)
    values ('duplicate', 'collection', 'Different Name', 'fixture', 'list')`),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'playlist_catalog_native_uidx',
  })
})

it('replays saved film and subscription evidence by cursor without changing library state', async () => {
  type Batch = Parameters<typeof runNonMusicCatalogBackfill>[0]
  const film: Batch = { family: 'film-snapshots', limit: 10 }
  const sources: Batch = { family: 'subscription-sources', limit: 1 }
  const video: Batch = { family: 'subscription-items', limit: 10 }
  const observations = async () =>
    (
      await database.query(`
    select target_kind, target_id, subject_id, snapshot_id, operation
    from catalog_observation where id <> 'old-discovery'
    order by target_kind, target_id, operation`)
    ).rows

  expect(await runNonMusicCatalogBackfill(film)).toMatchObject({
    scanned: 1,
    projected: 1,
    next: null,
  })
  expect(await runNonMusicCatalogBackfill(sources)).toMatchObject({
    scanned: 1,
    projected: 1,
    next: 'followed',
  })
  expect(await runNonMusicCatalogBackfill(video)).toMatchObject({
    scanned: 1,
    projected: 1,
    next: null,
  })
  expect(await observations()).toEqual([])
  expect(
    (
      await database.query(
        "select id from playlist where catalog_external_id = '654321'",
      )
    ).rows,
  ).toEqual([])

  for (let replay = 0; replay < 2; replay++) {
    await runNonMusicCatalogBackfill(film, true)
    await runNonMusicCatalogBackfill(sources, true)
    expect(
      await runNonMusicCatalogBackfill({ ...sources, after: 'followed' }, true),
    ).toMatchObject({ scanned: 1, projected: 1, next: 'unfollowed' })
    expect(
      await runNonMusicCatalogBackfill(
        { ...sources, after: 'unfollowed' },
        true,
      ),
    ).toMatchObject({ scanned: 0, projected: 0, next: null })
    await runNonMusicCatalogBackfill(video, true)
  }

  expect(await observations()).toMatchObject([
    {
      target_kind: 'collection',
      subject_id: 'film',
      snapshot_id: 'fixture-snapshot',
    },
    { target_kind: 'film', target_id: 'film', snapshot_id: 'fixture-snapshot' },
    {
      target_kind: 'subscription-item',
      target_id: 'video',
      subject_id: 'unfollowed',
      operation: 'stored-subscription-item',
    },
    {
      target_kind: 'subscription-source',
      target_id: 'followed',
      operation: 'stored-subscription-source',
    },
    {
      target_kind: 'subscription-source',
      target_id: 'unfollowed',
      operation: 'stored-subscription-source',
    },
  ])
  expect(
    (
      await database.query(`select subscribed, ss.added_to_library as source_added,
    si.added_to_library as item_added, si.watched_at::date::text as watched
    from subscription_item si join subscription_source ss on ss.id = si.source_id
    where si.id = 'video'`)
    ).rows,
  ).toEqual([
    {
      subscribed: false,
      source_added: false,
      item_added: false,
      watched: '2024-08-01',
    },
  ])
  expect(
    (
      await database.query(
        "select added_to_library from playlist where catalog_external_id = '654321'",
      )
    ).rows,
  ).toEqual([{ added_to_library: false }])
})
