/**
 * Local calendar dates as the Playlists directory compares them
 * (columnRangeConditions, playlist-directory.ts): `(value)::date` in UTC,
 * else `(value at time zone 'UTC' at time zone <zone>)::date`. A date is the
 * number `year * 10000 + month * 100 + day`, which orders as the dates do.
 *
 * The device reads a zone from its own time zone database, which may be of
 * another version than PostgreSQL's; that is a stated limitation.
 */

const MICROSECONDS_PER_DAY = 86_400_000_000

/**
 * Whether the device reads the zone as PostgreSQL does: `UTC`, or an
 * `Area/Location` name of the time zone database. PostgreSQL may read
 * another name the schema accepts (an abbreviation, an `Etc/GMT+3` name, a
 * name without a slash) by other rules, so a date range in it is left to
 * the API (`time-zone`).
 */
export function readsTimeZoneAsServer(zone: string | undefined): boolean {
  if (zone === undefined || zone === 'UTC') return true
  return (
    /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/u.test(zone) && !/^etc\//iu.test(zone)
  )
}

/** A `YYYY-MM-DD` bound as a date number. */
export function boundDate(value: string): number {
  const [year = '0', month = '0', day = '0'] = value.split('-')
  return Number(year) * 10000 + Number(month) * 100 + Number(day)
}

/** The local date of stored timestamps in one zone (UTC when undefined). */
export type LocalDates = (microseconds: number) => number

export function localDates(zone: string | undefined): LocalDates {
  if (zone === undefined || zone === 'UTC') return utcDate
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    era: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
  return (microseconds) => {
    const parts = format.formatToParts(
      new Date(Math.floor(microseconds / 1000)),
    )
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((entry) => entry.type === type)?.value)
    const era = parts.find((entry) => entry.type === 'era')?.value
    const year = era === 'BC' ? 1 - part('year') : part('year')
    return year * 10000 + part('month') * 100 + part('day')
  }
}

function utcDate(microseconds: number): number {
  const day = new Date(
    Math.floor(microseconds / MICROSECONDS_PER_DAY) * 86_400_000,
  )
  return (
    day.getUTCFullYear() * 10000 +
    (day.getUTCMonth() + 1) * 100 +
    day.getUTCDate()
  )
}
