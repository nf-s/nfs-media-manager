import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  TrackMergeBlock,
  TrackMergeCaution,
  TrackMergeOutcome,
  TrackMergePlan,
  TrackMergePlanRequest,
} from '@repo/schemas/library-changes'
import type { TrackDuplicateMerge } from '@repo/schemas/track-duplicates'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { artistKeys, plainKey } from '@/lib/lastfm-album-matching'
import { trackVersionQualifiers } from '@/lib/track-matching'
import { readKeptSeparate } from './keep-separate-effects'
import { readTrackFollows, type TrackFollow } from './merge-follows'
import { albumTrackDurationExpression } from './track-values'

type Reader = Pick<typeof db, 'execute'>

/** A plan request. Without `follow`, nothing follows. */
export type TrackMergeSelection = Omit<TrackMergePlanRequest, 'follow'> & {
  follow?: boolean
}

// Known lengths further apart than this are treated as different recordings.
const DURATION_TOLERANCE_SEC = 10

const PlanTracksSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    artists: z.array(z.string()),
    album_title: z.string().nullable(),
    duration_sec: z.number().int().positive().nullable(),
    scrobbles: z.number().int().nonnegative(),
    spotify: z.boolean(),
    on_album: z.boolean(),
    on_playlist: z.boolean(),
    name_count: z.number().int().nonnegative(),
  }),
)
type PlanTrack = z.infer<typeof PlanTracksSchema>[number]

const PlanNamesSchema = z.array(
  z.object({
    track_id: z.string(),
    artist_name: z.string(),
    track_name: z.string(),
    count: z.number().int().nonnegative(),
    counted: z.boolean(),
  }),
)
const SharedAlbumsSchema = z.array(z.object({ title: z.string() }))

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

/** What a track has besides scrobbled names, which keeps it a track of its own. */
function blockOf(track: PlanTrack): TrackMergeBlock | null {
  if (track.spotify) return 'spotify'
  if (track.on_album) return 'album'
  if (track.on_playlist) return 'playlist'
  return null
}

/**
 * A track with its own Spotify track stays as a version of the kept record,
 * and so does one with no scrobbled names to move. The others are merged.
 */
function outcomeOf(track: PlanTrack, target: PlanTrack): TrackMergeOutcome {
  if (track === target) return 'keep'
  return track.spotify || track.name_count === 0 ? 'version' : 'merge'
}

/**
 * The chosen track, else one with its own Spotify track, else one with
 * another identity, else the most played.
 */
function chooseTarget(tracks: PlanTrack[], targetId?: string) {
  const [first] = [...tracks].sort(
    (left, right) =>
      Number(right.spotify) - Number(left.spotify) ||
      Number(blockOf(right) !== null) - Number(blockOf(left) !== null) ||
      right.scrobbles - left.scrobbles ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  )
  return tracks.find((track) => track.id === targetId) ?? first
}

function versionCaution(tracks: PlanTrack[]): TrackMergeCaution[] {
  const qualifiers = tracks.map(
    (track) =>
      new Map(
        trackVersionQualifiers(track.title).map((word) => [
          plainKey(word),
          word,
        ]),
      ),
  )
  const words = new Map<string, string>()
  for (const own of qualifiers)
    for (const [key, word] of own)
      if (!words.has(key) && !qualifiers.every((other) => other.has(key)))
        words.set(key, word)
  return words.size ? [{ code: 'version', words: [...words.values()] }] : []
}

function durationCaution(tracks: PlanTrack[]): TrackMergeCaution[] {
  const lengths = tracks.flatMap((track) =>
    track.duration_sec === null ? [] : [track.duration_sec],
  )
  const seconds =
    lengths.length > 1 ? Math.max(...lengths) - Math.min(...lengths) : 0
  return seconds > DURATION_TOLERANCE_SEC ? [{ code: 'duration', seconds }] : []
}

function artistCaution(
  target: PlanTrack,
  sources: PlanTrack[],
): TrackMergeCaution[] {
  const targetKeys = new Set(target.artists.flatMap(artistKeys))
  // A track without a credited artist says nothing either way.
  const different = sources.filter(
    (source) =>
      targetKeys.size > 0 &&
      source.artists.length > 0 &&
      !source.artists.flatMap(artistKeys).some((key) => targetKeys.has(key)),
  )
  const names = [
    ...new Set([target, ...different].map((track) => track.artists.join(', '))),
  ]
  return different.length && names.length > 1
    ? [{ code: 'artists', names }]
    : []
}

