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
/** A Browse row also carries the group's count in a requested sort period. */
const RecordingGroupRowSchema = RecordingGroupSchema.extend({
  listening_scrobbles: z.number().int().nonnegative().nullable(),
})
export type RecordingGroupRow = z.infer<typeof RecordingGroupRowSchema>
export const RecordingGroupRowsSchema = z.array(RecordingGroupRowSchema)
export const RecordingGroupPositionRowsSchema = z.array(
  RecordingGroupRowSchema.extend({ rank: z.number().int().positive() }),
)

// The SQL equivalent of albumNameKey. Keep the complete title so mix, edit
// and other version qualifiers participate in the identity.
const exactName = (value: SQL) =>
  sql`lower(trim(regexp_replace(${value}, '[[:space:]]+', ' ', 'g')))`

const normalizedIsrc = (value: SQL) => sql`upper(trim(${value}))`
const validIsrc = (value: SQL) =>
  sql`substring(${value} from '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$')`
const knownDuration = sql`case when lt.duration_sec > 0 then lt.duration_sec end`
const visibleTrack = sql`mi.media_type = 'track'
  and mi.metadata->>'legacyHidden' is distinct from 'true'`

function recordingVersionTracks(id: string) {
  return sql`recording_version_tracks as materialized (
    select mi.id, target.title_key from media_item mi
    join (select ${exactName(sql`title`)} as title_key from media_item where id = ${id}) target
      on target.title_key = ${exactName(sql`mi.title`)}
    where ${visibleTrack}
  ), `
}

const recordingGroupableTracks = sql`
  recording_isrcs as (
    select media_item_id as id, ${normalizedIsrc(sql`isrc`)} as isrc,
      count(*) over (partition by ${normalizedIsrc(sql`isrc`)}) as copies
    from library_track where isrc is not null
  ),
  recording_groupable as materialized (
    -- A track needs a shared identifier before its title or credits can
    -- affect a group, including peers whose ISRC could rule out a match.
    select id from recording_isrcs where copies > 1 and ${validIsrc(sql`isrc`)} is not null
    union
    select track_media_item_id as id from (
      select track_media_item_id, count(*) over (partition by username, artist_key, track_key) as copies
      from lastfm_track_link where strategy = 'exact'
    ) linked where copies > 1
  )`

function recordingContenders(creatorId?: string) {
  // Every version of a recording shares the track's complete artist credits.
  const source = creatorId
    ? sql`select mi.id, ${exactName(sql`mi.title`)} as title_key,
        ${validIsrc(normalizedIsrc(sql`lt.isrc`))} as isrc, ${knownDuration} as duration_sec
      from media_credit c
      join media_item mi on mi.id = c.media_item_id
      join library_track lt on lt.media_item_id = mi.id
      where c.artist_id = ${creatorId} and c.role = 'artist' and ${visibleTrack}`
    : sql`select mi.id, ${exactName(sql`mi.title`)} as title_key,
        ${validIsrc(normalizedIsrc(sql`lt.isrc`))} as isrc, ${knownDuration} as duration_sec
      from media_item mi
      join library_track lt on lt.media_item_id = mi.id
      where ${visibleTrack} and mi.id in (select id from recording_groupable)`
  return sql`
    ${creatorId ? sql`` : sql`${recordingGroupableTracks},`}
    recording_named_contenders as materialized (${source}),
    recording_matching_titles as materialized (
      select distinct named.title_key from recording_named_contenders named
      join recording_matches matched using (id)
      where named.title_key <> ''
    ),
    recording_contenders as materialized (
      select c.* from recording_named_contenders c
      join recording_matching_titles using (title_key)
    )`
}

