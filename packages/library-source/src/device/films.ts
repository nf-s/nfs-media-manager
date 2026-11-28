import { z } from 'zod'
import {
  filmBrowseFields,
  type BrowseField,
  type BrowseFilter,
} from '@repo/schemas/browse'
import { DeviceFilmItemSchema } from '@repo/schemas/device'
import {
  FilmListItemSchema,
  type FilmListItem,
  type FilmQuery,
} from '@repo/schemas/media'
import type { SqliteExecutor } from '../driver'
import type { BrowseCount, FilmListPage, FilmPage } from '../source'
import {
  checkFields,
  filterConditions,
  rangeCondition,
  readBrowseFields,
  searchFields,
  textMatch,
  valueExpression,
  type FieldTable,
  type RangeSpec,
  type ValueSource,
} from '../compile/fields'
import { checkPluginTextSort, withPluginFields } from '../compile/plugin-fields'
import {
  capCount,
  isMemberScope,
  listWindow,
  orderBy,
  orderTerm,
  pageWindow,
} from '../compile/query'
import { searchConditions, searchWords } from '../compile/search'
import { and, readRows, sql, type Sql } from '../compile/sql'
import {
  itemsWithTags,
  matchingTagNames,
  tagFilterName,
  tagIdsWithKeys,
} from '../compile/tags'
import { unsupported } from '../compile/unsupported'
import { readItems, type DeviceRead } from './read'

/**
 * The Films library on the device: the field table and the three reads
 * (DEVICE-22, 27). The server's `browseQueries`, browse.ts, defines every
 * rule; comments name the part of the service each piece reproduces.
 * Films have no listening controls: the query schema rejects them.
 */

type FilmContext = { tx: SqliteExecutor }

const column = (expression: Sql): ValueSource => ({
  kind: 'column',
  expression,
})
const stored = (field: string): ValueSource => ({ kind: 'sort', field })
const numeric = (field: string): ValueSource => ({ kind: 'num', field })

/** A number range read from `item_num`. */
const numberRange = (field: string): RangeSpec => ({
  source: numeric(field),
  unit: 'number',
})

/**
 * matchesValue('genre', value, 'film'), browse.ts: a film tag (any hidden
 * state) whose key is one of matchingTagNames(value, 'film'). Films have no
 * tag levels and no artist fallback.
 */
async function tagMatch(value: string, context: FilmContext): Promise<Sql> {
  const names = await matchingTagNames(context.tx, tagFilterName(value), 'film')
  return itemsWithTags(
    'film',
    'tagIds',
    await tagIdsWithKeys(context.tx, names, 'film'),
  )
}

