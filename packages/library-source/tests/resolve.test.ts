import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  ArchivableBrowseFacetQuerySchema,
  BrowseFacetQuerySchema,
} from '@repo/schemas/browse'
import {
  ArtistListeningHistogramQuerySchema,
  ArtistQuerySchema,
} from '@repo/schemas/creators'
import type { DeviceBrowseLibrary } from '@repo/schemas/device'
import { LibraryPlaylistListQuerySchema } from '@repo/schemas/library-playlists'
import {
  AlbumListeningHistogramQuerySchema,
  AlbumQuerySchema,
  FilmQuerySchema,
} from '@repo/schemas/media'
import {
  PlaylistBrowseQuerySchema,
  TrackListeningHistogramQuerySchema,
  TrackPositionsQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import {
  LIBRARY_READ_ROUTES,
  libraryReadPath,
  mayBeLibraryRead,
  resolveLibraryRead,
  type LibraryMethod,
  type LibraryQueries,
  type LibraryRead,
} from '../src'

/** Synthetic queries only: every name and ID below is invented. */

type RawQuery = Record<string, string>
/** Candidate raw values per parameter, as the web client sends them. */
type ParameterOptions = Record<string, readonly string[]>

const json = (value: unknown) => JSON.stringify(value)

/** The API collection of each library's `fields` route. */
const fieldLibraries = new Map<string, DeviceBrowseLibrary>([
  ['tracks', 'track'],
  ['albums', 'album'],
  ['films', 'film'],
  ['artists', 'artist'],
])

/** Mulberry32: a seeded generator, so a failure names a reproducible case. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `count` raw queries: each parameter left out or set to one of its options, `required` always set. */
function rawQueries(
  options: ParameterOptions,
  seed: number,
  count = 120,
  required: ParameterOptions = {},
): RawQuery[] {
  const next = random(seed)
  const pick = (values: readonly string[]) =>
    values[Math.floor(next() * values.length)] ?? ''
  const queries: RawQuery[] = [
    Object.fromEntries(
      Object.entries(required).map(([key, values]) => [key, pick(values)]),
    ),
  ]
  for (let index = 1; index < count; index += 1) {
    const query: RawQuery = {}
    for (const [key, values] of Object.entries({ ...options, ...required }))
      if (key in required || next() < 0.5) query[key] = pick(values)
    queries.push(query)
  }
  return queries
}

const texts = [
  '',
  'blue',
  'Blue & Gold + 100% "live"',
  'é ü ß 東京 🎵',
  '  spaced out  ',
  'a=b&c=d?#e',
]
const catalog: ParameterOptions = {
  libraryScope: ['library', 'outside', 'all'],
  discoverySources: ['playback', 'playback,scrobble,spotify-search'],
  discoverySourceMode: ['any', 'all', 'exclude'],
  discoverySourceScope: ['selection'],
}
const paging: ParameterOptions = {
  page: ['1', '7', '250'],
  size: ['1', '24', '100'],
}
const listening: ParameterOptions = {
  listening: [
    json({ match: 'all', rules: [{ period: { kind: 'all' }, min: 1 }] }),
    json({
      match: 'any',
      rules: [
        {
          period: { kind: 'rolling', amount: 3, unit: 'months' },
          min: 2,
          max: 9,
        },
        { period: { kind: 'dates', from: '2024-01-01' }, max: 10 },
      ],
    }),
    '',
  ],
  listeningSort: [
    json({ kind: 'rolling', amount: 1, unit: 'years' }),
    json({ kind: 'dates', from: '2023-02-01', to: '2023-03-01' }),
    json({ kind: 'all' }),
  ],
}
const periods = [
  json({ kind: 'all' }),
  json({ kind: 'rolling', amount: 12, unit: 'weeks' }),
  json({ kind: 'dates', to: '2022-12-31' }),
]
const mediaFilters = [
  json([]),
  json([
    { field: 'genre', value: 'Jazz', mode: 'required' },
    { field: 'tag', value: 'rock', mode: 'exclude' },
  ]),
  json([
    { field: 'title', value: 'A & B', mode: 'any' },
    { field: 'playlist', value: 'Road trip' },
  ]),
]
const mediaRanges = [
  json([]),
  json([{ field: 'durationSec', min: 60.5, max: 300, includeMissing: true }]),
  json([
    { field: 'releaseDate', min: -86_400_000.25 },
    { field: 'dateAdded', max: 1_700_000_000_000 },
  ]),
]

const trackOptions: ParameterOptions = {
  ...paging,
  ...catalog,
  ...listening,
  creatorId: ['artist-1', 'artist/ü 2'],
  groupRecordings: ['true', 'false'],
  limitResults: ['1', '500', '10000'],
  q: texts,
  filters: [
    ...mediaFilters,
    json([{ field: 'spotifyMatch', value: 'spotify import' }]),
  ],
  ranges: [...mediaRanges, json([{ field: 'bpm', min: 90, max: 90 }])],
  tagLevels: ['track', 'artist,track', 'album,track,artist'],
  sortBy: ['dateAdded', 'title', 'keyword', 'listeningScrobbles'],
  direction: ['asc', 'desc'],
}
const albumOptions: ParameterOptions = {
  ...paging,
  ...catalog,
  ...listening,
  creatorId: ['artist-1'],
  includeArchived: ['true', 'false'],
  editions: ['true', 'false'],
  limitResults: ['20', '10000'],
  q: texts,
  tag: ['jazz', 'Hip Hop'],
  filters: mediaFilters,
  ranges: mediaRanges,
  tagLevels: ['album', 'track,artist'],
  sortBy: ['dateAdded', 'title', 'ratingRymValue', 'listeningScrobbles'],
  direction: ['asc', 'desc'],
}
const filmOptions: ParameterOptions = {
  ...paging,
  ...catalog,
  creatorId: ['person-1'],
  creatorRole: ['director', 'actor'],
  includeArchived: ['true', 'false'],
  limitResults: ['5'],
  q: texts,
  tag: ['drama'],
  sourceKind: ['plex', 'manual'],
  filters: [
    ...mediaFilters,
    json([{ field: 'director', value: 'Example Director' }]),
  ],
  ranges: [
    ...mediaRanges,
    json([{ field: 'ratingImdbValue', min: 7.5, includeMissing: false }]),
  ],
  sortBy: ['releaseDate', 'title', 'ratingImdbValue'],
  direction: ['asc', 'desc'],
}
const artistOptions: ParameterOptions = {
  ...paging,
  ...catalog,
  ...listening,
  q: texts,
  direction: ['asc', 'desc'],
  sortBy: ['name', 'albumCount', 'listeningScrobbles', 'createdAt'],
  filters: [
    json([]),
    json([
      { field: 'country', value: 'Iceland', mode: 'any' },
      { field: 'genre', value: 'Post-rock', mode: 'required' },
      { field: 'provider', value: 'spotify', mode: 'exclude' },
    ]),
  ],
  ranges: [
    json([]),
    json([
      { field: 'albumCount', min: 2, includeMissing: false },
      { field: 'scrobbles', max: 1000 },
    ]),
  ],
  limitResults: ['1', '200'],
  playlistIds: [json([]), json(['playlist-1', 'playlist-2'])],
}
const facetOptions: ParameterOptions = {
  ...catalog,
  q: ['', 'jaz', '  Jazz  ', 'é & ü'],
  limitPerField: ['1', '25', '50'],
  tagLevels: ['track', 'album,artist'],
}
const playlistOptions: ParameterOptions = {
  ...paging,
  ...catalog,
  q: ['', 'road', ' Road trip '],
  name: ['Example Playlist'],
  sortBy: ['name', 'tracks', 'imported', 'description'],
  direction: ['asc', 'desc'],
  sources: [
    json([]),
    json(['library']),
    json(['spotify', 'spotify-liked', 'library']),
  ],
  ids: [json(['playlist-1']), json(['playlist-1', 'playlist/2 ü'])],
  acceptsAdditions: ['true', 'false'],
  // PL-17: the directory of a library, with its column filters.
  library: ['tracks', 'albums', 'films', 'subscriptions', 'mixes'],
  owner: ['Example Owner'],
  description: [' slow '],
  savedViewText: ['tag: jazz'],
  savedView: ['present', 'absent'],
  types: [json([]), json(['smart']), json(['playlist', 'smart'])],
  schedules: [json(['daily', 'off'])],
  columnRanges: [
    json({ count: { min: 2 }, updated: { max: '2024-05-31' } }),
    json({ duration: { min: 1.5, max: 90 } }),
  ],
  timeZone: ['UTC', 'America/Havana'],
  keyNotation: ['camelot'],
}
const libraryPlaylistOptions: ParameterOptions = {
  ...paging,
  type: ['playlist', 'smart'],
  q: ['', 'late', ' Late shift '],
  itemId: ['track-1', 'item/2 ü'],
}

/** One method's query schema and parameter options, typed by the method. */
type QueryCase<Method extends LibraryMethod> = {
  method: Method
  schema: z.ZodType<LibraryQueries[Method]>
  options: ParameterOptions
  required?: ParameterOptions
}

function queryCase<Method extends LibraryMethod>(
  method: Method,
  schema: z.ZodType<LibraryQueries[Method]>,
  options: ParameterOptions,
  required?: ParameterOptions,
): QueryCase<Method> {
  return { method, schema, options, required }
}

const queryCases = [
  queryCase('trackPage', TrackQuerySchema, trackOptions),
  queryCase('trackCount', TrackQuerySchema, trackOptions),
  queryCase('trackList', TrackQuerySchema, trackOptions),
  queryCase('trackPositions', TrackPositionsQuerySchema, trackOptions, {
    positions: ['0', '9,2,9,0', '1234567,5'],
  }),
  queryCase('trackFacets', BrowseFacetQuerySchema, facetOptions),
  queryCase(
    'trackHistogram',
    TrackListeningHistogramQuerySchema,
    trackOptions,
    {
      period: periods,
    },
  ),
  queryCase('albumPage', AlbumQuerySchema, albumOptions),
  queryCase('albumCount', AlbumQuerySchema, albumOptions),
  queryCase('albumList', AlbumQuerySchema, albumOptions),
  queryCase('albumFacets', ArchivableBrowseFacetQuerySchema, {
    ...facetOptions,
    includeArchived: ['true', 'false'],
  }),
  queryCase(
    'albumHistogram',
    AlbumListeningHistogramQuerySchema,
    albumOptions,
    { period: periods },
  ),
  queryCase('filmPage', FilmQuerySchema, filmOptions),
  queryCase('filmCount', FilmQuerySchema, filmOptions),
  queryCase('filmList', FilmQuerySchema, filmOptions),
  queryCase('filmFacets', ArchivableBrowseFacetQuerySchema, {
    ...facetOptions,
    includeArchived: ['true', 'false'],
  }),
  queryCase('artistPage', ArtistQuerySchema, artistOptions),
  queryCase('artistCount', ArtistQuerySchema, artistOptions),
  queryCase('artistFacets', BrowseFacetQuerySchema, facetOptions),
  queryCase(
    'artistHistogram',
    ArtistListeningHistogramQuerySchema,
    artistOptions,
    { period: periods },
  ),
  queryCase('playlistPage', PlaylistBrowseQuerySchema, playlistOptions),
  queryCase('playlistCount', PlaylistBrowseQuerySchema, playlistOptions),
  queryCase(
    'libraryPlaylistList',
    LibraryPlaylistListQuerySchema,
    libraryPlaylistOptions,
    { library: ['tracks', 'albums', 'films', 'subscriptions', 'mixes'] },
  ),
]

/**
 * Asserts that a path resolves to this read: deep-equal values, where a key
 * the original holds as `undefined` (`listening=` parses so) may be absent.
 */
function expectRoundTrip<Method extends LibraryMethod>(
  method: Method,
  query: LibraryQueries[Method],
) {
  const path = libraryReadPath(method, query)
  expect(resolveLibraryRead(path), path).toEqual({ method, query })
}

function runCase<Method extends LibraryMethod>(
  { method, schema, options, required }: QueryCase<Method>,
  seed: number,
) {
  const raw = rawQueries(options, seed, 120, required)
  for (const input of raw) {
    const parsed = schema.safeParse(input)
    // The options are valid values; a failure here is a fault in the test data.
    expect(parsed.error, JSON.stringify(input)).toBeUndefined()
    if (parsed.success) expectRoundTrip(method, parsed.data)
  }
  return raw.length
}

describe('libraryReadPath and resolveLibraryRead', () => {
  it.each(queryCases)(
    'round-trips $method queries of every parameter kind',
    (testCase) => {
      expect(runCase(testCase, 1000 + queryCases.indexOf(testCase))).toBe(120)
    },
  )

  it('round-trips recordings queries, the track ID encoded in the path', () => {
    const ids = [
      'track-1',
      'ü id/with slash?&#',
      '%25 literal',
      'x'.repeat(200),
    ]
    const queries = rawQueries(trackOptions, 77, 30)
    for (const id of ids)
      for (const input of queries)
        expectRoundTrip('trackRecordings', {
          id,
          query: TrackQuerySchema.parse(input),
        })
    expect(
      libraryReadPath('trackRecordings', {
        id: 'a/b c',
        query: TrackQuerySchema.parse({}),
      }),
    ).toMatch(/^\/api\/v1\/tracks\/a%2Fb%20c\/recordings\?/)
  })

  it('round-trips the fields of every library, with no query string', () => {
    for (const [collection, library] of fieldLibraries) {
      expect(libraryReadPath('fields', library)).toBe(
        `/api/v1/${collection}/fields`,
      )
      expectRoundTrip('fields', library)
    }
  })

  it('writes the web client conventions: JSON lists and objects, comma lists, every default', () => {
    const query = TrackPositionsQuerySchema.parse({
      positions: '4,1',
      tagLevels: 'album,track',
      groupRecordings: 'true',
      filters: json([{ field: 'genre', value: 'Jazz & Soul' }]),
      listeningSort: json({ kind: 'all' }),
    })
    const path = libraryReadPath('trackPositions', query)
    const [pathname, search] = path.split('?')
    expect(pathname).toBe('/api/v1/tracks/positions')
    const params = new URLSearchParams(search)
    expect(params.get('positions')).toBe('4,1')
    expect(params.get('tagLevels')).toBe('track,album')
    expect(params.get('groupRecordings')).toBe('true')
    expect(params.get('filters')).toBe(
      json([{ field: 'genre', value: 'Jazz & Soul' }]),
    )
    expect(params.get('ranges')).toBe('[]')
    expect(params.get('listeningSort')).toBe(json({ kind: 'all' }))
    expect(params.get('page')).toBe('1')
    expect(params.get('size')).toBe('24')
    expect(params.get('sortBy')).toBe('dateAdded')
    expect(params.get('direction')).toBe('desc')
    expect(params.has('q')).toBe(false)
  })
})

/**
 * Paths as the web client's builders write them (`URLSearchParams` in the
 * builders' parameter order). The builders live in React components and
 * hooks, so these are literal copies of their output for synthetic values:
 * track-browser.tsx, media-browser.tsx and artist-browser.tsx with
 * useVirtualBrowse.ts (pages and counts), browse-facets.ts, track-browse.ts
 * and the title suggestions (`/browse-page` and the list endpoints),
 * playback-source.ts (positions and album pages), track-recording-versions.tsx,
 * listening-controls.tsx (histograms), track-merge.tsx and lastfm-sync.ts
 * (lists), playlists-workspace.tsx and artist-playlist-filter.tsx (Playlists).
 */
const webPaths: [LibraryMethod, string][] = [
  [
    'trackPage',
    '/api/v1/tracks/browse-page?q=blue+note&filters=%5B%7B%22field%22%3A%22genre%22%2C%22value%22%3A%22Jazz+%26+Soul%22%2C%22mode%22%3A%22required%22%7D%2C%7B%22field%22%3A%22artist%22%2C%22value%22%3A%22Example+Artist%22%2C%22mode%22%3A%22exclude%22%7D%5D&ranges=%5B%7B%22field%22%3A%22durationSec%22%2C%22min%22%3A120%2C%22max%22%3A360%2C%22includeMissing%22%3Afalse%7D%5D&sortBy=scrobbles&direction=desc&groupRecordings=true&tagLevels=track%2Calbum&listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%7B%22period%22%3A%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A1%2C%22unit%22%3A%22years%22%7D%2C%22min%22%3A2%7D%5D%7D&listeningSort=%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A6%2C%22unit%22%3A%22months%22%7D&page=3&size=100',
  ],
  [
    'trackCount',
    '/api/v1/tracks/browse-count?filters=%5B%7B%22field%22%3A%22genre%22%2C%22value%22%3A%22Jazz+%26+Soul%22%2C%22mode%22%3A%22required%22%7D%2C%7B%22field%22%3A%22artist%22%2C%22value%22%3A%22Example+Artist%22%2C%22mode%22%3A%22exclude%22%7D%5D&groupRecordings=true&listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%7B%22period%22%3A%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A1%2C%22unit%22%3A%22years%22%7D%2C%22min%22%3A2%7D%5D%7D&q=blue+note&ranges=%5B%7B%22field%22%3A%22durationSec%22%2C%22min%22%3A120%2C%22max%22%3A360%2C%22includeMissing%22%3Afalse%7D%5D&tagLevels=track%2Calbum',
  ],
  [
    'trackPage',
    '/api/v1/tracks/browse-page?page=1&size=100&filters=%5B%7B%22field%22%3A%22title%22%2C%22value%22%3A%22Example%22%2C%22mode%22%3A%22any%22%7D%5D&sortBy=title&direction=asc&creatorId=artist-1',
  ],
  [
    'trackPositions',
    '/api/v1/tracks/positions?q=blue+note&filters=%5B%7B%22field%22%3A%22genre%22%2C%22value%22%3A%22Jazz+%26+Soul%22%2C%22mode%22%3A%22required%22%7D%2C%7B%22field%22%3A%22artist%22%2C%22value%22%3A%22Example+Artist%22%2C%22mode%22%3A%22exclude%22%7D%5D&ranges=%5B%7B%22field%22%3A%22durationSec%22%2C%22min%22%3A120%2C%22max%22%3A360%2C%22includeMissing%22%3Afalse%7D%5D&sortBy=scrobbles&direction=desc&groupRecordings=true&tagLevels=track%2Calbum&listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%7B%22period%22%3A%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A1%2C%22unit%22%3A%22years%22%7D%2C%22min%22%3A2%7D%5D%7D&listeningSort=%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A6%2C%22unit%22%3A%22months%22%7D&positions=7%2C0%2C42',
  ],
  [
    'trackRecordings',
    '/api/v1/tracks/track%207%2F%C3%BC/recordings?q=blue+note&filters=%5B%7B%22field%22%3A%22genre%22%2C%22value%22%3A%22Jazz+%26+Soul%22%2C%22mode%22%3A%22required%22%7D%2C%7B%22field%22%3A%22artist%22%2C%22value%22%3A%22Example+Artist%22%2C%22mode%22%3A%22exclude%22%7D%5D&ranges=%5B%7B%22field%22%3A%22durationSec%22%2C%22min%22%3A120%2C%22max%22%3A360%2C%22includeMissing%22%3Afalse%7D%5D&sortBy=scrobbles&direction=desc&groupRecordings=true&tagLevels=track%2Calbum&listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%7B%22period%22%3A%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A1%2C%22unit%22%3A%22years%22%7D%2C%22min%22%3A2%7D%5D%7D&listeningSort=%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A6%2C%22unit%22%3A%22months%22%7D&page=3&size=100',
  ],
  ['trackFacets', '/api/v1/tracks/facets?q=&limitPerField=25&tagLevels=album'],
  [
    'trackHistogram',
    '/api/v1/tracks/listening-histogram?q=blue+note&filters=%5B%7B%22field%22%3A%22genre%22%2C%22value%22%3A%22Jazz+%26+Soul%22%2C%22mode%22%3A%22required%22%7D%2C%7B%22field%22%3A%22artist%22%2C%22value%22%3A%22Example+Artist%22%2C%22mode%22%3A%22exclude%22%7D%5D&ranges=%5B%7B%22field%22%3A%22durationSec%22%2C%22min%22%3A120%2C%22max%22%3A360%2C%22includeMissing%22%3Afalse%7D%5D&groupRecordings=true&tagLevels=track%2Calbum&period=%7B%22kind%22%3A%22dates%22%2C%22from%22%3A%222024-01-01%22%2C%22to%22%3A%222024-06-30%22%7D',
  ],
  [
    'trackList',
    '/api/v1/tracks?q=example&page=2&size=20&sortBy=title&direction=asc&filters=%5B%7B%22field%22%3A%22spotifyMatch%22%2C%22value%22%3A%22Spotify+playlist+%2F+Liked+Songs%22%2C%22mode%22%3A%22any%22%7D%5D',
  ],
  [
    'albumPage',
    '/api/v1/albums/browse-page?libraryScope=library&discoverySources=playback%2Cscrobble&discoverySourceScope=selection&q=&filters=%5B%5D&ranges=%5B%5D&sortBy=releaseDate&direction=asc&creatorId=artist-2&includeArchived=true&editions=true&limitResults=50&listeningSort=%7B%22kind%22%3A%22all%22%7D&page=1&size=100',
  ],
  [
    'albumCount',
    '/api/v1/albums/browse-count?creatorId=artist-2&discoverySourceScope=selection&discoverySources=playback%2Cscrobble&editions=true&filters=%5B%5D&includeArchived=true&libraryScope=library&limitResults=50&q=&ranges=%5B%5D',
  ],
  [
    'albumList',
    '/api/v1/albums?page=1&size=100&filters=%5B%7B%22field%22%3A%22title%22%2C%22value%22%3A%22Example+Album%22%2C%22mode%22%3A%22any%22%7D%5D&sortBy=title&direction=asc&includeArchived=false',
  ],
  ['albumList', '/api/v1/albums?q=example&size=20'],
  [
    'albumFacets',
    '/api/v1/albums/facets?q=jaz&limitPerField=25&includeArchived=true',
  ],
  [
    'albumHistogram',
    '/api/v1/albums/listening-histogram?libraryScope=library&discoverySources=playback%2Cscrobble&discoverySourceScope=selection&q=&filters=%5B%5D&ranges=%5B%5D&creatorId=artist-2&includeArchived=true&editions=true&limitResults=50&period=%7B%22kind%22%3A%22all%22%7D',
  ],
  [
    'filmPage',
    '/api/v1/films/browse-page?q=night&filters=%5B%7B%22field%22%3A%22director%22%2C%22value%22%3A%22Example+Director%22%7D%5D&ranges=%5B%7B%22field%22%3A%22ratingImdbValue%22%2C%22min%22%3A7.5%2C%22includeMissing%22%3Atrue%7D%5D&sortBy=releaseDate&direction=desc&creatorId=person-3&creatorRole=director&page=2&size=100',
  ],
  [
    'filmCount',
    '/api/v1/films/browse-count?creatorId=person-3&creatorRole=director&filters=%5B%7B%22field%22%3A%22director%22%2C%22value%22%3A%22Example+Director%22%7D%5D&q=night&ranges=%5B%7B%22field%22%3A%22ratingImdbValue%22%2C%22min%22%3A7.5%2C%22includeMissing%22%3Atrue%7D%5D',
  ],
  ['filmFacets', '/api/v1/films/facets?q=drama&limitPerField=25'],
  [
    'filmList',
    '/api/v1/films?page=1&size=100&filters=%5B%7B%22field%22%3A%22title%22%2C%22value%22%3A%22Example+Film%22%2C%22mode%22%3A%22any%22%7D%5D&sortBy=title&direction=asc&includeArchived=true',
  ],
  [
    'artistPage',
    '/api/v1/artists/browse-page?q=example&filters=%5B%7B%22field%22%3A%22country%22%2C%22value%22%3A%22Iceland%22%2C%22mode%22%3A%22any%22%7D%5D&ranges=%5B%7B%22field%22%3A%22albumCount%22%2C%22min%22%3A2%2C%22includeMissing%22%3Afalse%7D%5D&sortBy=listeningScrobbles&direction=desc&playlistIds=%5B%22playlist-1%22%2C%22playlist-2%22%5D&limitResults=200&listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%7B%22period%22%3A%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A1%2C%22unit%22%3A%22years%22%7D%2C%22min%22%3A2%7D%5D%7D&listeningSort=%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A6%2C%22unit%22%3A%22months%22%7D&page=1&size=100',
  ],
  [
    'artistCount',
    '/api/v1/artists/browse-count?filters=%5B%7B%22field%22%3A%22country%22%2C%22value%22%3A%22Iceland%22%2C%22mode%22%3A%22any%22%7D%5D&limitResults=200&listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%7B%22period%22%3A%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A1%2C%22unit%22%3A%22years%22%7D%2C%22min%22%3A2%7D%5D%7D&playlistIds=%5B%22playlist-1%22%2C%22playlist-2%22%5D&q=example&ranges=%5B%7B%22field%22%3A%22albumCount%22%2C%22min%22%3A2%2C%22includeMissing%22%3Afalse%7D%5D',
  ],
  [
    'artistPage',
    '/api/v1/artists/browse-page?page=1&size=100&filters=%5B%7B%22field%22%3A%22name%22%2C%22value%22%3A%22Example+Artist%22%2C%22mode%22%3A%22any%22%7D%5D&sortBy=name&direction=asc',
  ],
  ['artistFacets', '/api/v1/artists/facets?q=&limitPerField=25'],
  [
    'artistHistogram',
    '/api/v1/artists/listening-histogram?q=example&filters=%5B%7B%22field%22%3A%22country%22%2C%22value%22%3A%22Iceland%22%2C%22mode%22%3A%22any%22%7D%5D&ranges=%5B%7B%22field%22%3A%22albumCount%22%2C%22min%22%3A2%2C%22includeMissing%22%3Afalse%7D%5D&playlistIds=%5B%22playlist-1%22%2C%22playlist-2%22%5D&limitResults=200&period=%7B%22kind%22%3A%22rolling%22%2C%22amount%22%3A6%2C%22unit%22%3A%22months%22%7D',
  ],
  [
    'playlistCount',
    '/api/v1/playlists/browse-count?q=road&sources=%5B%22spotify%22%2C%22library%22%5D&libraryScope=all',
  ],
  [
    'playlistPage',
    '/api/v1/playlists/browse-page?q=road&sources=%5B%22spotify%22%2C%22library%22%5D&libraryScope=all&sortBy=tracks&direction=desc&page=2&size=100',
  ],
  [
    'playlistPage',
    '/api/v1/playlists/browse-page?ids=%5B%22playlist-1%22%2C%22playlist-2%22%5D&size=2',
  ],
  [
    'playlistPage',
    '/api/v1/playlists/browse-page?library=albums&sortBy=count&direction=desc&types=%5B%22smart%22%5D&columnRanges=%7B%22count%22%3A%7B%22min%22%3A2%7D%2C%22updated%22%3A%7B%22min%22%3A%222024-05-01%22%7D%7D&timeZone=America%2FHavana&savedViewText=jazz&keyNotation=camelot&page=1&size=100',
  ],
  [
    'libraryPlaylistList',
    '/api/v1/library-playlists?library=tracks&type=playlist&q=late&itemId=track-1&page=1&size=25',
  ],
  ['libraryPlaylistList', '/api/v1/library-playlists/?library=films'],
  ['fields', '/api/v1/tracks/fields'],
  ['fields', '/api/v1/albums/fields'],
  ['fields', '/api/v1/films/fields'],
  ['fields', '/api/v1/artists/fields'],
]

/**
 * The validator's input, read with the platform's `URLSearchParams` rather
 * than the resolver's own reader: Hono's `c.req.queries()`, one value
 * unwrapped, repeated names as arrays.
 */
function validatorInput(search: string): Record<string, string | string[]> {
  const input: Record<string, string | string[]> = {}
  const params = new URLSearchParams(search)
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name)
    const [only, ...rest] = values
    input[name] = only !== undefined && rest.length === 0 ? only : values
  }
  return input
}

