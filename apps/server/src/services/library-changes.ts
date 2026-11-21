import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import {
  LibraryChangeActionSchema,
  LibraryChangeActorSchema,
  LibraryChangeKindSchema,
  type LibraryChange,
  type LibraryChangeAction,
  type LibraryChangeActor,
  type LibraryChangeListQuery,
  type LibraryChangePage,
} from '@repo/schemas/library-changes'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  libraryChange,
  libraryChangeMove,
  libraryChangeRemoval,
  type LibraryChangeRecordSnapshot,
} from '@/schemas/db'
import {
  lockLibraryTrackWrites,
  removeOrphanTracks,
} from './album-library-tracks'
import { refreshArtistListeningTotals } from './artist-listening'
import { refreshTrackAddedDates } from './spotify-playlists'
import { writeScrobbleTrackLinks } from './track-links'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'execute'>
type ChangeRow = typeof libraryChange.$inferSelect

const WRITE_BATCH = 500

const NameStatesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    track_id: z.string(),
    manual: z.boolean(),
  }),
)
type NameState = z.infer<typeof NameStatesSchema>[number]
/** A scrobbled artist and track name of one Last.fm account. */
export type ScrobbledNameRef = Pick<
  NameState,
  'username' | 'artist_key' | 'track_key'
>

const ScrobbledNamesSchema = z.array(
  z.object({
    username: z.string(),
    artist_key: z.string(),
    track_key: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    count: z.number().int().nonnegative(),
  }),
)
const RecordRowsSchema = z.array(
  z.object({ id: z.string(), title: z.string(), by: z.string() }),
)
const IdRowsSchema = z.array(z.object({ id: z.string() }))
const ArchiveRowsSchema = z.array(
  z.object({
    id: z.string(),
    snapshot: z.record(z.string(), JsonValueSchema),
  }),
)
type ArchivedTrack = z.infer<typeof ArchiveRowsSchema>[number]
const MoveRowsSchema = z.array(
  z.object({
    change_id: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    scrobbles: z.number().int().nonnegative(),
    from_id: z.string(),
    to_id: z.string(),
    owner_id: z.string().nullable(),
    from_available: z.boolean(),
    to_available: z.boolean(),
  }),
)

const nameId = (name: ScrobbledNameRef) =>
  JSON.stringify([name.username, name.artist_key, name.track_key])

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

const namesInput = (names: ScrobbledNameRef[]) =>
  sql`jsonb_to_recordset(${JSON.stringify(
    names.map(({ username, artist_key, track_key }) => ({
      username,
      artist_key,
      track_key,
    })),
  )}::jsonb) as r(username text, artist_key text, track_key text)`

async function readNameStates(reader: Reader, names: ScrobbledNameRef[]) {
  if (!names.length) return []
  return NameStatesSchema.parse(
    (
      await reader.execute(sql`
        select s.username, s.artist_key, s.track_key,
          s.track_media_item_id as track_id, s.manually_matched as manual
        from lastfm_track_source s join ${namesInput(names)}
          on s.username = r.username and s.artist_key = r.artist_key
            and s.track_key = r.track_key`)
    ).rows,
  )
}

async function readNamesOwnedBy(reader: Reader, trackIds: string[]) {
  if (!trackIds.length) return []
  return NameStatesSchema.parse(
    (
      await reader.execute(sql`
        select username, artist_key, track_key,
          track_media_item_id as track_id, manually_matched as manual
        from lastfm_track_source
        where track_media_item_id in (${idList(trackIds)})`)
    ).rows,
  )
}

async function readRecords(
  reader: Reader,
  ids: string[],
): Promise<LibraryChangeRecordSnapshot[]> {
  if (!ids.length) return []
  return RecordRowsSchema.parse(
    (
      await reader.execute(sql`
        select mi.id, mi.title, coalesce((
          select string_agg(a.name, ', ' order by c.billing_order, a.id)
          from media_credit c join artist a on a.id = c.artist_id
          where c.media_item_id = mi.id and c.role = 'artist'), '') as "by"
        from media_item mi where mi.id in (${idList(ids)})`)
    ).rows,
  )
}

