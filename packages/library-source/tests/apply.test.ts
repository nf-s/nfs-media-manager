import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { applyRows } from '../src/apply'
import type { SqlValue, SqliteDriver } from '../src/driver'
import { globContains } from '../src/fold'
import { STORE_SCHEMA_VERSION } from '../src/schema'
import { openStore, readStoreStatus } from '../src/store'
import {
  albumPayload,
  artistPayload,
  drivers,
  filmPayload,
  live,
  playlistPayload,
  sharedPayloads,
  tombstone,
  trackPayload,
} from './fixtures'

const CountSchema = z.object({ count: z.number().int() })

async function count(
  driver: SqliteDriver,
  sql: string,
  params: SqlValue[] = [],
): Promise<number> {
  const [row] = await driver.all(`SELECT count(*) AS count FROM ${sql}`, params)
  return CountSchema.parse(row).count
}

async function column(
  driver: SqliteDriver,
  sql: string,
  params: SqlValue[] = [],
): Promise<SqlValue[]> {
  const rows = await driver.all(sql, params)
  return rows.map((row) => Object.values(row)[0] ?? null)
}

describe.each(drivers)('store on $name', ({ open }) => {
  let driver: SqliteDriver

  beforeEach(async () => {
    driver = await open()
    await openStore(driver)
  })

  afterEach(async () => {
    await driver.close()
  })

  it('creates the schema with its version and an empty sync state', async () => {
    expect(await column(driver, 'PRAGMA user_version')).toEqual([
      STORE_SCHEMA_VERSION,
    ])
    expect(await readStoreStatus(driver)).toMatchObject({
      ready: false,
      phase: 'empty',
      cursor: null,
    })
    await openStore(driver)
    expect(await count(driver, 'sync_state')).toBe(1)
  })

  it('drops and recreates a store with another schema version', async () => {
    await driver.transaction((tx) =>
      applyRows(tx, [live('track', 'track-1', 1, trackPayload('track-1'))]),
    )
    await driver.run('PRAGMA user_version = 999')
    await driver.run('CREATE TABLE leftover (id INTEGER)')
    await openStore(driver)
    expect(await count(driver, 'track')).toBe(0)
    expect(await count(driver, 'item_text_fts')).toBe(0)
    expect(await count(driver, "sqlite_schema WHERE name = 'leftover'")).toBe(0)
    expect(await column(driver, 'PRAGMA user_version')).toEqual([
      STORE_SCHEMA_VERSION,
    ])
  })

  it('fills every table from a row of every entity', async () => {
    await driver.transaction((tx) =>
      applyRows(tx, [
        live('track', 'track-1', 1, trackPayload('track-1')),
        live('album', 'album-1', 2, albumPayload('album-1')),
        live('film', 'film-1', 3, filmPayload('film-1')),
        live('artist', 'artist-1', 4, artistPayload('artist-1')),
        live('playlist', 'playlist-1', 5, playlistPayload('playlist-1')),
        live('playlist_job', 'spotify:example', 6, sharedPayloads.playlist_job),
        live('tag', 'tag-1', 7, sharedPayloads.tag),
        live('tag_key', 'album:dark ambient', 8, sharedPayloads.tag_key),
        live('scrobble_name', 'name-track-1', 9, sharedPayloads.scrobble_name),
        live('album_plays', 'album-1', 10, sharedPayloads.album_plays),
        live('artist_plays', 'artist-1', 11, sharedPayloads.artist_plays),
        live('meta', 'listening', 12, sharedPayloads.meta),
      ]),
    )

    for (const table of ['track', 'album', 'film', 'artist', 'playlist']) {
      expect(await count(driver, table)).toBe(1)
    }
    const [track] = await driver.all(
      `SELECT archived, album_id, natural_year, sort_title, date_added,
         json_extract(j.item, '$.title') AS title
       FROM track t JOIN item_json j ON j.entity = 'track' AND j.rid = t.rid`,
    )
    expect(track).toEqual({
      archived: 0,
      album_id: 'album-1',
      natural_year: 2001,
      sort_title: 'track track-1',
      date_added: 1_700_000_000_000_000,
      title: 'Track track-1',
    })

    expect(
      await column(
        driver,
        `SELECT field FROM item_text WHERE entity = 'track' ORDER BY field`,
      ),
    ).toEqual([
      'album',
      'albumLink',
      'artist',
      'hasTrackTags',
      'musicalKey',
      'playlist',
      'source',
      'spotifyMatch',
      'title',
    ])
    expect(
      await column(
        driver,
        `SELECT folded FROM item_text WHERE entity = 'track' AND field = 'title'`,
      ),
    ).toEqual(['track track-1'])
    expect(
      await count(
        driver,
        "item_text WHERE entity = 'album' AND field = 'pluginMood'",
      ),
    ).toBe(1)
    expect(
      await column(
        driver,
        `SELECT field FROM item_search WHERE entity = 'track' ORDER BY field`,
      ),
    ).toEqual(['albumTag', 'artistTag'])
    expect(
      await column(
        driver,
        `SELECT folded FROM item_search WHERE entity = 'artist' ORDER BY folded`,
      ),
    ).toEqual(['artist artist-1', 'artist artist-1, the'])

    // Nulls have no row; plugin numbers do.
    expect(await count(driver, "item_num WHERE entity = 'track'")).toBe(5)
    expect(
      await column(
        driver,
        `SELECT value FROM item_num WHERE entity = 'album' AND field = 'pluginScore'`,
      ),
    ).toEqual([7])
    expect(
      await column(
        driver,
        `SELECT value FROM item_sort WHERE entity = 'track' AND field = 'genre:track,artist'`,
      ),
    ).toEqual(['drone'])
    expect(
      await count(
        driver,
        "item_sort WHERE entity = 'track' AND field = 'genre:track'",
      ),
    ).toBe(0)
    expect(
      await column(
        driver,
        `SELECT value FROM item_sort WHERE entity = 'playlist' AND field = 'source'`,
      ),
    ).toEqual([3])
    expect(
      await column(
        driver,
        `SELECT value FROM item_sort WHERE entity = 'film' AND field = 'genre'`,
      ),
    ).toEqual(['drama'])

    expect(
      await driver.all(
        'SELECT entity, level, tag_id FROM item_tag ORDER BY entity, level',
      ),
    ).toEqual([
      { entity: 'album', level: 'tagIds', tag_id: 'tag-1' },
      { entity: 'album', level: 'trackTagIds', tag_id: 'tag-3' },
      { entity: 'film', level: 'tagIds', tag_id: 'tag-2' },
      { entity: 'track', level: 'albumTagIds', tag_id: 'tag-1' },
    ])
    expect(
      await driver.all(
        'SELECT entity, kind, key FROM item_artist_tag_key ORDER BY entity, kind',
      ),
    ).toEqual([
      { entity: 'album', kind: 'label', key: 'drone' },
      { entity: 'album', kind: 'raw', key: 'drone' },
      { entity: 'artist', kind: 'raw', key: 'drone' },
      { entity: 'track', kind: 'label', key: 'drone' },
      { entity: 'track', kind: 'raw', key: 'drone' },
    ])
    expect(
      await driver.all(
        `SELECT role, position, artist_id FROM item_credit WHERE entity = 'film'
         ORDER BY role, position`,
      ),
    ).toEqual([
      { role: 'actor', position: 0, artist_id: 'person-2' },
      { role: 'actor', position: 1, artist_id: 'person-3' },
      { role: 'director', position: 0, artist_id: 'person-1' },
    ])
    expect(
      await column(driver, 'SELECT playlist_id FROM item_playlist'),
    ).toEqual(['playlist-1'])
    expect(await column(driver, 'SELECT name_id FROM track_name')).toEqual([
      'name-track-1',
    ])

    expect(
      await driver.all(
        'SELECT media_type, key, hidden, alias_target_id FROM tag',
      ),
    ).toEqual([
      { media_type: 'album', key: 'ambient', hidden: 0, alias_target_id: null },
    ])
    expect(
      await column(driver, 'SELECT key FROM tag_identity ORDER BY key'),
    ).toEqual(['ambience', 'ambient music'])
    expect(
      await column(
        driver,
        `SELECT ancestor_key FROM tag_ancestor WHERE key = 'dark ambient' ORDER BY ancestor_key`,
      ),
    ).toEqual(['ambient', 'electronic'])

    expect(
      await driver.all(
        'SELECT entity, id, play_count FROM play_set ORDER BY entity',
      ),
    ).toEqual([
      { entity: 'album_plays', id: 'album-1', play_count: 1 },
      { entity: 'artist_plays', id: 'artist-1', play_count: 2 },
      { entity: 'scrobble_name', id: 'name-track-1', play_count: 3 },
    ])
    expect(
      await column(
        driver,
        'SELECT played_at FROM name_play ORDER BY played_at',
      ),
    ).toEqual([1_717_236_000, 1_717_236_000, 1_717_322_400])
    expect(await count(driver, 'album_play')).toBe(1)
    expect(await count(driver, 'artist_play')).toBe(2)
    expect(await column(driver, 'SELECT status FROM playlist_job')).toEqual([
      'succeeded',
    ])
    expect(
      await column(driver, "SELECT json_extract(value, '$.kind') FROM meta"),
    ).toEqual(['listening'])
  })

  it('replaces the derived rows of a changed row', async () => {
    await driver.transaction((tx) =>
      applyRows(tx, [
        live(
          'track',
          'track-1',
          1,
          trackPayload('track-1', {
            title: 'First Title',
            tagIds: ['tag-1', 'tag-2'],
          }),
        ),
      ]),
    )
    const [before] = await column(
      driver,
      "SELECT rid FROM track WHERE id = 'track-1'",
    )
    await driver.transaction((tx) =>
      applyRows(tx, [
        live(
          'track',
          'track-1',
          2,
          trackPayload('track-1', {
            title: 'Second Title',
            album: null,
            tagIds: ['tag-9'],
          }),
        ),
      ]),
    )
    expect(
      await column(driver, "SELECT rid FROM track WHERE id = 'track-1'"),
    ).toEqual([before])
    expect(
      await column(driver, "SELECT value FROM item_text WHERE field = 'title'"),
    ).toEqual(['Second Title'])
    expect(await count(driver, "item_text WHERE field = 'album'")).toBe(0)
    expect(await column(driver, 'SELECT tag_id FROM item_tag')).toEqual([
      'tag-9',
    ])
    expect(await count(driver, "item_sort WHERE field = 'album'")).toBe(0)
    expect(await column(driver, 'SELECT album_id FROM track')).toEqual([null])
    expect(
      await count(driver, 'item_text_fts WHERE folded GLOB ?', [
        globContains('First'),
      ]),
    ).toBe(0)
    expect(
      await count(driver, 'item_text_fts WHERE folded GLOB ?', [
        globContains('Second'),
      ]),
    ).toBe(1)
  })

  it('ignores a row older than the stored one', async () => {
    await driver.transaction((tx) =>
      applyRows(tx, [
        live('track', 'track-1', 5, trackPayload('track-1', { title: 'New' })),
        live('track', 'track-1', 3, trackPayload('track-1', { title: 'Old' })),
        tombstone('track', 'track-1', 4),
        live('tag', 'tag-1', 5, sharedPayloads.tag),
        tombstone('tag', 'tag-1', 2),
      ]),
    )
    expect(await column(driver, 'SELECT sort_title FROM track')).toEqual([
      'new',
    ])
    expect(await count(driver, 'tag')).toBe(1)
  })

  it('removes a row and its derived rows on a tombstone', async () => {
    await driver.transaction((tx) =>
      applyRows(tx, [
        live('track', 'track-1', 1, trackPayload('track-1')),
        live('track', 'track-2', 2, trackPayload('track-2')),
        live('artist', 'artist-1', 3, artistPayload('artist-1')),
        live('tag', 'tag-1', 4, sharedPayloads.tag),
        live('tag_key', 'album:dark ambient', 5, sharedPayloads.tag_key),
        live('scrobble_name', 'name-track-1', 6, sharedPayloads.scrobble_name),
        live('meta', 'listening', 7, sharedPayloads.meta),
      ]),
    )
    await driver.transaction((tx) =>
      applyRows(tx, [
        tombstone('track', 'track-1', 8),
        tombstone('artist', 'artist-1', 9),
        tombstone('tag', 'tag-1', 10),
        tombstone('tag_key', 'album:dark ambient', 11),
        tombstone('scrobble_name', 'name-track-1', 12),
        tombstone('meta', 'listening', 13),
        tombstone('film', 'film-never-seen', 14),
      ]),
    )
    expect(await column(driver, 'SELECT id FROM track')).toEqual(['track-2'])
    const [remaining] = await column(driver, 'SELECT rid FROM track')
    for (const table of [
      'item_json',
      'item_text',
      'item_search',
      'item_num',
      'item_sort',
      'item_tag',
      'item_artist_tag_key',
      'item_credit',
    ]) {
      expect(
        await count(
          driver,
          `${table} WHERE NOT (entity = 'track' AND rid = ?)`,
          [remaining ?? null],
        ),
      ).toBe(0)
    }
    expect(await count(driver, 'item_playlist')).toBe(0)
    expect(await count(driver, 'track_name')).toBe(1)
    expect(await count(driver, 'item_text_fts')).toBe(
      await count(driver, 'item_text'),
    )
    expect(
      await count(driver, 'item_search_fts WHERE folded GLOB ?', [
        globContains('artist'),
      ]),
    ).toBe(0)
    for (const table of [
      'artist',
      'tag',
      'tag_identity',
      'tag_key',
      'tag_ancestor',
      'play_set',
      'name_play',
      'meta',
    ]) {
      expect(await count(driver, table)).toBe(0)
    }
  })

  it('finds a substring case-insensitively through the trigram index', async () => {
    await driver.transaction((tx) =>
      applyRows(tx, [
        live(
          'track',
          'track-1',
          1,
          trackPayload('track-1', { title: 'Nocturne İn Blue' }),
        ),
        live(
          'track',
          'track-2',
          2,
          trackPayload('track-2', { title: 'ΣΟΦΙΑ Live' }),
        ),
        live(
          'track',
          'track-3',
          3,
          trackPayload('track-3', { title: 'Morning' }),
        ),
      ]),
    )
    const search = (word: string) =>
      column(
        driver,
        `SELECT t.id FROM item_text_fts f
         JOIN item_text v ON v.tid = f.rowid
         JOIN track t ON t.rid = v.rid
         WHERE f.folded GLOB ? AND v.entity = 'track' AND v.field = 'title'
         ORDER BY t.id`,
        [globContains(word)],
      )
    expect(await search('TURNE')).toEqual(['track-1'])
    expect(await search('İN BL')).toEqual(['track-1'])
    expect(await search('σοφ')).toEqual(['track-2'])
    expect(await search('ΣΟΦ')).toEqual(['track-2'])
    expect(await search('RN')).toEqual(['track-1', 'track-3'])
    expect(await search('*')).toEqual([])
  })
})
