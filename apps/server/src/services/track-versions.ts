import { sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { LibraryChange } from '@repo/schemas/library-changes'
import {
  AlbumUnlistedNameSchema,
  TrackPartNameSchema,
  TrackPartTypeSchema,
  type AlbumUnlistedNames,
  type TrackParts,
} from '@repo/schemas/track-versions'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { lockLibraryTrackWrites } from './album-library-tracks'
import type {
  ChangeEffectEntry,
  ChangeReader,
  ChangeTransaction,
} from './library-change-effect'
import {
  getLibraryChange,
  readChangeRecords,
  recordChange,
} from './library-changes'
import { readRecordingVersions } from './recording-groups'
import { relinkTrackRecords } from './track-links'
import { albumTrackDurationExpression } from './track-values'
import { readVersionStates, storeVersionStates } from './track-version-effects'

const NOT_FOUND = 'Track not found.'
const NO_VERSIONS = 'This track has no other versions.'

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

const IdRowsSchema = z.array(z.object({ id: z.string() }))

/** Every track of a stored version group, hidden ones included. */
async function groupTrackIds(reader: ChangeReader, groupId: string | null) {
  if (groupId === null) return []
  return IdRowsSchema.parse(
    (
      await reader.execute(sql`
        select media_item_id as id from library_track
        where version_group_id = ${groupId}`)
    ).rows,
  ).map((row) => row.id)
}

/** The versions of a track's record, with the one its row is shown as. */
async function readRecord(reader: ChangeReader, trackId: string) {
  const versions = await readRecordingVersions(reader, [trackId])
  const own = versions.find((version) => version.id === trackId)
  if (!own) throw new ServerError({ statusCode: 404, message: NOT_FOUND })
  const members = versions.filter(
    (version) => version.group_key === own.group_key,
  )
  const shown = members.find((version) => version.shown) ?? own
  return { ids: members.map((version) => version.id), shownId: shown.id }
}

/**
 * Joins the sources' records to the target's as versions of one record,
 * shown as the target. Versions worked out for any of them are joined too,
 * so none is split off, except `leavingIds`: tracks the same change removes.
 * Returns the effect to record and every track of the record, or a null
 * effect when they were one record already.
 */
export async function joinTrackVersions(
  tx: ChangeTransaction,
  targetId: string,
  sourceIds: string[],
  leavingIds: string[] = [],
): Promise<{ effect: ChangeEffectEntry | null; trackIds: string[] }> {
  const stored = (await readVersionStates(tx, [targetId])).get(targetId)
  const groupId = stored?.groupId ?? nanoid()
  const leaving = new Set(leavingIds)
  const trackIds = [
    ...new Set([
      ...(await readRecordingVersions(tx, [targetId, ...sourceIds])).map(
        (version) => version.id,
      ),
      ...(await groupTrackIds(tx, stored?.groupId ?? null)),
    ]),
  ].filter((id) => !leaving.has(id))
  const effect = await storeVersionStates(
    tx,
    trackIds.map((id) => ({ id, state: { groupId, shown: id === targetId } })),
  )
  return { effect, trackIds }
}

async function versionChange(
  tx: ChangeTransaction,
  action: 'separate' | 'show',
  trackId: string,
  otherId: string,
  effect: ChangeEffectEntry,
) {
  const records = await readChangeRecords(tx, 'track', [trackId, otherId])
  const target = records.find((record) => record.id === trackId)
  const changeId = await recordChange(
    tx,
    {
      kind: 'track',
      action,
      target: target ?? null,
      sources: records.filter((record) => record.id === otherId),
      details: {
        counts: { version: 1 },
        labels: target ? [target.title] : [],
      },
    },
    { effects: [effect] },
  )
  if (!changeId)
    throw new ServerError({ statusCode: 409, message: NO_VERSIONS })
  return getLibraryChange(changeId, tx)
}

/**
 * Gives a version its own row again: it becomes a record of one, which the
 * worked-out versions do not join again.
 */
export async function separateTrackVersion(
  trackId: string,
): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const record = await readRecord(tx, trackId)
    const others = record.ids.filter((id) => id !== trackId)
    const [first] = others
    if (!first) throw new ServerError({ statusCode: 409, message: NO_VERSIONS })
    const effect = await storeVersionStates(tx, [
      { id: trackId, state: { groupId: nanoid(), shown: false } },
    ])
    if (!effect)
      throw new ServerError({ statusCode: 409, message: NO_VERSIONS })
    await relinkTrackRecords(tx, record.ids)
    const left = record.shownId === trackId ? first : record.shownId
    return versionChange(tx, 'separate', trackId, left, effect)
  })
}

