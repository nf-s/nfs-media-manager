import { z } from 'zod'
import { resolveLibraryRead } from '@repo/library-source'
import {
  BrowseFieldSchema,
  LIBRARY_PLAYLIST_FILTER_FIELD,
  type BrowseField,
} from '@repo/schemas/browse'
import { compareRead, ParityReport, type ParityStore } from './harness'
import { readDataFacts } from './facts'
import type { DataFacts } from './holes'
import { parityPluginFields } from '../fixtures/device-parity-library'
import {
  absentValue,
  apiPath,
  combinedListeningRules,
  directions,
  filterFields,
  filterModes,
  filterValues,
  isTagField,
  libraryPlaylistValues,
  listeningPeriods,
  listeningRuleCases,
  rangeCases,
  rangeFields,
  samplePairs,
  searchWords,
  sortKeys,
  tagLocations,
  tagValues,
  type FilterChoice,
  type LibraryRoutes,
  type Params,
} from './matrix'

/** Runs the matrix against one synced store and collects the report. */
export class ParityRunner {
  readonly report = new ParityReport()
  private facts: DataFacts | undefined

  constructor(private readonly store: ParityStore) {}

  /** Re-reads the data the holes depend on, after the library changed. */
  async refreshFacts() {
    this.facts = await readDataFacts(pluginTextKeys)
  }

  async read(path: string) {
    const facts = this.facts ?? (await readDataFacts(pluginTextKeys))
    this.facts = facts
    return compareRead(this.store, facts, this.report, path)
  }

  /** Every page of a paged read, until the API says there are no more. */
  async pages(route: string, params: Params, size: number, maxPages = 40) {
    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.read(apiPath(route, { ...params, page, size }))
      const slice = PageSchema.safeParse(result?.data)
      if (!slice.success || !slice.data.hasMore) return
    }
  }

  /** The common reads of one query: the first Browse page, the count and the list page. */
  async query(routes: LibraryRoutes, params: Params) {
    await this.read(apiPath(routes.page, { ...params, size: 4 }))
    await this.read(apiPath(routes.count, params))
    if (routes.list !== undefined)
      await this.read(apiPath(routes.list, { ...params, size: 4, page: 2 }))
  }
}

const PageSchema = z.object({ hasMore: z.boolean() })
const pluginTextKeys = new Set(
  parityPluginFields
    .filter((field) => field.type === 'text')
    .map((field) => field.key),
)
const FieldsSchema = z.array(BrowseFieldSchema)
const FacetsSchema = z.array(z.object({ field: z.string(), value: z.string() }))

/** A query the API rejects: an unknown filter, range or sort field, or a range on a text field. */
type InvalidQuery = {
  filters?: FilterChoice[]
  ranges?: { field: string; min: number }[]
  sortBy?: string
}

export type MatrixOptions = {
  /** After edits: fewer modes and values, the same dimensions. */
  reduced: boolean
  /** Extra filter values per field, where the facets suggest none. */
  extraValues: Record<string, string[]>
}

async function libraryFields(run: ParityRunner, routes: LibraryRoutes) {
  const result = await run.read(apiPath(routes.fields))
  return FieldsSchema.parse(result?.data)
}

async function suggestedValues(
  run: ParityRunner,
  routes: LibraryRoutes,
): Promise<Map<string, string[]>> {
  const archived =
    routes.library === 'album' || routes.library === 'film'
      ? { includeArchived: 'true' }
      : {}
  const result = await run.read(
    apiPath(routes.facets, { limitPerField: 50, ...archived }),
  )
  const values = new Map<string, string[]>()
  for (const option of FacetsSchema.parse(result?.data ?? []))
    values.set(option.field, [
      ...(values.get(option.field) ?? []),
      option.value,
    ])
  return values
}