/** Assign each matching track to one recording, using direct identity evidence. */
export function recordingMemberships(
  matches: SQLWrapper,
  creatorId?: string,
  versionId?: string,
) {
  const contenders =
    versionId !== undefined
      ? sql`recording_contenders as (
      select v.*, ${validIsrc(normalizedIsrc(sql`lt.isrc`))} as isrc, ${knownDuration} as duration_sec
      from recording_version_tracks v join library_track lt on lt.media_item_id = v.id
      where v.title_key <> ''
    )`
      : recordingContenders(creatorId)
  return sql`${versionId === undefined ? sql`` : recordingVersionTracks(versionId)}
    recording_matches as materialized (${matches}),
    ${contenders},
    recording_guard as (
      select c.*, credits.artist_ids, exact.lastfm_key
      from recording_contenders c
      cross join lateral (
        select array_agg(mc.artist_id order by mc.billing_order, mc.artist_id) as artist_ids,
          array_agg(${exactName(sql`a.name`)}) as artist_keys
        from media_credit mc
        join artist a on a.id = mc.artist_id
        where mc.media_item_id = c.id and mc.role = 'artist'
        having count(*) > 0
      ) credits
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
        coalesce(c.duration_sec, positions.shortest) as shortest,
        coalesce(c.duration_sec, positions.longest) as longest
      from recording_candidates c
      cross join lateral (
        select min(t.duration_sec) as shortest, max(t.duration_sec) as longest
        from track t
        where t.track_media_item_id = c.id and c.duration_sec is null and t.duration_sec > 0
      ) positions
      where c.group_key is not null
    ),
    recording_duration_spans as (
      -- Give rounding and brief silence some leeway. Check the whole span
      -- so a series of small differences cannot bridge different versions.
      select id, min(id) over versions as group_key, count(*) over versions as version_count,
        max(longest) over versions - min(shortest) over versions as span
      from recording_durations
      window versions as (partition by group_key)
    ),
    recording_group_members as materialized (
      select d.id, d.group_key from recording_duration_spans d
      where d.version_count > 1 and (d.span > 5) is not true
        and d.id in (select id from recording_matches)
    )`
}

export const recordingVersionMembers = sql`
    recording_members as materialized (
      select matched.id, coalesce(m.group_key, matched.id) as group_key
      from recording_matches matched
      left join recording_group_members m using (id)
    )`

export const recordingCount = sql`
  select ((select count(*) from recording_matches)
    - (select count(*) - count(distinct group_key) from recording_group_members))::int as value`

/** Choose a playable edition first. Every ordering uses the same representative. */
export const recordingRepresentatives = sql`
  recording_group_representatives as (
    select m.group_key, count(*)::int as version_count, min(lt.date_added) as date_added,
      (array_agg(m.id order by (lt.spotify_track_id is not null) desc,
        (lt.album_media_item_id is not null) desc,
        coalesce(release.release_date, mi.release_date) asc nulls last, m.id))[1] as id
    from recording_group_members m
    join library_track lt on lt.media_item_id = m.id
    join media_item mi on mi.id = m.id
    left join media_item release on release.id = lt.album_media_item_id
    group by m.group_key
  ),
  recording_singletons as (
    select m.id as group_key, 1 as version_count, lt.date_added, m.id,
      lt.scrobble_count as scrobbles, lt.last_listened_at
    from recording_matches m
    join library_track lt on lt.media_item_id = m.id
    where not exists (select 1 from recording_group_members g where g.id = m.id)
  )`

/** A stored event belongs to exactly one (account, artist, title) tuple. */
export const recordingListening = sql`
  recording_listening_names as (
    select m.group_key, l.username, l.artist_key, l.track_key, min(m.id) as member_id
    from recording_group_members m
    join recording_group_representatives r using (group_key)
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
    select group_key, version_count, date_added, id, scrobbles, last_listened_at
    from recording_singletons
    union all
    -- With only one linked name, a member linked to it already holds the exact total.
    select r.*,
      coalesce(lt.scrobble_count, l.scrobbles, 0) as scrobbles,
      coalesce(lt.last_listened_at, l.last_listened_at) as last_listened_at
    from recording_group_representatives r
    left join recording_listening_name_counts c using (group_key)
    left join library_track lt on lt.media_item_id = case
      when r.version_count = 1 then r.id when c.name_count = 1 then c.member_id end
    left join recording_listening l using (group_key)
  )`

export const recordingDates = sql`
  recording_dates as (
    select group_key, version_count, date_added, id from recording_singletons
    union all
    select group_key, version_count, date_added, id from recording_group_representatives
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
