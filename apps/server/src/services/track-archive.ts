import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import { libraryChangeRemoval } from '@/schemas/db'
import { removeOrphanTracks } from './album-library-tracks'
import { writeArtistCredits } from './artist-names'
import type { ChangeReader, ChangeTransaction } from './library-change-effect'

type Reader = ChangeReader
type Transaction = ChangeTransaction

const IdRowsSchema = z.array(z.object({ id: z.string() }))
const ArchiveRowsSchema = z.array(
  z.object({
    id: z.string(),
    snapshot: z.record(z.string(), JsonValueSchema),
  }),
)
/** A track as it was, with everything that is deleted with it. */
export type ArchivedTrack = z.infer<typeof ArchiveRowsSchema>[number]
const ArchivedCreditsSchema = z.array(
  z.object({
    mediaItemId: z.string(),
    name: z.string(),
    role: z.string(),
    billingOrder: z.number().int(),
    creditedAs: z.string().nullable(),
  }),
)

export const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

/** The given tracks that are in the library. */
export async function existingTrackIds(reader: Reader, ids: string[]) {
  if (!ids.length) return new Set<string>()
  return new Set(
    IdRowsSchema.parse(
      (
        await reader.execute(sql`
          select media_item_id as id from library_track
          where media_item_id in (${idList(ids)})`)
      ).rows,
    ).map((row) => row.id),
  )
}

type AttachedColumn = string | { name: string; value: SQL }
const createdBy: AttachedColumn = {
  name: 'created_by_user_id',
  value: sql`(select u.id from "user" u where u.id = x.created_by_user_id)`,
}
const stamps = ['created_at', 'updated_at']

/**
 * Rows that are deleted with a track, with the columns an undo restores. A
 * column that points at a record that can be gone by then is read through
 * that record.
 */
const ATTACHED: {
  table: string
  columns: AttachedColumn[]
  when?: SQL
}[] = [
  {
    table: 'tag_occurrence',
    columns: [
      'id',
      'media_item_id',
      'tag_id',
      'provider',
      'source',
      'source_id',
      'raw_name',
      'kind',
      ...stamps,
    ],
    when: sql`exists (select 1 from tag t where t.id = x.tag_id)`,
  },
  {
    table: 'external_link',
    columns: ['id', 'media_item_id', 'provider', 'label', 'url', ...stamps],
  },
  {
    table: 'provider_reference',
    columns: [
      'id',
      'media_item_id',
      'provider',
      'reference_type',
      'external_id',
      'is_primary',
      'metadata',
      ...stamps,
    ],
  },
  {
    table: 'provider_current_state',
    columns: [
      'id',
      'media_item_id',
      'provider',
      {
        name: 'latest_snapshot_id',
        value: sql`(select s.id from provider_snapshot s
          where s.id = x.latest_snapshot_id)`,
      },
      'checksum',
      'payload',
      'normalized_data',
      'status',
      'last_successful_at',
      'last_scraped_at',
      ...stamps,
    ],
  },
  {
    table: 'media_override',
    columns: [
      'id',
      'media_item_id',
      'field',
      'value',
      'note',
      createdBy,
      ...stamps,
    ],
  },
  {
    table: 'provider_reference_override',
    columns: [
      'id',
      'media_item_id',
      'provider',
      'reference_type',
      'external_id',
      'note',
      createdBy,
      ...stamps,
    ],
  },
]

/** Stored responses and job items outlive their track; an undo points them back. */
const DETACHED = [
  { table: 'provider_snapshot', key: 'snapshotIds' },
  { table: 'scrape_job_item', key: 'jobItemIds' },
]

