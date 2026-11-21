import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type {
  TrackMergeBlock,
  TrackMergeCaution,
  TrackMergePlan,
  TrackMergePlanRequest,
} from '@repo/schemas/library-changes'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { artistKeys, plainKey } from '@/lib/lastfm-album-matching'
import { trackVersionQualifiers } from '@/lib/track-matching'
import { albumTrackDurationExpression } from './track-values'

type Reader = Pick<typeof db, 'execute'>

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

/** The chosen track, else the one with its own identity, else the most played. */
function chooseTarget(tracks: PlanTrack[], targetId?: string) {
  const [first] = [...tracks].sort(
    (left, right) =>
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

/**
 * What merging the selected tracks would do. `lock` holds the tracks for the
 * rest of the caller's transaction.
 */
export async function readTrackMergePlan(
  reader: Reader,
  { trackIds, targetId }: TrackMergePlanRequest,
  lock = false,
): Promise<TrackMergePlan> {
  const tracks = PlanTracksSchema.parse(
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
            where pi.media_item_id = lt.media_item_id) as on_playlist
        from library_track lt join media_item mi on mi.id = lt.media_item_id
        left join media_item am on am.id = lt.album_media_item_id
        where lt.media_item_id in (${idList(trackIds)})
          and mi.media_type = 'track'
          and mi.metadata->>'legacyHidden' is distinct from 'true'
        ${lock ? sql`for update of lt` : sql``}`)
    ).rows,
  )
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
  const sources = ordered.filter(
    (track) => track !== target && blockOf(track) === null,
  )
  const mergeable = new Set(sources.map((track) => track.id))
  const moving = names.filter((name) => mergeable.has(name.track_id))
  const added = moving.reduce(
    (total, name) => total + (name.counted ? 0 : name.count),
    0,
  )
  return {
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
      blocked: track === target ? null : blockOf(track),
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
    cautions: [
      ...versionCaution([target, ...sources]),
      ...durationCaution([target, ...sources]),
      ...artistCaution(target, sources),
    ],
    blocked: sources.length < ordered.length - 1,
  }
}

/** The plan the Merge button reads before it merges or opens a review. */
export async function planTrackMerge(input: TrackMergePlanRequest) {
  return readTrackMergePlan(db, input)
}
