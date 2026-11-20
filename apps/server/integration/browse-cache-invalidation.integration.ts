import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { env } from '@/env'

const suffix = randomUUID().replaceAll('-', '')
const name = `browse_cache_${suffix}`
const writerRole = `browse_writer_${suffix}`
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
  statement_timeout: 10000,
})
let databaseCreated = false
let roleCreated = false

beforeAll(async () => {
  await admin.connect()
  await admin.query(`create database ${name}`)
  databaseCreated = true
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
  await pool.query(`create role ${writerRole}`)
  roleCreated = true
  await pool.query(
    `grant update (title), select (id) on media_item to ${writerRole};
      grant update (latest_snapshot_id) on artist_provider_current_state to ${writerRole};`,
  )
})

beforeEach(async () => {
  await pool.query(`
    truncate media_item, playlist, artist, tag cascade;
    insert into media_item (id, slug, media_type, title) values
      ('film', 'film', 'film', 'Fixture film'),
      ('untagged-film', 'untagged-film', 'film', 'Fixture untagged film'),
      ('release', 'release', 'album', 'Fixture album'),
      ('track', 'track', 'track', 'Fixture track'),
      ('peer', 'peer', 'track', 'Fixture peer');
    insert into album (media_item_id) values ('release');
    insert into tag (id, media_type, name, kind) values
      ('film-tag', 'film', 'Fixture keyword', 'keyword'),
      ('other-film-tag', 'film', 'Fixture other keyword', 'keyword'),
      ('album-tag', 'album', 'Fixture tag', 'genre'),
      ('other-album-tag', 'album', 'Fixture other tag', 'genre');
    insert into media_item_tag values ('film', 'film-tag'), ('release', 'album-tag');
    insert into artist (id, name) values ('actor', 'Fixture actor'), ('artist', 'Fixture artist');
    insert into media_credit (media_item_id, artist_id, role)
    values ('film', 'actor', 'actor'), ('release', 'artist', 'artist');
    insert into library_track (media_item_id, album_media_item_id)
    values ('track', 'release'), ('peer', null);
    insert into playlist (id, name, kind) values
      ('list', 'Fixture playlist', 'playlist'), ('other', 'Fixture other playlist', 'playlist');
    insert into playlist_item (playlist_id, media_item_id) values ('list', 'track');
    insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy)
    values ('fixture-listener', 'artist', 'title', 'track', 'exact');
    insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
    values ('fixture-listener', 'artist', 'title', 'track');
  `)
  await clearMarkers()
})

afterAll(async () => {
  await pool.end()
  if (databaseCreated) await admin.query(`drop database ${name}`)
  if (roleCreated) await admin.query(`drop role ${writerRole}`)
  await admin.end()
})

function clearMarkers() {
  return pool.query(
    'delete from track_facet_dirty; delete from recording_browse_order_dirty',
  )
}

async function expectMarkers(facets: number, recordings = facets) {
  const { rows } = await pool.query(`
    select (select count(*)::int from track_facet_dirty) as facets,
      (select count(*)::int from recording_browse_order_dirty) as recordings
  `)
  expect(rows).toEqual([{ facets, recordings }])
}