/** Everything needed to put a Last.fm-only track back as it was. */
export async function archiveTracks(reader: Reader, ids: string[]) {
  if (!ids.length) return []
  const attached = sql.join(
    ATTACHED.map(
      ({ table }) => sql`${table}::text, coalesce((
        select jsonb_agg(to_jsonb(x)) from ${sql.identifier(table)} x
        where x.media_item_id = mi.id), '[]'::jsonb)`,
    ),
    sql`, `,
  )
  const detached = sql.join(
    DETACHED.map(
      ({ table, key }) => sql`${key}::text, coalesce((
        select jsonb_agg(x.id) from ${sql.identifier(table)} x
        where x.media_item_id = mi.id), '[]'::jsonb)`,
    ),
    sql`, `,
  )
  return ArchiveRowsSchema.parse(
    (
      await reader.execute(sql`
        select mi.id, jsonb_build_object(
          'mediaItem', to_jsonb(mi),
          'libraryTrack', to_jsonb(lt),
          'credits', coalesce((
            select jsonb_agg(jsonb_build_object('artistId', c.artist_id,
              'artistName', a.name, 'role', c.role,
              'billingOrder', c.billing_order,
              'creditedAs', c.credited_as) order by c.billing_order, a.id)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id), '[]'::jsonb),
          'tagIds', coalesce((
            select jsonb_agg(t.tag_id order by t.tag_id)
            from media_item_tag t where t.media_item_id = mi.id), '[]'::jsonb),
          'attached', jsonb_build_object(${attached}),
          ${detached}
        ) as snapshot
        from media_item mi join library_track lt on lt.media_item_id = mi.id
        where mi.id in (${idList(ids)})`)
    ).rows,
  )
}

/** Keeps the archive of every track the change removed. */
export async function storeRemovals(
  tx: Transaction,
  changeId: string,
  archived: ArchivedTrack[],
) {
  const existing = await existingTrackIds(
    tx,
    archived.map((track) => track.id),
  )
  const removed = archived.filter((track) => !existing.has(track.id))
  if (!removed.length) return
  await tx
    .insert(libraryChangeRemoval)
    .values(
      removed.map(({ id, snapshot }) => ({ changeId, recordId: id, snapshot })),
    )
    .onConflictDoUpdate({
      target: [libraryChangeRemoval.changeId, libraryChangeRemoval.recordId],
      set: { snapshot: sql`excluded.snapshot` },
    })
}

/**
 * Puts removed tracks back from the change's archive, with the provider data,
 * links and edits they had. Columns are listed so a column added later takes
 * its default. Returns the IDs it could not restore.
 */