/** What the route's validator passes to its service for the path, as a read. */
function routeRead(method: LibraryMethod, path: string): LibraryRead {
  const [pathname = '', search = ''] = path.split('?')
  const input = validatorInput(search)
  switch (method) {
    case 'trackPage':
    case 'trackCount':
    case 'trackList':
      return { method, query: TrackQuerySchema.parse(input) }
    case 'trackPositions':
      return { method, query: TrackPositionsQuerySchema.parse(input) }
    case 'trackRecordings':
      return {
        method,
        query: {
          id: decodeURIComponent(pathname.split('/')[4] ?? ''),
          query: TrackQuerySchema.parse(input),
        },
      }
    case 'trackFacets':
    case 'artistFacets':
      return { method, query: BrowseFacetQuerySchema.parse(input) }
    case 'trackHistogram':
      return { method, query: TrackListeningHistogramQuerySchema.parse(input) }
    case 'albumPage':
    case 'albumCount':
    case 'albumList':
      return { method, query: AlbumQuerySchema.parse(input) }
    case 'albumFacets':
    case 'filmFacets':
      return { method, query: ArchivableBrowseFacetQuerySchema.parse(input) }
    case 'albumHistogram':
      return { method, query: AlbumListeningHistogramQuerySchema.parse(input) }
    case 'filmPage':
    case 'filmCount':
    case 'filmList':
      return { method, query: FilmQuerySchema.parse(input) }
    case 'artistPage':
    case 'artistCount':
      return { method, query: ArtistQuerySchema.parse(input) }
    case 'artistHistogram':
      return {
        method,
        query: ArtistListeningHistogramQuerySchema.parse(input),
      }
    case 'playlistPage':
    case 'playlistCount':
      return { method, query: PlaylistBrowseQuerySchema.parse(input) }
    case 'libraryPlaylistList':
      return { method, query: LibraryPlaylistListQuerySchema.parse(input) }
    case 'fields': {
      const library = fieldLibraries.get(pathname.split('/')[3] ?? '')
      if (!library) throw new Error(`No fields route: ${pathname}`)
      return { method, query: library }
    }
  }
}

