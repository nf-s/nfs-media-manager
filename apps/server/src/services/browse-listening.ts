import { sql, type SQL } from 'drizzle-orm'
import type {
  ListeningFilter,
  ListeningPeriod,
  ListeningRule,
} from '@repo/schemas/listening'

/** Calendar subtraction preserves UTC time and clamps month ends. */
export function listeningPeriodBounds(period: ListeningPeriod, now: Date) {
  if (period.kind === 'all') return {}
  if (period.kind === 'dates') {
    return {
      from: period.from ? new Date(`${period.from}T00:00:00.000Z`) : undefined,
      to: period.to
        ? new Date(Date.parse(`${period.to}T00:00:00.000Z`) + 86_400_000)
        : undefined,
      inclusiveTo: false,
    }
  }
  const from = new Date(now)
  if (period.unit === 'days' || period.unit === 'weeks') {
    from.setUTCDate(
      from.getUTCDate() - period.amount * (period.unit === 'weeks' ? 7 : 1),
    )
  } else {
    const day = from.getUTCDate()
    from.setUTCDate(1)
    from.setUTCMonth(
      from.getUTCMonth() - period.amount * (period.unit === 'years' ? 12 : 1),
    )
    const monthEnd = new Date(from)
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
    from.setUTCDate(Math.min(day, monthEnd.getUTCDate()))
  }
  return { from, to: now, inclusiveTo: true }
}

/** True for scrobbles inside the period; `listenedAt` names the timestamp column. */
export function listeningPeriodPredicate(
  period: ListeningPeriod,
  now: Date,
  listenedAt: SQL = sql`listened_at`,
): SQL {
  const bounds = listeningPeriodBounds(period, now)
  const conditions: SQL[] = []
  if (bounds.from)
    conditions.push(
      sql`${listenedAt} >= ${bounds.from.toISOString()}::timestamp`,
    )
  if (bounds.to)
    conditions.push(
      bounds.inclusiveTo
        ? sql`${listenedAt} <= ${bounds.to.toISOString()}::timestamp`
        : sql`${listenedAt} < ${bounds.to.toISOString()}::timestamp`,
    )
  return conditions.length
    ? sql`(${sql.join(conditions, sql` and `)})`
    : sql`true`
}

/**
 * What a count belongs to. A track counts the scrobbles of its linked names,
 * as `library_track.scrobble_count` does. A recording group counts each
 * linked name of its members once, as `recording_stats.scrobbles` does, and
 * needs the `recording_members` CTE in scope.
 */
export type ListeningSubject = 'album' | 'track' | 'recording'

type ScrobblePresence = (period: SQL) => SQL

function presenceRule(rule: ListeningRule) {
  if (rule.max === 0) return 'absent'
  if (rule.min === 1 && rule.max === undefined) return 'present'
}

/**
 * Share exact counts between rules and sorting. Presence rules can use
 * semijoins or antijoins when they apply independently, so selective Browse
 * queries need only look for scrobbles of their matching items.
 */
export function listeningCounts(
  filter: ListeningFilter | undefined,
  sortPeriod: ListeningPeriod | undefined,
  now = new Date(),
  independentPresence = false,
) {
  const periods = new Map<string, { predicate: SQL; alias: string }>()
  function count(period: ListeningPeriod): SQL<number> {
    const key = JSON.stringify(period)
    let entry = periods.get(key)
    if (!entry) {
      entry = {
        predicate: listeningPeriodPredicate(period, now),
        alias: `count_${periods.size}`,
      }
      periods.set(key, entry)
    }
    return sql<number>`coalesce(${sql.identifier('listening_counts')}.${sql.identifier(entry.alias)}, 0)`
  }
  const rules = filter?.rules ?? []
  // A single presence rule can use a semijoin or antijoin. Multiple rules or
  // a sort period share a grouped read so each period need not scan separately.
  const usePresence =
    sortPeriod === undefined && (rules.length === 1 || independentPresence)
  const conditions = rules.map((rule) => {
    const presence = usePresence ? presenceRule(rule) : undefined
    if (presence) {
      const period = listeningPeriodPredicate(rule.period, now)
      return (hasScrobbles: ScrobblePresence) =>
        presence === 'absent'
          ? sql`not (${hasScrobbles(period)})`
          : hasScrobbles(period)
    }
    const value = count(rule.period)
    const bounds: SQL[] = []
    if (rule.min !== undefined) bounds.push(sql`${value} >= ${rule.min}`)
    if (rule.max !== undefined) bounds.push(sql`${value} <= ${rule.max}`)
    return () => sql`(${sql.join(bounds, sql` and `)})`
  })
  const sort = sortPeriod ? count(sortPeriod) : undefined
  if (!periods.size && !conditions.length) return undefined
  return {
    entries: [...periods.values()],
    condition(hasScrobbles: ScrobblePresence) {
      if (!conditions.length) return
      return sql`(${sql.join(
        conditions.map((condition) => condition(hasScrobbles)),
        filter?.match === 'any' ? sql` or ` : sql` and `,
      )})`
    },
    sort,
  }
}

