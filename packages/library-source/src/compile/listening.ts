import {
  listeningPeriodBounds,
  type ListeningFilter,
  type ListeningHistogram,
  type ListeningPeriod,
} from '@repo/schemas/listening'
import { and, or, sql, type Sql } from './sql'

/**
 * Listening rules and sort periods (DEVICE-23), on the period arithmetic
 * the server also calls: listeningPeriodBounds, `@repo/schemas/listening`.
 */

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

/**
 * listeningHistogramCounts and listeningBar, browse.ts: items per bar from
 * rows of (period count, items with that count). A count is in the bar of
 * the last edge at or below it, as `width_bucket` places it; bars without
 * items count zero.
 */
export function listeningHistogram(
  edges: readonly number[],
  rows: readonly { listening: number; count: number }[],
): ListeningHistogram {
  const bar = (listening: number) =>
    edges.filter((edge) => edge <= listening).length
  return {
    edges: [...edges],
    counts: edges.map((_, index) =>
      rows
        .filter((row) => bar(row.listening) === index + 1)
        .reduce((total, row) => total + row.count, 0),
    ),
  }
}
