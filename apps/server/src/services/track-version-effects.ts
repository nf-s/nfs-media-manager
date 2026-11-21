import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  defineChangeEffect,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'

const TRACK_GONE = 'A track in this change is no longer in the library.'
const VERSIONS_MOVED =
  'A later change moved these versions. Undo that change first.'
const POSITIONS_MOVED =
  'A later change moved these album positions. Undo that change first.'
const POSITIONS_GONE = 'An album position in this change is no longer stored.'
const ENTRIES_MOVED =
  'A later change moved these playlist entries. Undo that change first.'

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

/*
 * The modules that relink and recount reach the journal, which imports this
 * module, so they are loaded when an effect runs.
 */
async function relinkRecords(tx: ChangeTransaction, trackIds: string[]) {
  const { relinkTrackRecords } = await import('./track-links')
  await relinkTrackRecords(tx, trackIds)
}
async function refreshAddedDates(tx: ChangeTransaction, trackIds: string[]) {
  const { refreshTrackAddedDates } = await import('./spotify-playlists')
  await refreshTrackAddedDates(tx, trackIds)
}

/* Versions: the group a track is in and whether the record is shown as it. */

const VersionStateSchema = z.object({
  groupId: z.string().nullable(),
  shown: z.boolean(),
})
/** A track's version group, or null when its versions are worked out. */
export type VersionState = z.infer<typeof VersionStateSchema>

const VersionStepSchema = z.object({
  id: z.string(),
  before: VersionStateSchema,
  after: VersionStateSchema,
})
/** One track's version group before and after a change. */
export type VersionStep = z.infer<typeof VersionStepSchema>

const VersionRowsSchema = z.array(
  z.object({
    id: z.string(),
    group_id: z.string().nullable(),
    shown: z.boolean(),
  }),
)

/** The stored version group of each given track that is in the library. */
export async function readVersionStates(reader: ChangeReader, ids: string[]) {
  if (!ids.length) return new Map<string, VersionState>()
  return new Map(
    VersionRowsSchema.parse(
      (
        await reader.execute(sql`
          select media_item_id as id, version_group_id as group_id,
            version_shown as shown
          from library_track where media_item_id in (${idList(ids)})`)
      ).rows,
    ).map((row) => [row.id, { groupId: row.group_id, shown: row.shown }]),
  )
}

const sameState = (left: VersionState, right: VersionState) =>
  left.groupId === right.groupId && left.shown === right.shown

async function writeVersionStates(
  tx: ChangeTransaction,
  states: { id: string; state: VersionState }[],
) {
  if (!states.length) return
  const rows = sql`jsonb_to_recordset(${JSON.stringify(
    states.map(({ id, state }) => ({
      id,
      group_id: state.groupId,
      shown: state.shown,
    })),
  )}::jsonb) as r(id text, group_id text, shown boolean)`
  // Clear first: a group can have one shown version at a time.
  await tx.execute(sql`
    update library_track lt set version_shown = false
    from ${rows} where lt.media_item_id = r.id and lt.version_shown`)
  await tx.execute(sql`
    update library_track lt
    set version_group_id = r.group_id, version_shown = r.shown
    from ${rows} where lt.media_item_id = r.id
      and (lt.version_group_id is distinct from r.group_id or r.shown)`)
}

const trackVersions = defineChangeEffect({
  type: 'track-versions',
  payload: z.object({ steps: z.array(VersionStepSchema) }),
  async blocker(reader, { steps }, direction) {
    const current = await readVersionStates(
      reader,
      steps.map((step) => step.id),
    )
    for (const step of steps) {
      const state = current.get(step.id)
      if (!state) return TRACK_GONE
      if (!sameState(state, direction === 'undo' ? step.after : step.before))
        return VERSIONS_MOVED
    }
    return null
  },
  async apply(tx, { steps }, direction) {
    await writeVersionStates(
      tx,
      steps.map((step) => ({
        id: step.id,
        state: direction === 'undo' ? step.before : step.after,
      })),
    )
    return () =>
      relinkRecords(
        tx,
        steps.map((step) => step.id),
      )
  },
})

