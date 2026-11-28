import type { ListeningFilter, ListeningPeriod } from '@repo/schemas/listening'
import { and, or, sql, type Sql } from './sql'

/**
 * Listening rules and sort periods (DEVICE-23). The period arithmetic is a
 * copy of listeningPeriodBounds, apps/server/src/services/browse-listening.ts,
 * which `packages/schemas` does not export; tests pin the two together.
 */

export type ListeningBounds = {
  from?: Date
  to?: Date
  inclusiveTo?: boolean
}

/** Calendar subtraction in UTC that keeps the time of day and clamps month ends. */
export function listeningPeriodBounds(
  period: ListeningPeriod,
  now: Date,
): ListeningBounds {
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

/**
 * A period as inclusive bounds on whole epoch seconds, the precision of
 * stored play times. A play at `s` seconds is in the period exactly when
 * `s * 1000` is within the millisecond bounds the service compares.
 */
export function playTimeBounds(
  period: ListeningPeriod,
  now: Date,
): { min?: number; max?: number } {
  const bounds = listeningPeriodBounds(period, now)
  const min =
    bounds.from === undefined
      ? undefined
      : Math.ceil(bounds.from.getTime() / 1000)
  let max: number | undefined
  if (bounds.to !== undefined) {
    const to = bounds.to.getTime() / 1000
    max = bounds.inclusiveTo ? Math.floor(to) : Math.ceil(to) - 1
  }
  return { min, max }
}

/**
 * Where the plays of the current row `t` are. `plays` reaches play rows `p`
 * with `p.played_at` and ANDs `where` to them; `sets` reaches the play sets
 * `ps` with `ps.play_count`, for an all-time count.
 */
export type PlaySource = {
  plays(where: Sql): Sql
  sets(): Sql
}

/** The number of plays of the row in the period; zero without any. */
export function periodCount(
  source: PlaySource,
  period: ListeningPeriod,
  now: Date,
): Sql {
  if (period.kind === 'all')
    return sql`(SELECT coalesce(sum(ps.play_count), 0) ${source.sets()})`
  const { min, max } = playTimeBounds(period, now)
  const bounds: Sql[] = []
  if (min !== undefined) bounds.push(sql`p.played_at >= ${min}`)
  if (max !== undefined) bounds.push(sql`p.played_at <= ${max}`)
  return sql`(SELECT count(*) ${source.plays(and(bounds))})`
}

/**
 * The rules as createBrowseListening, browse-listening.ts: each rule bounds
 * the count in its period, inclusive; rules are ANDed for `all` and ORed
 * for `any`. Undefined without rules.
 */
export function listeningRules(
  filter: ListeningFilter | undefined,
  count: (period: ListeningPeriod) => Sql,
): Sql | undefined {
  if (filter === undefined || filter.rules.length === 0) return undefined
  const rules = filter.rules.map((rule) => {
    const value = count(rule.period)
    const bounds: Sql[] = []
    if (rule.min !== undefined) bounds.push(sql`${value} >= ${rule.min}`)
    if (rule.max !== undefined) bounds.push(sql`${value} <= ${rule.max}`)
    return and(bounds)
  })
  return filter.match === 'any' ? or(rules) : and(rules)
}