export const linkedTrackScrobbles = sql`lastfm_track_link listening_link
  join lastfm_scrobble using (username, artist_key, track_key)`

function hasBrowseScrobbles(subject: ListeningSubject, id: SQL, period: SQL) {
  if (subject === 'album')
    return sql`exists (select 1 from lastfm_scrobble
      where album_media_item_id = ${id} and ${period})`
  if (subject === 'track')
    return sql`exists (select 1 from ${linkedTrackScrobbles}
      where listening_link.track_media_item_id = ${id} and ${period})`
  return sql`exists (select 1 from recording_members listening_member
    join ${linkedTrackScrobbles} on listening_link.track_media_item_id = listening_member.id
    where listening_member.group_key = ${id} and ${period})`
}

/**
 * All requested counts share one grouped read. `source(subject)` is aliased
 * `listening_counts` with the subject's key in `id`; absent rows count as zero.
 */
export function createBrowseListening(
  filter: ListeningFilter | undefined,
  sortPeriod: ListeningPeriod | undefined,
  now = new Date(),
) {
  const requested = listeningCounts(filter, sortPeriod, now)
  if (!requested) return undefined
  const { entries, condition, sort } = requested
  const counts = sql.join(
    entries.map(
      (entry) =>
        sql`count(*) filter (where ${entry.predicate})::int as ${sql.identifier(entry.alias)}`,
    ),
    sql`, `,
  )
  const inPeriods = sql`(${sql.join(
    entries.map((entry) => entry.predicate),
    sql` or `,
  )})`
  // Every scrobble of a name has the same track links, so names are counted
  // once and then added up per track or recording.
  const nameSums = sql.join(
    entries.map(
      (entry) =>
        sql`sum(listening_names.${sql.identifier(entry.alias)})::int as ${sql.identifier(entry.alias)}`,
    ),
    sql`, `,
  )
  // Keep the linked subjects even when no name was played in the period.
  // This preserves the join's cardinality estimate. Counts coalesce to zero.
  const linkedNames = (links: SQL) => sql`from ${links}
    left join (select username, artist_key, track_key, ${counts}
      from lastfm_scrobble where ${inPeriods}
      group by username, artist_key, track_key) listening_names
    on listening_names.username = linked.username
      and listening_names.artist_key = linked.artist_key
      and listening_names.track_key = linked.track_key`
  function source(subject: ListeningSubject, members?: SQL) {
    if (!entries.length) return
    if (subject === 'album')
      return sql`(select album_media_item_id as id, ${counts}
        from lastfm_scrobble
        where album_media_item_id is not null and ${inPeriods}
        group by album_media_item_id) listening_counts`
    const track = subject === 'track'
    const id = track ? sql`linked.track_media_item_id` : sql`linked.group_key`
    const trackLinks = members
      ? sql`(select l.* from lastfm_track_link l join ${members} m
          on l.track_media_item_id = m.id) linked`
      : sql`lastfm_track_link linked`
    const links = track
      ? trackLinks
      : sql`(select distinct m.group_key, l.username, l.artist_key, l.track_key
        from ${members ?? sql`recording_members`} m
        join lastfm_track_link l on l.track_media_item_id = m.id) linked`
    // A narrow recording scope can probe each linked name through the event
    // index. Aggregate inside the probe so an overestimate of the scope does
    // not make PostgreSQL scan the entire listening history.
    if (members && !track)
      return sql`(select ${id} as id, ${nameSums}
        from ${links} cross join lateral (
          select ${counts} from lastfm_scrobble s
          where s.username = linked.username and s.artist_key = linked.artist_key
            and s.track_key = linked.track_key and ${inPeriods}
        ) listening_names group by ${id}) listening_counts`
    // Expanding a recording already identifies its track versions.
    if (members)
      return sql`(select ${id} as id, ${counts}
        from ${links} join lastfm_scrobble using (username, artist_key, track_key)
        where ${inPeriods} group by ${id}) listening_counts`
    return sql`(select ${id} as id, ${nameSums}
      ${linkedNames(links)} group by ${id}) listening_counts`
  }
  return {
    source,
    condition: (subject: ListeningSubject, id: SQL) =>
      condition((period) => hasBrowseScrobbles(subject, id, period)),
    multiRulePresenceCondition(hasScrobbles: ScrobblePresence) {
      if (
        !filter ||
        filter.rules.length < 2 ||
        !filter.rules.every(presenceRule)
      )
        return undefined
      return listeningCounts(filter, undefined, now, true)?.condition(
        hasScrobbles,
      )
    },
    sort,
  }
}

export type BrowseListening = NonNullable<
  ReturnType<typeof createBrowseListening>
>
