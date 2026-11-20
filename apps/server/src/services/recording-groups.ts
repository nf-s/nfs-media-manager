import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import { db } from '@/lib/db'
import { canReadDatabaseWithoutCache } from '@/lib/database-read-cache'

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

function recordingTracksWithTitles(titles: SQL, creatorId?: SQL) {
  const title = exactName(sql`mi.title`)
  return sql`select mi.id, ${title} as title_key from media_item mi
    where ${visibleTrack} and ${title} = any(array(${titles}))
    ${
      creatorId
        ? sql`and mi.id in (select media_item_id from media_credit
          where artist_id = (${creatorId}) and role = 'artist')`
        : sql``
    }`
}

function recordingVersionTracks(id: string) {
  return sql`recording_version_tracks as materialized (
    ${recordingTracksWithTitles(sql`select ${exactName(sql`title`)} as title_key from media_item where id = ${id}`)}
  ), `
}

const scanRecordingLibrary = sql`(select not bounded from recording_title_scope)`
const recordingGroupableTracks = sql`
  recording_isrcs as (
    select media_item_id as id, ${normalizedIsrc(sql`isrc`)} as isrc,
      count(*) over (partition by ${normalizedIsrc(sql`isrc`)}) as copies
    from library_track where isrc is not null and ${scanRecordingLibrary}
  ),
  recording_groupable as materialized (
    -- A track needs a shared identifier before its title or credits can
    -- affect a group, including peers whose ISRC could rule out a match.
    select id from recording_isrcs where copies > 1 and ${validIsrc(sql`isrc`)} is not null
    union
    select track_media_item_id as id from (
      select track_media_item_id, count(*) over (partition by username, artist_key, track_key) as copies
      from lastfm_track_link where strategy = 'exact' and ${scanRecordingLibrary}
    ) linked where copies > 1
  )`

// A bounded set of exact-title lookups avoids scanning both identity tables
// for narrow searches. A broad request still benefits from finding shared
// identities before normalizing titles and checking credits.
const recordingTitleLookupLimit = 4096
const recordingTitleTargets = sql`
    recording_title_targets as materialized (
      select id from recording_matches limit ${recordingTitleLookupLimit + 1}
    ),
    recording_title_scope as (
      select count(*) <= ${recordingTitleLookupLimit} as bounded from recording_title_targets
    )`
// Keep all visible peers of these titles, including tracks excluded by Browse.
// Their identities and durations can rule out a group.
const boundedTitles = sql`
    select distinct ${exactName(sql`mi.title`)} as title_key
    from recording_title_targets target join media_item mi using (id)
    where (select bounded from recording_title_scope)`

