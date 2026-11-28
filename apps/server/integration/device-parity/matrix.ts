import type { BrowseField, TagLevel } from '@repo/schemas/browse'
import type { ListeningPeriod } from '@repo/schemas/listening'

/**
 * The query matrix of the parity suite (DEVICE-32), generated from each
 * library's field list so a new field is covered without a change here.
 * Every dimension is covered in full; pairs of filters are a deterministic
 * sample (`samplePairs`, fixed seed).
 */

export type ParityLibrary = 'track' | 'album' | 'film' | 'artist'

/** Query parameters as the web client writes them. */
export type Params = Record<
  string,
  string | number | boolean | readonly unknown[] | object | undefined
>

const commaParameters = new Set(['tagLevels', 'positions'])

/** An API path with its query string: JSON for lists and objects, commas for tag levels and positions. */
export function apiPath(route: string, params: Params = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      search.set(key, String(value))
    else if (Array.isArray(value) && commaParameters.has(key))
      search.set(key, value.map((entry: unknown) => String(entry)).join(','))
    else search.set(key, JSON.stringify(value))
  }
  const query = search.toString()
  return `/api/v1/${route}${query ? `?${query}` : ''}`
}

export type LibraryRoutes = {
  library: ParityLibrary
  page: string
  count: string
  list?: string
  facets: string
  histogram?: string
  fields: string
  /** Tags filters and the Tags sort take `tagLevels`. */
  tagLevels: boolean
  /** Listening rules and the listening sort. */
  listening: boolean
}

export const libraries: LibraryRoutes[] = [
  {
    library: 'track',
    page: 'tracks/browse-page',
    count: 'tracks/browse-count',
    list: 'tracks',
    facets: 'tracks/facets',
    histogram: 'tracks/listening-histogram',
    fields: 'tracks/fields',
    tagLevels: true,
    listening: true,
  },
  {
    library: 'album',
    page: 'albums/browse-page',
    count: 'albums/browse-count',
    list: 'albums',
    facets: 'albums/facets',
    histogram: 'albums/listening-histogram',
    fields: 'albums/fields',
    tagLevels: true,
    listening: true,
  },
  {
    library: 'film',
    page: 'films/browse-page',
    count: 'films/browse-count',
    list: 'films',
    facets: 'films/facets',
    fields: 'films/fields',
    tagLevels: false,
    listening: false,
  },
  {
    library: 'artist',
    page: 'artists/browse-page',
    count: 'artists/browse-count',
    facets: 'artists/facets',
    histogram: 'artists/listening-histogram',
    fields: 'artists/fields',
    tagLevels: false,
    listening: true,
  },
]

export const directions = ['asc', 'desc'] as const
export const filterModes = ['required', 'any', 'exclude'] as const

/** Every Tags location: Auto and each combination of levels. */
export const tagLocations: (TagLevel[] | undefined)[] = [
  undefined,
  ['track'],
  ['album'],
  ['artist'],
  ['track', 'album'],
  ['track', 'artist'],
  ['album', 'artist'],
  ['track', 'album', 'artist'],
]

export const isTagField = (key: string) =>
  ['genre', 'trackTag', 'albumTag', 'artistTag'].includes(key)

/** A value no item holds. */
export const absentValue = 'zz absent value'

/** Text filter fields, as the API lists them. */
export const filterFields = (fields: readonly BrowseField[]) =>
  fields.filter((field) => field.type === 'text' && field.filterable)

export const rangeFields = (fields: readonly BrowseField[]) =>
  fields.filter((field) => field.type !== 'text')

/** Sort keys: every listed field, and the listening sort where the library has it. */
export function sortKeys(
  routes: LibraryRoutes,
  fields: readonly BrowseField[],
) {
  return [
    ...fields.map((field) => field.key),
    ...(routes.listening ? ['listeningScrobbles'] : []),
  ]
}

/**
 * Range bounds for a field: around the synthetic library's values, with
 * fractional bounds for numbers and a millisecond inside a stored
 * microsecond for dates.
 */
export function rangeValues(field: BrowseField): number[] {
  if (field.type === 'date')
    return [
      Date.UTC(2000, 0, 1),
      Date.UTC(2021, 0, 1, 10, 0, 0, 654),
      Date.UTC(2023, 6, 1),
      Date.UTC(2026, 2, 31, 12),
    ]
  return [0, 0.5, 1, 2.25, 7.5, 96.5, 120.25, 200, 2400]
}

export function rangeCases(field: BrowseField) {
  const values = rangeValues(field)
  const cases: { min?: number; max?: number; includeMissing: boolean }[] = []
  for (const includeMissing of [false, true]) {
    for (const value of values) {
      cases.push({ min: value, includeMissing })
      cases.push({ max: value, includeMissing })
    }
    cases.push({
      min: values[1],
      max: values[values.length - 2],
      includeMissing,
    })
    cases.push({ min: values[2], max: values[2], includeMissing })
  }
  return cases
}

/** Listening periods of every kind, with edges at the fixtures' play times. */
export const listeningPeriods: ListeningPeriod[] = [
  { kind: 'all' },
  { kind: 'rolling', amount: 7, unit: 'days' },
  { kind: 'rolling', amount: 1, unit: 'weeks' },
  { kind: 'rolling', amount: 1, unit: 'months' },
  { kind: 'rolling', amount: 2, unit: 'months' },
  { kind: 'rolling', amount: 1, unit: 'years' },
  { kind: 'rolling', amount: 10, unit: 'years' },
  { kind: 'dates', from: '2026-01-01', to: '2026-01-31' },
  { kind: 'dates', from: '2026-01-01' },
  { kind: 'dates', to: '2025-12-31' },
  { kind: 'dates', from: '2026-02-28', to: '2026-02-28' },
  { kind: 'dates', from: '2019-01-01', to: '2023-12-31' },
]