const filmFields: FieldTable<FilmContext> = {
  entity: 'film',
  library: 'film',
  filters: {
    summary: textMatch('film', 'summary'),
    title: textMatch('film', 'title'),
    director: textMatch('film', 'director'),
    actor: textMatch('film', 'actor'),
    writer: textMatch('film', 'writer'),
    genre: (value, context) => tagMatch(value, context),
    country: textMatch('film', 'country'),
    language: textMatch('film', 'language'),
    productionCompany: textMatch('film', 'productionCompany'),
    awards: textMatch('film', 'awards'),
    collection: textMatch('film', 'collection'),
    playlist: textMatch('film', 'playlist'),
    source: textMatch('film', 'source'),
    watched: textMatch('film', 'watched'),
    identification: textMatch('film', 'identification'),
    provider: textMatch('film', 'provider'),
  },
  ranges: {
    releaseDate: { source: column(sql`t.release_date`), unit: 'date' },
    dateAdded: { source: column(sql`t.date_added`), unit: 'date' },
    updatedAt: { source: numeric('updatedAt'), unit: 'date' },
    ratingImdbPersonalDate: {
      source: numeric('ratingImdbPersonalDate'),
      unit: 'date',
    },
    runtimeMinutes: numberRange('runtimeMinutes'),
    budget: numberRange('budget'),
    boxOffice: numberRange('boxOffice'),
    ratingImdbPersonal: numberRange('ratingImdbPersonal'),
    ratingImdbValue: numberRange('ratingImdbValue'),
    ratingImdbVotes: numberRange('ratingImdbVotes'),
    ratingMetascore: numberRange('ratingMetascore'),
    ratingTmdbValue: numberRange('ratingTmdbValue'),
    ratingTmdbVotes: numberRange('ratingTmdbVotes'),
    popularityTmdb: numberRange('popularityTmdb'),
    ratingRt: numberRange('ratingRt'),
    ratingMetacriticUser: numberRange('ratingMetacriticUser'),
    ratingMetacriticUserVotes: numberRange('ratingMetacriticUserVotes'),
    ratingTrakt: numberRange('ratingTrakt'),
    ratingTraktVotes: numberRange('ratingTraktVotes'),
    ratingLetterboxd: numberRange('ratingLetterboxd'),
    ratingLetterboxdVotes: numberRange('ratingLetterboxdVotes'),
    ratingRtAudience: numberRange('ratingRtAudience'),
    ratingRtAudienceVotes: numberRange('ratingRtAudienceVotes'),
  },
  sorts: {
    title: column(sql`t.sort_title`),
    // directSortExpression('releaseDate', 'film'): media_item.release_date.
    releaseDate: column(sql`t.release_date`),
    // numericExpression('dateAdded', 'film'): coalesce(film.date_added, created_at).
    dateAdded: column(sql`t.date_added`),
    updatedAt: numeric('updatedAt'),
    ratingImdbPersonalDate: numeric('ratingImdbPersonalDate'),
    summary: stored('summary'),
    director: stored('director'),
    actor: stored('actor'),
    writer: stored('writer'),
    genre: stored('genre'),
    country: stored('country'),
    language: stored('language'),
    productionCompany: stored('productionCompany'),
    awards: stored('awards'),
    collection: stored('collection'),
    playlist: stored('playlist'),
    source: stored('source'),
    watched: stored('watched'),
    identification: stored('identification'),
    provider: stored('provider'),
    runtimeMinutes: numeric('runtimeMinutes'),
    budget: numeric('budget'),
    boxOffice: numeric('boxOffice'),
    ratingImdbPersonal: numeric('ratingImdbPersonal'),
    ratingImdbValue: numeric('ratingImdbValue'),
    ratingImdbVotes: numeric('ratingImdbVotes'),
    ratingMetascore: numeric('ratingMetascore'),
    ratingTmdbValue: numeric('ratingTmdbValue'),
    ratingTmdbVotes: numeric('ratingTmdbVotes'),
    popularityTmdb: numeric('popularityTmdb'),
    ratingRt: numeric('ratingRt'),
    ratingMetacriticUser: numeric('ratingMetacriticUser'),
    ratingMetacriticUserVotes: numeric('ratingMetacriticUserVotes'),
    ratingTrakt: numeric('ratingTrakt'),
    ratingTraktVotes: numeric('ratingTraktVotes'),
    ratingLetterboxd: numeric('ratingLetterboxd'),
    ratingLetterboxdVotes: numeric('ratingLetterboxdVotes'),
    ratingRtAudience: numeric('ratingRtAudience'),
    ratingRtAudienceVotes: numeric('ratingRtAudienceVotes'),
  },
  search: {
    // browseTextSearchIds searches every Films text field, filterable or not.
    fields: {
      summary: { table: 'text', field: 'summary' },
      title: { table: 'text', field: 'title' },
      director: { table: 'text', field: 'director' },
      actor: { table: 'text', field: 'actor' },
      writer: { table: 'text', field: 'writer' },
      genre: { table: 'search', field: 'genre' },
      country: { table: 'text', field: 'country' },
      language: { table: 'text', field: 'language' },
      productionCompany: { table: 'text', field: 'productionCompany' },
      awards: { table: 'text', field: 'awards' },
      collection: { table: 'text', field: 'collection' },
      playlist: { table: 'text', field: 'playlist' },
      source: { table: 'text', field: 'source' },
      watched: { table: 'text', field: 'watched' },
      identification: { table: 'text', field: 'identification' },
      provider: { table: 'text', field: 'provider' },
    },
    unsearched: [],
  },
}

type FilmPlan = {
  /** Every condition on the film rows. */
  where: Sql
  /** The primary value of row `t`. */
  primary: Sql
  sortBy: string
  direction: FilmQuery['direction']
}

/**
 * Decides whether the device serves the query and builds its SQL pieces.
 * Every reason to fall through is found before a row of the result is read.
 */
async function planFilms(
  read: DeviceRead,
  query: FilmQuery,
): Promise<FilmPlan> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  // browseQueries: the API answers listening controls on Films with an error.
  if (query.listening !== undefined || query.listeningSort !== undefined)
    unsupported('invalid-query')
  // A creator scope also takes films whose catalog observations name the
  // person, in every scope; the device holds no catalog observations.
  if (query.creatorId !== undefined) unsupported('creator-films')
  const fields: BrowseField[] = await readBrowseFields(read.tx, 'film')
  const table = withPluginFields(filmFields, fields, filmBrowseFields)
  // The `tag` navigation scope is a required Tags filter.
  const tagFilter: BrowseFilter[] = query.tag
    ? [{ field: 'genre', value: query.tag, mode: 'required' }]
    : []
  const filters = [...query.filters, ...tagFilter]
  checkFields(table, fields, {
    filters,
    ranges: query.ranges,
    sortBy: query.sortBy,
  })
  await checkPluginTextSort(
    read.tx,
    'film',
    fields,
    filmBrowseFields,
    query.sortBy,
  )
  const words = searchWords(query.q)
  const searched = words.length > 0 ? searchFields(table, fields) : undefined

  const context: FilmContext = { tx: read.tx }
  const conditions: Sql[] = []
  if (query.includeArchived !== 'true') conditions.push(sql`t.archived = 0`)
  if (query.sourceKind)
    conditions.push(sql`t.source_kind = ${query.sourceKind}`)
  conditions.push(...(await filterConditions(table, filters, context)))
  for (const range of query.ranges) {
    const spec = table.ranges[range.field]
    if (spec === undefined) return unsupported('unknown-field')
    conditions.push(rangeCondition('film', range, spec))
  }
  if (searched !== undefined)
    conditions.push(...searchConditions('film', words, searched))

  const sortSpec = table.sorts[query.sortBy]
  const sortSource =
    sortSpec === undefined
      ? undefined
      : typeof sortSpec === 'function'
        ? sortSpec(context)
        : sortSpec
  if (sortSource === undefined) return unsupported('unknown-field')

  return {
    where: and(conditions),
    primary: valueExpression('film', sortSource),
    sortBy: query.sortBy,
    direction: query.direction,
  }
}

