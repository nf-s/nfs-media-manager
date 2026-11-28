import { z } from 'zod'
import type {
  DeviceAlbumRow,
  DeviceArtistRow,
  DeviceEntity,
  DeviceFilmRow,
  DeviceLibraryPlaylistRow,
  DeviceLiveRow,
  DevicePlaylistRow,
  DeviceRow,
  DeviceTrackRow,
} from '@repo/schemas/device'
import type { SqlValue, SqliteExecutor } from './driver'
import { foldText, isFoldRow, readTextFold, type TextFold } from './fold'
import type { ItemEntity } from './schema'

/**
 * Writes feed rows into the store (DEVICE-21, DEVICE-28). Applying a live
 * row replaces it and every row derived from it; a tombstone removes both.
 * A row older than the stored one (a lower `seq`) is ignored, so a row seen
 * twice or out of order is harmless. Run it inside the page's transaction.
 *
 * Item text is folded with the stored `meta` row `fold`, which a fill
 * applies first; an item row while the store has none throws, so the page
 * is not committed.
 */
export async function applyRows(
  tx: SqliteExecutor,
  rows: readonly DeviceRow[],
): Promise<void> {
  let fold: TextFold | undefined
  const folds = async () => {
    fold ??= await readTextFold(tx)
    if (fold === undefined)
      throw new Error(
        'An item row arrived before the fold row; its text cannot be folded.',
      )
    return fold
  }
  for (const row of rows) {
    if (row.deleted) await removeRow(tx, row.entity, row.id, row.seq)
    else await applyLiveRow(tx, row, folds)
    if (isFoldRow(row.entity, row.id)) fold = undefined
  }
}

const SeqRowSchema = z.object({ seq: z.number().int() })
const ItemKeySchema = z.object({ rid: z.number().int(), seq: z.number().int() })
const PlaySetKeySchema = z.object({
  pid: z.number().int(),
  seq: z.number().int(),
})
const RidSchema = z.object({ rid: z.number().int() })
const PidSchema = z.object({ pid: z.number().int() })

/** The derived tables of each item entity. */
const DERIVED_TABLES: Record<ItemEntity, readonly string[]> = {
  track: [
    'item_json',
    'item_text',
    'item_search',
    'item_num',
    'item_sort',
    'item_tag',
    'item_artist_tag_key',
    'item_credit',
  ],
  album: [
    'item_json',
    'item_text',
    'item_search',
    'item_num',
    'item_sort',
    'item_tag',
    'item_artist_tag_key',
    'item_credit',
  ],
  film: [
    'item_json',
    'item_text',
    'item_search',
    'item_num',
    'item_sort',
    'item_tag',
    'item_credit',
  ],
  artist: [
    'item_json',
    'item_text',
    'item_search',
    'item_num',
    'item_sort',
    'item_artist_tag_key',
    'item_playlist',
  ],
  playlist: ['item_json', 'item_search', 'item_num', 'item_sort'],
  library_playlist: ['item_json', 'item_search'],
}

const PLAY_TABLES = {
  scrobble_name: 'name_play',
  album_plays: 'album_play',
  artist_plays: 'artist_play',
} as const
type PlayEntity = keyof typeof PLAY_TABLES

