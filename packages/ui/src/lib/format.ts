/**
 * The app's value formats. Dates are ISO, times are 24-hour, ages are in
 * words, and a missing value is an en dash.
 */

export const EMPTY_VALUE = '–'

const numberFormat = new Intl.NumberFormat('en')

/** `12,480` */
export function formatCount(value: number): string {
  return numberFormat.format(value)
}

/** `128 albums`, `1 album`, and `6 of 128 albums` when filtered. */
export function formatItemCount(
  count: number,
  noun: { one: string; other: string },
  total?: number,
): string {
  const basis = total ?? count
  const label = basis === 1 ? noun.one : noun.other
  return total !== undefined && total !== count
    ? `${formatCount(count)} of ${formatCount(total)} ${label}`
    : `${formatCount(count)} ${label}`
}

function parse(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const pad = (value: number) => String(value).padStart(2, '0')

/** `2026-11-16` in local time. */
export function formatDate(value: string | number | Date | null | undefined) {
  const date = value == null ? null : parse(value)
  if (!date) return EMPTY_VALUE
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `14:20` in local 24-hour time. */
export function formatTime(value: string | number | Date | null | undefined) {
  const date = value == null ? null : parse(value)
  if (!date) return EMPTY_VALUE
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `2026-11-16 14:20` */
export function formatDateTime(
  value: string | number | Date | null | undefined,
) {
  const date = value == null ? null : parse(value)
  if (!date) return EMPTY_VALUE
  return `${formatDate(date)} ${formatTime(date)}`
}

/** `just now`, `5 min ago`, `3 h ago`, `2 days ago`, `4 months ago`, `2 years ago`. */
export function formatAge(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
) {
  const date = value == null ? null : parse(value)
  if (!date) return EMPTY_VALUE
  const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return days === 1 ? '1 day ago' : `${days} days ago`
  const months = Math.round(days / 30.44)
  if (months < 24) return `${months} months ago`
  return `${Math.round(days / 365.25)} years ago`
}

/** A wait until a time today or later: `14:20`, or `2026-11-17 09:00`. */
export function formatUntil(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
) {
  const date = value == null ? null : parse(value)
  if (!date) return EMPTY_VALUE
  return formatDate(date) === formatDate(now)
    ? formatTime(date)
    : formatDateTime(date)
}

/** Track length: `4:10`, or `1:02:45`. */
export function formatTrackLength(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return EMPTY_VALUE
  const seconds = Math.round(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = pad(seconds % 60)
  return hours ? `${hours}:${pad(minutes)}:${rest}` : `${minutes}:${rest}`
}

/** Running time: `42 min`, or `2h 51m`. */
export function formatRuntime(minutes: number | null | undefined) {
  if (minutes == null || !Number.isFinite(minutes)) return EMPTY_VALUE
  const whole = Math.round(minutes)
  return whole < 60
    ? `${whole} min`
    : `${Math.floor(whole / 60)}h ${whole % 60}m`
}

/** How long a job took: `8s`, `4m 12s`, `1h 05m`. */
export function formatElapsed(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return EMPTY_VALUE
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}
