import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { env } from '@/env'

const name = `album_tracks_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const database = new pg.Client({ ...connection, database: name })
const migrations = readMigrationFiles({ migrationsFolder: './drizzle' })
const migrationIndex = migrations.findIndex((migration) =>
  migration.sql.some((statement) =>
    statement.includes('CREATE FUNCTION resolve_album_library_tracks'),
  ),
)
let created = false

beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
  await admin.connect()
  await admin.query(`create database ${name}`)
  created = true
  await database.connect()
  for (const migration of migrations.slice(0, migrationIndex)) {
    await database.query('begin')
    for (const statement of migration.sql) await database.query(statement)
    await database.query('commit')
  }
})

afterAll(async () => {
  await database.end()
  if (created) await admin.query(`drop database ${name}`)
  await admin.end()
  vi.unstubAllGlobals()
})

it('backfills every stored position and preserves confirmed recording identities and source evidence', async () => {
  const spotifyId = 'AlbumTrack000000000001'
  await database.query(`
    insert into media_item (id, media_type, slug, title, source_label) values
      ('fixture-album', 'album', 'fixture-album', 'Fixture Album', null),
      ('second-album', 'album', 'second-album', 'Second Album', null),
      ('spotify-fixture', 'track', 'spotify-fixture', 'Shared Recording', 'spotify'),
      ('lastfm-repeated', 'track', 'lastfm-repeated', 'Repeated Recording', 'lastfm'),
      ('lastfm-redundant', 'track', 'lastfm-redundant', 'Shared Recording', 'lastfm'),
      ('lastfm-unidentified', 'track', 'lastfm-unidentified', 'Unidentified Recording', 'lastfm');
    insert into artist (id, name) values ('fixture-artist', 'Fixture Artist');
    insert into media_credit (media_item_id, artist_id, role)
    select id, 'fixture-artist', 'artist' from media_item;
    insert into album (media_item_id, track_count)
    values ('fixture-album', 5), ('second-album', 1);
    insert into library_track (media_item_id, spotify_track_id, album_media_item_id, date_added)
    values
      ('spotify-fixture', '${spotifyId}', 'fixture-album', '2023-05-06'),
      ('lastfm-repeated', null, 'fixture-album', '2022-02-03'),
      ('lastfm-redundant', null, 'fixture-album', '2021-04-05'),
      ('lastfm-unidentified', null, 'fixture-album', '2020-01-02');
    insert into playlist (id, kind, name) values ('fixture-playlist', 'playlist', 'Fixture Playlist');
    insert into playlist_item (playlist_id, media_item_id, position, added_at)
    values
      ('fixture-playlist', 'spotify-fixture', 2, '2023-05-06'),
      ('fixture-playlist', 'lastfm-redundant', 1, '2022-01-02');
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    values
      ('fixture-listener', 'fixture artist', 'shared recording', 'lastfm-redundant'),
      ('fixture-listener', 'fixture artist', 'repeated recording', 'lastfm-repeated'),
      ('fixture-listener', 'fixture artist', 'unidentified recording', 'lastfm-unidentified');
    insert into lastfm_scrobble
      (id, username, artist_key, artist_name, track_key, track_name, listened_at)
    values ('fixture-scrobble', 'fixture-listener', 'fixture artist', 'Fixture Artist',
      'shared recording', 'Shared Recording', '2021-04-05');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    values ('fixture-listener', 'fixture artist', 'shared recording', 'lastfm-redundant', 'exact');
    insert into track (id, album_media_item_id, title, position, duration_sec, external_id) values
      ('new-entry', 'fixture-album', 'Fixture Recording', 1, 120, null),
      ('shared-entry-a', 'fixture-album', 'Shared Recording', 2, 180, '${spotifyId}'),
      ('repeated-a', 'fixture-album', 'Repeated Recording', 3, 10, null),
      ('repeated-b', 'fixture-album', 'Repeated Recording', 4, 40, null),
      ('unidentified-entry', 'fixture-album', 'Unidentified Recording', 5, 90, 'fixture-provider-id'),
      ('shared-entry-b', 'second-album', 'Shared Recording', 1, 150, '${spotifyId}')
  `)

  const before = await database.query(`
    select mi.title from library_track lt join media_item mi on mi.id = lt.media_item_id
    where mi.title = 'Fixture Recording'
  `)
  expect(before.rows).toEqual([])

  const migration = migrations[migrationIndex]
  if (!migration) throw new Error('Missing album track migration')
  await database.query('begin')
  for (const statement of migration.sql) await database.query(statement)
  await database.query('commit')

  const entries = await database.query(`
    select t.id, t.position, t.duration_sec, t.track_media_item_id, lt.spotify_track_id
    from track t join library_track lt on lt.media_item_id = t.track_media_item_id
    order by t.album_media_item_id, t.position
  `)
  expect(entries.rows).toEqual([
    {
      id: 'new-entry',
      position: 1,
      duration_sec: 120,
      track_media_item_id: expect.any(String),
      spotify_track_id: null,
    },
    {
      id: 'shared-entry-a',
      position: 2,
      duration_sec: 180,
      track_media_item_id: 'spotify-fixture',
      spotify_track_id: spotifyId,
    },
    {
      id: 'repeated-a',
      position: 3,
      duration_sec: 10,
      track_media_item_id: expect.any(String),
      spotify_track_id: null,
    },
    {
      id: 'repeated-b',
      position: 4,
      duration_sec: 40,
      track_media_item_id: expect.any(String),
      spotify_track_id: null,
    },
    {
      id: 'unidentified-entry',
      position: 5,
      duration_sec: 90,
      track_media_item_id: 'lastfm-unidentified',
      spotify_track_id: null,
    },
    {
      id: 'shared-entry-b',
      position: 1,
      duration_sec: 150,
      track_media_item_id: 'spotify-fixture',
      spotify_track_id: spotifyId,
    },
  ])
  expect(
    new Set(entries.rows.map((row) => row.track_media_item_id)),
  ).toHaveProperty('size', 5)
  expect(
    entries.rows.some((row) => row.track_media_item_id === 'lastfm-repeated'),
  ).toBe(false)

  const sources = await database.query(`
    select track_key, track_media_item_id, manually_matched from lastfm_track_source order by track_key
  `)
  expect(sources.rows).toEqual([
    {
      track_key: 'repeated recording',
      track_media_item_id: 'lastfm-repeated',
      manually_matched: false,
    },
    {
      track_key: 'shared recording',
      track_media_item_id: 'spotify-fixture',
      manually_matched: false,
    },
    {
      track_key: 'unidentified recording',
      track_media_item_id: 'lastfm-unidentified',
      manually_matched: false,
    },
  ])
  const shared = await database.query(`
    select lt.media_item_id, lt.scrobble_count, lt.last_listened_at::date::text as last_listened,
      lt.date_added::date::text as date_added, pi.position, pi.added_at::date::text as playlist_added
    from library_track lt join playlist_item pi on pi.media_item_id = lt.media_item_id
    where lt.media_item_id in ('spotify-fixture', 'lastfm-redundant')
  `)
  expect(shared.rows).toEqual([
    {
      media_item_id: 'spotify-fixture',
      scrobble_count: 1,
      last_listened: '2021-04-05',
      date_added: '2021-04-05',
      position: 1,
      playlist_added: '2022-01-02',
    },
  ])

  await database.query("delete from media_item where id = 'fixture-album'")
  await expect(
    database.query("delete from media_item where id = 'spotify-fixture'"),
  ).rejects.toMatchObject({
    code: '23503',
  })
  const kept = await database.query(`
    select t.track_media_item_id from track t where t.album_media_item_id = 'second-album'
  `)
  expect(kept.rows).toEqual([{ track_media_item_id: 'spotify-fixture' }])
})
