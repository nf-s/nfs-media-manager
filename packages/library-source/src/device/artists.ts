import { z } from 'zod'
import type { BrowseField } from '@repo/schemas/browse'
import {
  ArtistSummarySchema,
  type ArtistQuery,
  type ArtistSummary,
} from '@repo/schemas/creators'
import {
  DeviceArtistItemSchema,
  DeviceMetaRowSchema,
} from '@repo/schemas/device'
import {
  defaultListeningPeriod,
  monthKeys,
  type ListeningPeriod,
} from '@repo/schemas/listening'
import type { SqliteExecutor } from '../driver'
import type { ArtistPage, BrowseCount } from '../source'
import {
  checkFields,
  filterConditions,
  rangeCondition,
  readBrowseFields,
  searchFields,
  textMatch,
  valueExpression,
  type FieldTable,
  type ValueSource,
} from '../compile/fields'
import {
  listeningRules,
  periodCount,
  type PlaySource,
} from '../compile/listening'
import {
  capCount,
  isMemberScope,
  orderBy,
  orderTerm,
  pageWindow,
} from '../compile/query'
import { searchConditions, searchWords } from '../compile/search'
import { and, readRows, sql, values, type Sql } from '../compile/sql'
import {
  itemsWithArtistTagKeys,
  matchingTagNames,
  tagFilterName,
} from '../compile/tags'
import { unsupported } from '../compile/unsupported'
import { readItems, type DeviceRead } from './read'

/**
 * The Artists library on the device: the field table and the page and count
 * reads. The server's artist-browse.ts defines every rule (membership,
 * ordering, artistBrowseCounts, loadArtists); comments name the part of the
 * service each piece reproduces. The device holds the member artists of the
 * library scope only.
 */

type ArtistContext = { tx: SqliteExecutor }

const column = (expression: Sql): ValueSource => ({
  kind: 'column',
  expression,
})
const stored = (field: string): ValueSource => ({ kind: 'sort', field })
const numeric = (field: string): ValueSource => ({ kind: 'num', field })

const artistFields: FieldTable<ArtistContext> = {
  entity: 'artist',
  library: 'artist',
  // textMatchRows(field, value), artist-browse.ts: `value ILIKE` the escaped
  // value, a case-insensitive equality on the field's rows.
  filters: {
    name: textMatch('artist', 'name'),
    playlist: textMatch('artist', 'playlist'),
    // A raw snapshot tag whose normalised key is among matchingTagNames(value, 'album').
    genre: async (value, context) =>
      itemsWithArtistTagKeys(
        'artist',
        await matchingTagNames(context.tx, tagFilterName(value), 'album'),
      ),
    country: textMatch('artist', 'country'),
    type: textMatch('artist', 'type'),
    provider: textMatch('artist', 'provider'),
  },
  // numericValue(field), artist-browse.ts. The counts are coalesced to zero
  // and include credited items outside the library.
  ranges: {
    createdAt: { source: column(sql`t.created_at`), unit: 'date' },
    albumCount: { source: numeric('albumCount'), unit: 'number' },
    trackCount: { source: numeric('trackCount'), unit: 'number' },
    scrobbles: { source: column(sql`t.scrobbles`), unit: 'number' },
    playlistCount: { source: numeric('playlistCount'), unit: 'number' },
  },
  // ordering(query), artist-browse.ts.
  sorts: {
    name: column(sql`t.sort_name`),
    playlist: stored('playlist'),
    genre: stored('genre'),
    country: stored('country'),
    type: stored('type'),
    provider: stored('provider'),
    createdAt: column(sql`t.created_at`),
    albumCount: numeric('albumCount'),
    trackCount: numeric('trackCount'),
    scrobbles: column(sql`t.scrobbles`),
    playlistCount: numeric('playlistCount'),
  },
  // membership `q`, artist-browse.ts: every text field by substring, and
  // `artist.sort_name`, which `search.name` holds with the name.
  search: {
    fields: {
      name: { table: 'search', field: 'name' },
      playlist: { table: 'text', field: 'playlist' },
      genre: { table: 'text', field: 'genre' },
      country: { table: 'text', field: 'country' },
      type: { table: 'text', field: 'type' },
      provider: { table: 'text', field: 'provider' },
    },
    unsearched: [],
  },
}

/** artistScrobbles, artist-browse.ts: the artist's attributed scrobbles, each once. */
const artistPlays: PlaySource = {
  plays: (where) => sql`FROM play_set ps
    CROSS JOIN artist_play p ON p.pid = ps.pid
    WHERE ps.entity = 'artist_plays' AND ps.id = t.id AND ${where}`,
  sets: () => sql`FROM play_set ps
    WHERE ps.entity = 'artist_plays' AND ps.id = t.id`,
}

