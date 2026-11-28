import {
  and,
  asc,
  eq,
  ilike,
  isNotNull,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  LibraryPlaylistDetailSchema,
  LibraryPlaylistSummarySchema,
  type CreateLibraryPlaylist,
  type LibraryPlaylistCreated,
  type LibraryPlaylistDetail,
  type LibraryPlaylistDuplicates,
  type LibraryPlaylistEntriesPage,
  type LibraryPlaylistEntriesQuery,
  type LibraryPlaylistEntryAddition,
  type LibraryPlaylistEntryCheck,
  type LibraryPlaylistEntryRemoval,
  type LibraryPlaylistEntryRemovalInput,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistListQuery,
  type LibraryPlaylistMembershipsQuery,
  type LibraryPlaylistPage,
  type LibraryPlaylistSelection,
  type LibraryPlaylistSummary,
  type UpdateLibraryPlaylist,
} from '@repo/schemas/library-playlists'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { libraryPlaylist, libraryPlaylistEntry } from '@/schemas/db'
import { listedInLibraryBrowse } from './browse'
import {
  listedEntry,
  listedEntryOf,
  usesMediaItems,
} from './library-playlist-entries'
import { ensureLegacySavedViews } from './library-playlist-legacy-views'
import {
  isLibraryPlaylistNameTaken,
  lockLibraryPlaylistNames,
  playlistNameTaken,
  type LibraryPlaylistTransaction,
} from './library-playlist-names'
import {
  parseLibraryPlaylistView,
  onlyInLibraryMessage,
  resolveLibraryPlaylistSelection,
} from './library-playlist-selection'
import { loadAlbums, loadFilms } from './media'
import {
  inSubscriptionLibrary,
  listedInSubscriptionLibrary,
  loadSubscriptionItems,
} from './subscription-library'
import { loadTracks } from './tracks'

type Reader = Pick<typeof db, 'execute' | 'select'>
type PlaylistRow = {
  id: string
  library: LibraryPlaylistLibrary
  type: 'playlist' | 'smart'
}

const DAY_INTERVAL = sql`interval '24 hours'`

const notFound = () =>
  new ServerError({ statusCode: 404, message: 'Playlist not found' })

/** PL-02: the item is in the playlist's library. */
function libraryItemExists(library: LibraryPlaylistLibrary, id: SQL) {
  switch (library) {
    case 'albums':
      return sql`exists (select 1 from album a where a.media_item_id = ${id})`
    case 'tracks':
      return sql`exists (select 1 from library_track t where t.media_item_id = ${id})`
    case 'films':
      return sql`exists (select 1 from film f where f.media_item_id = ${id})`
    case 'subscriptions':
    case 'mixes':
      return sql`exists (select 1 from subscription_item si
        where si.id = ${id} and ${inSubscriptionLibrary(sql`si.type`, library)})`
  }
}

/** PL-02: the library's Browse at the In library scope can list the item. */
function libraryItemListed(library: LibraryPlaylistLibrary, id: SQL) {
  switch (library) {
    case 'albums':
      return listedInLibraryBrowse('album', id)
    case 'tracks':
      return listedInLibraryBrowse('track', id)
    case 'films':
      return listedInLibraryBrowse('film', id)
    case 'subscriptions':
    case 'mixes':
      return listedInSubscriptionLibrary(library, id)
  }
}

const playlistIdColumn = sql`${libraryPlaylist.id}`
const entryCount = sql<number>`(select count(*)::int from library_playlist_entry e
  where ${listedEntry(playlistIdColumn)})`

export const summaryColumns = {
  id: libraryPlaylist.id,
  library: libraryPlaylist.library,
  type: libraryPlaylist.type,
  name: libraryPlaylist.name,
  view: libraryPlaylist.view,
  updatedAt: libraryPlaylist.updatedAt,
  entryCount,
}

type SummaryRow = {
  id: string
  library: LibraryPlaylistLibrary
  type: 'playlist' | 'smart'
  name: string
  view: unknown
  updatedAt: Date
  entryCount: number
  containsItem?: boolean | null
}

