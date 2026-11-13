import type { ListeningMonth, ListeningTrack } from '@repo/schemas/lastfm'

export type ListeningPeriod = 'year' | 'month'

export type ListeningBar = {
  period: string
  year: string
  count: number
  /** Bar height as a percentage of the busiest period. */
  share: number
}

function monthIndex(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1
}

function monthLabel(index: number) {
  const year = Math.floor(index / 12)
  return `${year}-${String((index % 12) + 1).padStart(2, '0')}`
}

function scaled(bars: Array<{ period: string; year: string; count: number }>) {
  const max = Math.max(0, ...bars.map((bar) => bar.count))
  return bars.map((bar) => ({
    ...bar,
    share: max ? (bar.count / max) * 100 : 0,
  }))
}

/** Months between the first and last scrobbled month, including empty months. */
export function monthBars(months: ListeningMonth[]): ListeningBar[] {
  const counts = new Map<number, number>()
  for (const item of months)
    counts.set(
      monthIndex(item.month),
      (counts.get(monthIndex(item.month)) ?? 0) + item.count,
    )
  if (!counts.size) return []
  const first = Math.min(...counts.keys())
  const last = Math.max(...counts.keys())
  return scaled(
    Array.from({ length: last - first + 1 }, (_, offset) => {
      const period = monthLabel(first + offset)
      return {
        period,
        year: period.slice(0, 4),
        count: counts.get(first + offset) ?? 0,
      }
    }),
  )
}

/** Years between the first and last scrobbled year, including empty years. */
export function yearBars(months: ListeningMonth[]): ListeningBar[] {
  const counts = new Map<number, number>()
  for (const item of months) {
    const year = Number(item.month.slice(0, 4))
    counts.set(year, (counts.get(year) ?? 0) + item.count)
  }
  if (!counts.size) return []
  const first = Math.min(...counts.keys())
  const last = Math.max(...counts.keys())
  return scaled(
    Array.from({ length: last - first + 1 }, (_, offset) => ({
      period: String(first + offset),
      year: String(first + offset),
      count: counts.get(first + offset) ?? 0,
    })),
  )
}

export function listeningBars(
  months: ListeningMonth[],
  period: ListeningPeriod,
) {
  return period === 'year' ? yearBars(months) : monthBars(months)
}

/** Scrobble counts per album track position; unmatched tracks are ignored. */
export function scrobblesByPosition(tracks: ListeningTrack[]) {
  const counts = new Map<number, number>()
  for (const track of tracks)
    if (track.position !== null)
      counts.set(
        track.position,
        (counts.get(track.position) ?? 0) + track.count,
      )
  return counts
}

export function albumListeningPath(albumId: string, track: string) {
  const query = track ? `?${new URLSearchParams({ track })}` : ''
  return `/api/v1/albums/${albumId}/listening${query}`
}

export type ListeningChartStyle = 'bar' | 'line'

export type ChartPoint = { x: number; y: number }

export type PlotArea = {
  left: number
  top: number
  width: number
  height: number
}

/** Approximate width of one 11px tabular digit, used to keep labels apart. */
export const LABEL_CHAR_WIDTH = 6.5
const LABEL_GAP = 10
// A chart with one or two periods keeps bars, not blocks.
const MAX_BAR_WIDTH = 48
const YEAR_LABEL_SPACING = 4 * LABEL_CHAR_WIDTH + LABEL_GAP

/** Integer steps 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, ... */
function niceSteps(limit: number) {
  const steps: number[] = []
  for (let scale = 1; scale <= Math.max(1, limit); scale *= 10)
    steps.push(
      scale,
      2 * scale,
      ...(scale >= 10 ? [2.5 * scale] : []),
      5 * scale,
    )
  return steps.sort((a, b) => a - b)
}