type PlanOptions = {
  /** The read returns list items, which carry links for a non-exclude Provider filter. */
  returnsItems: boolean
}

type ArtistPlan = {
  /** Membership, filters, ranges, search, playlists and listening rules on `artist t`. */
  where: Sql
  /** The sort period count of row `t`, when a period applies. */
  listening: Sql | undefined
  /** The primary value of row `t`. */
  primary: Sql
  direction: ArtistQuery['direction']
}

/** listeningSortPeriod, artist-browse.ts. */
function sortPeriodOf(query: ArtistQuery): ListeningPeriod | undefined {
  return (
    query.listeningSort ??
    (query.sortBy === 'listeningScrobbles' ? defaultListeningPeriod : undefined)
  )
}

/**
 * Decides whether the device serves the query and builds its SQL pieces, as
 * membership and ordering, artist-browse.ts, do.
 */
async function planArtists(
  read: DeviceRead,
  query: ArtistQuery,
  options: PlanOptions,
): Promise<ArtistPlan> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  const fields: BrowseField[] = await readBrowseFields(read.tx, 'artist')
  checkFields(artistFields, fields, query, ['listeningScrobbles'])
  // loadArtists adds `links` for selectedBrowseProviders(filters).
  if (
    options.returnsItems &&
    query.filters.some(
      (filter) => filter.field === 'provider' && filter.mode !== 'exclude',
    )
  )
    unsupported('provider-filter')
  const words = searchWords(query.q)
  const searched =
    words.length > 0 ? searchFields(artistFields, fields) : undefined

  const context: ArtistContext = { tx: read.tx }
  const conditions: Sql[] = []
  if (query.playlistIds.length > 0)
    conditions.push(sql`t.rid IN (SELECT rid FROM item_playlist
      WHERE entity = 'artist' AND playlist_id IN ${values(query.playlistIds)})`)
  if (searched !== undefined)
    conditions.push(...searchConditions('artist', words, searched))
  conditions.push(
    ...(await filterConditions(artistFields, query.filters, context)),
  )
  for (const range of query.ranges) {
    const spec = artistFields.ranges[range.field]
    if (spec === undefined) return unsupported('unknown-field')
    conditions.push(rangeCondition('artist', range, spec))
  }
  const count = (period: ListeningPeriod) =>
    periodCount(artistPlays, period, read.now)
  const rules = listeningRules(query.listening, count)
  if (rules !== undefined) conditions.push(rules)

  const sortPeriod = sortPeriodOf(query)
  const sortSpec = artistFields.sorts[query.sortBy]
  const primary =
    query.sortBy === 'listeningScrobbles'
      ? sql`t.listening`
      : sortSpec === undefined
        ? unsupported('unknown-field')
        : valueExpression(
            'artist',
            typeof sortSpec === 'function' ? sortSpec(context) : sortSpec,
          )
  return {
    where: and(conditions),
    listening: sortPeriod === undefined ? undefined : count(sortPeriod),
    primary,
    direction: query.direction,
  }
}

const PageRowSchema = z.object({
  rid: z.number().int(),
  listening: z.number().int().nonnegative().nullable(),
})
type PageRow = z.infer<typeof PageRowSchema>
const CountRowSchema = z.object({ total: z.number().int().nonnegative() })

/** Rows in the query's order (`value dir NULLS LAST, a.id ASC`) from `offset`, at most `limit`. */
async function readOrderedRows(
  read: DeviceRead,
  plan: ArtistPlan,
  window: { offset: number; limit: number },
): Promise<PageRow[]> {
  const listening = plan.listening ?? sql`NULL`
  const rows = await readRows(
    read.tx,
    sql`SELECT t.rid AS rid, t.listening AS listening
      FROM (SELECT t.*, ${listening} AS listening FROM artist t WHERE ${plan.where}) t
      ${orderBy([orderTerm(plan.primary, plan.direction), sql`t.id ASC`])}
      LIMIT ${window.limit} OFFSET ${window.offset}`,
  )
  return rows.map((row) => PageRowSchema.parse(row))
}

async function readTotal(read: DeviceRead, plan: ArtistPlan): Promise<number> {
  const [row] = await readRows(
    read.tx,
    sql`SELECT count(*) AS total FROM artist t WHERE ${plan.where}`,
  )
  return CountRowSchema.parse(row).total
}

