import { sql, type SQL } from 'drizzle-orm'
import type { ListeningFilter, ListeningPeriod } from '@repo/schemas/listening'

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

/**
 * The count columns a filter and a sort period need, one per distinct period,
 * with the rules and the sort value written against `listening_counts`.
 * Nothing when neither asks for a count.
 */
export function listeningCounts(
  filter: ListeningFilter | undefined,
  sortPeriod: ListeningPeriod | undefined,
  now = new Date(),
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
  const conditions = (filter?.rules ?? []).map((rule) => {
    const value = count(rule.period)
    const bounds: SQL[] = []
    if (rule.min !== undefined) bounds.push(sql`${value} >= ${rule.min}`)
    if (rule.max !== undefined) bounds.push(sql`${value} <= ${rule.max}`)
    return sql`(${sql.join(bounds, sql` and `)})`
  })
  const sort = sortPeriod ? count(sortPeriod) : undefined
  if (!periods.size) return undefined
  return {
    entries: [...periods.values()],
    condition: conditions.length
      ? sql`(${sql.join(conditions, filter?.match === 'any' ? sql` or ` : sql` and `)})`
      : undefined,
    sort,
  }
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
  const linkedNames = (links: SQL) => sql`from ${links}
    join (select username, artist_key, track_key, ${counts}
      from lastfm_scrobble where ${inPeriods}
      group by username, artist_key, track_key) listening_names
    on listening_names.username = linked.username
      and listening_names.artist_key = linked.artist_key
      and listening_names.track_key = linked.track_key`
  function source(subject: ListeningSubject) {
    if (subject === 'album')
      return sql`(select album_media_item_id as id, ${counts}
        from lastfm_scrobble
        where album_media_item_id is not null and ${inPeriods}
        group by album_media_item_id) listening_counts`
    if (subject === 'track')
      return sql`(select linked.track_media_item_id as id, ${nameSums}
        ${linkedNames(sql`lastfm_track_link linked`)}
        group by linked.track_media_item_id) listening_counts`
    return sql`(select linked.group_key as id, ${nameSums}
      ${linkedNames(sql`(select distinct m.group_key, l.username, l.artist_key, l.track_key
        from recording_members m
        join lastfm_track_link l on l.track_media_item_id = m.id) linked`)}
      group by linked.group_key) listening_counts`
  }
  return { source, condition, sort }
}

export type BrowseListening = NonNullable<
  ReturnType<typeof createBrowseListening>
>
