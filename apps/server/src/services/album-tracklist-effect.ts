import { isDeepStrictEqual } from 'node:util'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema } from '@repo/schemas/common'
import { ServerError } from '@/lib/error'
import { album, track } from '@/schemas/db'
import {
  admitAlbumTrackMembers,
  withdrawAlbumTrackAdmission,
} from './album-track-membership'
import {
  defineChangeEffect,
  type ChangeDirection,
  type ChangeEffectEntry,
  type ChangeEffectHandler,
  type ChangeReader,
  type ChangeTransaction,
} from './library-change-effect'
import { refreshTrackDuplicates } from './track-duplicate-refresh'

export const albumTracklistEffectType = 'album-tracklist-correction'

const ALBUM_GONE = 'The album in this change is no longer stored.'
const TRACKLIST_CHANGED =
  'The album’s track list changed after it was reviewed.'
const RECORDING_GONE = 'A recording in this change is no longer available.'

const PositionSchema = z.object({
  id: z.string().min(1),
  albumMediaItemId: z.string().min(1),
  trackMediaItemId: z.string().min(1),
  position: z.number().int(),
  title: z.string(),
  durationSec: z.number().int().nullable(),
  externalId: z.string().nullable(),
  metadata: z.record(z.string(), JsonValueSchema).nullable(),
})
export type AlbumTracklistPosition = z.infer<typeof PositionSchema>

const PatchSchema = z.object({
  before: PositionSchema.nullable(),
  after: PositionSchema.nullable(),
})
export type AlbumTracklistPatch = z.infer<typeof PatchSchema>

const CorrectionSchema = z.object({
  albumId: z.string().min(1),
  patches: z.array(PatchSchema),
  expectedCount: z.number().int().nonnegative(),
  afterCount: z.number().int().nonnegative(),
})
type Correction = z.infer<typeof CorrectionSchema>
const EffectSchema = CorrectionSchema.extend({
  beforeMemberIds: z.array(z.string()),
  afterMemberIds: z.array(z.string()),
})
type Effect = z.infer<typeof EffectSchema>

const AlbumStateSchema = z.array(
  z.object({
    track_count: z.number().int(),
    positions: z.array(PositionSchema),
    saved: z.boolean(),
  }),
)
const RecordingRowsSchema = z.array(
  z.object({ id: z.string(), saved: z.boolean(), hidden: z.boolean() }),
)

const unique = (ids: string[]) => [...new Set(ids)]

const ordered = (positions: AlbumTracklistPosition[]) =>
  [...positions].sort((a, b) => a.position - b.position)

function positionsOn({ patches }: Correction, side: 'before' | 'after') {
  return patches.flatMap((patch) => {
    const row = patch[side]
    return row ? [row] : []
  })
}

function byRowId(positions: AlbumTracklistPosition[]) {
  return new Map(positions.map((row) => [row.id, row]))
}

function changedRows(
  positions: AlbumTracklistPosition[],
  other: Map<string, AlbumTracklistPosition>,
) {
  return positions.filter((row) => !isDeepStrictEqual(row, other.get(row.id)))
}

function recordingIds(positions: AlbumTracklistPosition[]) {
  return unique(positions.map((row) => row.trackMediaItemId))
}

function recordingDifference(ids: string[], other: string[]) {
  const present = new Set(other)
  return ids.filter((id) => !present.has(id))
}

function affectedTracks(correction: Correction) {
  const before = positionsOn(correction, 'before')
  const after = positionsOn(correction, 'after')
  return recordingIds([
    ...changedRows(before, byRowId(after)),
    ...changedRows(after, byRowId(before)),
  ])
}

function validateCorrection(correction: Correction) {
  const { albumId, patches, expectedCount, afterCount } = correction
  const before = positionsOn(correction, 'before')
  const after = positionsOn(correction, 'after')
  const validList = (positions: AlbumTracklistPosition[]) =>
    new Set(positions.map((row) => row.position)).size === positions.length &&
    byRowId(positions).size === positions.length &&
    positions.every((row) => row.albumMediaItemId === albumId)
  if (
    afterCount !== after.length ||
    !validList(before) ||
    !validList(after) ||
    patches.some(({ before, after }) => !before && !after) ||
    (expectedCount === afterCount &&
      isDeepStrictEqual(ordered(before), ordered(after)))
  )
    throw new ServerError({
      statusCode: 409,
      message: 'The track list correction is invalid.',
    })
}

