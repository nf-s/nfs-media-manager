import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { z } from 'zod'

const RecordingGroupSchema = z.object({
  id: z.string(),
  version_count: z.number().int().positive(),
  scrobbles: z.number().int().nonnegative(),
  last_listened_at: z.string().nullable(),
  date_added: z.string().nullable(),
})

export type RecordingGroup = z.infer<typeof RecordingGroupSchema>
export const RecordingGroupRowsSchema = z.array(RecordingGroupSchema)
export const RecordingGroupPositionRowsSchema = z.array(
  RecordingGroupSchema.extend({ rank: z.number().int().positive() }),
)

// The SQL equivalent of albumNameKey. Keep the complete title so mix, edit
// and other version qualifiers participate in the identity.
const exactName = (value: SQL) =>
  sql`lower(trim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`

export function recordingTitleMatches(title: SQL, id: string) {
  return sql`${exactName(title)} = (select ${exactName(sql`target.title`)} from media_item target where target.id = ${id})`
}

/** Assign each matching track to one recording, using direct identity evidence. */
export function recordingMemberships(matches: SQLWrapper) {
  return sql`
    recording_matches as materialized (${matches}),
    recording_titles as (
      select distinct ${exactName(sql`title`)} as title_key from recording_matches
    ),
    recording_contenders as materialized (
      select mi.id, title_key,
        substring(upper(trim(lt.isrc)) from '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$') as isrc,
        case when lt.duration_sec > 0 then lt.duration_sec end as duration_sec
      from media_item mi
      join recording_titles on title_key = ${exactName(sql`mi.title`)}
      join library_track lt on lt.media_item_id = mi.id
      where title_key <> '' and mi.media_type = 'track'
        and mi.metadata->>'legacyHidden' is distinct from 'true'
        and (lt.isrc is not null or exists (select 1 from lastfm_track_link l
          where l.track_media_item_id = mi.id and l.strategy = 'exact'))
    ),
    recording_credits as (
      select c.media_item_id as id,
        array_agg(c.artist_id order by c.billing_order, c.artist_id) as artist_ids,
        array_agg(${exactName(sql`a.name`)}) as artist_keys
      from recording_contenders
      join media_credit c on c.media_item_id = recording_contenders.id and c.role = 'artist'
      join artist a on a.id = c.artist_id
      group by c.media_item_id
    ),
    recording_guard as (
      select c.*, credits.artist_ids, exact.lastfm_key
      from recording_contenders c
      join recording_credits credits on credits.id = c.id
      left join lateral (
        select array[l.username, l.artist_key, l.track_key] as lastfm_key
        from lastfm_track_link l
        where l.track_media_item_id = c.id and l.strategy = 'exact'
          and l.track_key = title_key and l.artist_key = any(credits.artist_keys)
        order by l.artist_key, l.username limit 1
      ) exact on true
    ),
    recording_exact_keys as (
      select *, min(isrc) over shared_name as first_isrc, max(isrc) over shared_name as last_isrc
      from recording_guard
      window shared_name as (partition by title_key, artist_ids, lastfm_key)
    ),
    recording_candidates as (
      select id, duration_sec,
        case
          when isrc is not null then jsonb_build_array('isrc', title_key, artist_ids, isrc)
          when lastfm_key is not null and first_isrc = last_isrc then
            jsonb_build_array('isrc', title_key, artist_ids, first_isrc)
          when lastfm_key is not null and first_isrc is null then
            jsonb_build_array('lastfm', title_key, artist_ids, lastfm_key)
        end as group_key
      from recording_exact_keys
    ),
    recording_durations as (
      select c.id, c.group_key,
        min(coalesce(c.duration_sec, t.duration_sec)) as shortest,
        max(coalesce(c.duration_sec, t.duration_sec)) as longest
      from recording_candidates c
      left join track t on t.track_media_item_id = c.id and c.duration_sec is null and t.duration_sec > 0
      where c.group_key is not null
      group by c.id, c.group_key
    ),
    recording_duration_spans as (
      -- Give rounding and brief silence some leeway. Check the whole span
      -- so a series of small differences cannot bridge different versions.
      select id, group_key,
        max(longest) over versions - min(shortest) over versions as span
      from recording_durations
      window versions as (partition by group_key)
    ),
    recording_members as materialized (
      select matched.id, case when d.group_key is null or d.span > 5 then jsonb_build_array(matched.id)
        else d.group_key end as group_key
      from recording_matches matched
      left join recording_duration_spans d using (id)
    )`
}

/** Choose a playable edition first. Every ordering uses the same representative. */
export const recordingRepresentatives = sql`
  recording_representatives as (
    select m.group_key, count(*)::int as version_count, min(lt.date_added) as date_added,
      (array_agg(m.id order by (lt.spotify_track_id is not null) desc,
        (lt.album_media_item_id is not null) desc,
        coalesce(release.release_date, mi.release_date) asc nulls last, m.id))[1] as id
    from recording_members m
    join library_track lt on lt.media_item_id = m.id
    join media_item mi on mi.id = m.id
    left join media_item release on release.id = lt.album_media_item_id
    group by m.group_key
  )`

/** A stored event belongs to exactly one (account, artist, title) tuple. */
export const recordingListening = sql`
  recording_listening_names as (
    select m.group_key, l.username, l.artist_key, l.track_key, min(m.id) as member_id
    from recording_members m
    join recording_representatives r using (group_key)
    join lastfm_track_link l on l.track_media_item_id = m.id
    where r.version_count > 1
    group by m.group_key, l.username, l.artist_key, l.track_key
  ),
  recording_listening_name_counts as (
    select group_key, count(*) as name_count, min(member_id) as member_id
    from recording_listening_names group by group_key
  ),
  recording_listening as (
    select n.group_key, sum(events.scrobbles)::int as scrobbles, max(events.last_listened_at) as last_listened_at
    from recording_listening_names n
    join recording_listening_name_counts c using (group_key)
    cross join lateral (
      select count(*) as scrobbles, max(s.listened_at) as last_listened_at
      from lastfm_scrobble s
      where s.username = n.username and s.artist_key = n.artist_key and s.track_key = n.track_key
    ) events
    where c.name_count > 1
    group by n.group_key
  ),
  recording_stats as (
    -- With only one linked name, a member linked to it already holds the exact total.
    select r.*,
      coalesce(lt.scrobble_count, l.scrobbles, 0) as scrobbles,
      coalesce(lt.last_listened_at, l.last_listened_at) as last_listened_at
    from recording_representatives r
    left join recording_listening_name_counts c using (group_key)
    left join library_track lt on lt.media_item_id = case
      when r.version_count = 1 then r.id when c.name_count = 1 then c.member_id end
    left join recording_listening l using (group_key)
  )`

export function recordingGroupValue(key: string) {
  switch (key) {
    case 'dateAdded':
      return sql`g.date_added`
    case 'scrobbles':
      return sql`g.scrobbles`
    case 'lastListenedAt':
      return sql`g.last_listened_at`
    default:
      return undefined
  }
}

export const recordingGroupProjection = sql`
  g.id, g.version_count, g.scrobbles,
  to_char(g.last_listened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_listened_at,
  to_char(g.date_added, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as date_added`