export async function restoreRemovedTracks(
  tx: Transaction,
  changeId: string,
  ids: string[],
) {
  if (!ids.length) return []
  const rows = sql`from library_change_removal r cross join lateral`
  const selected = sql`where r.change_id = ${changeId}
    and r.record_id in (${idList(ids)})`
  await tx.execute(sql`
    insert into media_item (id, media_type, slug, title, original_title,
      summary, artwork_url, release_date, source_label, metadata, in_library, created_at,
      updated_at)
    select x.id, x.media_type, x.slug, x.title, x.original_title, x.summary,
      x.artwork_url, x.release_date, x.source_label, x.metadata, coalesce(x.in_library, true), x.created_at,
      x.updated_at
    ${rows} jsonb_populate_record(null::media_item, r.snapshot->'mediaItem') x
    ${selected}
    on conflict do nothing`)
  // The album may have left the library since the track was removed, and
  // another version of its record may be the one shown by now.
  await tx.execute(sql`
    insert into library_track (media_item_id, spotify_track_id, isrc,
      duration_sec, date_added, spotify_url, album_name, spotify_album_id,
      album_media_item_id, album_link_strategy, version_group_id,
      version_shown, created_at, updated_at)
    select x.media_item_id, x.spotify_track_id, x.isrc, x.duration_sec,
      x.date_added, x.spotify_url, x.album_name, x.spotify_album_id,
      a.media_item_id,
      case when a.media_item_id is null then null else x.album_link_strategy end,
      x.version_group_id,
      coalesce(x.version_shown, false) and not exists (
        select 1 from library_track v
        where v.version_group_id = x.version_group_id and v.version_shown),
      x.created_at, x.updated_at
    ${rows} jsonb_populate_record(null::library_track, r.snapshot->'libraryTrack') x
    left join album a on a.media_item_id = x.album_media_item_id
    ${selected}
      and exists (select 1 from media_item mi where mi.id = x.media_item_id)
    on conflict do nothing`)
  // Keep the exact provider artist when it still exists, following name merges.
  await tx.execute(sql`
    insert into media_credit (media_item_id, artist_id, role, billing_order, credited_as)
    select r.record_id, coalesce(a.merged_into_id, a.id), c->>'role',
      (c->>'billingOrder')::int,
      coalesce(c->>'creditedAs', case when a.merged_into_id is not null then a.name end)
    ${rows} jsonb_array_elements(r.snapshot->'credits') c
    join artist a on a.id = c->>'artistId'
    ${selected}
      and exists (select 1 from media_item mi where mi.id = r.record_id)
    order by r.record_id, c->>'role', (c->>'billingOrder')::int
    on conflict do nothing`)
  // Fall back to the archived name when the artist has since been removed.
  const credits = ArchivedCreditsSchema.parse(
    (
      await tx.execute(sql`
        select r.record_id as "mediaItemId", c->>'artistName' as name,
          c->>'role' as role, (c->>'billingOrder')::int as "billingOrder",
          c->>'creditedAs' as "creditedAs"
        ${rows} jsonb_array_elements(r.snapshot->'credits') c
        ${selected}
          and not exists (select 1 from artist a where a.id = c->>'artistId')
          and exists (select 1 from media_item mi where mi.id = r.record_id)`)
    ).rows,
  )
  await writeArtistCredits(tx, credits)
  await tx.execute(sql`
    insert into media_item_tag (media_item_id, tag_id)
    select r.record_id, t.id
    ${rows} jsonb_array_elements_text(r.snapshot->'tagIds') tag_id
    join tag t on t.id = tag_id
    ${selected}
      and exists (select 1 from media_item mi where mi.id = r.record_id)
    on conflict do nothing`)
  for (const { table, columns, when } of ATTACHED) {
    const target = sql.identifier(table)
    await tx.execute(sql`
      insert into ${target} (${sql.join(
        columns.map((column) =>
          sql.identifier(typeof column === 'string' ? column : column.name),
        ),
        sql`, `,
      )})
      select ${sql.join(
        columns.map((column) =>
          typeof column === 'string'
            ? sql`x.${sql.identifier(column)}`
            : column.value,
        ),
        sql`, `,
      )}
      ${rows} jsonb_populate_recordset(null::${target},
        coalesce(r.snapshot->'attached'->${table}::text, '[]'::jsonb)) x
      ${selected}
        and exists (select 1 from media_item mi where mi.id = x.media_item_id)
        ${when ? sql`and ${when}` : sql``}
      on conflict do nothing`)
  }
  for (const { table, key } of DETACHED)
    await tx.execute(sql`
      update ${sql.identifier(table)} x set media_item_id = r.record_id
      ${rows} jsonb_array_elements_text(
        coalesce(r.snapshot->${key}::text, '[]'::jsonb)) kept
      ${selected}
        and x.id = kept and x.media_item_id is null
        and exists (select 1 from media_item mi where mi.id = r.record_id)`)
  await tx.execute(sql`delete from library_change_removal r ${selected}`)
  const restored = await existingTrackIds(tx, ids)
  return ids.filter((id) => !restored.has(id))
}

/**
 * Removes tracks without a Spotify identity that no longer hold a name, an
 * album position or a playlist entry.
 */
export async function removeEmptyTracks(tx: Transaction, ids: string[]) {
  if (!ids.length) return
  const unidentified = IdRowsSchema.parse(
    (
      await tx.execute(sql`
        select media_item_id as id from library_track
        where media_item_id in (${idList(ids)}) and spotify_track_id is null`)
    ).rows,
  )
  await removeOrphanTracks(
    tx,
    unidentified.map((row) => row.id),
  )
}
