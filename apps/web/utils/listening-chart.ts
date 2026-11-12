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