export function summary(row: SummaryRow): LibraryPlaylistSummary {
  return LibraryPlaylistSummarySchema.parse({
    id: row.id,
    library: row.library,
    type: row.type,
    name: row.name,
    entryCount: row.type === 'playlist' ? row.entryCount : null,
    view: row.type === 'smart' ? row.view : null,
    updatedAt: row.updatedAt.toISOString(),
    ...(typeof row.containsItem === 'boolean'
      ? { containsItem: row.containsItem }
      : {}),
  })
}

/**
 * PL-03: removes playlists deleted more than 24 hours ago, except those made
 * from a legacy saved view, and entries removed more than 24 hours ago.
 */
async function purgeLibraryPlaylists(tx: LibraryPlaylistTransaction) {
  await tx.execute(sql`with purged as (
      delete from library_playlist
      where deleted_at < now() - ${DAY_INTERVAL} and legacy_key is null
    )
    delete from library_playlist_entry where removed_at < now() - ${DAY_INTERVAL}`)
}

async function lockPlaylist(
  tx: LibraryPlaylistTransaction,
  id: string,
  deleted = false,
): Promise<PlaylistRow> {
  const [row] = await tx
    .select({
      id: libraryPlaylist.id,
      library: libraryPlaylist.library,
      type: libraryPlaylist.type,
    })
    .from(libraryPlaylist)
    .where(
      and(
        eq(libraryPlaylist.id, id),
        deleted
          ? isNotNull(libraryPlaylist.deletedAt)
          : isNull(libraryPlaylist.deletedAt),
      ),
    )
    .for('update')
  if (!row) throw notFound()
  return row
}

/** A write to one playlist: purges first, then locks the playlist row. */
function writePlaylist<T>(
  id: string,
  work: (tx: LibraryPlaylistTransaction, playlist: PlaylistRow) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    await purgeLibraryPlaylists(tx)
    return work(tx, await lockPlaylist(tx, id))
  })
}

/** Entries are a playlist's; a smart playlist lists its view. */
function requireEntries(playlist: PlaylistRow) {
  if (playlist.type !== 'playlist')
    throw new ServerError({
      statusCode: 422,
      message: 'A smart playlist has no entries.',
    })
}

async function touchPlaylist(tx: LibraryPlaylistTransaction, id: string) {
  await tx
    .update(libraryPlaylist)
    .set({ updatedAt: sql`now()` })
    .where(eq(libraryPlaylist.id, id))
}

async function readDetail(
  reader: Reader,
  id: string,
  deleted = false,
): Promise<LibraryPlaylistDetail> {
  const [row] = await reader
    .select({
      ...summaryColumns,
      createdAt: libraryPlaylist.createdAt,
      repeatCount: sql<number>`(select (count(*) - count(distinct coalesce(e.media_item_id, e.subscription_item_id)))::int
        from library_playlist_entry e where ${listedEntry(playlistIdColumn)})`,
    })
    .from(libraryPlaylist)
    .where(
      and(
        eq(libraryPlaylist.id, id),
        deleted
          ? isNotNull(libraryPlaylist.deletedAt)
          : isNull(libraryPlaylist.deletedAt),
      ),
    )
  if (!row) throw notFound()
  return LibraryPlaylistDetailSchema.parse({
    ...summary(row),
    createdAt: row.createdAt.toISOString(),
    repeatCount: row.repeatCount,
  })
}