/** Integer gridline values from 0, with two to four intervals covering `max`. */
export function yTicks(max: number) {
  const top = Math.max(1, Math.ceil(max))
  if (top === 1) return [0, 1]
  let best = { step: top, intervals: 1 }
  for (const step of niceSteps(top)) {
    const intervals = Math.ceil(top / step)
    if (intervals < 2 || intervals > 4) continue
    const span = step * intervals
    const bestSpan = best.step * best.intervals
    if (best.intervals === 1 || span < bestSpan) best = { step, intervals }
  }
  return Array.from(
    { length: best.intervals + 1 },
    (_, index) => index * best.step,
  )
}

/** Width of each period's slot and its drawn bar; gaps vanish on narrow slots. */
export function barLayout(count: number, plotWidth: number) {
  const slot = count ? plotWidth / count : plotWidth
  const gap = slot >= 4 ? Math.min(4, slot * 0.2) : 0
  return { slot, barWidth: Math.min(MAX_BAR_WIDTH, slot - gap) }
}

/**
 * Bars to label on the x axis: every year in year view, each January in
 * month view, thinned to every Nth year so labels keep their spacing.
 */
export function xLabelIndices(
  bars: ListeningBar[],
  period: ListeningPeriod,
  plotWidth: number,
) {
  if (!bars.length) return []
  const { slot } = barLayout(bars.length, plotWidth)
  const candidates = bars.flatMap((bar, index) =>
    period === 'year' || bar.period.endsWith('-01')
      ? [{ index, year: Number(bar.year) }]
      : [],
  )
  if (!candidates.length) return [0]
  const unit = period === 'year' ? slot : slot * 12
  const every =
    niceSteps(YEAR_LABEL_SPACING).find(
      (step) => step * unit >= YEAR_LABEL_SPACING,
    ) ?? Math.ceil(YEAR_LABEL_SPACING / unit)
  const kept = candidates.filter((item) => item.year % every === 0)
  const indices = (kept.length ? kept : candidates.slice(0, 1)).map(
    (item) => item.index,
  )
  // Label a partial first year when it has room before the first January.
  const first = indices[0]
  if (
    period === 'month' &&
    first !== undefined &&
    first > 0 &&
    first * slot >= YEAR_LABEL_SPACING
  )
    return [0, ...indices]
  return indices
}

/**
 * One point per period, scaled against the top gridline. Bars sit at the
 * centre of their slot; a line runs from the left edge of the plot to the right.
 */
export function chartPoints(
  counts: number[],
  yMax: number,
  plot: PlotArea,
  style: ListeningChartStyle = 'bar',
): ChartPoint[] {
  const { slot } = barLayout(counts.length, plot.width)
  const step = counts.length > 1 ? plot.width / (counts.length - 1) : 0
  return counts.map((count, index) => ({
    x:
      style === 'line' && step
        ? plot.left + step * index
        : plot.left + slot * (index + 0.5),
    y: plot.top + plot.height * (1 - (yMax ? count / yMax : 0)),
  }))
}

/** Period under a horizontal position in the plot, clamped to the bars. */
export function periodAt(
  x: number,
  count: number,
  plot: PlotArea,
  style: ListeningChartStyle = 'bar',
) {
  if (!count) return null
  const { slot } = barLayout(count, plot.width)
  const index =
    style === 'line' && count > 1
      ? Math.round((x - plot.left) / (plot.width / (count - 1)))
      : Math.floor((x - plot.left) / slot)
  return Math.min(count - 1, Math.max(0, index))
}

/** Next active period for an arrow, Home or End key; null for other keys. */
export function steppedPeriod(
  current: number | null,
  key: string,
  count: number,
) {
  if (!count) return null
  const last = count - 1
  if (key === 'Home') return 0
  if (key === 'End') return last
  if (key === 'ArrowLeft')
    return current === null ? last : Math.max(0, current - 1)
  if (key === 'ArrowRight')
    return current === null ? last : Math.min(last, current + 1)
  return null
}

export function scrobbleLabel(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? 'scrobble' : 'scrobbles'}`
}

export function periodScrobbles(bar: ListeningBar) {
  return `${bar.period}: ${scrobbleLabel(bar.count)}`
}