/**
 * Puts the given tracks in the given version groups. Returns the effect to
 * record with the change, or null when every track was there already. The
 * caller relinks the record's names.
 */
export async function storeVersionStates(
  tx: ChangeTransaction,
  wanted: { id: string; state: VersionState }[],
): Promise<ChangeEffectEntry | null> {
  const current = await readVersionStates(
    tx,
    wanted.map(({ id }) => id),
  )
  const steps = wanted.flatMap(({ id, state }) => {
    const before = current.get(id)
    return before && !sameState(before, state)
      ? [{ id, before, after: state }]
      : []
  })
  if (!steps.length) return null
  await writeVersionStates(
    tx,
    steps.map(({ id, after }) => ({ id, state: after })),
  )
  return trackVersions.entry(
    { steps },
    steps.map((step) => step.id),
  )
}

/* Album positions: track list rows moved to the kept track. */

const AlbumLinkSchema = z.object({
  albumId: z.string().nullable(),
  strategy: z.string().nullable(),
})
type AlbumLink = z.infer<typeof AlbumLinkSchema>
const AlbumLinkRowsSchema = z.array(
  z.object({
    album_id: z.string().nullable(),
    strategy: z.string().nullable(),
  }),
)
const PositionRowsSchema = z.array(
  z.object({ id: z.string(), track_id: z.string() }),
)
const IdRowsSchema = z.array(z.object({ id: z.string() }))

async function readAlbumLink(
  reader: ChangeReader,
  trackId: string,
): Promise<AlbumLink | null> {
  const [row] = AlbumLinkRowsSchema.parse(
    (
      await reader.execute(sql`
        select album_media_item_id as album_id, album_link_strategy as strategy
        from library_track where media_item_id = ${trackId}`)
    ).rows,
  )
  return row ? { albumId: row.album_id, strategy: row.strategy } : null
}

const sameLink = (left: AlbumLink | null, right: AlbumLink) =>
  left !== null &&
  left.albumId === right.albumId &&
  left.strategy === right.strategy

async function writeAlbumLink(
  tx: ChangeTransaction,
  trackId: string,
  { albumId, strategy }: AlbumLink,
) {
  // The album can have left the library since.
  await tx.execute(sql`
    update library_track set
      album_media_item_id = (select media_item_id from album
        where media_item_id = ${albumId}),
      album_link_strategy = case when exists (select 1 from album
        where media_item_id = ${albumId}) then ${strategy} end
    where media_item_id = ${trackId}`)
}

const positionMove = defineChangeEffect({
  type: 'track-position-move',
  payload: z.object({
    sourceId: z.string(),
    targetId: z.string(),
    /** The `track` rows that moved from the source to the target. */
    positionIds: z.array(z.string()),
    /** The target's library album link, when the move changed it. */
    targetAlbum: z
      .object({ before: AlbumLinkSchema, after: AlbumLinkSchema })
      .nullable(),
  }),
  async blocker(
    reader,
    { sourceId, targetId, positionIds, targetAlbum },
    direction,
  ) {
    const rows = PositionRowsSchema.parse(
      (
        await reader.execute(sql`
          select id, track_media_item_id as track_id from track
          where id in (${idList(positionIds)})`)
      ).rows,
    )
    if (rows.length < positionIds.length) return POSITIONS_GONE
    const holder = direction === 'undo' ? targetId : sourceId
    if (rows.some((row) => row.track_id !== holder)) return POSITIONS_MOVED
    if (targetAlbum) {
      const link = await readAlbumLink(reader, targetId)
      if (!link) return TRACK_GONE
      if (
        !sameLink(
          link,
          direction === 'undo' ? targetAlbum.after : targetAlbum.before,
        )
      )
        return POSITIONS_MOVED
    }
    return null
  },
  async apply(tx, { sourceId, targetId, positionIds, targetAlbum }, direction) {
    const [from, to] =
      direction === 'undo' ? [targetId, sourceId] : [sourceId, targetId]
    await tx.execute(sql`
      update track set track_media_item_id = ${to}
      where id in (${idList(positionIds)}) and track_media_item_id = ${from}`)
    if (targetAlbum)
      await writeAlbumLink(
        tx,
        targetId,
        direction === 'undo' ? targetAlbum.before : targetAlbum.after,
      )
    return null
  },
})