function recordingIdentities(titledTracks: SQL) {
  return sql`select v.*, ${validIsrc(normalizedIsrc(sql`lt.isrc`))} as isrc, ${knownDuration} as duration_sec
    from ${titledTracks} v join library_track lt on lt.media_item_id = v.id
    where v.title_key <> ''`
}

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
    ${
      creatorId
        ? sql``
        : sql`${recordingTitleTargets}, ${recordingGroupableTracks},`
    }
    recording_named_contenders as materialized (${source}),
    recording_matching_titles as materialized (
      select distinct named.title_key from recording_named_contenders named
      join recording_matches matched using (id)
      where named.title_key <> ''
    ),
    recording_contenders as materialized (
      select c.* from recording_named_contenders c
      join recording_matching_titles using (title_key)
      ${
        creatorId
          ? sql``
          : sql`union all ${recordingIdentities(sql`(${recordingTracksWithTitles(boundedTitles)})`)}`
      }
    )`
}

/** Assign each matching track to one recording, using direct identity evidence. */
export function recordingMemberships(
  matches: SQLWrapper,
  options: {
    creatorId?: string
    versionId?: string
    includePeerMembers?: boolean
    useTargetTitles?: boolean
    targetArtist?: SQL
  } = {},
) {
  const {
    creatorId,
    versionId,
    includePeerMembers,
    useTargetTitles,
    targetArtist,
  } = options
  const titledTracks =
    versionId !== undefined
      ? sql`recording_version_tracks`
      : useTargetTitles
        ? sql`(${recordingTracksWithTitles(
            sql`
            select distinct ${exactName(sql`mi.title`)} as title_key
            from recording_matches target join media_item mi using (id)
          `,
            targetArtist,
          )})`
        : undefined
  const contenders = titledTracks
    ? sql`recording_contenders as (${recordingIdentities(titledTracks)})`
    : recordingContenders(creatorId)
  return sql`${versionId === undefined ? sql`` : recordingVersionTracks(versionId)}
    recording_matches as materialized (${matches}),
    ${contenders},
    recording_credits as (
      select c.id,
        array_agg(mc.artist_id order by mc.billing_order, mc.artist_id) as artist_ids,
        array_agg(${exactName(sql`a.name`)}) as artist_keys
      from recording_contenders c
      join media_credit mc on mc.media_item_id = c.id and mc.role = 'artist'
      join artist a on a.id = mc.artist_id
      group by c.id
    ),
    recording_exact_links as (
      select distinct on (c.id) c.id, array[l.username, l.artist_key, l.track_key] as lastfm_key
      from recording_contenders c
      join recording_credits credits using (id)
      join lastfm_track_link l on l.track_media_item_id = c.id and l.strategy = 'exact'
        and l.track_key = c.title_key and l.artist_key = any(credits.artist_keys)
      -- Exact links can resolve or rule out an assignment for a missing ISRC.
      where c.isrc is null or c.title_key in (
        select title_key from recording_contenders where isrc is null
      )
      order by c.id, l.artist_key, l.username
    ),
    recording_guard as (
      select c.*, credits.artist_ids, exact.lastfm_key
      from recording_contenders c
      join recording_credits credits using (id)
      left join recording_exact_links exact using (id)
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
    recording_position_durations as (
      select c.id, min(t.duration_sec) as shortest, max(t.duration_sec) as longest
      from recording_contenders c
      join track t on t.track_media_item_id = c.id and t.duration_sec > 0
      where c.duration_sec is null
      group by c.id
    ),
    recording_durations as (
      select c.id, c.group_key,
        coalesce(c.duration_sec, positions.shortest) as shortest,
        coalesce(c.duration_sec, positions.longest) as longest
      from recording_candidates c
      left join recording_position_durations positions using (id)
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
        ${includePeerMembers ? sql`` : sql`and d.id in (select id from recording_matches)`}
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
export function recordingRepresentatives(
  spotifyAvailable = sql`lt.spotify_track_id is not null`,
) {
  return sql`
  recording_group_representatives as (
    select m.group_key, count(*)::int as version_count, min(lt.date_added) as date_added,
      (array_agg(m.id order by (${spotifyAvailable}) desc,
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
}

export function playableSpotifyId(id: SQL) {
  return sql`coalesce(${id} collate "C" ~ ${spotifyIdPattern.source}, false)`
}

/** A playable sibling covers the recording while each release keeps its own identity. */
export function spotifyAlternates(
  scope: SQL,
  options: {
    creatorId?: string
    useTargetTitles?: boolean
    targetArtist?: SQL
  } = {},
) {
  const matches = sql`select target.id from (${scope}) target
    where not ${playableSpotifyId(sql`target.spotify_track_id`)} and (
      target.source_label is distinct from 'lastfm' or not exists (
        select 1 from lastfm_track_source s
        where s.track_media_item_id = target.id and s.manually_matched
      )
    )`
  return sql`
    ${recordingMemberships(matches, { ...options, includePeerMembers: true })},
    ${recordingRepresentatives(playableSpotifyId(sql`lt.spotify_track_id`))},
    spotify_alternates as materialized (
      select m.id, r.id as track_id, alternate.title as name,
        coalesce(playable.album_name, release.title) as album_name,
        release.id as album_id, release.title as album_title,
        coalesce(alternate.artwork_url, release.artwork_url) as artwork_url,
        playable.spotify_track_id as identifier
      from recording_matches target
      join recording_group_members m using (id)
      join recording_group_representatives r using (group_key)
      join library_track playable on playable.media_item_id = r.id
      join media_item alternate on alternate.id = r.id
      left join media_item release on release.id = playable.album_media_item_id
      where ${playableSpotifyId(sql`playable.spotify_track_id`)}
    )`
}

export const spotifyAlternateValue = sql`case when a.track_id is not null then jsonb_build_object(
  'trackId', a.track_id, 'name', a.name, 'albumName', a.album_name,
  'identifier', a.identifier, 'artworkUrl', a.artwork_url,
  'album', case when a.album_id is not null then jsonb_build_object(
    'id', a.album_id, 'title', a.album_title
  ) end
) end`

/** Only consider the editions of this target's title for a detail lookup. */
export function trackSpotifyAlternate(id: string) {
  const target = sql`select mi.id, mi.source_label, lt.spotify_track_id
    from media_item mi join library_track lt on lt.media_item_id = mi.id
    where mi.id = ${id} and ${visibleTrack}`
  // Every sibling has the same complete artist credits. Use one to narrow
  // common titles before validating all credits and recording evidence.
  const targetArtist = sql`select artist_id from media_credit
    where media_item_id = ${id} and role = 'artist'
    order by billing_order, artist_id limit 1`
  return sql`with ${spotifyAlternates(target, { useTargetTitles: true, targetArtist })}
    select ${spotifyAlternateValue} as alternate from spotify_alternates a`
}

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

const RecordingOrderReadSchema = z.object({
  total_count: z.number().int().nonnegative().nullable(),
  can_refresh: z.boolean(),
  rows: RecordingGroupPositionRowsSchema,
})

const cleanOrder = sql`not exists (select 1 from recording_browse_order_dirty)`
// Bump when the unfiltered membership or order changes, including tie-breaks.
const orderBuilder = sql`current_user || ':v1'`
const staleOrder = sql`(recording_browse_order_state.total_count is null
  or recording_browse_order_state.builder <> ${orderBuilder}
  or not (${cleanOrder}))`
const foregroundOrderBudget = 3500
const OrderLeaseSchema = z.object({ lease: z.string() })
const MissingMaintenanceColumn = z.object({ code: z.literal('42703') })

/** Check for committed changes and read ranks within the same snapshot. */
export async function readRecordingBrowseOrder(rows?: SQL) {
  const selected = rows
    ? sql`coalesce((select jsonb_agg(r order by r.rank) from (${rows}) r), '[]'::jsonb)`
    : sql`'[]'::jsonb`
  try {
    const result = await db.execute(sql`
      with current_order as (
        select total_count from recording_browse_order_state
        where singleton and builder = ${orderBuilder} and ${cleanOrder}
      ) select (select total_count from current_order) as total_count,
        not exists (
          select 1 from recording_browse_order_state s
          where singleton and (retry_after > statement_timestamp()
            or to_jsonb(s)->>'maintenance_only' is distinct from 'false')
        ) as can_refresh,
        case when (select total_count from current_order) is not null
          then ${selected} else '[]'::jsonb end as rows`)
    return RecordingOrderReadSchema.parse(result.rows[0])
  } catch (error) {
    if (!canReadDatabaseWithoutCache(error)) throw error
    return undefined
  }
}

export function recordingBrowseOrderRows(rank: SQL, condition: SQL) {
  return sql`select ${recordingGroupProjection}, null::int as listening_scrobbles,
    ${rank} as rank from recording_browse_order g where ${condition} order by ${rank}`
}

async function claimRecordingOrderRefresh(foreground: boolean) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '100ms'`)
    const result = await tx.execute(
      foreground
        ? // An interrupted foreground build keeps the request path disabled.
          sql`insert into recording_browse_order_state
            (singleton, builder, maintenance_only, retry_after)
          select true, ${orderBuilder}, true, statement_timestamp() + interval '30 seconds'
          where not exists (select 1 from recording_browse_order_state
            where singleton and (maintenance_only or retry_after > statement_timestamp()))
          on conflict (singleton) do update set maintenance_only = true, retry_after = excluded.retry_after
          where not recording_browse_order_state.maintenance_only
            and recording_browse_order_state.retry_after <= statement_timestamp()
            and ${staleOrder}
          returning retry_after::text as lease`
        : sql`update recording_browse_order_state
          set retry_after = statement_timestamp() + interval '120 seconds'
          where singleton and retry_after <= statement_timestamp() and ${staleOrder}
          returning retry_after::text as lease, maintenance_only`,
    )
    const row = result.rows[0]
    return row ? OrderLeaseSchema.parse(row).lease : undefined
  })
}