/** PL-10: one library's playlists by name, with whether each holds an item. */
export async function listLibraryPlaylists(
  query: LibraryPlaylistListQuery,
): Promise<LibraryPlaylistPage> {
  if (query.library === 'albums' && query.type !== 'playlist')
    await ensureLegacySavedViews()
  const rows = await db
    .select({
      ...summaryColumns,
      containsItem:
        query.itemId === undefined
          ? sql<null>`null`
          : sql<boolean>`${listedEntryOf(query.library, playlistIdColumn, query.itemId)}`,
    })
    .from(libraryPlaylist)
    .where(
      and(
        eq(libraryPlaylist.library, query.library),
        isNull(libraryPlaylist.deletedAt),
        query.type ? eq(libraryPlaylist.type, query.type) : undefined,
        query.q
          ? ilike(
              libraryPlaylist.name,
              `%${query.q.replace(/[\\%_]/g, '\\$&')}%`,
            )
          : undefined,
      ),
    )
    .orderBy(sql`lower(${libraryPlaylist.name})`, asc(libraryPlaylist.id))
    .limit(query.size + 1)
    .offset((query.page - 1) * query.size)
  return {
    items: rows.slice(0, query.size).map(summary),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

/** PL-12: the playlist with its entry count and repeats. */
export function getLibraryPlaylist(id: string) {
  return readDetail(db, id)
}

const AdditionRowsSchema = z.array(
  z.object({
    outside: z.coerce.number(),
    unlisted: z.coerce.number(),
    present: z.coerce.number(),
    added: z.coerce.number(),
  }),
)

/**
 * PL-02: an item of another library, or one the library's Browse at the In
 * library scope does not list, rejects the whole selection.
 */
function requireListedItems(row: { outside: number; unlisted: number }) {
  if (row.outside > 0)
    throw new ServerError({
      statusCode: 422,
      message: 'An item is not in this playlist’s library.',
    })
  if (row.unlisted > 0)
    throw new ServerError({
      statusCode: 422,
      message: onlyInLibraryMessage,
    })
}

/**
 * Appends items in order in one statement. With `skip`, items already listed
 * are left out; with `again`, they are added and counted as repeated.
 */
async function appendEntries(
  tx: LibraryPlaylistTransaction,
  playlist: Pick<PlaylistRow, 'id' | 'library'>,
  ids: string[],
  duplicates: LibraryPlaylistDuplicates,
): Promise<LibraryPlaylistEntryAddition> {
  const batchId = nanoid()
  const column = usesMediaItems(playlist.library)
    ? sql`media_item_id`
    : sql`subscription_item_id`
  const result = await tx.execute(sql`with selected as (
      select u.id, u.ord,
        ${libraryItemExists(playlist.library, sql`u.id`)} as belongs,
        ${libraryItemListed(playlist.library, sql`u.id`)} as listed,
        ${listedEntryOf(playlist.library, playlist.id, sql`u.id`)} as present
      from unnest(${sql.param(ids)}::text[]) with ordinality u(id, ord)
    ), counts as (
      select count(*) filter (where not belongs) as outside,
        count(*) filter (where belongs and not listed) as unlisted,
        count(*) filter (where present) as present
      from selected
    ), last_position as (
      select coalesce(max(position), 0) as position
      from library_playlist_entry where playlist_id = ${playlist.id}
    ), inserted as (
      insert into library_playlist_entry (id, playlist_id, position, ${column}, batch_id)
      select ${batchId} || '-' || s.ord, ${playlist.id},
        l.position + row_number() over (order by s.ord), s.id, ${batchId}
      from selected s cross join last_position l
      where (select outside + unlisted from counts) = 0
        and (${duplicates === 'again'}::boolean or not s.present)
      returning 1
    )
    select counts.outside, counts.unlisted, counts.present,
      (select count(*) from inserted) as added
    from counts`)
  const [row] = AdditionRowsSchema.parse(result.rows)
  if (!row) throw new Error('The addition returned no counts')
  requireListedItems(row)
  if (row.added > 0) await touchPlaylist(tx, playlist.id)
  return {
    added: row.added,
    skipped: duplicates === 'skip' ? row.present : 0,
    repeated: duplicates === 'again' ? row.present : 0,
    batchId,
  }
}

/** PL-11: a playlist, with a selection to add, or a smart playlist with its view. */
export async function createLibraryPlaylist(
  input: CreateLibraryPlaylist,
  userId: string | null,
): Promise<LibraryPlaylistCreated> {
  const ids =
    input.type === 'playlist' && input.selection
      ? await resolveLibraryPlaylistSelection(input.library, input.selection)
      : undefined
  if (input.type === 'smart')
    parseLibraryPlaylistView(input.library, input.view)
  return db.transaction(async (tx) => {
    await purgeLibraryPlaylists(tx)
    await lockLibraryPlaylistNames(tx, input.library)
    if (await isLibraryPlaylistNameTaken(tx, input.library, input.name))
      throw playlistNameTaken()
    const id = nanoid()
    await tx.insert(libraryPlaylist).values({
      id,
      library: input.library,
      type: input.type,
      name: input.name,
      view: input.type === 'smart' ? input.view : null,
      createdByUserId: userId,
    })
    const addition = ids
      ? await appendEntries(tx, { id, library: input.library }, ids, 'again')
      : null
    return { playlist: await readDetail(tx, id), addition }
  })
}

/** PL-11: renames, or replaces a smart playlist's view. */
export function updateLibraryPlaylist(
  id: string,
  input: UpdateLibraryPlaylist,
) {
  return writePlaylist(id, async (tx, playlist) => {
    if (input.view !== undefined) {
      if (playlist.type !== 'smart')
        throw new ServerError({
          statusCode: 422,
          message: 'Only a smart playlist has a view.',
        })
      parseLibraryPlaylistView(playlist.library, input.view)
    }
    if (input.name !== undefined) {
      await lockLibraryPlaylistNames(tx, playlist.library)
      if (
        await isLibraryPlaylistNameTaken(tx, playlist.library, input.name, id)
      )
        throw playlistNameTaken()
    }
    await tx
      .update(libraryPlaylist)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.view === undefined ? {} : { view: input.view }),
        updatedAt: sql`now()`,
      })
      .where(eq(libraryPlaylist.id, id))
    return readDetail(tx, id)
  })
}

