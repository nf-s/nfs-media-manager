import type { JsonValue } from '@repo/schemas/common'
import type {
  FieldSource,
  MediaFieldProvenance,
} from '@repo/schemas/provenance'
import { formatCount, formatDateTime } from '@repo/ui/lib/format'

export type FormattedFieldValue =
  | { kind: 'empty' }
  | { kind: 'text' | 'number' | 'json'; text: string }
  | { kind: 'list'; items: string[] }

const MIDNIGHT_UTC = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function scalarText(value: string | number | boolean) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return formatCount(value)
  const date = MIDNIGHT_UTC.exec(value)
  if (date?.[1]) return date[1]
  return DATE_TIME.test(value) ? formatDateTime(value) : value
}

/**
 * A stored or supplied value of any JSON type, for one table cell: dates as
 * ISO dates, numbers grouped, names as a list, anything else as compact JSON.
 */
export function formatFieldValue(value: JsonValue): FormattedFieldValue {
  if (value === null || value === '') return { kind: 'empty' }
  if (typeof value === 'string')
    return { kind: 'text', text: scalarText(value) }
  if (typeof value === 'number')
    return { kind: 'number', text: scalarText(value) }
  if (typeof value === 'boolean')
    return { kind: 'text', text: scalarText(value) }
  if (Array.isArray(value)) {
    if (!value.length) return { kind: 'empty' }
    const items = value.flatMap((item) =>
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
        ? [scalarText(item)]
        : [],
    )
    if (items.length === value.length) return { kind: 'list', items }
  }
  return { kind: 'json', text: JSON.stringify(value) }
}

/** Sources whose value is the stored one first, then the rest, newest first. */
export function orderedFieldSources(sources: readonly FieldSource[]) {
  return [
    ...sources.filter((source) => source.matchesCurrent),
    ...sources.filter((source) => !source.matchesCurrent),
  ]
}

/** When the stored value last changed hands: the edit, else the newest matching scrape. */
export function fieldUpdatedAt(field: MediaFieldProvenance) {
  if (field.override) return field.override.at
  return (
    orderedFieldSources(field.sources).find(
      (source) => source.matchesCurrent && source.scrapedAt,
    )?.scrapedAt ?? null
  )
}

const knownProviders: Record<string, string> = {
  spotify: 'Spotify',
  lastfm: 'Last.fm',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  rym: 'Rate Your Music',
  tmdb: 'TMDb',
  omdb: 'OMDb',
  imdb: 'IMDb',
  tidal: 'TIDAL',
  sonovault: 'Sonovault',
}

/** A provider's display name from the catalog, a known name, or its ID. */
export function providerLabel(
  id: string,
  catalog?: readonly { id: string; displayName: string }[],
) {
  return (
    catalog?.find((provider) => provider.id === id)?.displayName ??
    knownProviders[id] ??
    id
  )
}