describe('resolveLibraryRead on the web client’s paths', () => {
  it.each(webPaths)('%s: %s', (method, path) => {
    expect(resolveLibraryRead(path)).toStrictEqual(routeRead(method, path))
  })

  it('covers every LibrarySource method', () => {
    expect(new Set(webPaths.map(([method]) => method)).size).toBe(24)
  })

  it('parses values as the route does: numbers, booleans, defaults, JSON and lists', () => {
    const [, path = ''] = webPaths[0] ?? []
    const read = resolveLibraryRead(path)
    expect(read?.method).toBe('trackPage')
    if (read?.method !== 'trackPage') return
    expect(read.query).toMatchObject({
      page: 3,
      size: 100,
      q: 'blue note',
      groupRecordings: true,
      tagLevels: ['track', 'album'],
      sortBy: 'scrobbles',
      direction: 'desc',
      filters: [
        { field: 'genre', value: 'Jazz & Soul', mode: 'required' },
        { field: 'artist', value: 'Example Artist', mode: 'exclude' },
      ],
      ranges: [
        { field: 'durationSec', min: 120, max: 360, includeMissing: false },
      ],
      listeningSort: { kind: 'rolling', amount: 6, unit: 'months' },
    })
    expect(
      resolveLibraryRead('/api/v1/albums?q=example&size=20'),
    ).toStrictEqual({
      method: 'albumList',
      query: AlbumQuerySchema.parse({ q: 'example', size: '20' }),
    })
    expect(resolveLibraryRead('/api/v1/films/browse-page')).toMatchObject({
      method: 'filmPage',
      query: {
        page: 1,
        size: 24,
        filters: [],
        ranges: [],
        sortBy: 'releaseDate',
        direction: 'desc',
      },
    })
    expect(
      resolveLibraryRead('/api/v1/tracks/positions?positions=3%2C1%2C3'),
    ).toMatchObject({ method: 'trackPositions', query: { positions: [3, 1] } })
  })

  it('reads the query string as the API’s router does', () => {
    // A trailing slash (the API is not strict), an escaped path segment, a fragment, names without values.
    expect(resolveLibraryRead('/api/v1/tracks/browse-page/?q=a')).toStrictEqual(
      resolveLibraryRead('/api/v1/tracks/browse-page?q=a'),
    )
    expect(resolveLibraryRead('/api/v1/tracks/browse%2Dpage')?.method).toBe(
      'trackPage',
    )
    expect(
      resolveLibraryRead('/api/v1/tracks/browse-page?q=a#q=b'),
    ).toStrictEqual(resolveLibraryRead('/api/v1/tracks/browse-page?q=a'))
    expect(
      resolveLibraryRead('/api/v1/tracks/browse-page?q&=x&&'),
    ).toStrictEqual({
      method: 'trackPage',
      query: TrackQuerySchema.parse({ q: '' }),
    })
    expect(resolveLibraryRead('/api/v1/tracks/facets?q=a+b%2Bc')).toMatchObject(
      {
        query: { q: 'a b+c' },
      },
    )
    // The fields routes take no query, so any query string reads the fields.
    expect(
      resolveLibraryRead('/api/v1/albums/fields?x=%E0%A4%A'),
    ).toStrictEqual({ method: 'fields', query: 'album' })
  })
})