/** Shows a record's row as one of its versions. */
export async function showTrackVersion(
  trackId: string,
): Promise<LibraryChange> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const record = await readRecord(tx, trackId)
    if (record.ids.length < 2)
      throw new ServerError({ statusCode: 409, message: NO_VERSIONS })
    const states = await readVersionStates(tx, record.ids)
    const own = states.get(trackId)
    if (!own) throw new ServerError({ statusCode: 404, message: NOT_FOUND })
    if (own.shown)
      throw new ServerError({
        statusCode: 409,
        message: 'The record is already shown as this version.',
      })
    // Worked-out versions are stored first, so the choice holds.
    const groupId = own.groupId ?? nanoid()
    const ids = [
      ...new Set([...record.ids, ...(await groupTrackIds(tx, own.groupId))]),
    ]
    const effect = await storeVersionStates(
      tx,
      ids.map((id) => ({ id, state: { groupId, shown: id === trackId } })),
    )
    if (!effect)
      throw new ServerError({ statusCode: 409, message: NO_VERSIONS })
    if (own.groupId === null) await relinkTrackRecords(tx, record.ids)
    return versionChange(tx, 'show', trackId, record.shownId, effect)
  })
}

const PartVersionRowsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    by: z.string(),
    type: TrackPartTypeSchema,
    album_id: z.string().nullable(),
    album_title: z.string().nullable(),
    album_name: z.string().nullable(),
    duration_sec: z.number().int().positive().nullable(),
    scrobbles: z.number().int().nonnegative(),
    stored: z.boolean(),
  }),
)
const PartNameRowsSchema = z.array(TrackPartNameSchema)
const CountRowsSchema = z.array(
  z.object({ count: z.number().int().nonnegative() }),
)