async function readAlbum(reader: ChangeReader, albumId: string) {
  const [state] = AlbumStateSchema.parse(
    (
      await reader.execute(sql`
      select a.track_count, mi.in_library as saved, coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'albumMediaItemId', t.album_media_item_id,
          'trackMediaItemId', t.track_media_item_id, 'position', t.position,
          'title', t.title, 'durationSec', t.duration_sec, 'externalId', t.external_id,
          'metadata', t.metadata
        ) order by t.position)
        from track t where t.album_media_item_id = a.media_item_id
      ), '[]'::jsonb) as positions
      from album a join media_item mi on mi.id = a.media_item_id and mi.media_type = 'album'
      where a.media_item_id = ${albumId}`)
    ).rows,
  )
  return state
}

async function readRecordings(reader: ChangeReader, ids: string[]) {
  if (!ids.length) return []
  return RecordingRowsSchema.parse(
    (
      await reader.execute(sql`
      select mi.id, mi.in_library as saved,
        mi.metadata->>'legacyHidden' is not distinct from 'true' as hidden
      from library_track lt join media_item mi
        on mi.id = lt.media_item_id and mi.media_type = 'track'
      where mi.id = any(${sql.param(ids)}::text[])`)
    ).rows,
  )
}

async function checkCorrection(
  reader: ChangeReader,
  correction: Correction,
  direction: ChangeDirection,
): Promise<
  { blocker: string } | { beforeMemberIds: string[]; afterMemberIds: string[] }
> {
  const { albumId, expectedCount, afterCount } = correction
  const album = await readAlbum(reader, albumId)
  if (!album) return { blocker: ALBUM_GONE }

  const before = positionsOn(correction, 'before')
  const after = positionsOn(correction, 'after')
  const [expected, destination] =
    direction === 'undo' ? [after, before] : [before, after]
  if (
    album.track_count !== (direction === 'undo' ? afterCount : expectedCount) ||
    !isDeepStrictEqual(album.positions, ordered(expected))
  )
    return { blocker: TRACKLIST_CHANGED }

  const beforeIds = recordingIds(before)
  const afterIds = recordingIds(after)
  const ids = unique([...beforeIds, ...afterIds])
  const recordings = await readRecordings(reader, ids)
  const byId = new Map(recordings.map((recording) => [recording.id, recording]))
  if (recordings.length !== ids.length) return { blocker: RECORDING_GONE }
  const addedIds = recordingDifference(afterIds, beforeIds)
  if (direction === 'redo' && addedIds.some((id) => byId.get(id)?.hidden))
    return { blocker: RECORDING_GONE }

  const currentRows = byRowId(expected)
  const insertedIds = destination
    .filter(({ id }) => !currentRows.has(id))
    .map(({ id }) => id)
  if (insertedIds.length) {
    const occupied = await reader.execute(sql`
        select id from track where id = any(${sql.param(insertedIds)}::text[])
        limit 1`)
    if (occupied.rows.length) return { blocker: TRACKLIST_CHANGED }
  }

  return {
    beforeMemberIds: album.saved
      ? recordingDifference(beforeIds, afterIds).filter(
          (id) => byId.get(id)?.saved,
        )
      : [],
    afterMemberIds: album.saved ? addedIds : [],
  }
}

