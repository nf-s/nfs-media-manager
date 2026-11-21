import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import {
  LibraryChangeActionSchema,
  LibraryChangeActorSchema,
  LibraryChangeDetailsSchema,
  LibraryChangeKindSchema,
  type LibraryChange,
  type LibraryChangeAction,
  type LibraryChangeActor,
  type LibraryChangeDetails,
  type LibraryChangeKind,
  type LibraryChangeListQuery,
  type LibraryChangePage,
} from '@repo/schemas/library-changes'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  libraryChange,
  libraryChangeBatch,
  libraryChangeEffect,
  libraryChangeMove,
  libraryChangeRemoval,
  libraryMatchRejection,
  type LibraryChangeRecordSnapshot,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import { refreshArtistListeningTotals } from './artist-listening'
import type {
  AfterNames,
  ChangeDirection,
  ChangeEffectEntry,
  ChangeReader,
  ChangeTransaction,
} from './library-change-effect'
import { changeEffectHandler } from './library-change-effects'
import { refreshTrackAddedDates } from './spotify-playlists'
import {
  archiveTracks,
  existingTrackIds,
  idList,
  removeEmptyTracks,
  restoreRemovedTracks,
  storeRemovals,
  type ArchivedTrack,
} from './track-archive'
import { refreshTrackDuplicates } from './track-duplicate-refresh'
import { writeScrobbleTrackLinks } from './track-links'

type Transaction = ChangeTransaction
type Reader = ChangeReader
type ChangeRow = typeof libraryChange.$inferSelect
type EffectRow = typeof libraryChangeEffect.$inferSelect

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

/**
 * Tracks, albums or artists as they are named now, to keep with a change. An
 * artist has no `by`.
 */
export async function readChangeRecords(
  reader: Reader,
  kind: LibraryChangeKind,
  ids: string[],
): Promise<LibraryChangeRecordSnapshot[]> {
  if (!ids.length) return []
  return RecordRowsSchema.parse(
    (
      await reader.execute(
        kind === 'artist'
          ? sql`select id, name as title, '' as "by" from artist
              where id in (${idList(ids)})`
          : sql`
        select mi.id, mi.title, coalesce((
          select string_agg(a.name, ', ' order by c.billing_order, a.id)
          from media_credit c join artist a on a.id = c.artist_id
          where c.media_item_id = mi.id and c.role = 'artist'), '') as "by"
        from media_item mi where mi.id in (${idList(ids)})`,
      )
    ).rows,
  )
}

const readRecords = (reader: Reader, ids: string[]) =>
  readChangeRecords(reader, 'track', ids)