describe('stored Track Browse invalidation', () => {
  it.each([
    "update media_item set title = 'Missing' where id = 'missing'",
    "update media_item set title = title where id = 'track'",
    `update media_item set metadata = '{"browse":{"rating":10},"legacyHidden":false}' where id = 'track'`,
    "update media_item set title = 'New film title' where id = 'film'",
    "insert into media_item (id, slug, media_type, title) values ('new-film', 'new-film', 'film', 'New film')",
    "delete from media_item where id = 'film'",
    "update library_track set album_name = album_name where media_item_id = 'track'",
    "insert into library_track (media_item_id) values ('track') on conflict do nothing",
    "insert into playlist_item (playlist_id, media_item_id, position) values ('list', 'track', 2) on conflict (playlist_id, media_item_id) do update set position = excluded.position",
    "delete from playlist_item where playlist_id = 'missing'",
    "insert into lastfm_track_link values ('fixture-listener', 'artist', 'title', 'track', 'exact') on conflict do nothing",
    "insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id) values ('fixture-listener', 'artist', 'title', 'track') on conflict (username, artist_key, track_key) do update set track_media_item_id = excluded.track_media_item_id",
    "insert into media_item_tag values ('film', 'film-tag') on conflict do nothing",
    "insert into media_item_tag values ('release', 'album-tag') on conflict do nothing",
    "insert into media_item_tag values ('film', 'other-film-tag')",
    "update media_item_tag set tag_id = 'other-film-tag' where media_item_id = 'film'",
    "update media_item_tag set tag_id = tag_id where media_item_id = 'release'",
    "update media_credit set artist_id = 'actor' where media_item_id = 'missing'",
    "insert into media_credit (media_item_id, artist_id, role) values ('release', 'artist', 'artist') on conflict do nothing",
    "insert into media_credit (media_item_id, artist_id, role) values ('film', 'artist', 'director')",
    "update media_credit set role = 'director' where media_item_id = 'film'",
    "update media_credit set billing_order = billing_order where media_item_id = 'release'",
  ])('preserves the cache for %s', async (statement) => {
    await pool.query(statement)
    await expectMarkers(0)
  })

  it.each([
    "update media_item set title = 'New release title' where id = 'release'",
    "update media_item set title = 'New track title' where id = 'track'",
    `update media_item set metadata = '{"legacyHidden":true}' where id = 'track'`,
    "update media_item set media_type = 'track' where id = 'untagged-film'",
    "update media_item set media_type = 'film' where id = 'track'",
    "insert into media_item (id, slug, media_type, title) values ('new-track', 'new-track', 'track', 'New track')",
    "update library_track set album_name = 'New album name' where media_item_id = 'track'",
    "update playlist_item set playlist_id = 'other' where playlist_id = 'list'",
    "delete from playlist_item where playlist_id = 'list'",
    "update lastfm_track_link set strategy = 'manual' where track_media_item_id = 'track'",
    "update lastfm_track_source set manually_matched = true where track_media_item_id = 'track'",
    "delete from media_item where id = 'track'",
    'truncate lastfm_track_source',
  ])('marks both caches for %s', async (statement) => {
    await pool.query(statement)
    await expectMarkers(1)
  })

  it('marks only facets for a new Spotify search source', async () => {
    await pool.query(
      `update media_item set metadata = '{"spotifyTrackSearch":null}' where id = 'track'`,
    )
    await expectMarkers(1, 0)
    await clearMarkers()
    await pool.query(
      `update media_item set metadata = '{"spotifyTrackSearch":{"verified":true}}' where id = 'track'`,
    )
    await expectMarkers(0)
  })

  it('marks only recording order for changed scrobble counts', async () => {
    await pool.query(
      "update library_track set scrobble_count = 1 where media_item_id = 'track'",
    )
    await expectMarkers(0, 1)
  })

  it.each([
    "insert into media_item_tag values ('release', 'other-album-tag')",
    "update media_item_tag set tag_id = 'other-album-tag' where media_item_id = 'release'",
    "update media_item_tag set media_item_id = 'film', tag_id = 'other-film-tag' where media_item_id = 'release'",
    "update media_item_tag set media_item_id = 'release', tag_id = 'other-album-tag' where media_item_id = 'film'",
    "delete from media_item_tag where media_item_id = 'release'",
    "delete from tag where id = 'album-tag'",
  ])(
    'marks facets when a release tag changes through %s',
    async (statement) => {
      await pool.query(statement)
      await expectMarkers(1, 0)
    },
  )

  it.each([
    "insert into media_credit (media_item_id, artist_id, role) values ('release', 'actor', 'artist')",
    "update media_credit set role = 'director' where media_item_id = 'release'",
    "update media_credit set role = 'artist' where media_item_id = 'film'",
    "update media_credit set artist_id = 'actor' where media_item_id = 'release'",
    "update media_credit set media_item_id = 'track' where media_item_id = 'release'",
    "delete from artist where id = 'artist'",
  ])(
    'marks both caches when an artist credit changes through %s',
    async (statement) => {
      await pool.query(statement)
      await expectMarkers(1)
    },
  )

  it('marks only recording order for changed artist billing order', async () => {
    await pool.query(
      "update media_credit set billing_order = 1 where media_item_id = 'release'",
    )
    await expectMarkers(0, 1)
  })

  it('preserves both caches when a film and its credits and tags are deleted', async () => {
    await pool.query("delete from media_item where id = 'film'")
    await expectMarkers(0)
  })

  it('preserves release dependencies across media types', async () => {
    await pool.query("insert into album (media_item_id) values ('film')")
    await pool.query(
      "update library_track set album_media_item_id = 'film' where media_item_id = 'track'",
    )
    await clearMarkers()
    await pool.query(
      "update media_item set title = 'New release title' where id = 'film'",
    )
    await expectMarkers(1)
  })

  it('preserves Last.fm visibility dependencies across media types', async () => {
    await pool.query(`
      insert into library_track (media_item_id) values ('film');
      insert into lastfm_track_link values
      ('fixture-listener', 'artist', 'title', 'film', 'exact')
    `)
    await clearMarkers()
    await pool.query(
      `update media_item set metadata = '{"legacyHidden":true}' where id = 'film'`,
    )
    await expectMarkers(1)
  })

  it('preserves the vocabulary when tagged history is saved without publication', async () => {
    await pool.query(`
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      values ('historic', 'artist', 'fixture', '{}', '{"tags":["Fixture tag"]}');
    `)
    await expectMarkers(0)
  })

  it('preserves the vocabulary when a profile publishes no usable tags', async () => {
    await pool.query(`
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      values ('empty', 'artist', 'fixture', '{}', '{"tags":[" ",null]}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      values ('artist', 'fixture', 'empty');
    `)
    await expectMarkers(0)
  })

  it('preserves equivalent tag sets when replacing and editing the current profile', async () => {
    await pool.query(`
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      values ('before', 'artist', 'fixture', '{}', '{"tags":["One","Two"]}'),
             ('equivalent', 'artist', 'fixture', '{}', '{"tags":[" two ","ONE","One",""],"url":"https://example.com/"}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      values ('artist', 'fixture', 'before');
    `)
    await expectMarkers(1, 0)
    await clearMarkers()
    await pool.query(`
      update artist_provider_current_state set latest_snapshot_id = 'equivalent';
      update artist_provider_snapshot set normalized_data = '{"tags":["one","two"],"bio":"Fixture"}'
      where id = 'equivalent';
    `)
    await expectMarkers(0)
  })

  it.each([
    "update artist_provider_current_state set latest_snapshot_id = 'tagged'",
    `update artist_provider_snapshot set normalized_data = '{"tags":["replacement"]}' where id = 'first'`,
    "update artist_provider_current_state set artist_id = 'actor'",
    "update artist_provider_current_state set latest_snapshot_id = 'empty'",
    'delete from artist_provider_current_state',
    "delete from artist_provider_snapshot where id = 'first'",
    'truncate artist_provider_snapshot cascade',
  ])('marks facets for artist tag changes through %s', async (statement) => {
    await pool.query(`
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      values ('first', 'artist', 'fixture', '{}', '{"tags":["first"]}'),
             ('tagged', 'artist', 'fixture', '{}', '{"tags":["tagged"]}'),
             ('empty', 'artist', 'fixture', '{}', '{}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      values ('artist', 'fixture', 'first');
    `)
    await clearMarkers()
    await pool.query(statement)
    await expectMarkers(1, 0)
  })

  it('lets a restricted writer publish tags and rolls the marker back with the publication', async () => {
    await pool.query(`
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      values ('empty', 'artist', 'fixture', '{}', '{}'),
             ('tagged', 'artist', 'fixture', '{}', '{"tags":["tagged"]}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      values ('artist', 'fixture', 'empty');
    `)
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`set local role ${writerRole}`)
      await client.query(`
        create temporary table old_rows (unrelated integer) on commit drop;
        create temporary table new_rows (unrelated integer) on commit drop;
        create temporary table artist_provider_snapshot (unrelated integer) on commit drop;
        update public.artist_provider_current_state set latest_snapshot_id = 'tagged';
      `)
      await expectMarkers(0)
      await client.query('rollback')
      await expectMarkers(0)
      await client.query('begin')
      await client.query(`set local role ${writerRole}`)
      await client.query(
        "update artist_provider_current_state set latest_snapshot_id = 'tagged'",
      )
      await client.query('commit')
      await expectMarkers(1, 0)
    } finally {
      await client.query('rollback')
      client.release()
    }
  })

  it('checks the latest snapshot tags after a concurrent edit commits', async () => {
    await pool.query(`
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data)
      values ('first', 'artist', 'fixture', '{}', '{"tags":["equivalent"]}'),
             ('next', 'artist', 'fixture', '{}', '{"tags":["equivalent"]}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id)
      values ('artist', 'fixture', 'first');
    `)
    await clearMarkers()
    const editor = await pool.connect()
    const publisher = await pool.connect()
    try {
      const { rows } = await publisher.query(
        'select pg_backend_pid() as publisher_pid',
      )
      const pid = rows[0]?.publisher_pid
      await editor.query('begin')
      await editor.query(`
        update artist_provider_snapshot set normalized_data = '{"tags":["changed"]}'
        where id = 'next'
      `)
      await publisher.query('begin')
      const { rows: writer } = await publisher.query(
        'select txid_current() as transaction_id',
      )
      const publication = publisher.query(
        "update artist_provider_current_state set latest_snapshot_id = 'next'",
      )
      try {
        await expect
          .poll(async () => {
            const { rows } = await admin.query(
              'select cardinality(pg_blocking_pids($1)) as blockers',
              [pid],
            )
            return rows[0]?.blockers
          })
          .toBe(1)
      } finally {
        await editor.query('commit')
        await publication
      }
      await publisher.query('commit')
      const { rows: markers } = await publisher.query(`
        select transaction_id from track_facet_dirty order by transaction_id
      `)
      expect(markers).toEqual(writer)
    } finally {
      await editor.query('rollback')
      await publisher.query('rollback')
      editor.release()
      publisher.release()
    }
  })

  it('allows a restricted writer to mark dirty and publishes only after commit', async () => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`set local role ${writerRole}`)
      const { rows } = await client.query(
        `select has_function_privilege('mark_browse_cache_dirty()', 'execute') as can_execute`,
      )
      expect(rows).toEqual([{ can_execute: false }])
      await expect(
        client.query('select transaction_id from track_facet_dirty'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('rollback')

      await client.query('begin')
      await client.query(`set local role ${writerRole}`)
      await client.query(`
        create temporary table old_rows (unrelated integer) on commit drop;
        create temporary table new_rows (unrelated integer) on commit drop;
        update media_item set title = 'New track title' where id = 'track';
      `)
      await expectMarkers(0)
      await clearMarkers()
      await client.query('commit')
      await expectMarkers(1)
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
})