async function replacePositions(
  tx: ChangeTransaction,
  albumId: string,
  current: AlbumTracklistPosition[],
  replacement: AlbumTracklistPosition[],
) {
  const currentRows = byRowId(current)
  const nextRows = byRowId(replacement)
  const removed = current.filter(
    ({ id, position }) => nextRows.get(id)?.position !== position,
  )
  // Free their slots first, including when two retained rows trade positions.
  const timestamps = removed.length
    ? await tx
        .delete(track)
        .where(
          and(
            eq(track.albumMediaItemId, albumId),
            inArray(
              track.id,
              removed.map(({ id }) => id),
            ),
          ),
        )
        .returning({
          id: track.id,
          createdAt: track.createdAt,
          updatedAt: track.updatedAt,
        })
    : []
  const previousTimestamps = new Map(
    timestamps.map(({ id, ...times }) => [id, times]),
  )
  const additions: (typeof track.$inferInsert)[] = []
  const updates: AlbumTracklistPosition[] = []
  for (const row of changedRows(replacement, currentRows)) {
    if (currentRows.get(row.id)?.position === row.position) updates.push(row)
    else additions.push({ ...row, ...previousTimestamps.get(row.id) })
  }
  if (updates.length)
    await tx.execute(sql`
      update track t set track_media_item_id = r."trackMediaItemId",
        title = r.title, duration_sec = r."durationSec",
        external_id = r."externalId", metadata = r.metadata
      from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
        as r(id text, "trackMediaItemId" text, title text,
          "durationSec" integer, "externalId" text, metadata jsonb)
      where t.album_media_item_id = ${albumId} and t.id = r.id`)
  if (additions.length) await tx.insert(track).values(additions)
}

async function writeCorrection(
  tx: ChangeTransaction,
  effect: Effect,
  direction: ChangeDirection,
) {
  const {
    albumId,
    expectedCount,
    afterCount,
    beforeMemberIds,
    afterMemberIds,
  } = effect
  const before = positionsOn(effect, 'before')
  const after = positionsOn(effect, 'after')
  const [current, replacement] =
    direction === 'undo' ? [after, before] : [before, after]
  await replacePositions(tx, albumId, current, replacement)
  if (expectedCount !== afterCount)
    await tx
      .update(album)
      .set({ trackCount: direction === 'undo' ? expectedCount : afterCount })
      .where(eq(album.mediaItemId, albumId))

  const [leaving, joining] =
    direction === 'undo'
      ? [afterMemberIds, beforeMemberIds]
      : [beforeMemberIds, afterMemberIds]
  await withdrawAlbumTrackAdmission(tx, leaving)
  if (joining.length) await admitAlbumTrackMembers(tx, albumId, joining)

  const currentIds = recordingIds(current)
  const replacementIds = recordingIds(replacement)
  const touched = unique([
    ...leaving,
    ...joining,
    ...recordingDifference(currentIds, replacementIds),
    ...recordingDifference(replacementIds, currentIds),
  ])
  if (touched.length) {
    // The Added-date writer reaches the journal, which imports this effect.
    const { refreshTrackAddedDates } = await import('./spotify-playlists')
    await refreshTrackAddedDates(tx, touched)
    await refreshTrackDuplicates(tx, { trackIds: touched })
  }
}

const albumTracklistCorrection = defineChangeEffect({
  type: albumTracklistEffectType,
  payload: EffectSchema,
  async blocker(reader, effect, direction) {
    const checked = await checkCorrection(reader, effect, direction)
    return 'blocker' in checked ? checked.blocker : null
  },
  async apply(tx, effect, direction) {
    await writeCorrection(tx, effect, direction)
    return null
  },
})

/**
 * Applies a reviewed edition. Include the whole list on both sides, including
 * unchanged positions, and record the returned effect in the same transaction.
 */
export async function applyAlbumTracklistCorrection(
  tx: ChangeTransaction,
  albumId: string,
  patches: AlbumTracklistPatch[],
  expectedCount: number,
  afterCount: number,
): Promise<ChangeEffectEntry> {
  const correction = CorrectionSchema.parse({
    albumId,
    patches,
    expectedCount,
    afterCount,
  })
  validateCorrection(correction)
  const { lockLibraryTrackWrites } = await import('./album-library-tracks')
  await lockLibraryTrackWrites(tx)
  const checked = await checkCorrection(tx, correction, 'redo')
  if ('blocker' in checked)
    throw new ServerError({ statusCode: 409, message: checked.blocker })

  const effect = {
    ...correction,
    beforeMemberIds: checked.beforeMemberIds,
    afterMemberIds: checked.afterMemberIds,
  }
  await writeCorrection(tx, effect, 'redo')
  return albumTracklistCorrection.entry(effect, [
    albumId,
    ...affectedTracks(effect),
  ])
}

export const albumTracklistEffects: ChangeEffectHandler[] = [
  albumTracklistCorrection.handler,
]