/** PL-11: deletes; restorable for 24 hours. */
export function deleteLibraryPlaylist(id: string) {
  return writePlaylist(id, async (tx) => {
    await tx
      .update(libraryPlaylist)
      .set({ deletedAt: sql`now()` })
      .where(eq(libraryPlaylist.id, id))
    return readDetail(tx, id, true)
  })
}

/** PL-11: restores a deleted playlist whose name is still free. */
export function restoreLibraryPlaylist(id: string) {
  return db.transaction(async (tx) => {
    await purgeLibraryPlaylists(tx)
    const playlist = await lockPlaylist(tx, id, true)
    await lockLibraryPlaylistNames(tx, playlist.library)
    const [row] = await tx
      .select({ name: libraryPlaylist.name })
      .from(libraryPlaylist)
      .where(eq(libraryPlaylist.id, id))
    if (
      !row ||
      (await isLibraryPlaylistNameTaken(tx, playlist.library, row.name, id))
    )
      throw playlistNameTaken()
    await tx
      .update(libraryPlaylist)
      .set({ deletedAt: null })
      .where(eq(libraryPlaylist.id, id))
    return readDetail(tx, id)
  })
}

const CheckRowsSchema = z.array(
  z.object({
    outside: z.coerce.number(),
    unlisted: z.coerce.number(),
    total: z.coerce.number(),
    present: z.coerce.number(),
    sample: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        creator: z.string().nullable(),
      }),
    ),
  }),
)

/** The title and creator or channel of item `p.id`. */
function itemLabel(library: LibraryPlaylistLibrary) {
  if (!usesMediaItems(library))
    return {
      join: sql`join subscription_item i on i.id = p.id
        join subscription_source s on s.id = i.source_id`,
      title: sql`i.title`,
      creator: sql`s.title`,
    }
  const role = library === 'films' ? 'director' : 'artist'
  return {
    join: sql`join media_item m on m.id = p.id`,
    title: sql`m.title`,
    creator: sql`(select string_agg(a.name, ', ' order by c.billing_order, a.name)
      from media_credit c join artist a on a.id = c.artist_id
      where c.media_item_id = m.id and c.role = ${role})`,
  }
}

async function readPlaylist(id: string): Promise<PlaylistRow> {
  const [row] = await db
    .select({
      id: libraryPlaylist.id,
      library: libraryPlaylist.library,
      type: libraryPlaylist.type,
    })
    .from(libraryPlaylist)
    .where(and(eq(libraryPlaylist.id, id), isNull(libraryPlaylist.deletedAt)))
  if (!row) throw notFound()
  return row
}