/** Filters, search, ranges, sorts, listening, facets and histograms of one library. */
export async function runLibraryMatrix(
  run: ParityRunner,
  routes: LibraryRoutes,
  options: MatrixOptions,
): Promise<BrowseField[]> {
  const fields = await libraryFields(run, routes)
  const suggested = await suggestedValues(run, routes)
  const modes = options.reduced
    ? (['required', 'exclude'] as const)
    : filterModes
  const choices: FilterChoice[] = []

  // Every filter field in every mode, with present, case-variant and absent values.
  for (const field of filterFields(fields)) {
    const tag = isTagField(field.key)
    const values = tag
      ? routes.library === 'film'
        ? tagValues.film
        : tagValues.music
      : filterValues(
          field.key,
          suggested.get(field.key) ?? [],
          options.extraValues[field.key] ?? [],
        )
    const used = options.reduced ? values.slice(0, 2) : values
    for (const value of used)
      for (const mode of modes) {
        const filter = { field: field.key, value, mode }
        choices.push(filter)
        await run.query(routes, { filters: [filter] })
      }
    const [first] = used
    if (first !== undefined)
      await run.query(routes, { filters: [{ field: field.key, value: first }] })
  }

  // Tags filters at every location, and the Tags sort at each.
  if (routes.tagLevels)
    for (const tagLevels of options.reduced
      ? tagLocations.slice(0, 3)
      : tagLocations)
      for (const field of filterFields(fields).filter((entry) =>
        isTagField(entry.key),
      ))
        for (const value of options.reduced
          ? tagValues.music.slice(0, 4)
          : tagValues.music)
          for (const mode of ['required', 'exclude'] as const)
            await run.query(routes, {
              tagLevels,
              filters: [{ field: field.key, value, mode }],
            })

  // Pairs of filters mixing modes: a deterministic sample.
  for (const pair of samplePairs(choices, options.reduced ? 20 : 80, 32))
    await run.query(routes, { filters: pair })
  // The any/unset OR group across fields, with a required one.
  const pairsOfAny = samplePairs(
    choices.filter((choice) => choice.mode === 'any'),
    options.reduced ? 5 : 20,
    33,
  )
  for (const [first, second] of pairsOfAny)
    if (first !== undefined && second !== undefined)
      await run.query(routes, {
        filters: [
          { field: first.field, value: first.value },
          second,
          ...(choices[0] === undefined
            ? []
            : [{ ...choices[0], mode: 'required' }]),
        ],
      })

  // Search words.
  for (const q of options.reduced
    ? searchWords(routes.library).slice(0, 6)
    : searchWords(routes.library))
    await run.query(routes, { q })

  // Every range field with min, max, both and includeMissing.
  for (const field of rangeFields(fields)) {
    const cases = rangeCases(field)
    for (const range of options.reduced ? cases.slice(0, 4) : cases)
      await run.query(routes, { ranges: [{ field: field.key, ...range }] })
  }

  // Every sort in both directions, paged to the end, alone and under a filter.
  const filtered =
    choices.find((choice) => choice.mode === 'exclude') ?? choices[0]
  for (const sortBy of sortKeys(routes, fields))
    for (const direction of options.reduced ? ['asc' as const] : directions) {
      await run.pages(routes.page, { sortBy, direction }, 3)
      if (routes.list !== undefined)
        await run.pages(routes.list, { sortBy, direction }, 5)
      if (filtered !== undefined)
        await run.pages(
          routes.page,
          { sortBy, direction, filters: [filtered] },
          3,
        )
      if (routes.tagLevels && sortBy === 'genre')
        for (const tagLevels of tagLocations.slice(1))
          await run.pages(routes.page, { sortBy, direction, tagLevels }, 3)
    }

  // limitResults on pages, counts and lists.
  for (const limitResults of [1, 5, 9])
    await run.pages(routes.page, { limitResults, sortBy: 'title' }, 3)
  for (const limitResults of [1, 5])
    await run.query(routes, { limitResults, q: 'a' })

  // Listening rules and the listening sort, for each period kind.
  if (routes.listening) {
    const periods = options.reduced
      ? listeningPeriods.slice(0, 6)
      : listeningPeriods
    for (const period of periods) {
      for (const listening of listeningRuleCases(period))
        await run.query(routes, { listening })
      await run.pages(
        routes.page,
        {
          sortBy: 'listeningScrobbles',
          listeningSort: period,
          direction: 'desc',
        },
        4,
      )
      await run.query(routes, {
        sortBy: 'listeningScrobbles',
        listeningSort: period,
        listening: { match: 'all', rules: [{ period, min: 1 }] },
      })
    }
    for (const listening of combinedListeningRules)
      await run.query(routes, { listening })
  }

  // Facets.
  const archivable = routes.library === 'album' || routes.library === 'film'
  const facetTexts = [
    undefined,
    'a',
    'e',
    'pop',
    'dream pop',
    'aster vale',
    'İ',
    absentValue,
  ]
  for (const q of options.reduced ? facetTexts.slice(0, 3) : facetTexts)
    for (const limitPerField of [1, 3, 50])
      for (const includeArchived of archivable
        ? [undefined, 'true', 'false']
        : [undefined])
        await run.read(
          apiPath(routes.facets, { q, limitPerField, includeArchived }),
        )
  // Films and Artists suggestions do not read `tagLevels`, which their
  // routes accept: served as without it.
  for (const tagLevels of routes.tagLevels
    ? tagLocations
    : tagLocations.slice(1, 3))
    for (const q of [undefined, 'pop', 'rock'])
      await run.read(
        apiPath(routes.facets, { q, tagLevels, limitPerField: 10 }),
      )

  // Histograms for each period, alone and under filters and rules.
  if (routes.histogram !== undefined)
    for (const period of listeningPeriods) {
      await run.read(apiPath(routes.histogram, { period }))
      if (!options.reduced) {
        if (filtered !== undefined)
          await run.read(
            apiPath(routes.histogram, { period, filters: [filtered] }),
          )
        await run.read(
          apiPath(routes.histogram, {
            period,
            q: 'a',
            listening: combinedListeningRules[0],
          }),
        )
      }
    }

  // PL-18: the libraryPlaylist filter in every mode, alone, beside another
  // filter, under a sort and in a histogram. The device holds no library
  // playlists and leaves each read to the API.
  const playlistValues = libraryPlaylistValues[routes.library]
  for (const value of options.reduced
    ? playlistValues.slice(0, 1)
    : playlistValues)
    for (const mode of [undefined, ...modes]) {
      const filter = { field: LIBRARY_PLAYLIST_FILTER_FIELD, value, mode }
      await run.query(routes, { filters: [filter] })
      if (filtered !== undefined)
        await run.query(routes, { filters: [filtered, filter] })
      await run.read(
        apiPath(routes.page, {
          filters: [filter],
          sortBy: 'dateAdded',
          direction: 'desc',
          size: 4,
        }),
      )
      if (routes.histogram !== undefined)
        await run.read(
          apiPath(routes.histogram, {
            period: { kind: 'all' },
            filters: [filter],
          }),
        )
    }

  // Catalog scopes other than the library, and queries the API rejects.
  for (const scope of [
    { libraryScope: 'all' },
    { libraryScope: 'outside' },
    { discoverySourceScope: 'selection', discoverySources: 'spotify-search' },
    { discoverySourceScope: 'selection', discoverySources: 'scrobble' },
  ])
    await run.query(routes, scope)
  const invalidQueries: InvalidQuery[] = [
    { filters: [{ field: 'notAField', value: 'x' }] },
    { ranges: [{ field: 'notAField', min: 1 }] },
    { ranges: [{ field: 'title', min: 1 }] },
    { sortBy: 'notAField' },
  ]
  for (const invalid of invalidQueries) await run.query(routes, invalid)

  // A rejected query that also holds an earlier reason in the order of
  // reasons: a libraryPlaylist filter, a catalog scope, a grouped creator
  // scope on Tracks and a creator scope on Films. The earlier reason applies.
  const playlistFilter = {
    field: LIBRARY_PLAYLIST_FILTER_FIELD,
    value: playlistValues[0] ?? absentValue,
  }
  const creatorScope =
    routes.library === 'track'
      ? [{ creatorId: 'artist-aster', groupRecordings: true }]
      : routes.library === 'film'
        ? [{ creatorId: 'artist-delta' }]
        : []
  for (const invalid of invalidQueries) {
    const withPlaylist = {
      ...invalid,
      filters: [playlistFilter, ...(invalid.filters ?? [])],
    }
    await run.query(routes, withPlaylist)
    if (routes.histogram !== undefined && invalid.sortBy === undefined)
      await run.read(
        apiPath(routes.histogram, { period: { kind: 'all' }, ...withPlaylist }),
      )
    await run.query(routes, { ...invalid, libraryScope: 'all' })
    for (const scope of creatorScope)
      await run.query(routes, { ...invalid, ...scope })
  }
  return fields
}

/** Paths that are not Browse reads of `LibrarySource`: the resolver must not map them. */
export const unresolvedPaths = [
  '/api/v1/ai/search?q=calm',
  '/api/v1/subscriptions/browse-page',
  '/api/v1/subscriptions/facets',
  '/api/v1/tracks/track-aurora',
  '/api/v1/albums/album-north',
  '/api/v1/albums/selection',
  '/api/v1/films/film-harbor',
  '/api/v1/playlists/playlist-morning',
  '/api/v1/playlists/playlist-morning/entries',
  '/api/v1/collections/browse-page',
  '/api/v1/tags',
  '/api/v1/people',
  '/api/v1/scrape/jobs',
  '/api/v1/providers',
  '/api/v1/imports',
  '/api/v1/tracks/match-diagnostics/fields',
]

export function unresolved(path: string) {
  return resolveLibraryRead(path) === undefined
}