// Statements

/**
 * fieldOrder, browse.ts: the primary value (`title desc` puts nulls first),
 * then the ID. Films have no natural order.
 */
function filmOrder(plan: FilmPlan): Sql[] {
  const nulls =
    plan.sortBy === 'title' && plan.direction === 'desc' ? 'first' : 'last'
  return [orderTerm(plan.primary, plan.direction, nulls), sql`t.id ASC`]
}

const PageRowSchema = z.object({ rid: z.number().int() })
type Row = z.infer<typeof PageRowSchema>
const CountRowSchema = z.object({ total: z.number().int().nonnegative() })

/** Rows of the query's order from `offset`, at most `limit`. */
async function readOrderedRows(
  read: DeviceRead,
  plan: FilmPlan,
  window: { offset: number; limit: number },
): Promise<Row[]> {
  if (window.limit === 0) return []
  const rows = await readRows(
    read.tx,
    sql`SELECT t.rid AS rid FROM film t WHERE ${plan.where}
      ${orderBy(filmOrder(plan))} LIMIT ${window.limit} OFFSET ${window.offset}`,
  )
  return rows.map((row) => PageRowSchema.parse(row))
}

async function readTotal(read: DeviceRead, plan: FilmPlan): Promise<number> {
  const [row] = await readRows(
    read.tx,
    sql`SELECT count(*) AS total FROM film t WHERE ${plan.where}`,
  )
  return CountRowSchema.parse(row).total
}

/** loadFilms, media.ts: the stored item. */
async function filmItems(
  read: DeviceRead,
  rows: readonly Row[],
): Promise<FilmListItem[]> {
  const items = await readItems(
    read.tx,
    'film',
    rows.map((row) => row.rid),
  )
  return rows.map((row) =>
    FilmListItemSchema.parse(DeviceFilmItemSchema.parse(items.get(row.rid))),
  )
}

/**
 * unfilteredBrowseQuery, browse.ts: the query Clear filters leaves, or null
 * when nothing is filtered. The archived toggle, the source kind and the
 * tag scope stay.
 */
function unfilteredQuery(query: FilmQuery): FilmQuery | null {
  const filtered =
    Boolean(query.q) ||
    query.filters.length > 0 ||
    query.ranges.length > 0 ||
    query.creatorId !== undefined ||
    query.listening !== undefined
  if (!filtered) return null
  return {
    ...query,
    q: undefined,
    filters: [],
    ranges: [],
    limitResults: undefined,
    creatorId: undefined,
    creatorRole: undefined,
    listening: undefined,
  }
}

// Reads

/** `GET /films/browse-page`: queryBrowsePageIds and listFilmBrowsePage. */
export async function filmPage(
  read: DeviceRead,
  query: FilmQuery,
): Promise<FilmPage> {
  const plan = await planFilms(read, query)
  const window = pageWindow(query)
  const rows = window === null ? [] : await readOrderedRows(read, plan, window)
  return {
    items: await filmItems(read, rows.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

/** `GET /films/browse-count`: queryBrowseCounts. */
export async function filmCount(
  read: DeviceRead,
  query: FilmQuery,
): Promise<BrowseCount> {
  const plan = await planFilms(read, query)
  const total = await readTotal(read, plan)
  const unfiltered = unfilteredQuery(query)
  const unfilteredCount =
    unfiltered === null
      ? total
      : await readTotal(read, await planFilms(read, unfiltered))
  return { totalCount: capCount(total, query.limitResults), unfilteredCount }
}

/** `GET /films/`: queryBrowseIds and listFilms. */
export async function filmList(
  read: DeviceRead,
  query: FilmQuery,
): Promise<FilmListPage> {
  const plan = await planFilms(read, query)
  const totalCount = capCount(await readTotal(read, plan), query.limitResults)
  const rows = await readOrderedRows(read, plan, listWindow(query, totalCount))
  return {
    page: query.page,
    size: query.size,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
    items: await filmItems(read, rows),
  }
}