const MetaValueSchema = z.object({ value: z.string() })
const MonthRowSchema = z.object({
  id: z.string(),
  month: z.string(),
  count: z.number().int().positive(),
})

/**
 * loadArtistListening, artist-browse.ts: each artist's scrobbles per UTC
 * month, from the month of `listeningHistoryStart` (the current date without
 * one) to the current month, zero for a month without scrobbles.
 */
async function listeningMonths(
  read: DeviceRead,
  ids: readonly string[],
): Promise<Map<string, number[]>> {
  if (ids.length === 0) return new Map()
  const [meta] = await readRows(
    read.tx,
    sql`SELECT value FROM meta WHERE id = 'listening'`,
  )
  if (meta === undefined) return unsupported('not-ready')
  const parsed = DeviceMetaRowSchema.parse(
    JSON.parse(MetaValueSchema.parse(meta).value),
  )
  if (parsed.kind !== 'listening') return unsupported('store-error')
  const keys = monthKeys(
    parsed.historyStart ?? read.now.toISOString().slice(0, 10),
    read.now,
  )
  const index = new Map(keys.map((key, position) => [key, position]))
  const listening = new Map(ids.map((id) => [id, keys.map(() => 0)]))
  const rows = await readRows(
    read.tx,
    sql`SELECT ps.id AS id, strftime('%Y-%m', p.played_at, 'unixepoch') AS month,
        count(*) AS count
      FROM play_set ps CROSS JOIN artist_play p ON p.pid = ps.pid
      WHERE ps.entity = 'artist_plays' AND ps.id IN ${values(ids)}
      GROUP BY 1, 2`,
  )
  for (const row of rows) {
    const { id, month, count } = MonthRowSchema.parse(row)
    const months = listening.get(id)
    const position = index.get(month)
    if (months !== undefined && position !== undefined) months[position] = count
  }
  return listening
}

/**
 * The list items of the rows, in order, as loadArtists, artist-browse.ts,
 * returns them for a Browse page: the stored item with its listening months,
 * and the period count when a sort period applies.
 */
async function artistItems(
  read: DeviceRead,
  plan: ArtistPlan,
  rows: readonly PageRow[],
): Promise<ArtistSummary[]> {
  const stored = await readItems(
    read.tx,
    'artist',
    rows.map((row) => row.rid),
  )
  const items = rows.map((row) => ({
    row,
    item: DeviceArtistItemSchema.parse(stored.get(row.rid)),
  }))
  const months = await listeningMonths(
    read,
    items.map(({ item }) => item.id),
  )
  return items.map(({ row, item }) =>
    ArtistSummarySchema.parse({
      ...item,
      ...(plan.listening === undefined
        ? {}
        : { listeningScrobbles: row.listening ?? 0 }),
      listeningMonths: months.get(item.id) ?? [],
    }),
  )
}

/** artistBrowseCounts, artist-browse.ts: whether Clear filters changes the query. */
function isFiltered(query: ArtistQuery): boolean {
  return (
    Boolean(query.q) ||
    query.filters.length > 0 ||
    query.ranges.length > 0 ||
    query.playlistIds.length > 0 ||
    query.listening !== undefined
  )
}

// Reads

/** `GET /artists/browse-page`: readArtistBrowsePage and listArtistBrowsePage. */
export async function artistPage(
  read: DeviceRead,
  query: ArtistQuery,
): Promise<ArtistPage> {
  const plan = await planArtists(read, query, { returnsItems: true })
  const window = pageWindow(query)
  const rows = window === null ? [] : await readOrderedRows(read, plan, window)
  return {
    items: await artistItems(read, plan, rows.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

/**
 * `GET /artists/browse-count`: artistBrowseCounts. The total with the
 * listening rules (not the sort period), capped by `limitResults`; the
 * unfiltered count drops search, filters, ranges, playlists and rules.
 */
export async function artistCount(
  read: DeviceRead,
  query: ArtistQuery,
): Promise<BrowseCount> {
  const plan = await planArtists(read, query, { returnsItems: false })
  const total = await readTotal(read, plan)
  const unfilteredCount = isFiltered(query)
    ? await readTotal(
        read,
        await planArtists(
          read,
          {
            ...query,
            q: undefined,
            filters: [],
            ranges: [],
            playlistIds: [],
            limitResults: undefined,
            listening: undefined,
          },
          { returnsItems: false },
        ),
      )
    : total
  return { totalCount: capCount(total, query.limitResults), unfilteredCount }
}
