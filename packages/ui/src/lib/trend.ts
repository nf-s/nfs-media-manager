/**
 * Series maths for the trend chart: choose a grain the data can fill, bucket
 * the counts, and draw a smooth line that never dips below a value.
 */

export type TrendGrain = 'day' | 'week' | 'month' | 'quarter' | 'year'
export type TrendRange = '30d' | '1y' | '5y' | 'all'
export type TrendSample = { t: number; v: number }
export type TrendSeries = { grain: TrendGrain; points: TrendSample[] }

export const DAY_MS = 86_400_000

const GRAINS: readonly TrendGrain[] = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
]
const RANGE_DAYS: Record<Exclude<TrendRange, 'all'>, number> = {
  '30d': 29,
  '1y': 364,
  '5y': 1825,
}
const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]
const QUARTERS: readonly string[] = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec']

/** UTC midnight of an ISO date (`YYYY-MM-DD`) or month (`YYYY-MM`). */
export function utcDay(value: string): number {
  const [year = NaN, month = 1, day = 1] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

export function utcToday(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

export function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

function grainStart(t: number, grain: TrendGrain): number {
  const date = new Date(t)
  if (grain === 'day') return t
  if (grain === 'week') return t - ((date.getUTCDay() + 6) % 7) * DAY_MS
  if (grain === 'month')
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  if (grain === 'quarter')
    return Date.UTC(
      date.getUTCFullYear(),
      Math.floor(date.getUTCMonth() / 3) * 3,
      1,
    )
  return Date.UTC(date.getUTCFullYear(), 0, 1)
}

function total(points: readonly TrendSample[]): number {
  return points.reduce((sum, point) => sum + point.v, 0)
}

/**
 * Bucket samples for a range. Of the allowed grains, take the finest that
 * averages three or more per point with between 10 and `maxPoints` points. A
 * sparse history falls back to the coarsest grain that still gives ten
 * points. Empty periods are filled with zero, and "all" never shows less than
 * 30 days.
 *
 * `finest` is the grain of the samples themselves: daily samples can use
 * every grain, monthly samples only month and coarser.
 */
export function bucketTrend(
  samples: readonly TrendSample[],
  range: TrendRange,
  options: {
    today: number
    maxPoints?: number
    finest?: Extract<TrendGrain, 'day' | 'month'>
  },
): TrendSeries {
  const { today, maxPoints = 120, finest = 'day' } = options
  const first = samples[0]?.t ?? today
  const from =
    range === 'all'
      ? Math.min(first, today - 29 * DAY_MS)
      : today - RANGE_DAYS[range] * DAY_MS
  const grains = finest === 'day' ? GRAINS : GRAINS.slice(2)
  const build = (grain: TrendGrain): TrendSeries => {
    const start = grainStart(from, grain)
    const counts = new Map<number, number>()
    for (let t = start; t <= today; t += DAY_MS) {
      const key = grainStart(t, grain)
      if (!counts.has(key)) counts.set(key, 0)
    }
    for (const sample of samples) {
      if (sample.t < start || sample.t > today) continue
      const key = grainStart(sample.t, grain)
      counts.set(key, (counts.get(key) ?? 0) + sample.v)
    }
    return { grain, points: [...counts].map(([t, v]) => ({ t, v })) }
  }
  const all = grains.map(build)
  const options_ = all.filter((series) => series.points.length <= maxPoints)
  const fits = options_.filter((series) => series.points.length >= 10)
  const dense = fits.find(
    (series) => total(series.points) / series.points.length >= 3,
  )
  const fallback = fits[fits.length - 1] ?? options_[0] ?? all[all.length - 1]
  return dense ?? fallback ?? { grain: 'year', points: [] }
}

/** Merge a series down to at most `max` points for a sparkline. */
export function sparkValues(values: readonly number[], max = 16): number[] {
  const size = Math.max(1, Math.ceil(values.length / max))
  const merged: number[] = []
  for (let index = 0; index < values.length; index += size)
    merged.push(
      values.slice(index, index + size).reduce((sum, value) => sum + value, 0),
    )
  return merged
}

const round = (value: number) => Math.round(value * 10) / 10

export type TrendPath = { start: string; segments: string[] }

/** Monotone cubic through the points: smooth, and never dips below a value. */
export function smoothPath(
  points: readonly (readonly [number, number])[],
): TrendPath {
  const [origin] = points
  if (!origin) return { start: '', segments: [] }
  const start = `M${origin[0]} ${origin[1]}`
  if (points.length < 3)
    return {
      start,
      segments: points.slice(1).map(([x, y]) => `L${x} ${y}`),
    }
  const dx: number[] = []
  const slope: number[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const [x0, y0] = points[index] ?? origin
    const [x1, y1] = points[index + 1] ?? origin
    dx.push(x1 - x0)
    slope.push((y1 - y0) / (x1 - x0))
  }
  const tangent: number[] = [slope[0] ?? 0]
  for (let index = 1; index < points.length - 1; index++) {
    const before = slope[index - 1] ?? 0
    const after = slope[index] ?? 0
    tangent.push(
      before * after <= 0 ? 0 : (2 * before * after) / (before + after),
    )
  }
  tangent.push(slope[slope.length - 1] ?? 0)
  const segments: string[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const [x0, y0] = points[index] ?? origin
    const [x1, y1] = points[index + 1] ?? origin
    const third = (dx[index] ?? 0) / 3
    segments.push(
      `C${round(x0 + third)} ${round(y0 + (tangent[index] ?? 0) * third)} ${round(x1 - third)} ${round(y1 - (tangent[index + 1] ?? 0) * third)} ${x1} ${y1}`,
    )
  }
  return { start, segments }
}

const TICK_STEPS: readonly number[] = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000,
  20000, 50000,
]

/** Up to four round gridline values from zero to just above `max`. */
export function trendTicks(max: number): number[] {
  const step = TICK_STEPS.find((candidate) => max / candidate <= 3.2) ?? 100000
  const top = Math.max(step, Math.ceil(max / step) * step)
  const ticks: number[] = []
  for (let value = 0; value <= top; value += step) ticks.push(value)
  return ticks
}

/** The tooltip's name for one point. The last point of a coarse grain is partial. */
export function periodLabel(
  t: number,
  grain: TrendGrain,
  isLast: boolean,
): string {
  const date = new Date(t)
  const year = date.getUTCFullYear()
  const label =
    grain === 'day'
      ? isoDay(t)
      : grain === 'week'
        ? `Week of ${isoDay(t)}`
        : grain === 'month'
          ? `${MONTHS[date.getUTCMonth()] ?? ''} ${year}`
          : grain === 'quarter'
            ? `${QUARTERS[Math.floor(date.getUTCMonth() / 3)] ?? ''} ${year}`
            : String(year)
  return isLast && grain !== 'day' ? `${label}, so far` : label
}

/** Axis labels at natural boundaries, thinned to fit `room` labels. */
export function axisLabels(
  points: readonly TrendSample[],
  grain: TrendGrain,
  room: number,
): { index: number; text: string }[] {
  const labels: { index: number; text: string }[] = []
  points.forEach((point, index) => {
    const date = new Date(point.t)
    const month = MONTHS[date.getUTCMonth()] ?? ''
    const year = String(date.getUTCFullYear())
    if (grain === 'day' && date.getUTCDay() === 1)
      labels.push({ index, text: `${date.getUTCDate()} ${month}` })
    if (grain === 'week' && date.getUTCDate() <= 7)
      labels.push({
        index,
        text: date.getUTCMonth() === 0 ? `Jan ${year}` : month,
      })
    if ((grain === 'month' || grain === 'quarter') && date.getUTCMonth() === 0)
      labels.push({ index, text: year })
    if (grain === 'year') labels.push({ index, text: year })
  })
  const step = Math.max(1, Math.ceil(labels.length / Math.max(1, room)))
  return labels.filter((_, index) => index % step === 0)
}
