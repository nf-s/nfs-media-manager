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

function periodPredicate(period: ListeningPeriod, now: Date): SQL {
  const bounds = listeningPeriodBounds(period, now)
  const conditions: SQL[] = []
  if (bounds.from)
    conditions.push(sql`listened_at >= ${bounds.from.toISOString()}::timestamp`)
  if (bounds.to)
    conditions.push(
      bounds.inclusiveTo
        ? sql`listened_at <= ${bounds.to.toISOString()}::timestamp`
        : sql`listened_at < ${bounds.to.toISOString()}::timestamp`,
    )
  return conditions.length
    ? sql`(${sql.join(conditions, sql` and `)})`
    : sql`true`
}

/** All requested counts share one grouped read; absent album rows count as zero. */
export function createBrowseListening(
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
        predicate: periodPredicate(period, now),
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
  const entries = [...periods.values()]
  const columns = entries.map(
    (entry) =>
      sql`count(*) filter (where ${entry.predicate})::int as ${sql.identifier(entry.alias)}`,
  )
  return {
    source: sql`(select album_media_item_id, ${sql.join(columns, sql`, `)}
      from lastfm_scrobble
      where album_media_item_id is not null and (${sql.join(
        entries.map((entry) => entry.predicate),
        sql` or `,
      )})
      group by album_media_item_id) listening_counts`,
    condition: conditions.length
      ? sql`(${sql.join(conditions, filter?.match === 'any' ? sql` or ` : sql` and `)})`
      : undefined,
    sort,
  }
}