async function applyLiveRow(
  tx: SqliteExecutor,
  row: DeviceLiveRow,
  folds: () => Promise<TextFold>,
): Promise<void> {
  switch (row.entity) {
    case 'track':
      return writeTrack(tx, await folds(), row.id, row.seq, row.payload)
    case 'album':
      return writeAlbum(tx, await folds(), row.id, row.seq, row.payload)
    case 'film':
      return writeFilm(tx, await folds(), row.id, row.seq, row.payload)
    case 'artist':
      return writeArtist(tx, await folds(), row.id, row.seq, row.payload)
    case 'playlist':
      return writePlaylist(tx, await folds(), row.id, row.seq, row.payload)
    case 'library_playlist':
      return writeLibraryPlaylist(
        tx,
        await folds(),
        row.id,
        row.seq,
        row.payload,
      )
    case 'playlist_job':
      if (!(await isNewer(tx, 'playlist_job', row.id, row.seq))) return
      await tx.run(
        `INSERT INTO playlist_job (id, seq, status, job) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq,
           status = excluded.status, job = excluded.job`,
        [row.id, row.seq, row.payload.status, JSON.stringify(row.payload)],
      )
      return
    case 'meta':
      if (!(await isNewer(tx, 'meta', row.id, row.seq))) return
      await tx.run(
        `INSERT INTO meta (id, seq, value) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, value = excluded.value`,
        [row.id, row.seq, JSON.stringify(row.payload)],
      )
      return
    case 'tag':
      if (!(await isNewer(tx, 'tag', row.id, row.seq))) return
      await tx.run(
        `INSERT INTO tag (id, seq, media_type, name, key, kind, hidden, alias_target_id, sonovault)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq,
           media_type = excluded.media_type, name = excluded.name,
           key = excluded.key, kind = excluded.kind, hidden = excluded.hidden,
           alias_target_id = excluded.alias_target_id, sonovault = excluded.sonovault`,
        [
          row.id,
          row.seq,
          row.payload.mediaType,
          row.payload.name,
          row.payload.key,
          row.payload.kind,
          flag(row.payload.hidden),
          row.payload.aliasTargetId,
          flag(row.payload.sonovault),
        ],
      )
      await tx.run('DELETE FROM tag_identity WHERE tag_id = ?', [row.id])
      await insertJson(
        tx,
        `INSERT INTO tag_identity (tag_id, key) SELECT ?, value FROM json_each(?)`,
        [row.id],
        distinct(row.payload.identityKeys),
      )
      return
    case 'tag_key': {
      if (!(await isNewer(tx, 'tag_key', row.id, row.seq))) return
      await removeTagKey(tx, row.id)
      const { mediaType, key, ancestorKeys } = row.payload
      await tx.run(
        'INSERT INTO tag_key (id, seq, media_type, key) VALUES (?, ?, ?, ?)',
        [row.id, row.seq, mediaType, key],
      )
      await insertJson(
        tx,
        `INSERT INTO tag_ancestor (media_type, key, ancestor_key)
         SELECT ?, ?, value FROM json_each(?)`,
        [mediaType, key],
        distinct(ancestorKeys),
      )
      return
    }
    case 'scrobble_name':
    case 'album_plays':
    case 'artist_plays':
      return writePlays(tx, row.entity, row.id, row.seq, row.payload.plays)
  }
}

async function removeRow(
  tx: SqliteExecutor,
  entity: DeviceEntity,
  id: string,
  seq: number,
): Promise<void> {
  switch (entity) {
    case 'track':
    case 'album':
    case 'film':
    case 'artist':
    case 'playlist':
    case 'library_playlist': {
      const existing = await readItemKey(tx, entity, id)
      if (existing === null || existing.seq > seq) return
      await removeDerived(tx, entity, existing.rid)
      await tx.run(`DELETE FROM ${entity} WHERE rid = ?`, [existing.rid])
      return
    }
    case 'tag':
      if (!(await isNewer(tx, 'tag', id, seq))) return
      await tx.run('DELETE FROM tag_identity WHERE tag_id = ?', [id])
      await tx.run('DELETE FROM tag WHERE id = ?', [id])
      return
    case 'tag_key':
      if (!(await isNewer(tx, 'tag_key', id, seq))) return
      await removeTagKey(tx, id)
      return
    case 'playlist_job':
    case 'meta':
      if (!(await isNewer(tx, entity, id, seq))) return
      await tx.run(`DELETE FROM ${entity} WHERE id = ?`, [id])
      return
    case 'scrobble_name':
    case 'album_plays':
    case 'artist_plays': {
      const existing = await readPlaySetKey(tx, entity, id)
      if (existing === null || existing.seq > seq) return
      await tx.run(`DELETE FROM ${PLAY_TABLES[entity]} WHERE pid = ?`, [
        existing.pid,
      ])
      await tx.run('DELETE FROM play_set WHERE pid = ?', [existing.pid])
      return
    }
  }
}