/* Playlist entries: rows moved to the kept track, joined where it had one. */

const EntrySchema = z.object({
  position: z.number().int(),
  /** `added_at` to the microsecond, as stored. */
  addedAt: z.string().nullable(),
})
type Entry = z.infer<typeof EntrySchema>
const EntryStepSchema = z.object({
  playlistId: z.string(),
  /** The source's entry, removed by the move. */
  source: EntrySchema,
  /** The target's entry before the move, or null when it had none. */
  before: EntrySchema.nullable(),
  after: EntrySchema,
})
const EntryRowsSchema = z.array(
  z.object({
    playlist_id: z.string(),
    position: z.number().int(),
    added_at: z.string().nullable(),
  }),
)

async function readEntries(
  reader: ChangeReader,
  trackId: string,
  playlistIds?: string[],
) {
  if (playlistIds?.length === 0) return new Map<string, Entry>()
  return new Map(
    EntryRowsSchema.parse(
      (
        await reader.execute(sql`
          select playlist_id, position,
            to_char(added_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as added_at
          from playlist_item where media_item_id = ${trackId}
          ${playlistIds ? sql`and playlist_id in (${idList(playlistIds)})` : sql``}`)
      ).rows,
    ).map((row) => [
      row.playlist_id,
      { position: row.position, addedAt: row.added_at },
    ]),
  )
}

const entriesInput = (
  trackId: string,
  entries: { playlistId: string; entry: Entry }[],
) =>
  sql`(select r.playlist_id, ${trackId}::text as media_item_id, r.position,
    r.added_at::timestamp as added_at
    from jsonb_to_recordset(${JSON.stringify(
      entries.map(({ playlistId, entry }) => ({
        playlist_id: playlistId,
        position: entry.position,
        added_at: entry.addedAt,
      })),
    )}::jsonb) as r(playlist_id text, position int, added_at text)
    where exists (select 1 from playlist p where p.id = r.playlist_id))`

async function putEntries(
  tx: ChangeTransaction,
  trackId: string,
  entries: { playlistId: string; entry: Entry }[],
) {
  if (!entries.length) return
  await tx.execute(sql`
    insert into playlist_item (playlist_id, media_item_id, position, added_at)
    select * from ${entriesInput(trackId, entries)} e
    on conflict (playlist_id, media_item_id) do update
      set position = excluded.position, added_at = excluded.added_at`)
}

async function removeEntries(
  tx: ChangeTransaction,
  trackId: string,
  playlistIds: string[],
) {
  if (!playlistIds.length) return
  await tx.execute(sql`
    delete from playlist_item
    where media_item_id = ${trackId} and playlist_id in (${idList(playlistIds)})`)
}

async function existingPlaylists(reader: ChangeReader, ids: string[]) {
  if (!ids.length) return new Set<string>()
  return new Set(
    IdRowsSchema.parse(
      (
        await reader.execute(
          sql`select id from playlist where id in (${idList(ids)})`,
        )
      ).rows,
    ).map((row) => row.id),
  )
}