/** What a track's record is made of: every version and the names each owns. */
export async function readTrackParts(id: string): Promise<TrackParts> {
  const record = await readRecord(db, id)
  const members = idList(record.ids)
  const owned = sql`select s.track_media_item_id as track_id,
      s.artist_key, s.track_key, s.manually_matched,
      max(e.artist_name) as artist_name, max(e.track_name) as track_name,
      count(*)::int as scrobbles
    from lastfm_track_source s
    join lastfm_scrobble e on e.username = s.username
      and e.artist_key = s.artist_key and e.track_key = s.track_key
    where s.track_media_item_id in (${members})
    group by s.track_media_item_id, s.username, s.artist_key, s.track_key`
  const [versions, names, counted] = await Promise.all([
    db.execute(sql`
      select lt.media_item_id as id, mi.title,
        coalesce((
          select string_agg(a.name, ', ' order by c.billing_order, a.id)
          from media_credit c join artist a on a.id = c.artist_id
          where c.media_item_id = mi.id and c.role = 'artist'), '') as "by",
        case when lt.spotify_track_id is not null then 'spotify'
          when exists (select 1 from track t
            where t.track_media_item_id = lt.media_item_id) then 'album'
          else 'lastfm' end as type,
        album.id as album_id, album.title as album_title,
        lt.album_name,
        nullif(greatest(coalesce(lt.duration_sec, ${albumTrackDurationExpression(
          sql`lt.media_item_id`,
          sql`lt.album_media_item_id`,
        )}), 0), 0) as duration_sec,
        coalesce((select sum(n.scrobbles)::int from (${owned}) n
          where n.track_id = lt.media_item_id), 0) as scrobbles,
        lt.version_group_id is not null as stored
      from library_track lt join media_item mi on mi.id = lt.media_item_id
      left join media_item album on album.id = lt.album_media_item_id
      where lt.media_item_id in (${members})`),
    db.execute(sql`
      select n.track_id as "trackId", n.artist_key as "artistKey",
        n.track_key as "trackKey", n.artist_name as "artistName",
        n.track_name as "trackName", n.scrobbles,
        n.manually_matched as "manuallyMatched"
      from (${owned}) n
      order by n.scrobbles desc, n.track_name, n.artist_name`),
    db.execute(sql`
      select count(*)::int as count from (
        select distinct username, artist_key, track_key from lastfm_track_link
        where track_media_item_id in (${members})
      ) n join lastfm_scrobble e using (username, artist_key, track_key)`),
  ])
  const rows = PartVersionRowsSchema.parse(versions.rows)
  const [total] = CountRowsSchema.parse(counted.rows)
  return {
    shownId: record.shownId,
    stored: rows.some((row) => row.stored),
    scrobbles: total?.count ?? 0,
    versions: rows
      .map((row) => ({
        id: row.id,
        title: row.title,
        by: row.by,
        type: row.type,
        album:
          row.album_id && row.album_title
            ? { id: row.album_id, title: row.album_title }
            : null,
        albumName: row.album_name,
        durationSec: row.duration_sec,
        scrobbles: row.scrobbles,
        shown: row.id === record.shownId,
      }))
      .sort(
        (left, right) =>
          Number(right.shown) - Number(left.shown) ||
          right.scrobbles - left.scrobbles ||
          left.title.localeCompare(right.title) ||
          left.id.localeCompare(right.id),
      ),
    names: PartNameRowsSchema.parse(names.rows),
  }
}

const AlbumRowsSchema = z.array(z.object({ id: z.string() }))

/**
 * Names scrobbled under an album whose owner is not on its track list and
 * does not count for a track on it, most played first.
 */
export async function readAlbumUnlistedNames(
  albumId: string,
): Promise<AlbumUnlistedNames> {
  const album = AlbumRowsSchema.parse(
    (
      await db.execute(sql`
        select a.media_item_id as id from album a
        join media_item mi on mi.id = a.media_item_id
        where a.media_item_id = ${albumId}
          and mi.metadata->>'legacyHidden' is distinct from 'true'`)
    ).rows,
  )
  if (!album.length)
    throw new ServerError({ statusCode: 404, message: 'Album not found.' })
  const { rows } = await db.execute(sql`
    with scrobbled as (
      select e.username, e.artist_key, e.track_key,
        max(e.artist_name) as artist_name, max(e.track_name) as track_name,
        count(*)::int as scrobbles
      from lastfm_scrobble e where e.album_media_item_id = ${albumId}
      group by e.username, e.artist_key, e.track_key
    )
    select s.track_media_item_id as "trackId", n.artist_key as "artistKey",
      n.track_key as "trackKey", n.artist_name as "artistName",
      n.track_name as "trackName", n.scrobbles
    from scrobbled n
    join lastfm_track_source s on s.username = n.username
      and s.artist_key = n.artist_key and s.track_key = n.track_key
    where not exists (
        select 1 from track t where t.album_media_item_id = ${albumId}
          and t.track_media_item_id = s.track_media_item_id)
      and not exists (
        select 1 from lastfm_track_link l
        join track t on t.track_media_item_id = l.track_media_item_id
          and t.album_media_item_id = ${albumId}
        where l.username = n.username and l.artist_key = n.artist_key
          and l.track_key = n.track_key)
    order by n.scrobbles desc, n.track_name, n.artist_name, s.track_media_item_id
    limit 100`)
  return { names: z.array(AlbumUnlistedNameSchema).parse(rows) }
}