/** PL-14: how many items a selection holds and how many are already listed. */
export async function checkLibraryPlaylistEntries(
  id: string,
  selection: LibraryPlaylistSelection,
): Promise<LibraryPlaylistEntryCheck> {
  const playlist = await readPlaylist(id)
  requireEntries(playlist)
  const ids = await resolveLibraryPlaylistSelection(playlist.library, selection)
  const label = itemLabel(playlist.library)
  const result = await db.execute(sql`with selected as (
      select u.id, u.ord,
        ${libraryItemExists(playlist.library, sql`u.id`)} as belongs,
        ${libraryItemListed(playlist.library, sql`u.id`)} as listed,
        ${listedEntryOf(playlist.library, playlist.id, sql`u.id`)} as present
      from unnest(${sql.param(ids)}::text[]) with ordinality u(id, ord)
    )
    select count(*) filter (where not belongs) as outside,
      count(*) filter (where belongs and not listed) as unlisted, count(*) as total,
      count(*) filter (where present) as present,
      coalesce((select json_agg(json_build_object(
          'id', sample.id, 'title', sample.title, 'creator', sample.creator
        ) order by sample.ord)
        from (
          select p.id, p.ord, ${label.title} as title, ${label.creator} as creator
          from selected p ${label.join}
          where p.present order by p.ord limit 5
        ) sample), '[]'::json) as sample
    from selected`)
  const [row] = CheckRowsSchema.parse(result.rows)
  if (!row) throw new Error('The check returned no counts')
  requireListedItems(row)
  return { total: row.total, present: row.present, sample: row.sample }
}

/** PL-14: appends a selection in selection order. */
export async function addLibraryPlaylistEntries(
  id: string,
  selection: LibraryPlaylistSelection,
  duplicates: LibraryPlaylistDuplicates,
) {
  const current = await readPlaylist(id)
  requireEntries(current)
  const ids = await resolveLibraryPlaylistSelection(current.library, selection)
  return writePlaylist(id, async (tx, playlist) => {
    requireEntries(playlist)
    return appendEntries(tx, playlist, ids, duplicates)
  })
}

const CountRowsSchema = z.array(z.object({ count: z.coerce.number() }))

/** PL-14: removes what one addition added. */
export function undoLibraryPlaylistAddition(id: string, batchId: string) {
  return writePlaylist(id, async (tx, playlist) => {
    requireEntries(playlist)
    const result = await tx.execute(sql`with removed as (
        delete from library_playlist_entry
        where playlist_id = ${id} and batch_id = ${batchId}
        returning 1
      ) select count(*) as count from removed`)
    const removed = CountRowsSchema.parse(result.rows)[0]?.count ?? 0
    if (removed > 0) await touchPlaylist(tx, id)
    return { removed }
  })
}

/**
 * PL-15: removes entries by ID, or every entry whose item is already earlier
 * in the playlist, as one removal that can be restored.
 */
export function removeLibraryPlaylistEntries(
  id: string,
  input: LibraryPlaylistEntryRemovalInput,
): Promise<LibraryPlaylistEntryRemoval> {
  return writePlaylist(id, async (tx, playlist) => {
    requireEntries(playlist)
    const batchId = nanoid()
    const targets =
      'entryIds' in input
        ? sql`select e.id from library_playlist_entry e
            where e.playlist_id = ${id} and e.removed_batch_id is null
              and e.id = any(${sql.param(input.entryIds)}::text[])`
        : sql`select ranked.id from (
            select e.id, row_number() over (
              partition by coalesce(e.media_item_id, e.subscription_item_id)
              order by e.position
            ) as rank
            from library_playlist_entry e
            where e.playlist_id = ${id} and e.removed_batch_id is null
          ) ranked where ranked.rank > 1`
    const result = await tx.execute(sql`with removed as (
        update library_playlist_entry set removed_batch_id = ${batchId}, removed_at = now()
        where id in (${targets})
        returning 1
      ) select count(*) as count from removed`)
    const removed = CountRowsSchema.parse(result.rows)[0]?.count ?? 0
    if (removed > 0) await touchPlaylist(tx, id)
    return { removed, batchId }
  })
}

