import type { JsonValue } from '@repo/media-plugin-sdk'
import { isJsonRecord } from './provider-normalizers'

export interface FilmAddedDate {
  dateAdded: string
  dateAddedSource: string
}

export const NFO_CREATION_SOURCE = 'NFO file creation time'

export function nfoCreationDate(
  birthtimeMs: number,
): FilmAddedDate | undefined {
  return birthtimeMs > 0
    ? filmAddedDate(birthtimeMs, NFO_CREATION_SOURCE)
    : undefined
}

// Source exports without a timezone are interpreted consistently as UTC.
export function filmAddedDate(
  value: unknown,
  source: string,
): FilmAddedDate | undefined {
  const input = Array.isArray(value) ? value[0] : value
  const numeric = typeof input === 'number' ? new Date(input) : undefined
  const raw =
    numeric && Number.isFinite(numeric.getTime())
      ? numeric.toISOString()
      : input
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(raw))
    return undefined
  const normalized = raw.trim().replace(' ', 'T')
  const calendar = new Date(normalized.slice(0, 10))
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== normalized.slice(0, 10)
  )
    return undefined
  const date = new Date(
    normalized.length > 10 && !/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)
      ? `${normalized}Z`
      : normalized,
  )
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now())
    return undefined
  return { dateAdded: date.toISOString(), dateAddedSource: source }
}

export function earliestFilmAddedDate(
  candidates: Array<FilmAddedDate | undefined>,
): FilmAddedDate | undefined {
  return candidates
    .filter((value): value is FilmAddedDate => value !== undefined)
    .sort((a, b) => a.dateAdded.localeCompare(b.dateAdded))[0]
}

export function legacyFilmAddedDate(
  value: JsonValue,
): FilmAddedDate | undefined {
  if (!isJsonRecord(value)) return undefined
  const imdb = isJsonRecord(value.imdb) ? value.imdb : value
  const rating = isJsonRecord(imdb.myRating) ? imdb.myRating : {}
  const watchlist = isJsonRecord(imdb.myWatchlist) ? imdb.myWatchlist : {}
  return earliestFilmAddedDate([
    filmAddedDate(value.dateAdded, 'Legacy library date'),
    filmAddedDate(watchlist.date, 'IMDb watchlist (estimated)'),
    filmAddedDate(rating.date, 'IMDb rating (estimated)'),
  ])
}