describe('resolveLibraryRead leaves other paths to the API', () => {
  it.each([
    // Other prefixes and forms
    '/api/v2/tracks/browse-page',
    '/tracks/browse-page',
    'api/v1/tracks/browse-page',
    'https://media.example.test/api/v1/tracks/browse-page',
    '/api/auth/get-session',
    '/api/v1',
    '/api/v1/',
    '/api/v1/tracks%2Fbrowse-page',
    '/api/v1/tracks//browse-page',
    '/api/v1/tracks/browse-page//',
    '/api/v1/Tracks/browse-page',
    // Lists that are not LibrarySource methods
    '/api/v1/artists?page=1',
    '/api/v1/playlists?page=1',
    '/api/v1/people',
    '/api/v1/subscriptions/browse-page?page=1',
    '/api/v1/subscriptions/browse-count?library=mixes',
    '/api/v1/collections',
    '/api/v1/album-collections',
    '/api/v1/tags?mediaType=album',
    // Server state: Metadata selection, Matches, duplicates
    '/api/v1/albums/selection?page=1&size=24',
    '/api/v1/films/selection',
    '/api/v1/artists/metadata/browse-page?page=1',
    '/api/v1/tracks/match-diagnostics?page=1',
    '/api/v1/tracks/match-diagnostics/facets?q=',
    '/api/v1/tracks/match-diagnostics/fields',
    '/api/v1/tracks/duplicates/count',
    // Details and the lists they own
    '/api/v1/tracks/track-1',
    '/api/v1/albums/album-1',
    '/api/v1/films/film-1',
    '/api/v1/artists/artist-1?includeHistory=false',
    '/api/v1/artists/artist-1/albums?page=1&size=12',
    '/api/v1/artists/artist-1/tracks',
    '/api/v1/playlists/playlist-1?page=1&size=1&sortBy=position&direction=asc',
    '/api/v1/albums/album-1/listening',
    '/api/v1/albums/album-1/playlists',
    '/api/v1/tracks/track-1/listening/series',
    '/api/v1/tracks/track-1/recordings/extra',
    '/api/v1/tracks/recordings',
    // Paths that writes use
    '/api/v1/tracks/track-1/tags',
    '/api/v1/tracks/track-1/merge?interactive=true',
    '/api/v1/tracks/track-1/playlist-additions',
    '/api/v1/playlists/playlist-1/presentation',
    '/api/v1/library-changes/track-merges',
    '/api/v1/performance/browse',
  ])('%s', (path) => {
    expect(resolveLibraryRead(path)).toBeUndefined()
  })

  it.each([
    // The route answers these with a validation error.
    '/api/v1/tracks/browse-page?page=0',
    '/api/v1/tracks/browse-page?size=101',
    '/api/v1/tracks/browse-page?page=two',
    '/api/v1/tracks/browse-page?direction=up',
    '/api/v1/tracks/browse-page?sortBy=bad%20key',
    '/api/v1/tracks/browse-page?filters=not-json',
    '/api/v1/tracks/browse-page?filters=%5B%7B%22field%22%3A%22genre%22%7D%5D',
    '/api/v1/tracks/browse-page?ranges=%5B%7B%22field%22%3A%22bpm%22%2C%22min%22%3A5%2C%22max%22%3A1%7D%5D',
    '/api/v1/tracks/browse-page?tagLevels=track%2Ctrack',
    '/api/v1/tracks/browse-page?groupRecordings=yes',
    '/api/v1/tracks/browse-page?limitResults=0',
    '/api/v1/tracks/browse-page?listening=%7B%22match%22%3A%22all%22%7D',
    '/api/v1/tracks/browse-page?libraryScope=elsewhere',
    '/api/v1/tracks/browse-page?q=one&q=two',
    '/api/v1/tracks/positions',
    '/api/v1/tracks/positions?positions=a',
    `/api/v1/tracks/positions?positions=${Array.from({ length: 51 }, (_, index) => index).join(',')}`,
    '/api/v1/tracks/listening-histogram',
    '/api/v1/tracks/listening-histogram?period=%7B%22kind%22%3A%22dates%22%7D',
    `/api/v1/tracks/${'x'.repeat(201)}/recordings`,
    '/api/v1/tracks/track-1/recordings?page=0',
    '/api/v1/tracks/facets?limitPerField=51',
    `/api/v1/tracks/facets?q=${'a'.repeat(201)}`,
    '/api/v1/albums/browse-page?includeArchived=yes',
    '/api/v1/albums/facets?includeArchived=1',
    '/api/v1/films/browse-page?listening=%7B%22match%22%3A%22all%22%2C%22rules%22%3A%5B%5D%7D',
    '/api/v1/films/browse-page?sortBy=listeningScrobbles',
    '/api/v1/films/browse-page?creatorRole=writer',
    '/api/v1/artists/browse-page?filters=%5B%7B%22field%22%3A%22title%22%2C%22value%22%3A%22x%22%7D%5D',
    '/api/v1/artists/browse-page?ranges=%5B%7B%22field%22%3A%22name%22%2C%22min%22%3A1%7D%5D',
    '/api/v1/artists/browse-page?sortBy=title',
    '/api/v1/artists/browse-page?playlistIds=playlist-1',
    '/api/v1/artists/listening-histogram',
    '/api/v1/playlists/browse-page?sources=%5B%22tidal%22%5D',
    '/api/v1/playlists/browse-page?ids=%5B%5D',
    '/api/v1/playlists/browse-page?sortBy=position',
    '/api/v1/playlists/browse-page?timeZone=Not%2FA_Zone',
    '/api/v1/library-playlists',
    '/api/v1/library-playlists?library=artists',
    '/api/v1/library-playlists?library=tracks&size=0',
  ])('rejected query: %s', (path) => {
    expect(resolveLibraryRead(path)).toBeUndefined()
  })

  it.each([
    // Hono decodes a malformed escape in part and answers; the API keeps that behaviour.
    '/api/v1/tracks/browse-page?q=%E0%A4%A',
    '/api/v1/tracks/browse-page?%E0%A4%A=1',
    '/api/v1/tracks/%E0%A4%A/recordings',
  ])('malformed escape: %s', (path) => {
    expect(resolveLibraryRead(path)).toBeUndefined()
  })
})