/** PL-15: puts the entries of a removal back in their places. */
export function restoreLibraryPlaylistEntries(id: string, batchId: string) {
  return writePlaylist(id, async (tx, playlist) => {
    requireEntries(playlist)
    const result = await tx.execute(sql`with restored as (
        update library_playlist_entry set removed_batch_id = null, removed_at = null
        where playlist_id = ${id} and removed_batch_id = ${batchId}
        returning 1
      ) select count(*) as count from restored`)
    const restored = CountRowsSchema.parse(result.rows)[0]?.count ?? 0
    if (restored > 0) await touchPlaylist(tx, id)
    return { restored }
  })
}

type EntryRow = {
  id: string
  addedAt: Date
  mediaItemId: string | null
  subscriptionItemId: string | null
}

/** Entries whose item still reads, numbered from the page's offset. */
function entriesWith<T extends { id: string }>(
  rows: EntryRow[],
  items: T[],
  offset: number,
) {
  const byId = new Map(items.map((item) => [item.id, item]))
  return rows.flatMap((row, index) => {
    const item = byId.get(row.mediaItemId ?? row.subscriptionItemId ?? '')
    return item
      ? [
          {
            id: row.id,
            position: offset + index + 1,
            addedAt: row.addedAt.toISOString(),
            item,
          },
        ]
      : []
  })
}

/** PL-12: a page of entries in position order with each item's Browse row. */
export async function listLibraryPlaylistEntries(
  id: string,
  query: LibraryPlaylistEntriesQuery,
): Promise<LibraryPlaylistEntriesPage> {
  const playlist = await readPlaylist(id)
  requireEntries(playlist)
  const offset = (query.page - 1) * query.size
  const rows = await db
    .select({
      id: libraryPlaylistEntry.id,
      addedAt: libraryPlaylistEntry.addedAt,
      mediaItemId: libraryPlaylistEntry.mediaItemId,
      subscriptionItemId: libraryPlaylistEntry.subscriptionItemId,
    })
    .from(libraryPlaylistEntry)
    .where(
      and(
        eq(libraryPlaylistEntry.playlistId, id),
        isNull(libraryPlaylistEntry.removedBatchId),
      ),
    )
    .orderBy(asc(libraryPlaylistEntry.position))
    .limit(query.size + 1)
    .offset(offset)
  const page = rows.slice(0, query.size)
  const ids = [
    ...new Set(
      page.flatMap((row) => {
        const item = row.mediaItemId ?? row.subscriptionItemId
        return item === null ? [] : [item]
      }),
    ),
  ]
  const slice = {
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
  switch (playlist.library) {
    case 'albums':
      return {
        library: 'albums',
        items: entriesWith(page, await loadAlbums(ids, undefined), offset),
        ...slice,
      }
    case 'tracks':
      return {
        library: 'tracks',
        items: entriesWith(page, await loadTracks(ids), offset),
        ...slice,
      }
    case 'films':
      return {
        library: 'films',
        items: entriesWith(page, await loadFilms(ids), offset),
        ...slice,
      }
    case 'subscriptions':
    case 'mixes':
      return {
        library: playlist.library,
        items: entriesWith(page, await loadSubscriptionItems(ids), offset),
        ...slice,
      }
  }
}

/** PL-16: the playlists that hold an item, by name. */
export async function listLibraryPlaylistMemberships(
  query: LibraryPlaylistMembershipsQuery,
): Promise<LibraryPlaylistSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(libraryPlaylist)
    .where(
      and(
        eq(libraryPlaylist.library, query.library),
        eq(libraryPlaylist.type, 'playlist'),
        isNull(libraryPlaylist.deletedAt),
        listedEntryOf(query.library, playlistIdColumn, query.itemId),
      ),
    )
    .orderBy(sql`lower(${libraryPlaylist.name})`, asc(libraryPlaylist.id))
    .limit(100)
  return rows.map(summary)
}