// Item entities

async function writeTrack(
  tx: SqliteExecutor,
  fold: TextFold,
  id: string,
  seq: number,
  row: DeviceTrackRow,
): Promise<void> {
  const { extra, sort, num } = row
  const { natural, genre, ...flatSort } = sort
  const rid = await writeItem(tx, 'track', id, seq, row.item, {
    archived: flag(extra.archived),
    redundant_placeholder: flag(extra.redundantPlaceholder),
    album_id: extra.albumId,
    has_own_tags: flag(extra.hasOwnTags),
    album_release_tag_count: extra.albumReleaseTagCount,
    recording_key: extra.recording.key,
    recording_shown: flag(extra.recording.shown),
    recording_playable: flag(extra.recording.playable),
    recording_linked: flag(extra.recording.linked),
    recording_release_date: extra.recording.releaseDate,
    natural_artist: natural.artist,
    natural_album_date: natural.albumDate,
    natural_year: natural.year,
    natural_spotify_album_id: natural.spotifyAlbumId,
    natural_position: natural.position,
    sort_title: sort.title,
    sort_artist: sort.artist,
    sort_album: sort.album,
    sort_release_date: sort.releaseDate,
    date_added: num.dateAdded,
    scrobbles: num.scrobbles,
    last_listened_at: num.lastListenedAt,
  })
  if (rid === null) return
  await writeValues(tx, fold, 'track', rid, {
    text: row.text,
    search: row.search,
    num,
    sort: { ...flatSort, ...locationSort(genre) },
    tags: {
      ownTagIds: extra.ownTagIds,
      ownSonovaultTagIds: extra.ownSonovaultTagIds,
      albumTagIds: extra.albumTagIds,
    },
    artistTagKeys: {
      raw: extra.artistTagKeys,
      label: extra.artistTagLabelKeys,
    },
    credits: { artist: extra.artistIds },
  })
  await insertJson(
    tx,
    'INSERT INTO track_name (rid, name_id) SELECT ?, value FROM json_each(?)',
    [rid],
    distinct(extra.scrobbleNameIds),
  )
}

async function writeAlbum(
  tx: SqliteExecutor,
  fold: TextFold,
  id: string,
  seq: number,
  row: DeviceAlbumRow,
): Promise<void> {
  const { extra, sort, num } = row
  const { genre, ...flatSort } = sort
  const rid = await writeItem(tx, 'album', id, seq, row.item, {
    archived: flag(extra.archived),
    is_edition: flag(extra.isEdition),
    release_tag_count: extra.releaseTagCount,
    sort_title: sort.title,
    sort_artist: sort.artist,
    release_date: num.releaseDate,
    date_added: num.dateAdded,
  })
  if (rid === null) return
  await writeValues(tx, fold, 'album', rid, {
    text: row.text,
    search: row.search,
    num,
    sort: { ...flatSort, ...locationSort(genre) },
    tags: { tagIds: extra.tagIds, trackTagIds: extra.trackTagIds },
    artistTagKeys: {
      raw: extra.artistTagKeys,
      label: extra.artistTagLabelKeys,
    },
    credits: { artist: extra.artistIds },
  })
}