/** The tracks of the given IDs that a merge can read. */
async function readPlanTracks(
  reader: Reader,
  trackIds: string[],
  lock = false,
) {
  return PlanTracksSchema.parse(
    (
      await reader.execute(sql`
        select lt.media_item_id as id, mi.title,
          coalesce((
            select array_agg(a.name order by c.billing_order, a.id)
            from media_credit c join artist a on a.id = c.artist_id
            where c.media_item_id = mi.id and c.role = 'artist'), '{}') as artists,
          coalesce(am.title, lt.album_name) as album_title,
          nullif(greatest(coalesce(lt.duration_sec, ${albumTrackDurationExpression(
            sql`lt.media_item_id`,
            sql`lt.album_media_item_id`,
          )}), 0), 0) as duration_sec,
          lt.scrobble_count as scrobbles,
          lt.spotify_track_id is not null as spotify,
          exists (select 1 from track t
            where t.track_media_item_id = lt.media_item_id) as on_album,
          exists (select 1 from playlist_item pi
            where pi.media_item_id = lt.media_item_id) as on_playlist,
          (select count(*)::int from lastfm_track_source s
            where s.track_media_item_id = lt.media_item_id) as name_count
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        left join media_item am on am.id = lt.album_media_item_id
        where lt.media_item_id in (${idList(trackIds)})
          and mi.media_type = 'track'
          and mi.metadata->>'legacyHidden' is distinct from 'true'
        ${lock ? sql`for update of lt` : sql``}`)
    ).rows,
  )
}

/** Albums on which two of the tracks are different positions. */
async function sameAlbumCaution(
  reader: Reader,
  trackIds: string[],
): Promise<TrackMergeCaution[]> {
  const albums = SharedAlbumsSchema.parse(
    (
      await reader.execute(sql`
        select mi.title from track t join media_item mi on mi.id = t.album_media_item_id
        where t.track_media_item_id in (${idList(trackIds)})
        group by mi.id, mi.title
        having count(distinct t.track_media_item_id) > 1
        order by mi.title, mi.id`)
    ).rows,
  )
  return albums.length
    ? [{ code: 'same-album', albums: albums.map((album) => album.title) }]
    : []
}

async function separateCaution(
  reader: Reader,
  trackIds: string[],
): Promise<TrackMergeCaution[]> {
  const pairs = await readKeptSeparate(reader, 'track', trackIds)
  const kept = [
    ...new Set(pairs.flatMap(({ lowId, highId }) => [lowId, highId])),
  ]
  return kept.length ? [{ code: 'separate', trackIds: kept }] : []
}

const shownName = (name: { artistName: string; trackName: string }) => ({
  artistName: name.artistName,
  trackName: name.trackName,
})

/** Titles that would follow from another album, or match more than one track. */
function followCautions(follows: TrackFollow[]): TrackMergeCaution[] {
  const elsewhere = follows.flatMap(({ follow }) => follow.elsewhere)
  const ambiguous = follows.flatMap(({ follow }) => follow.ambiguous)
  const cautions: TrackMergeCaution[] = []
  if (elsewhere.length)
    cautions.push({
      code: 'elsewhere',
      count: elsewhere.length,
      names: elsewhere.slice(0, 5),
    })
  if (ambiguous.length)
    cautions.push({
      code: 'ambiguous',
      count: ambiguous.length,
      names: ambiguous.slice(0, 5).map(shownName),
    })
  return cautions
}

/** What a track merge would do, with what follows it, for `mergeTracks`. */
export type TrackMergeReading = {
  plan: TrackMergePlan
  follows: TrackFollow[]
}

/**
 * What merging the selected tracks would do, and with `follow`, the album
 * names and titles that follow. `lock` holds the tracks for the rest of the
 * caller's transaction.
 */