describe('mayBeLibraryRead', () => {
  it('is true for every path resolveLibraryRead resolves', () => {
    for (const [, path] of webPaths)
      expect(mayBeLibraryRead(path), path).toBe(true)
    for (const { method, schema, options, required } of queryCases)
      for (const input of rawQueries(options, 5, 20, required)) {
        const path = `${libraryReadPath(method, schema.parse(input))}#x`
        expect(mayBeLibraryRead(path), path).toBe(true)
      }
    for (const route of LIBRARY_READ_ROUTES)
      expect(mayBeLibraryRead(`/api/v1/${route}/?q=a`), route).toBe(true)
    expect(mayBeLibraryRead('/api/v1/tracks/browse%2Dpage')).toBe(true)
    expect(mayBeLibraryRead('/api/v1/tracks/track%207/recordings?q=a')).toBe(
      true,
    )
  })

  it.each([
    '/api/v1/jobs/activity',
    '/api/v1/providers/overview',
    '/api/v1/ai/status',
    '/api/v1/spotify/status',
    '/api/v1/device/state',
    '/api/v1/tracks/track-1',
    '/api/v1/tracks/track-1/listening/series',
    '/api/v1/albums/selection?page=1&size=24',
    '/api/v1/artists?page=1',
    '/api/v2/tracks/browse-page',
    '/api/auth/get-session',
    '/api/v1/Tracks/browse-page',
    '/api/v1/library-playlists/playlist-1',
    '/api/v1/library-playlists/playlist-1/entries?page=1',
    '/api/v1/library-playlists/memberships?library=tracks&itemId=track-1',
  ])('is false for %s, which resolveLibraryRead never resolves', (path) => {
    expect(mayBeLibraryRead(path)).toBe(false)
    expect(resolveLibraryRead(path)).toBeUndefined()
  })
})