const playlistEntryMove = defineChangeEffect({
  type: 'track-playlist-entry-move',
  payload: z.object({
    sourceId: z.string(),
    targetId: z.string(),
    entries: z.array(EntryStepSchema),
  }),
  async blocker(reader, { sourceId, targetId, entries }, direction) {
    // A playlist deleted since has nothing to put back.
    const playlists = await existingPlaylists(
      reader,
      entries.map((entry) => entry.playlistId),
    )
    const held = await readEntries(
      reader,
      direction === 'undo' ? targetId : sourceId,
      [...playlists],
    )
    return [...playlists].every((id) => held.has(id)) ? null : ENTRIES_MOVED
  },
  async apply(tx, { sourceId, targetId, entries }, direction) {
    if (direction === 'undo') {
      await removeEntries(
        tx,
        targetId,
        entries
          .filter((entry) => entry.before === null)
          .map((entry) => entry.playlistId),
      )
      await putEntries(
        tx,
        targetId,
        entries.flatMap(({ playlistId, before }) =>
          before ? [{ playlistId, entry: before }] : [],
        ),
      )
      await putEntries(
        tx,
        sourceId,
        entries.map(({ playlistId, source }) => ({
          playlistId,
          entry: source,
        })),
      )
    } else {
      await putEntries(
        tx,
        targetId,
        entries.map(({ playlistId, after }) => ({ playlistId, entry: after })),
      )
      await removeEntries(
        tx,
        sourceId,
        entries.map((entry) => entry.playlistId),
      )
    }
    return () => refreshAddedDates(tx, [sourceId, targetId])
  },
})

/**
 * Moves a track's playlist entries, and its album positions when asked, to
 * another track, keeping what an undo needs. A playlist that has both keeps
 * the earlier position and Added date, as imports do. Returns the effects to
 * record with the change.
 */
export async function moveTrackMemberships(
  tx: ChangeTransaction,
  sourceId: string,
  targetId: string,
  moveAlbumPositions: boolean,
): Promise<ChangeEffectEntry[]> {
  const effects: ChangeEffectEntry[] = []
  const records = [sourceId, targetId]
  const sourceEntries = await readEntries(tx, sourceId)
  const playlistIds = [...sourceEntries.keys()]
  const targetBefore = await readEntries(tx, targetId, playlistIds)
  await tx.execute(sql`
    insert into playlist_item (playlist_id, media_item_id, position, added_at)
    select playlist_id, ${targetId}, position, added_at
    from playlist_item where media_item_id = ${sourceId}
    on conflict (playlist_id, media_item_id) do update
      set position = least(playlist_item.position, excluded.position),
        added_at = least(playlist_item.added_at, excluded.added_at)`)
  await removeEntries(tx, sourceId, playlistIds)
  const targetAfter = await readEntries(tx, targetId, playlistIds)
  const entries = playlistIds.flatMap((playlistId) => {
    const source = sourceEntries.get(playlistId)
    const after = targetAfter.get(playlistId)
    return source && after
      ? [
          {
            playlistId,
            source,
            before: targetBefore.get(playlistId) ?? null,
            after,
          },
        ]
      : []
  })
  if (entries.length)
    effects.push(
      playlistEntryMove.entry({ sourceId, targetId, entries }, records),
    )

  if (moveAlbumPositions) {
    const before = await readAlbumLink(tx, targetId)
    const moved = IdRowsSchema.parse(
      (
        await tx.execute(sql`
          update track set track_media_item_id = ${targetId}
          where track_media_item_id = ${sourceId} returning id`)
      ).rows,
    )
    await tx.execute(sql`
      update library_track target
      set album_media_item_id = source.album_media_item_id,
        album_link_strategy = 'album-track-list'
      from library_track source
      where target.media_item_id = ${targetId} and source.media_item_id = ${sourceId}
        and (target.album_media_item_id is null or target.album_media_item_id = source.album_media_item_id) and exists (
          select 1 from track t where t.track_media_item_id = target.media_item_id
            and t.album_media_item_id = source.album_media_item_id)`)
    const after = await readAlbumLink(tx, targetId)
    if (moved.length)
      effects.push(
        positionMove.entry(
          {
            sourceId,
            targetId,
            positionIds: moved.map((row) => row.id),
            targetAlbum:
              before && after && !sameLink(before, after)
                ? { before, after }
                : null,
          },
          records,
        ),
      )
  }
  return effects
}

/** Joining and separating versions of a track, and moving its album positions and playlist entries. */
export const trackVersionEffects: ChangeEffectHandler[] = [
  trackVersions.handler,
  positionMove.handler,
  playlistEntryMove.handler,
]