async function writeFilm(
  tx: SqliteExecutor,
  fold: TextFold,
  id: string,
  seq: number,
  row: DeviceFilmRow,
): Promise<void> {
  const { extra, sort, num } = row
  const rid = await writeItem(tx, 'film', id, seq, row.item, {
    archived: flag(extra.archived),
    source_kind: extra.sourceKind,
    sort_title: sort.title,
    release_date: num.releaseDate,
    date_added: num.dateAdded,
  })
  if (rid === null) return
  await writeValues(tx, fold, 'film', rid, {
    text: row.text,
    search: row.search,
    num,
    sort,
    tags: { tagIds: extra.tagIds },
    credits: {
      director: extra.creditIds.director,
      actor: extra.creditIds.actor,
    },
  })
}

async function writeArtist(
  tx: SqliteExecutor,
  fold: TextFold,
  id: string,
  seq: number,
  row: DeviceArtistRow,
): Promise<void> {
  const { extra, sort, num } = row
  const rid = await writeItem(tx, 'artist', id, seq, row.item, {
    sort_name: sort.name,
    created_at: num.createdAt,
    scrobbles: num.scrobbles,
  })
  if (rid === null) return
  await writeValues(tx, fold, 'artist', rid, {
    text: row.text,
    search: row.search,
    num,
    sort,
    artistTagKeys: { raw: extra.rawTagKeys },
  })
  await insertJson(
    tx,
    `INSERT INTO item_playlist (entity, rid, playlist_id)
     SELECT 'artist', ?, value FROM json_each(?)`,
    [rid],
    distinct(extra.playlistIds),
  )
}

async function writePlaylist(
  tx: SqliteExecutor,
  fold: TextFold,
  id: string,
  seq: number,
  row: DevicePlaylistRow,
): Promise<void> {
  const { extra, sort, num } = row
  const rid = await writeItem(tx, 'playlist', id, seq, row.item, {
    source: extra.source,
    sync_group_key: extra.syncGroupKey,
    sort_name: sort.name,
    added: num.added,
  })
  if (rid === null) return
  await writeValues(tx, fold, 'playlist', rid, {
    text: row.text,
    search: row.search,
    num,
    sort,
  })
}

async function writeLibraryPlaylist(
  tx: SqliteExecutor,
  fold: TextFold,
  id: string,
  seq: number,
  row: DeviceLibraryPlaylistRow,
): Promise<void> {
  const { extra, sort, num } = row
  const rid = await writeItem(tx, 'library_playlist', id, seq, row.item, {
    library: extra.library,
    type: extra.type,
    has_view: flag(extra.hasView),
    sort_name: sort.name,
    entry_count: num.count,
    updated: num.updated,
    added: num.added,
    summary: JSON.stringify(row.summary),
  })
  if (rid === null) return
  await writeValues(tx, fold, 'library_playlist', rid, {
    text: row.text,
    search: row.search,
    num: {},
    sort: {},
  })
  await insertJson(
    tx,
    `INSERT INTO library_playlist_item (rid, item_id)
     SELECT ?, value FROM json_each(?)`,
    [rid],
    distinct(extra.members),
  )
}

/**
 * Inserts or replaces one item row. Returns its `rid` with its derived rows
 * removed, or null when the stored row is newer.
 */
async function writeItem(
  tx: SqliteExecutor,
  entity: ItemEntity,
  id: string,
  seq: number,
  item: unknown,
  columns: Record<string, SqlValue>,
): Promise<number | null> {
  const names = Object.keys(columns)
  const values = Object.values(columns)
  const existing = await readItemKey(tx, entity, id)
  let rid: number
  if (existing === null) {
    const placeholders = names.map(() => ', ?').join('')
    const [inserted] = await tx.all(
      `INSERT INTO ${entity} (id, seq, ${names.join(', ')})
       VALUES (?, ?${placeholders}) RETURNING rid`,
      [id, seq, ...values],
    )
    rid = RidSchema.parse(inserted).rid
  } else {
    if (existing.seq > seq) return null
    rid = existing.rid
    await removeDerived(tx, entity, rid)
    const assignments = names.map((name) => `, ${name} = ?`).join('')
    await tx.run(`UPDATE ${entity} SET seq = ?${assignments} WHERE rid = ?`, [
      seq,
      ...values,
      rid,
    ])
  }
  await tx.run('INSERT INTO item_json (entity, rid, item) VALUES (?, ?, ?)', [
    entity,
    rid,
    JSON.stringify(item),
  ])
  return rid
}