/** The given records of one kind that are in the library. */
async function existingRecordIds(
  reader: Reader,
  kind: LibraryChangeKind,
  ids: string[],
) {
  if (!ids.length) return new Set<string>()
  if (kind === 'track') return existingTrackIds(reader, ids)
  return new Set(
    IdRowsSchema.parse(
      (
        await reader.execute(
          kind === 'album'
            ? sql`select media_item_id as id from album
                where media_item_id in (${idList(ids)})`
            : sql`select id from artist where id in (${idList(ids)})`,
        )
      ).rows,
    ).map((row) => row.id),
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

export type ChangeHeader = {
  /** The change's ID, when an effect had to store it first. */
  id?: string
  kind: LibraryChangeKind
  action: LibraryChangeAction
  actor?: LibraryChangeActor
  /** The automatic rule that made the change. */
  rule?: string | null
  /** The run an automatic change belongs to, from `openChangeBatch`. */
  batchId?: string | null
  reversible?: boolean
  /**
   * The records History names. Taken from the scrobbled names that moved when
   * omitted.
   */
  target?: LibraryChangeRecordSnapshot | null
  sources?: LibraryChangeRecordSnapshot[]
  details?: LibraryChangeDetails | null
}

type NameMove = { from: NameState; to: NameState }

/** The names of the draft that now have another owner or matching mode. */
async function readNameMoves(
  tx: Transaction,
  draft: TrackChangeDraft,
): Promise<NameMove[]> {
  const after = new Map(
    (await readNameStates(tx, draft.before)).map((name) => [
      nameId(name),
      name,
    ]),
  )
  return draft.before.flatMap((from) => {
    const to = after.get(nameId(from))
    return to && (to.track_id !== from.track_id || to.manual !== from.manual)
      ? [{ from, to }]
      : []
  })
}

/** Starts a run of automatic changes. History lists the run as one row. */
export async function openChangeBatch(tx: Transaction, trigger: string) {
  const id = nanoid()
  await tx.insert(libraryChangeBatch).values({ id, trigger })
  return id
}

/** Ends a run: a run that recorded no change is not kept. */
export async function closeChangeBatch(tx: Reader, batchId: string) {
  await tx.execute(sql`
    delete from library_change_batch
    where id = ${batchId} and change_count = 0`)
}

/**
 * Records one change: the scrobbled track names that moved since `draft` was
 * read, and the effects the caller made besides. Call it in the transaction
 * that made the change, after making it. Returns the change's ID, or null
 * when nothing moved and there are no effects.
 */
export async function recordChange(
  tx: Transaction,
  header: ChangeHeader,
  {
    draft,
    effects = [],
  }: { draft?: TrackChangeDraft; effects?: ChangeEffectEntry[] } = {},
) {
  const moves = draft ? await readNameMoves(tx, draft) : []
  if (!moves.length && !effects.length) return null

  const scrobbled = new Map(
    moves.length
      ? ScrobbledNamesSchema.parse(
          (
            await tx.execute(sql`
              select e.username, e.artist_key, e.track_key,
                max(e.artist_name) as artist_name,
                max(e.track_name) as track_name, count(*)::int as count
              from lastfm_scrobble e
              join ${namesInput(moves.map(({ from }) => from))}
                on e.username = r.username and e.artist_key = r.artist_key
                  and e.track_key = r.track_key
              group by e.username, e.artist_key, e.track_key`)
          ).rows,
        ).map((name) => [nameId(name), name])
      : [],
  )
  const sourceIds = new Set(
    moves
      .filter(({ from, to }) => from.track_id !== to.track_id)
      .map(({ from }) => from.track_id),
  )
  const targetIds = [...new Set(moves.map(({ to }) => to.track_id))]
  const [movedTo] =
    header.target === undefined && targetIds.length === 1
      ? await readRecords(tx, targetIds)
      : []
  const id = header.id ?? nanoid()
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
  const scrobbles = rows.reduce((total, row) => total + row.scrobbles, 0)
  await tx.insert(libraryChange).values({
    id,
    kind: header.kind,
    action: header.action,
    actor: header.actor ?? 'owner',
    rule: header.rule ?? null,
    batchId: header.batchId ?? null,
    target: header.target ?? movedTo ?? null,
    sources:
      header.sources ??
      (draft?.records ?? []).filter((record) => sourceIds.has(record.id)),
    scrobbles,
    details: header.details ?? null,
    reversible: header.reversible ?? true,
  })
  for (let start = 0; start < rows.length; start += WRITE_BATCH)
    await tx
      .insert(libraryChangeMove)
      .values(rows.slice(start, start + WRITE_BATCH))
  if (effects.length)
    await tx.insert(libraryChangeEffect).values(
      effects.map((effect, position) => ({
        changeId: id,
        position,
        type: effect.type,
        recordIds: effect.recordIds,
        payload: effect.payload,
      })),
    )
  if (draft) await storeRemovals(tx, id, draft.archived)
  if (header.batchId)
    await tx
      .update(libraryChangeBatch)
      .set({
        changeCount: sql`${libraryChangeBatch.changeCount} + 1`,
        nameCount: sql`${libraryChangeBatch.nameCount} + ${rows.length}`,
        scrobbles: sql`${libraryChangeBatch.scrobbles} + ${scrobbles}`,
      })
      .where(eq(libraryChangeBatch.id, header.batchId))
  return id
}

/**
 * Records a change to tracks: the names that now belong to another track or
 * changed between manual and automatic matching, with any effects.
 */
export async function recordTrackChange(
  tx: Transaction,
  draft: TrackChangeDraft,
  {
    effects,
    ...header
  }: Omit<ChangeHeader, 'kind'> & { effects?: ChangeEffectEntry[] },
) {
  return recordChange(tx, { ...header, kind: 'track' }, { draft, effects })
}

/** A scrobbled name a run moved, as the run knows it. */
export type RecordedNameMove = {
  username: string
  artistKey: string
  trackKey: string
  fromId: string
  fromManual: boolean
  toId: string
  toManual: boolean
}

const ArchivedRecordSchema = z.object({
  mediaItem: z.object({ title: z.string() }),
  credits: z.array(z.object({ artistName: z.string(), role: z.string() })),
})

/** A removed track as History names it. */
function archivedRecord({
  id,
  snapshot,
}: ArchivedTrack): LibraryChangeRecordSnapshot[] {
  const parsed = ArchivedRecordSchema.safeParse(snapshot)
  if (!parsed.success) return []
  return [
    {
      id,
      title: parsed.data.mediaItem.title,
      by: parsed.data.credits
        .filter((credit) => credit.role === 'artist')
        .map((credit) => credit.artistName)
        .join(', '),
    },
  ]
}

const READ_BATCH = 5000

function batches<Item>(items: Item[], size: number) {
  const result: Item[][] = []
  for (let start = 0; start < items.length; start += size)
    result.push(items.slice(start, start + size))
  return result
}

/**
 * Records scrobbled names a run moved, when the run knows the moves: one
 * change for each track the names went to, so one wrong match can be undone
 * alone. Call it after the moves, in their transaction. Returns the changes'
 * IDs.
 */
export async function recordNameMoves(
  tx: Transaction,
  {
    moves,
    rule,
    action,
    actor = 'automatic',
    batchId = null,
    archived = [],
    effects,
    details,
  }: {
    moves: RecordedNameMove[]
    rule: string | null
    /** `merge` when a track the names left was removed, else `move`, when omitted. */
    action?: LibraryChangeAction
    actor?: LibraryChangeActor
    /** The run, from `openChangeBatch`. */
    batchId?: string | null
    /** The tracks the names left, read with `archiveTracks` before the moves. */
    archived?: ArchivedTrack[]
    /** The effects to keep with the change of one track's names. */
    effects?: (toId: string, moves: RecordedNameMove[]) => ChangeEffectEntry[]
    /** What the change of one track's names moved besides them. */
    details?: (
      toId: string,
      moves: RecordedNameMove[],
    ) => LibraryChangeDetails | null
  },
): Promise<string[]> {
  const changed = moves.filter(
    (move) => move.fromId !== move.toId || move.fromManual !== move.toManual,
  )
  if (!changed.length) return []

  const nameOf = (move: RecordedNameMove) =>
    JSON.stringify([move.username, move.artistKey, move.trackKey])
  const scrobbled = new Map<
    string,
    z.infer<typeof ScrobbledNamesSchema>[number]
  >()
  for (const batch of batches(changed, READ_BATCH))
    for (const name of ScrobbledNamesSchema.parse(
      (
        await tx.execute(sql`
          select e.username, e.artist_key, e.track_key,
            max(e.artist_name) as artist_name,
            max(e.track_name) as track_name, count(*)::int as count
          from lastfm_scrobble e
          join ${namesInput(
            batch.map((move) => ({
              username: move.username,
              artist_key: move.artistKey,
              track_key: move.trackKey,
            })),
          )}
            on e.username = r.username and e.artist_key = r.artist_key
              and e.track_key = r.track_key
          group by e.username, e.artist_key, e.track_key`)
      ).rows,
    ))
      scrobbled.set(nameId(name), name)

  const trackIds = [
    ...new Set(changed.flatMap((move) => [move.fromId, move.toId])),
  ]
  const records = new Map<string, LibraryChangeRecordSnapshot>()
  for (const batch of batches(trackIds, READ_BATCH))
    for (const record of await readRecords(tx, batch))
      records.set(record.id, record)
  const removed = new Map<string, ArchivedTrack>()
  for (const batch of batches(archived, READ_BATCH)) {
    const present = await existingTrackIds(
      tx,
      batch.map((track) => track.id),
    )
    for (const track of batch)
      if (!present.has(track.id)) removed.set(track.id, track)
  }
  for (const track of removed.values())
    for (const record of archivedRecord(track))
      if (!records.has(record.id)) records.set(record.id, record)

  const byTarget = new Map<string, RecordedNameMove[]>()
  for (const move of changed)
    byTarget.set(move.toId, [...(byTarget.get(move.toId) ?? []), move])

  const changes: (typeof libraryChange.$inferInsert)[] = []
  const moveRows: (typeof libraryChangeMove.$inferInsert)[] = []
  const effectRows: (typeof libraryChangeEffect.$inferInsert)[] = []
  const removalRows: (typeof libraryChangeRemoval.$inferInsert)[] = []
  let scrobbles = 0
  for (const [toId, group] of byTarget) {
    const id = nanoid()
    const sourceIds = [
      ...new Set(
        group.filter((move) => move.fromId !== toId).map((move) => move.fromId),
      ),
    ]
    let total = 0
    for (const move of group) {
      const name = scrobbled.get(nameOf(move))
      total += name?.count ?? 0
      moveRows.push({
        changeId: id,
        username: move.username,
        artistKey: move.artistKey,
        trackKey: move.trackKey,
        artistName: name?.artist_name ?? move.artistKey,
        trackName: name?.track_name ?? move.trackKey,
        scrobbles: name?.count ?? 0,
        fromId: move.fromId,
        fromManual: move.fromManual,
        toId: move.toId,
        toManual: move.toManual,
      })
    }
    scrobbles += total
    changes.push({
      id,
      kind: 'track',
      action:
        action ??
        (sourceIds.some((sourceId) => removed.has(sourceId))
          ? 'merge'
          : 'move'),
      actor,
      rule,
      batchId,
      target: records.get(toId) ?? null,
      sources: sourceIds.flatMap((sourceId) => records.get(sourceId) ?? []),
      scrobbles: total,
      details: details?.(toId, group) ?? null,
      reversible: true,
    })
    for (const [position, effect] of (effects?.(toId, group) ?? []).entries())
      effectRows.push({
        changeId: id,
        position,
        type: effect.type,
        recordIds: effect.recordIds,
        payload: effect.payload,
      })
    for (const sourceId of sourceIds) {
      const track = removed.get(sourceId)
      if (track)
        removalRows.push({
          changeId: id,
          recordId: track.id,
          snapshot: track.snapshot,
        })
    }
  }

  for (const batch of batches(changes, WRITE_BATCH))
    await tx.insert(libraryChange).values(batch)
  for (const batch of batches(moveRows, WRITE_BATCH))
    await tx.insert(libraryChangeMove).values(batch)
  for (const batch of batches(effectRows, WRITE_BATCH))
    await tx.insert(libraryChangeEffect).values(batch)
  // A track's names can go to several tracks; each change can restore it.
  for (const batch of batches(removalRows, 50))
    await tx.insert(libraryChangeRemoval).values(batch).onConflictDoNothing()
  if (batchId)
    await tx
      .update(libraryChangeBatch)
      .set({
        changeCount: sql`${libraryChangeBatch.changeCount} + ${changes.length}`,
        nameCount: sql`${libraryChangeBatch.nameCount} + ${moveRows.length}`,
        scrobbles: sql`${libraryChangeBatch.scrobbles} + ${scrobbles}`,
      })
      .where(eq(libraryChangeBatch.id, batchId))
  return changes.map((change) => change.id)
}

/**
 * Records tracks a run removed that it cannot put back, with their archives,
 * so nothing is lost and History lists them. Call it after the removal, in its
 * transaction, with the tracks read with `archiveTracks` before. Returns the
 * change's ID, or null when none of the tracks was removed.
 */
export async function recordRemovedTracks(
  tx: Transaction,
  {
    archived,
    rule,
    actor = 'automatic',
    batchId = null,
    details = null,
  }: {
    archived: ArchivedTrack[]
    rule: string | null
    actor?: LibraryChangeActor
    batchId?: string | null
    details?: LibraryChangeDetails | null
  },
): Promise<string | null> {
  const present = await existingTrackIds(
    tx,
    archived.map((track) => track.id),
  )
  const removed = archived.filter((track) => !present.has(track.id))
  if (!removed.length) return null
  const id = nanoid()
  await tx.insert(libraryChange).values({
    id,
    kind: 'track',
    action: 'remove',
    actor,
    rule,
    batchId,
    target: null,
    sources: removed.flatMap(archivedRecord),
    details,
    reversible: false,
  })
  for (const batch of batches(removed, 50))
    await tx.insert(libraryChangeRemoval).values(
      batch.map((track) => ({
        changeId: id,
        recordId: track.id,
        snapshot: track.snapshot,
      })),
    )
  if (batchId)
    await tx
      .update(libraryChangeBatch)
      .set({ changeCount: sql`${libraryChangeBatch.changeCount} + 1` })
      .where(eq(libraryChangeBatch.id, batchId))
  return id
}

const NAMES_MOVED = 'A later change moved these names. Undo that change first.'
const NAMES_GONE = 'The scrobbles this change moved are no longer stored.'
const TRACK_GONE = 'A track in this change is no longer in the library.'
const NOT_RECORDED = 'This change cannot be undone.'
const UNKNOWN_EFFECT = 'This change was made by a newer version of the app.'

/** Why an effect cannot be applied in a direction now, or null. */
async function effectBlocker(
  reader: Reader,
  effect: EffectRow,
  direction: ChangeDirection,
) {
  const handler = changeEffectHandler(effect.type)
  if (!handler) return UNKNOWN_EFFECT
  return handler.blocker(reader, effect.payload, direction, {
    changeId: effect.changeId,
  })
}

/** Tracks an effect makes exist when applied in a direction. */
const effectRestores = (effect: EffectRow, direction: ChangeDirection) =>
  changeEffectHandler(effect.type)?.restores(effect.payload, direction) ?? []

async function describeChanges(
  reader: Pick<typeof db, 'execute' | 'select'>,
  rows: ChangeRow[],
): Promise<LibraryChange[]> {
  if (!rows.length) return []
  const ids = rows.map((row) => row.id)
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
        where m.change_id in (${idList(ids)})
        order by m.scrobbles desc, m.track_name, m.artist_name`)
    ).rows,
  )
  const effects = await reader
    .select()
    .from(libraryChangeEffect)
    .where(inArray(libraryChangeEffect.changeId, ids))
    .orderBy(asc(libraryChangeEffect.position))
  const existing = new Map<LibraryChangeKind, Set<string>>()
  for (const kind of LibraryChangeKindSchema.options)
    existing.set(
      kind,
      await existingRecordIds(reader, kind, [
        ...new Set(
          rows
            .filter((row) => row.kind === kind)
            .flatMap((row) => [
              ...(row.target ? [row.target.id] : []),
              ...row.sources.map((source) => source.id),
            ]),
        ),
      ]),
    )
  return Promise.all(
    rows.map(async (row) => {
      const kind = LibraryChangeKindSchema.parse(row.kind)
      const record = (snapshot: LibraryChangeRecordSnapshot) => ({
        ...snapshot,
        exists: existing.get(kind)?.has(snapshot.id) ?? false,
      })
      const own = moves.filter((move) => move.change_id === row.id)
      // A name whose scrobbles were deleted has nothing left to move.
      const live = own.filter((move) => move.owner_id !== null)
      const ownEffects = effects.filter((effect) => effect.changeId === row.id)
      const undone = row.undoneAt !== null
      const direction: ChangeDirection = undone ? 'redo' : 'undo'
      const blocked = async () => {
        if (!row.reversible) return NOT_RECORDED
        if (!live.length && !ownEffects.length) return NAMES_GONE
        const [here, there, available] = undone
          ? (['from_id', 'to_id', 'to_available'] as const)
          : (['to_id', 'from_id', 'from_available'] as const)
        if (live.some((move) => move.owner_id !== move[here]))
          return NAMES_MOVED
        const made = new Set(
          ownEffects.flatMap((effect) => effectRestores(effect, direction)),
        )
        if (live.some((move) => !move[available] && !made.has(move[there])))
          return TRACK_GONE
        for (const effect of ownEffects) {
          const reason = await effectBlocker(reader, effect, direction)
          if (reason) return reason
        }
        return null
      }
      const reason = await blocked()
      return {
        id: row.id,
        kind,
        action: LibraryChangeActionSchema.parse(row.action),
        actor: LibraryChangeActorSchema.parse(row.actor),
        rule: row.rule,
        batchId: row.batchId,
        target: row.target ? record(row.target) : null,
        sources: row.sources.map(record),
        names: own.slice(0, 5).map((move) => ({
          artistName: move.artist_name,
          trackName: move.track_name,
          scrobbles: move.scrobbles,
        })),
        nameCount: own.length,
        scrobbles: row.scrobbles,
        details: row.details
          ? LibraryChangeDetailsSchema.parse(row.details)
          : null,
        createdAt: row.createdAt.toISOString(),
        undoneAt: row.undoneAt?.toISOString() ?? null,
        reversible: row.reversible,
        canUndo: !undone && reason === null,
        canRedo: undone && reason === null,
        blocked: reason,
      }
    }),
  )
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
  batchId,
}: LibraryChangeListQuery): Promise<LibraryChangePage> {
  const where = and(
    eq(libraryChange.kind, kind),
    actor ? eq(libraryChange.actor, actor) : undefined,
    batchId ? eq(libraryChange.batchId, batchId) : undefined,
    recordId
      ? sql`(exists (select 1 from library_change_move m
          where m.change_id = ${libraryChange.id}
            and (m.from_id = ${recordId} or m.to_id = ${recordId}))
        or exists (select 1 from library_change_effect e
          where e.change_id = ${libraryChange.id}
            and e.record_ids @> array[${recordId}]::text[]))`
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

type NameStep = {
  state: NameState
  origin: { id: string; manual: boolean }
  destination: { id: string; manual: boolean }
}

/**
 * Remembers the matches an undone automatic change had made, so no automatic
 * rule makes them again. Making the change again forgets them.
 */
async function rememberUndoneMatches(
  tx: Transaction,
  change: ChangeRow,
  direction: ChangeDirection,
  steps: NameStep[],
) {
  if (change.actor !== 'automatic') return
  await tx
    .delete(libraryMatchRejection)
    .where(eq(libraryMatchRejection.changeId, change.id))
  const moved = steps.filter(
    ({ origin, destination }) => origin.id !== destination.id,
  )
  if (direction === 'redo' || !moved.length) return
  for (let start = 0; start < moved.length; start += WRITE_BATCH)
    await tx
      .insert(libraryMatchRejection)
      .values(
        moved.slice(start, start + WRITE_BATCH).map(({ state, origin }) => ({
          username: state.username,
          artistKey: state.artist_key,
          trackKey: state.track_key,
          recordId: origin.id,
          rule: change.rule,
          reason: 'undo',
          changeId: change.id,
        })),
      )
      .onConflictDoNothing()
}

async function applyChange(id: string, direction: ChangeDirection) {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const [change] = await tx
      .select()
      .from(libraryChange)
      .where(eq(libraryChange.id, id))
      .for('update')
    if (!change)
      throw new ServerError({ statusCode: 404, message: 'Change not found.' })
    if (!change.reversible)
      throw new ServerError({ statusCode: 409, message: NOT_RECORDED })
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
    const effects = await tx
      .select()
      .from(libraryChangeEffect)
      .where(eq(libraryChangeEffect.changeId, id))
      .orderBy(asc(libraryChangeEffect.position))
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
    const steps: NameStep[] = moves.flatMap((move) => {
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
    if (!steps.length && !effects.length)
      throw new ServerError({ statusCode: 409, message: NAMES_GONE })
    if (steps.some(({ state, origin }) => state.track_id !== origin.id))
      throw new ServerError({ statusCode: 409, message: NAMES_MOVED })
    for (const effect of effects) {
      const reason = await effectBlocker(tx, effect, direction)
      if (reason) throw new ServerError({ statusCode: 409, message: reason })
    }

    const destinationIds = [
      ...new Set(steps.map(({ destination }) => destination.id)),
    ]
    const present = await existingTrackIds(tx, destinationIds)
    const lost = await restoreRemovedTracks(
      tx,
      id,
      destinationIds.filter((trackId) => !present.has(trackId)),
    )

    const afterNames: AfterNames[] = []
    for (const effect of direction === 'undo'
      ? [...effects].reverse()
      : effects) {
      const later = await changeEffectHandler(effect.type)?.apply(
        tx,
        effect.payload,
        direction,
        { changeId: id },
      )
      if (later) afterNames.push(later)
    }
    // An effect can have made a track that was never archived.
    if ((await existingTrackIds(tx, lost)).size < lost.length)
      throw new ServerError({ statusCode: 409, message: TRACK_GONE })

    // Before relinking, so the plays of an undone match are not counted there.
    await rememberUndoneMatches(tx, change, direction, steps)
    if (steps.length) {
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
    }
    for (const later of afterNames) await later()

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
    if (steps.length) {
      await refreshTrackAddedDates(tx, [
        ...new Set([...originIds, ...destinationIds]),
      ])
      await refreshArtistListeningTotals(tx)
    }
    if (change.kind === 'track') {
      // Tracks the change touched can be possible duplicates again, or not.
      const touched = [
        ...new Set([
          ...moves.flatMap((move) => [move.fromId, move.toId]),
          ...effects.flatMap((effect) => effect.recordIds),
        ]),
      ]
      if (touched.length)
        await refreshTrackDuplicates(tx, { trackIds: touched })
    }
    await tx
      .update(libraryChange)
      .set({ undoneAt: direction === 'undo' ? new Date() : null })
      .where(eq(libraryChange.id, id))
    return getLibraryChange(id, tx)
  })
}

/** Puts back everything the change moved. */
export async function undoLibraryChange(id: string) {
  return applyChange(id, 'undo')
}

/** Makes an undone change again. */
export async function redoLibraryChange(id: string) {
  return applyChange(id, 'redo')
}