export async function readTrackMerge(
  reader: Reader,
  { trackIds, targetId, follow = false }: TrackMergeSelection,
  lock = false,
): Promise<TrackMergeReading> {
  const tracks = await readPlanTracks(reader, trackIds, lock)
  const target = chooseTarget(tracks, targetId)
  if (!target || tracks.length !== trackIds.length)
    throw new ServerError({ statusCode: 404, message: 'Track not found.' })

  const names = PlanNamesSchema.parse(
    (
      await reader.execute(sql`
        select s.track_media_item_id as track_id,
          max(e.artist_name) as artist_name, max(e.track_name) as track_name,
          count(*)::int as count,
          exists (select 1 from lastfm_track_link l
            where l.username = s.username and l.artist_key = s.artist_key
              and l.track_key = s.track_key
              and l.track_media_item_id = ${target.id}) as counted
        from lastfm_track_source s
        join lastfm_scrobble e on e.username = s.username
          and e.artist_key = s.artist_key and e.track_key = s.track_key
        where s.track_media_item_id in (${idList(trackIds)})
        group by s.track_media_item_id, s.username, s.artist_key, s.track_key
        order by count(*) desc, max(e.track_name), max(e.artist_name)`)
    ).rows,
  )
  const ordered = [target, ...tracks.filter((track) => track !== target)]
  const sources = ordered.filter((track) => track !== target)
  const moving = names.filter((name) =>
    sources.some(
      (track) =>
        track.id === name.track_id && outcomeOf(track, target) === 'merge',
    ),
  )
  const follows = follow
    ? await readTrackFollows(reader, {
        targetId: target.id,
        mergedIds: sources
          .filter((track) => outcomeOf(track, target) === 'merge')
          .map((track) => track.id),
        selectedIds: trackIds,
      })
    : []
  // Names a new version keeps also count for the record.
  const added = names.reduce(
    (total, name) =>
      total + (name.track_id === target.id || name.counted ? 0 : name.count),
    0,
  )
  const plan: TrackMergePlan = {
    targetId: target.id,
    tracks: ordered.map((track) => ({
      id: track.id,
      title: track.title,
      by: track.artists.join(', '),
      albumTitle: track.album_title,
      durationSec: track.duration_sec,
      scrobbles: track.scrobbles,
      spotify: track.spotify,
      nameCount: names.filter((name) => name.track_id === track.id).length,
      identity: blockOf(track),
      outcome: outcomeOf(track, target),
      blocked: null,
    })),
    names: moving.map((name) => ({
      trackId: name.track_id,
      artistName: name.artist_name,
      trackName: name.track_name,
      count: name.count,
      counted: name.counted,
    })),
    scrobbles: {
      target: target.scrobbles,
      added,
      total: target.scrobbles + added,
    },
    also: {
      albumNames: follows.flatMap(({ albumId, albumTitle, names }) =>
        names.map((name) => ({
          artistName: name.artistName,
          albumName: name.albumName,
          scrobbles: name.scrobbles,
          toAlbumId: albumId,
          toAlbumTitle: albumTitle,
        })),
      ),
      titles: follows.flatMap(({ follow: { also } }) =>
        also.map((name) => ({
          ...shownName(name),
          scrobbles: name.scrobbles,
          fromTrackId: name.fromTrackId,
          toTrackId: name.toTrackId,
          toTitle: name.toTitle,
        })),
      ),
    },
    cautions: [
      ...versionCaution(ordered),
      ...durationCaution(ordered),
      ...artistCaution(target, sources),
      ...(await sameAlbumCaution(reader, trackIds)),
      ...(await separateCaution(reader, trackIds)),
      ...followCautions(follows),
    ],
    blocked: false,
  }
  return { plan, follows }
}

/** What a list of suggested merges stores of each: the order and the cautions. */
export type TrackMergeOutline = {
  /** The tracks, the one to keep first. */
  trackIds: string[]
  cautions: TrackMergeCaution[]
}

// The most track IDs one outline statement is given.
const OUTLINE_BATCH = 2000

/** Consecutive groups of up to `OUTLINE_BATCH` tracks; a larger group alone. */
function outlineBatches(groups: string[][]) {
  const batches: string[][][] = []
  for (let start = 0; start < groups.length; ) {
    let end = start
    let size = 0
    do {
      size += groups[end]?.length ?? 0
      end += 1
    } while (
      end < groups.length &&
      size + (groups[end]?.length ?? 0) <= OUTLINE_BATCH
    )
    batches.push(groups.slice(start, end))
    start = end
  }
  return batches
}

const GroupAlbumsSchema = z.array(
  z.object({ group_index: z.number().int(), title: z.string() }),
)

/**
 * For each group of tracks, the kept track and the cautions that
 * `readTrackMergePlan` answers without `follow`, or null where it would not
 * find a track. Three statements read up to `OUTLINE_BATCH` tracks, whatever
 * the number of groups. A track is in one group at most.
 */