type ItemValues = {
  text: Record<string, readonly string[]>
  search: Record<string, readonly string[]>
  num: Record<string, number | null>
  sort: Record<string, string | number | null>
  tags?: Record<string, readonly string[]>
  artistTagKeys?: { raw: readonly string[]; label?: readonly string[] }
  credits?: Record<string, readonly string[]>
}

async function writeValues(
  tx: SqliteExecutor,
  fold: TextFold,
  entity: ItemEntity,
  rid: number,
  values: ItemValues,
): Promise<void> {
  const text: [string, string, string][] = []
  for (const [field, list] of Object.entries(values.text)) {
    for (const value of distinct(list))
      text.push([field, value, foldText(value, fold)])
  }
  await insertJson(
    tx,
    `INSERT INTO item_text (entity, rid, field, value, folded)
     SELECT ?, ?, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)`,
    [entity, rid],
    text,
  )

  const search: [string, string][] = []
  for (const [field, list] of Object.entries(values.search)) {
    const folded = distinct(list.map((value) => foldText(value, fold)))
    for (const value of folded) search.push([field, value])
  }
  await insertJson(
    tx,
    `INSERT INTO item_search (entity, rid, field, folded)
     SELECT ?, ?, value ->> 0, value ->> 1 FROM json_each(?)`,
    [entity, rid],
    search,
  )

  await insertJson(
    tx,
    `INSERT INTO item_num (entity, rid, field, value)
     SELECT ?, ?, value ->> 0, value ->> 1 FROM json_each(?)`,
    [entity, rid],
    presentEntries(values.num),
  )

  await insertJson(
    tx,
    `INSERT INTO item_sort (entity, rid, field, value)
     SELECT ?, ?, value ->> 0, value ->> 1 FROM json_each(?)`,
    [entity, rid],
    presentEntries(values.sort),
  )

  const tags: [string, string][] = []
  for (const [level, ids] of Object.entries(values.tags ?? {})) {
    for (const tagId of distinct(ids)) tags.push([level, tagId])
  }
  await insertJson(
    tx,
    `INSERT INTO item_tag (entity, rid, level, tag_id)
     SELECT ?, ?, value ->> 0, value ->> 1 FROM json_each(?)`,
    [entity, rid],
    tags,
  )

  const keys: [string, string][] = []
  const artistTagKeys = values.artistTagKeys
  if (artistTagKeys !== undefined) {
    for (const key of distinct(artistTagKeys.raw)) keys.push(['raw', key])
    for (const key of distinct(artistTagKeys.label ?? [])) {
      keys.push(['label', key])
    }
  }
  await insertJson(
    tx,
    `INSERT INTO item_artist_tag_key (entity, rid, kind, key)
     SELECT ?, ?, value ->> 0, value ->> 1 FROM json_each(?)`,
    [entity, rid],
    keys,
  )

  const credits: [string, number, string][] = []
  for (const [role, ids] of Object.entries(values.credits ?? {})) {
    distinct(ids).forEach((artistId, position) =>
      credits.push([role, position, artistId]),
    )
  }
  await insertJson(
    tx,
    `INSERT INTO item_credit (entity, rid, role, position, artist_id)
     SELECT ?, ?, value ->> 0, value ->> 1, value ->> 2 FROM json_each(?)`,
    [entity, rid],
    credits,
  )
}

async function removeDerived(
  tx: SqliteExecutor,
  entity: ItemEntity,
  rid: number,
): Promise<void> {
  for (const table of DERIVED_TABLES[entity]) {
    await tx.run(`DELETE FROM ${table} WHERE entity = ? AND rid = ?`, [
      entity,
      rid,
    ])
  }
  if (entity === 'track') {
    await tx.run('DELETE FROM track_name WHERE rid = ?', [rid])
  }
  if (entity === 'library_playlist') {
    await tx.run('DELETE FROM library_playlist_item WHERE rid = ?', [rid])
  }
}