async function existingTrackIds(reader: Reader, ids: string[]) {
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
async function archiveTracks(reader: Reader, ids: string[]) {
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
              'billingOrder', c.billing_order) order by c.billing_order, a.id)
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
async function storeRemovals(
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
async function restoreRemovedTracks(
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
      summary, artwork_url, release_date, source_label, metadata, created_at,
      updated_at)
    select x.id, x.media_type, x.slug, x.title, x.original_title, x.summary,
      x.artwork_url, x.release_date, x.source_label, x.metadata, x.created_at,
      x.updated_at
    ${rows} jsonb_populate_record(null::media_item, r.snapshot->'mediaItem') x
    ${selected}
    on conflict do nothing`)
  // The album may have left the library since the track was removed.
  await tx.execute(sql`
    insert into library_track (media_item_id, spotify_track_id, isrc,
      duration_sec, date_added, spotify_url, album_name, spotify_album_id,
      album_media_item_id, album_link_strategy, created_at, updated_at)
    select x.media_item_id, x.spotify_track_id, x.isrc, x.duration_sec,
      x.date_added, x.spotify_url, x.album_name, x.spotify_album_id,
      a.media_item_id,
      case when a.media_item_id is null then null else x.album_link_strategy end,
      x.created_at, x.updated_at
    ${rows} jsonb_populate_record(null::library_track, r.snapshot->'libraryTrack') x
    left join album a on a.media_item_id = x.album_media_item_id
    ${selected}
      and exists (select 1 from media_item mi where mi.id = x.media_item_id)
    on conflict do nothing`)
  await tx.execute(sql`
    insert into artist (id, name, sort_name)
    select distinct on (c->>'artistName')
      c->>'artistId', c->>'artistName', c->>'artistName'
    ${rows} jsonb_array_elements(r.snapshot->'credits') c
    ${selected}
    on conflict do nothing`)
  // An artist recreated since can have another ID for the same unique name.
  await tx.execute(sql`
    insert into media_credit (media_item_id, artist_id, role, billing_order)
    select r.record_id, a.id, c->>'role', (c->>'billingOrder')::int
    ${rows} jsonb_array_elements(r.snapshot->'credits') c
    join lateral (
      select id from artist
      where id = c->>'artistId' or name = c->>'artistName'
      order by case when id = c->>'artistId' then 0 else 1 end limit 1
    ) a on true
    ${selected}
      and exists (select 1 from media_item mi where mi.id = r.record_id)
    on conflict do nothing`)
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
async function removeEmptyTracks(tx: Transaction, ids: string[]) {
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

export type TrackChangeDraft = {
  before: NameState[]
  records: LibraryChangeRecordSnapshot[]
  archived: ArchivedTrack[]
}

/**
 * Reads where scrobbled names are before a change moves them: the names of
 * the given tracks, or the given names. Call `recordTrackChange` afterwards
 * in the same transaction.
 */
export async function beginTrackChange(
  tx: Transaction,
  scope: { trackIds: string[] } | { names: ScrobbledNameRef[] },
): Promise<TrackChangeDraft> {
  const before =
    'trackIds' in scope
      ? await readNamesOwnedBy(tx, scope.trackIds)
      : await readNameStates(tx, scope.names)
  const ownerIds = [...new Set(before.map((name) => name.track_id))]
  return {
    before,
    records: await readRecords(tx, ownerIds),
    archived: await archiveTracks(tx, ownerIds),
  }
}

/**
 * Records the names that now belong to another track, or changed between
 * manual and automatic matching, as one change. Returns its ID, or null when
 * nothing moved. `reversible` is false for a change that also moved album
 * positions or playlist entries, which are not recorded.
 */
export async function recordTrackChange(
  tx: Transaction,
  draft: TrackChangeDraft,
  {
    action,
    actor = 'owner',
    rule = null,
    reversible = true,
  }: {
    action: LibraryChangeAction
    actor?: LibraryChangeActor
    rule?: string | null
    reversible?: boolean
  },
) {
  const after = new Map(
    (await readNameStates(tx, draft.before)).map((name) => [
      nameId(name),
      name,
    ]),
  )
  const moves = draft.before.flatMap((from) => {
    const to = after.get(nameId(from))
    return to && (to.track_id !== from.track_id || to.manual !== from.manual)
      ? [{ from, to }]
      : []
  })
  if (!moves.length) return null

  const scrobbled = new Map(
    ScrobbledNamesSchema.parse(
      (
        await tx.execute(sql`
          select e.username, e.artist_key, e.track_key,
            max(e.artist_name) as artist_name, max(e.track_name) as track_name,
            count(*)::int as count
          from lastfm_scrobble e
          join ${namesInput(moves.map(({ from }) => from))}
            on e.username = r.username and e.artist_key = r.artist_key
              and e.track_key = r.track_key
          group by e.username, e.artist_key, e.track_key`)
      ).rows,
    ).map((name) => [nameId(name), name]),
  )
  const sourceIds = new Set(
    moves
      .filter(({ from, to }) => from.track_id !== to.track_id)
      .map(({ from }) => from.track_id),
  )
  const targetIds = [...new Set(moves.map(({ to }) => to.track_id))]
  const [target] =
    targetIds.length === 1 ? await readRecords(tx, targetIds) : []
  const id = nanoid()
  const rows = moves.map(({ from, to }) => {
    const name = scrobbled.get(nameId(from))
    return {
      changeId: id,
      username: from.username,
      artistKey: from.artist_key,
      trackKey: from.track_key,
      artistName: name?.artist_name ?? from.artist_key,
      trackName: name?.track_name ?? from.track_key,
      scrobbles: name?.count ?? 0,
      fromId: from.track_id,
      fromManual: from.manual,
      toId: to.track_id,
      toManual: to.manual,
    }
  })
  await tx.insert(libraryChange).values({
    id,
    kind: 'track',
    action,
    actor,
    rule,
    target: target ?? null,
    sources: draft.records.filter((record) => sourceIds.has(record.id)),
    scrobbles: rows.reduce((total, row) => total + row.scrobbles, 0),
    reversible,
  })
  for (let start = 0; start < rows.length; start += WRITE_BATCH)
    await tx
      .insert(libraryChangeMove)
      .values(rows.slice(start, start + WRITE_BATCH))
  await storeRemovals(tx, id, draft.archived)
  return id
}

async function describeChanges(
  reader: Reader,
  rows: ChangeRow[],
): Promise<LibraryChange[]> {
  if (!rows.length) return []
  const available = (column: 'from_id' | 'to_id') => sql`(
    exists (select 1 from library_track lt
      where lt.media_item_id = m.${sql.identifier(column)})
    or exists (select 1 from library_change_removal x
      where x.change_id = m.change_id
        and x.record_id = m.${sql.identifier(column)}))`
  const moves = MoveRowsSchema.parse(
    (
      await reader.execute(sql`
        select m.change_id, m.artist_name, m.track_name, m.scrobbles,
          m.from_id, m.to_id, s.track_media_item_id as owner_id,
          ${available('from_id')} as from_available,
          ${available('to_id')} as to_available
        from library_change_move m
        left join lastfm_track_source s on s.username = m.username
          and s.artist_key = m.artist_key and s.track_key = m.track_key
        where m.change_id in (${idList(rows.map((row) => row.id))})
        order by m.scrobbles desc, m.track_name, m.artist_name`)
    ).rows,
  )
  const existing = await existingTrackIds(reader, [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.target ? [row.target.id] : []),
        ...row.sources.map((source) => source.id),
      ]),
    ),
  ])
  const record = (snapshot: LibraryChangeRecordSnapshot) => ({
    ...snapshot,
    exists: existing.has(snapshot.id),
  })
  return rows.map((row) => {
    const own = moves.filter((move) => move.change_id === row.id)
    // A name whose scrobbles were deleted has nothing left to move.
    const live = own.filter((move) => move.owner_id !== null)
    const undone = row.undoneAt !== null
    return {
      id: row.id,
      kind: LibraryChangeKindSchema.parse(row.kind),
      action: LibraryChangeActionSchema.parse(row.action),
      actor: LibraryChangeActorSchema.parse(row.actor),
      rule: row.rule,
      target: row.target ? record(row.target) : null,
      sources: row.sources.map(record),
      names: own.slice(0, 5).map((move) => ({
        artistName: move.artist_name,
        trackName: move.track_name,
        scrobbles: move.scrobbles,
      })),
      nameCount: own.length,
      scrobbles: row.scrobbles,
      createdAt: row.createdAt.toISOString(),
      undoneAt: row.undoneAt?.toISOString() ?? null,
      reversible: row.reversible,
      canUndo:
        row.reversible &&
        !undone &&
        live.length > 0 &&
        live.every(
          (move) => move.owner_id === move.to_id && move.from_available,
        ),
      canRedo:
        row.reversible &&
        undone &&
        live.length > 0 &&
        live.every(
          (move) => move.owner_id === move.from_id && move.to_available,
        ),
    }
  })
}

/** One recorded change as it stands now. */
export async function getLibraryChange(
  id: string,
  reader: Pick<typeof db, 'execute' | 'select'> = db,
): Promise<LibraryChange> {
  const rows = await reader
    .select()
    .from(libraryChange)
    .where(eq(libraryChange.id, id))
  const [change] = await describeChanges(reader, rows)
  if (!change)
    throw new ServerError({ statusCode: 404, message: 'Change not found.' })
  return change
}

/** Recorded changes, newest first. */
export async function listLibraryChanges({
  page,
  size,
  kind,
  actor,
  recordId,
}: LibraryChangeListQuery): Promise<LibraryChangePage> {
  const where = and(
    eq(libraryChange.kind, kind),
    actor ? eq(libraryChange.actor, actor) : undefined,
    recordId
      ? sql`exists (select 1 from library_change_move m
          where m.change_id = ${libraryChange.id}
            and (m.from_id = ${recordId} or m.to_id = ${recordId}))`
      : undefined,
  )
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(libraryChange)
      .where(where)
      .orderBy(desc(libraryChange.createdAt), desc(libraryChange.id))
      .limit(size)
      .offset((page - 1) * size),
    db.select({ count: count() }).from(libraryChange).where(where),
  ])
  const totalCount = total?.count ?? 0
  return {
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
    items: await describeChanges(db, rows),
  }
}

async function applyChange(id: string, direction: 'undo' | 'redo') {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const [change] = await tx
      .select()
      .from(libraryChange)
      .where(eq(libraryChange.id, id))
      .for('update')
    if (!change)
      throw new ServerError({ statusCode: 404, message: 'Change not found.' })
    if (change.kind !== 'track' || !change.reversible)
      throw new ServerError({
        statusCode: 409,
        message: 'This change cannot be undone.',
      })
    if ((direction === 'undo') === (change.undoneAt !== null))
      throw new ServerError({
        statusCode: 409,
        message:
          direction === 'undo'
            ? 'This change is already undone.'
            : 'This change has not been undone.',
      })

    const moves = await tx
      .select()
      .from(libraryChangeMove)
      .where(eq(libraryChangeMove.changeId, id))
    const states = new Map(
      (
        await readNameStates(
          tx,
          moves.map((move) => ({
            username: move.username,
            artist_key: move.artistKey,
            track_key: move.trackKey,
          })),
        )
      ).map((state) => [nameId(state), state]),
    )
    const steps = moves.flatMap((move) => {
      const state = states.get(
        JSON.stringify([move.username, move.artistKey, move.trackKey]),
      )
      if (!state) return []
      const from = { id: move.fromId, manual: move.fromManual }
      const to = { id: move.toId, manual: move.toManual }
      const [origin, destination] =
        direction === 'undo' ? [to, from] : [from, to]
      return [{ state, origin, destination }]
    })
    if (!steps.length)
      throw new ServerError({
        statusCode: 409,
        message: 'The scrobbles this change moved are no longer stored.',
      })
    if (steps.some(({ state, origin }) => state.track_id !== origin.id))
      throw new ServerError({
        statusCode: 409,
        message: 'A later change moved these names. Undo that change first.',
      })

    const destinationIds = [
      ...new Set(steps.map(({ destination }) => destination.id)),
    ]
    const present = await existingTrackIds(tx, destinationIds)
    const lost = await restoreRemovedTracks(
      tx,
      id,
      destinationIds.filter((trackId) => !present.has(trackId)),
    )
    if (lost.length)
      throw new ServerError({
        statusCode: 409,
        message: 'A track in this change is no longer in the library.',
      })

    await tx.execute(sql`
      update lastfm_track_source s
      set track_media_item_id = r.track_id, manually_matched = r.manual
      from jsonb_to_recordset(${JSON.stringify(
        steps.map(({ state, destination }) => ({
          username: state.username,
          artist_key: state.artist_key,
          track_key: state.track_key,
          track_id: destination.id,
          manual: destination.manual,
        })),
      )}::jsonb) as r(username text, artist_key text, track_key text,
        track_id text, manual boolean)
      where s.username = r.username and s.artist_key = r.artist_key
        and s.track_key = r.track_key`)
    for (const username of new Set(steps.map(({ state }) => state.username)))
      await writeScrobbleTrackLinks(
        tx,
        username,
        steps
          .filter(({ state }) => state.username === username)
          .map(({ state }) => ({
            artistKey: state.artist_key,
            trackKey: state.track_key,
          })),
      )

    const originIds = [
      ...new Set(
        steps
          .filter(({ origin, destination }) => origin.id !== destination.id)
          .map(({ origin }) => origin.id),
      ),
    ]
    const archived = await archiveTracks(tx, originIds)
    await removeEmptyTracks(tx, originIds)
    await storeRemovals(tx, id, archived)
    await refreshTrackAddedDates(tx, [
      ...new Set([...originIds, ...destinationIds]),
    ])
    await refreshArtistListeningTotals(tx)
    await tx
      .update(libraryChange)
      .set({ undoneAt: direction === 'undo' ? new Date() : null })
      .where(eq(libraryChange.id, id))
    return getLibraryChange(id, tx)
  })
}

/** Puts every name the change moved back where it was. */
export async function undoLibraryChange(id: string) {
  return applyChange(id, 'undo')
}

/** Makes an undone change again. */
export async function redoLibraryChange(id: string) {
  return applyChange(id, 'redo')
}