/** Rules for one period: presence, absence and counts. */
export function listeningRuleCases(period: ListeningPeriod) {
  return [
    { match: 'all', rules: [{ period, min: 1 }] },
    { match: 'all', rules: [{ period, max: 0 }] },
    { match: 'all', rules: [{ period, min: 2, max: 3 }] },
  ]
}

/** Two rules of different periods, ANDed and ORed. */
export const combinedListeningRules = [
  {
    match: 'all',
    rules: [
      { period: { kind: 'rolling', amount: 1, unit: 'years' }, min: 1 },
      { period: { kind: 'all' }, max: 3 },
    ],
  },
  {
    match: 'any',
    rules: [
      { period: { kind: 'rolling', amount: 1, unit: 'months' }, min: 1 },
      { period: { kind: 'dates', to: '2023-12-31' }, min: 1 },
    ],
  },
]

/** Search words: one, two and three words, short words, case, accents and labels. */
export function searchWords(library: ParityLibrary): string[] {
  const common = ['a', 'of', 'zz', 'Ö', 'İ', 'ı', '_', '%', '100%', 'e e']
  const byLibrary: Record<ParityLibrary, string[]> = {
    track: [
      'aurora',
      'AURORA',
      'drift',
      'orbit song',
      'cold stream loose',
      'echelle',
      'Échelle',
      'istanbul',
      'İstanbul',
      'hum',
      'in library',
      'Unmatched',
      'liked songs',
      'Ambient',
      'dream pop',
      'gale hum single',
      'shoegaze',
      'musicbrainz',
      '8A',
      'fixture',
    ],
    album: [
      'northern',
      'orbit',
      'ORBIT live',
      'quiet fields',
      'aster vale northern',
      'edition',
      'not an edition',
      'blue',
      'ambient',
      'glitch',
      'nz',
      'spotify',
      '12',
      'morning mix',
    ],
    film: [
      'harbor',
      'kestrel',
      'falcon',
      'falcon over harbour',
      'noir',
      'needs id',
      'identified',
      'english',
      'welsh',
      'north pictures',
      'delta',
      'plex',
      'two wins',
      '9',
    ],
    artist: [
      'aster',
      'vale aster',
      'ålund',
      'alund',
      'ivy',
      'IVY lane',
      'i̇ris',
      'iris',
      'kite',
      'nz',
      'group',
      'shoegaze',
      'morning',
    ],
  }
  return [...byLibrary[library], ...common]
}

/** Filter values for a field: those the API suggests, a case variant, and an absent one. */
export function filterValues(
  field: string,
  suggested: readonly string[],
  extra: readonly string[],
): string[] {
  const picked = [
    ...new Set([...suggested.slice(0, 2), ...suggested.slice(-1), ...extra]),
  ]
  const [first] = picked
  const variants =
    first === undefined
      ? []
      : [first.toUpperCase(), first.toLowerCase()].filter(
          (variant) => variant !== first,
        )
  return [...new Set([...picked, ...variants.slice(0, 1), absentValue])].filter(
    (value) => value.length > 0 && !(field === 'title' && value.length > 200),
  )
}

/** Tag values: a tag, an alias, a hidden tag, an ancestor, a descendant, case and U+0130. */
export const tagValues: Record<'music' | 'film', string[]> = {
  music: [
    'Ambient',
    'ambient',
    'Electronica',
    'AMBIENT',
    'Hidden Noise',
    'Secret Scene',
    'Pop',
    'Rock',
    'Indie',
    'Dream Pop',
    'dream  POP',
    'Shoegaze',
    'Post-Rock',
    'Noise Pop',
    'İndie',
    'Drone',
    'synth pop',
    'electronic music',
  ],
  film: ['Drama', 'Noir', 'Neo-Noir', 'neo noir', 'Thriller', 'Hidden Film'],
}

/**
 * Values of the `libraryPlaylist` filter (PL-18) per library: a playlist of
 * the library with entries, one of another library, a smart playlist, a
 * deleted one and an unknown ID. Artists do not take the filter.
 */
export const libraryPlaylistValues: Record<ParityLibrary, string[]> = {
  track: [
    'library-playlist-night',
    'library-playlist-calm',
    'library-playlist-shelf',
    'library-playlist-gone',
    'library-playlist-weekly-caps',
    absentValue,
  ],
  album: [
    'library-playlist-shelf',
    'library-playlist-night-albums',
    'library-playlist-archive',
    'library-playlist-night',
    'library-playlist-gone',
    absentValue,
  ],
  film: [
    'library-playlist-screen',
    'library-playlist-films-kept',
    'library-playlist-night',
    'library-playlist-gone',
    absentValue,
  ],
  artist: ['library-playlist-night'],
}

/** A small deterministic generator (mulberry32), so samples repeat. */
export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

export type FilterChoice = { field: string; value: string; mode?: string }

/**
 * Pairs of filters with mixed modes, `count` of them, drawn with a fixed
 * seed from every (field, value, mode) the single-filter dimension uses.
 * Mode `undefined` is the default, any.
 */
export function samplePairs(
  choices: readonly FilterChoice[],
  count: number,
  seed: number,
): FilterChoice[][] {
  const random = seededRandom(seed)
  const pick = () => choices[Math.floor(random() * choices.length)]
  const pairs: FilterChoice[][] = []
  for (let index = 0; index < count && choices.length > 1; index += 1) {
    const first = pick()
    const second = pick()
    if (first !== undefined && second !== undefined) pairs.push([first, second])
  }
  return pairs
}