async function readItemKey(
  tx: SqliteExecutor,
  entity: ItemEntity,
  id: string,
): Promise<{ rid: number; seq: number } | null> {
  const [row] = await tx.all(`SELECT rid, seq FROM ${entity} WHERE id = ?`, [
    id,
  ])
  return row === undefined ? null : ItemKeySchema.parse(row)
}

// Shared rows

async function writePlays(
  tx: SqliteExecutor,
  entity: PlayEntity,
  id: string,
  seq: number,
  plays: readonly number[],
): Promise<void> {
  const existing = await readPlaySetKey(tx, entity, id)
  let pid: number
  if (existing === null) {
    const [inserted] = await tx.all(
      `INSERT INTO play_set (entity, id, seq, play_count) VALUES (?, ?, ?, ?)
       RETURNING pid`,
      [entity, id, seq, plays.length],
    )
    pid = PidSchema.parse(inserted).pid
  } else {
    if (existing.seq > seq) return
    pid = existing.pid
    await tx.run(`DELETE FROM ${PLAY_TABLES[entity]} WHERE pid = ?`, [pid])
    await tx.run('UPDATE play_set SET seq = ?, play_count = ? WHERE pid = ?', [
      seq,
      plays.length,
      pid,
    ])
  }
  await insertJson(
    tx,
    `INSERT INTO ${PLAY_TABLES[entity]} (pid, played_at, n)
     SELECT ?, value, key FROM json_each(?)`,
    [pid],
    plays,
  )
}

async function readPlaySetKey(
  tx: SqliteExecutor,
  entity: PlayEntity,
  id: string,
): Promise<{ pid: number; seq: number } | null> {
  const [row] = await tx.all(
    'SELECT pid, seq FROM play_set WHERE entity = ? AND id = ?',
    [entity, id],
  )
  return row === undefined ? null : PlaySetKeySchema.parse(row)
}

async function removeTagKey(tx: SqliteExecutor, id: string): Promise<void> {
  await tx.run(
    `DELETE FROM tag_ancestor WHERE (media_type, key) IN
       (SELECT media_type, key FROM tag_key WHERE id = ?)`,
    [id],
  )
  await tx.run('DELETE FROM tag_key WHERE id = ?', [id])
}

/** True when no row with this ID is stored, or the stored one is not newer. */
async function isNewer(
  tx: SqliteExecutor,
  table: 'tag' | 'tag_key' | 'playlist_job' | 'meta',
  id: string,
  seq: number,
): Promise<boolean> {
  const [row] = await tx.all(`SELECT seq FROM ${table} WHERE id = ?`, [id])
  return row === undefined || SeqRowSchema.parse(row).seq <= seq
}

// Helpers

/** Runs an `INSERT ... SELECT ... FROM json_each(?)` with the list as its last parameter; skips an empty list. */
async function insertJson(
  tx: SqliteExecutor,
  sql: string,
  params: readonly SqlValue[],
  list: readonly unknown[],
): Promise<void> {
  if (list.length === 0) return
  await tx.run(sql, [...params, JSON.stringify(list)])
}

/** The Tags sort per location as `genre:<location>` keys. */
function locationSort(
  genre: Record<string, string | null>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(genre).map(([location, value]) => [
      `genre:${location}`,
      value,
    ]),
  )
}

function presentEntries(
  values: Record<string, string | number | null>,
): [string, string | number][] {
  const entries: [string, string | number][] = []
  for (const [field, value] of Object.entries(values)) {
    if (value !== null) entries.push([field, value])
  }
  return entries
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function flag(value: boolean): number {
  return value ? 1 : 0
}