export async function readTrackMergeOutlines(
  reader: Reader,
  groups: string[][],
): Promise<(TrackMergeOutline | null)[]> {
  const outlines: (TrackMergeOutline | null)[] = []
  for (const batch of outlineBatches(groups)) {
    const trackIds = batch.flat()
    if (!trackIds.length) {
      outlines.push(...batch.map(() => null))
      continue
    }
    const tracks = new Map(
      (await readPlanTracks(reader, trackIds)).map((track) => [
        track.id,
        track,
      ]),
    )
    const albums = GroupAlbumsSchema.parse(
      (
        await reader.execute(sql`
          select g.group_index, mi.title
          from jsonb_to_recordset(${JSON.stringify(
            batch.flatMap((ids, index) =>
              ids.map((id) => ({ group_index: index, track_id: id })),
            ),
          )}::jsonb) as g(group_index int, track_id text)
          join track t on t.track_media_item_id = g.track_id
          join media_item mi on mi.id = t.album_media_item_id
          group by g.group_index, mi.id, mi.title
          having count(distinct t.track_media_item_id) > 1
          order by g.group_index, mi.title, mi.id`)
      ).rows,
    )
    const separate = await readKeptSeparate(reader, 'track', trackIds)
    batch.forEach((ids, index) => {
      const found = ids.flatMap((id) => {
        const track = tracks.get(id)
        return track ? [track] : []
      })
      const target = chooseTarget(found)
      if (!target || found.length !== ids.length) {
        outlines.push(null)
        return
      }
      const ordered = [target, ...found.filter((track) => track !== target)]
      const shared = albums
        .filter((album) => album.group_index === index)
        .map((album) => album.title)
      const own = new Set(ids)
      const kept = [
        ...new Set(
          separate
            .filter(({ lowId, highId }) => own.has(lowId) && own.has(highId))
            .flatMap(({ lowId, highId }) => [lowId, highId]),
        ),
      ]
      const cautions: TrackMergeCaution[] = [
        ...versionCaution(ordered),
        ...durationCaution(ordered),
        ...artistCaution(target, ordered.slice(1)),
      ]
      if (shared.length) cautions.push({ code: 'same-album', albums: shared })
      if (kept.length) cautions.push({ code: 'separate', trackIds: kept })
      outlines.push({ trackIds: ordered.map((track) => track.id), cautions })
    })
  }
  return outlines
}

/**
 * For each group of tracks, the first one kept, what merging the group into it
 * does: how many of the others stay as versions and how many are removed, by
 * the rule of `readTrackMergePlan`. Null where it would not find a track. One
 * statement reads up to `OUTLINE_BATCH` tracks, whatever the number of groups.
 */
export async function readTrackMergeSummaries(
  reader: Reader,
  groups: string[][],
): Promise<(TrackDuplicateMerge | null)[]> {
  const summaries: (TrackDuplicateMerge | null)[] = []
  for (const batch of outlineBatches(groups)) {
    const trackIds = batch.flat()
    const tracks = new Map(
      (trackIds.length ? await readPlanTracks(reader, trackIds) : []).map(
        (track) => [track.id, track],
      ),
    )
    for (const ids of batch) {
      const found = ids.flatMap((id) => {
        const track = tracks.get(id)
        return track ? [track] : []
      })
      const [target, ...others] = found
      if (!target || found.length !== ids.length) {
        summaries.push(null)
        continue
      }
      const removed = others.filter(
        (track) => outcomeOf(track, target) === 'merge',
      )
      summaries.push({
        keep: {
          id: target.id,
          title: target.title,
          by: target.artists.join(', '),
        },
        versions: others.length - removed.length,
        removed: removed.length,
        removedRecords: removed.filter((track) => blockOf(track) === null)
          .length,
      })
    }
  }
  return summaries
}

/** What merging the selected tracks would do. See `readTrackMerge`. */
export async function readTrackMergePlan(
  reader: Reader,
  selection: TrackMergeSelection,
  lock = false,
): Promise<TrackMergePlan> {
  return (await readTrackMerge(reader, selection, lock)).plan
}

/** The plan the Merge button reads before it merges or opens a review. */
export async function planTrackMerge(input: TrackMergePlanRequest) {
  return readTrackMergePlan(db, input)
}