/** Publish ranks and clear only the dirty markers visible to the builder. */
export async function refreshRecordingBrowseOrder(
  order: SQL,
  selectedRows?: SQL,
) {
  const foreground = selectedRows !== undefined
  const started = performance.now()
  const deadline = started + (foreground ? foregroundOrderBudget : 60_000)
  const expired = new Error('Recording order refresh exceeded its budget')
  let lease: string | undefined
  try {
    lease = await claimRecordingOrderRefresh(foreground)
    if (!lease) return undefined
    const claimed = sql`singleton and retry_after = ${lease}::timestamptz`

    return await db.transaction(
      async (tx) => {
        const guard =
          await tx.execute(sql`select set_config('lock_timeout', '100ms', true),
          set_config('jit', 'off', true),
          pg_try_advisory_xact_lock(hashtextextended(
            current_schema() || ':recording_browse_order', 0
          )) and exists (select 1 from recording_browse_order_state where ${claimed}) as ready`)
        if (!z.object({ ready: z.boolean() }).parse(guard.rows[0]).ready)
          return undefined

        async function useRemainingBudget() {
          const remaining = Math.floor(deadline - performance.now())
          if (remaining <= 0) throw expired
          await tx.execute(
            sql`select set_config('statement_timeout', ${`${remaining}ms`}, true)`,
          )
        }

        await useRemainingBudget()
        await tx.execute(sql`
          delete from recording_browse_order_dirty where transaction_id in (
            select transaction_id from recording_browse_order_dirty for update skip locked
          )`)
        await useRemainingBudget()
        await tx.execute(sql`delete from recording_browse_order`)
        await useRemainingBudget()
        await tx.execute(sql`
          with inserted as (
            insert into recording_browse_order
              (id, version_count, scrobbles, last_listened_at, date_added, ascending_rank, descending_rank)
            ${order}
            returning 1
          ) update recording_browse_order_state set
            builder = ${orderBuilder},
            total_count = (select count(*)::int from inserted),
            maintenance_only = ${foreground ? sql`false` : sql`maintenance_only`},
            retry_after = clock_timestamp() + interval '5 seconds'
          where ${claimed}`)
        if (!selectedRows) {
          if (performance.now() - started >= foregroundOrderBudget) {
            await useRemainingBudget()
            await tx.execute(sql`update recording_browse_order_state
              set maintenance_only = true where singleton and not maintenance_only`)
          }
          return []
        }
        await useRemainingBudget()
        const result = await tx.execute(selectedRows)
        return RecordingGroupPositionRowsSchema.parse(result.rows)
      },
      { isolationLevel: 'repeatable read' },
    )
  } catch (error) {
    const cause = error instanceof Error ? (error.cause ?? error) : error
    if (
      error !== expired &&
      !(!lease && MissingMaintenanceColumn.safeParse(cause).success) &&
      !canReadDatabaseWithoutCache(error)
    )
      throw error
    return undefined
  }
}
