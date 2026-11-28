import { z } from 'zod'
import {
  albumBrowseFields,
  albumEditionLabels,
  type BrowseField,
  type BrowseFilter,
  type TagLevels,
} from '@repo/schemas/browse'
import { DeviceAlbumItemSchema } from '@repo/schemas/device'
import {
  defaultListeningPeriod,
  listeningHistogramEdges,
  type ListeningHistogram,
  type ListeningPeriod,
} from '@repo/schemas/listening'
import {
  AlbumListItemSchema,
  type AlbumListeningHistogramQuery,
  type AlbumListItem,
  type AlbumQuery,
} from '@repo/schemas/media'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import type { SqliteExecutor } from '../driver'
import { equalsLabelAsServer, type TextFold } from '../fold'
import type { AlbumListPage, AlbumPage, BrowseCount } from '../source'
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
  listeningHistogram,
  listeningRules,
  periodCount,
  type PlaySource,
} from '../compile/listening'
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
import { FALSE, and, or, readRows, sql, type Sql } from '../compile/sql'
import {
  artistTagRawKeys,
  itemsWithArtistTagKeys,
  itemsWithTags,
  matchingTagNames,
  tagFilterName,
  tagIdsWithKeys,
} from '../compile/tags'
import { unsupported } from '../compile/unsupported'
import { readItems, type DeviceRead } from './read'

/**
 * The Albums library on the device: the field table and the three reads
 * (DEVICE-22, 23, 27). The server's `browseQueries`, browse.ts, defines
 * every rule; comments name the part of the service each piece reproduces.
 */

type AlbumContext = {
  tx: SqliteExecutor
  fold: TextFold
  tagLevels: TagLevels | undefined
}

const column = (expression: Sql): ValueSource => ({
  kind: 'column',
  expression,
})
const stored = (field: string): ValueSource => ({ kind: 'sort', field })
const numeric = (field: string): ValueSource => ({ kind: 'num', field })

/** The Tags sort location as `DeviceTagLocationSchema` writes it. */
function tagLocation(levels: TagLevels | undefined): string {
  return levels === undefined ? 'auto' : levels.join(',')
}

/**
 * The album tag names a filter value resolves to (matchingTagNames) and
 * the album-library tag IDs with those keys (matchingTagIds), music-tags.ts.
 */
async function resolveTag(value: string, context: AlbumContext) {
  const names = await matchingTagNames(
    context.tx,
    tagFilterName(value, context.fold),
    'album',
  )
  return { names, ids: await tagIdsWithKeys(context.tx, names, 'album') }
}

/** matchesValue('artistTag', value, 'album'), browse.ts: mediaIdsWithArtistTag. */
async function artistTagMatch(
  names: readonly string[],
  context: AlbumContext,
): Promise<Sql> {
  return itemsWithArtistTagKeys(
    'album',
    await artistTagRawKeys(context.tx, names),
  )
}

/**
 * matchesValue('genre', value, 'album', levels), browse.ts. Auto: the
 * album's own tags (any hidden state), or its artists' tags when it has
 * fewer than two release tags (albumsWithEnoughTags). Levels:
 * albumIdsWithTag, music-tags.ts, where Track is a library track of the
 * album carrying the tag itself.
 */
async function tagMatch(
  value: string,
  levels: TagLevels | undefined,
  context: AlbumContext,
): Promise<Sql> {
  const { names, ids } = await resolveTag(value, context)
  const release = itemsWithTags('album', 'tagIds', ids)
  if (levels === undefined)
    return or([
      release,
      and([
        await artistTagMatch(names, context),
        sql`t.release_tag_count < ${artistTagFallbackThreshold}`,
      ]),
    ])
  const sets: Sql[] = []
  if (levels.includes('track'))
    sets.push(itemsWithTags('album', 'trackTagIds', ids))
  if (levels.includes('album')) sets.push(release)
  if (levels.includes('artist')) sets.push(await artistTagMatch(names, context))
  return or(sets)
}

const albumFields: FieldTable<AlbumContext> = {
  entity: 'album',
  library: 'album',
  filters: {
    title: textMatch('album', 'title'),
    artist: textMatch('album', 'artist'),
    genre: (value, context) => tagMatch(value, context.tagLevels, context),
    // The release-tag part of the Tags filter only.
    albumTag: (value, context) => tagMatch(value, ['album'], context),
    artistTag: async (value, context) =>
      artistTagMatch((await resolveTag(value, context)).names, context),
    country: textMatch('album', 'country'),
    playlist: textMatch('album', 'playlist'),
    collection: textMatch('album', 'collection'),
    source: textMatch('album', 'source'),
    provider: textMatch('album', 'provider'),
    // matchesValue('edition'): the label, matched with toLowerCase; another value matches nothing.
    edition: (value, context) => {
      if (equalsLabelAsServer(value, albumEditionLabels.edition, context.fold))
        return sql`t.is_edition = 1`
      if (
        equalsLabelAsServer(value, albumEditionLabels.notEdition, context.fold)
      )
        return sql`t.is_edition = 0`
      return FALSE
    },
  },
  ranges: {
    releaseDate: { source: column(sql`t.release_date`), unit: 'date' },
    dateAdded: { source: column(sql`t.date_added`), unit: 'date' },
    durationSec: { source: numeric('durationSec'), unit: 'number' },
    trackCount: { source: numeric('trackCount'), unit: 'number' },
    scrobbles: { source: numeric('scrobbles'), unit: 'number' },
    lastListenedAt: { source: numeric('lastListenedAt'), unit: 'date' },
    scrobblesLast1y: { source: numeric('scrobblesLast1y'), unit: 'number' },
    scrobblesLast5y: { source: numeric('scrobblesLast5y'), unit: 'number' },
    ratingRymValue: { source: numeric('ratingRymValue'), unit: 'number' },
    ratingRymVotes: { source: numeric('ratingRymVotes'), unit: 'number' },
    ratingDiscogsValue: {
      source: numeric('ratingDiscogsValue'),
      unit: 'number',
    },
    ratingDiscogsVotes: {
      source: numeric('ratingDiscogsVotes'),
      unit: 'number',
    },
    ratingMetacriticValue: {
      source: numeric('ratingMetacriticValue'),
      unit: 'number',
    },
    ratingMetacriticVotes: {
      source: numeric('ratingMetacriticVotes'),
      unit: 'number',
    },
    popularityDiscogs: { source: numeric('popularityDiscogs'), unit: 'number' },
    popularitySpotify: { source: numeric('popularitySpotify'), unit: 'number' },
    popularityLastFm: { source: numeric('popularityLastFm'), unit: 'number' },
  },
  sorts: {
    title: column(sql`t.sort_title`),
    artist: column(sql`t.sort_artist`),
    // directSortExpression: albumAddedDateExpression and media_item.release_date.
    dateAdded: column(sql`t.date_added`),
    releaseDate: column(sql`t.release_date`),
    genre: (context) => stored(`genre:${tagLocation(context.tagLevels)}`),
    albumTag: stored('albumTag'),
    artistTag: stored('artistTag'),
    country: stored('country'),
    playlist: stored('playlist'),
    collection: stored('collection'),
    source: stored('source'),
    provider: stored('provider'),
    edition: stored('edition'),
    durationSec: numeric('durationSec'),
    trackCount: numeric('trackCount'),
    scrobbles: numeric('scrobbles'),
    lastListenedAt: numeric('lastListenedAt'),
    scrobblesLast1y: numeric('scrobblesLast1y'),
    scrobblesLast5y: numeric('scrobblesLast5y'),
    ratingRymValue: numeric('ratingRymValue'),
    ratingRymVotes: numeric('ratingRymVotes'),
    ratingDiscogsValue: numeric('ratingDiscogsValue'),
    ratingDiscogsVotes: numeric('ratingDiscogsVotes'),
    ratingMetacriticValue: numeric('ratingMetacriticValue'),
    ratingMetacriticVotes: numeric('ratingMetacriticVotes'),
    popularityDiscogs: numeric('popularityDiscogs'),
    popularitySpotify: numeric('popularitySpotify'),
    popularityLastFm: numeric('popularityLastFm'),
  },
  search: {
    fields: {
      title: { table: 'text', field: 'title' },
      artist: { table: 'text', field: 'artist' },
      albumTag: { table: 'search', field: 'albumTag' },
      artistTag: { table: 'search', field: 'artistTag' },
      country: { table: 'text', field: 'country' },
      playlist: { table: 'text', field: 'playlist' },
      collection: { table: 'text', field: 'collection' },
      source: { table: 'text', field: 'source' },
      provider: { table: 'text', field: 'provider' },
    },
    // browseTextSearchIds leaves these out on Albums.
    unsearched: ['genre', 'edition'],
  },
}

/** Scrobbles linked to album `t`: hasBrowseScrobbles('album'), browse-listening.ts. */
const albumPlays: PlaySource = {
  plays: (where) => sql`FROM play_set ps
    CROSS JOIN album_play p ON p.pid = ps.pid
    WHERE ps.entity = 'album_plays' AND ps.id = t.id AND ${where}`,
  sets: () => sql`FROM play_set ps
    WHERE ps.entity = 'album_plays' AND ps.id = t.id`,
}

type AlbumPlan = {
  /** Every condition on the album rows, listening rules included. */
  where: Sql
  /** The sort period count of row `t`, when a period applies. */
  listening: Sql | undefined
  /** The primary value of row `t`. */
  primary: Sql
  sortBy: string
  direction: AlbumQuery['direction']
}

/**
 * Decides whether the device serves the query and builds its SQL pieces.
 * Every reason to fall through is found before a row of the result is read.
 */
async function planAlbums(
  read: DeviceRead,
  query: AlbumQuery,
): Promise<AlbumPlan> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  const fields: BrowseField[] = await readBrowseFields(read.tx, 'album')
  const table = withPluginFields(albumFields, fields, albumBrowseFields)
  const sortPeriod: ListeningPeriod | undefined =
    query.listeningSort ??
    (query.sortBy === 'listeningScrobbles' ? defaultListeningPeriod : undefined)
  // The `tag` navigation scope is a required Tags filter.
  const tagFilter: BrowseFilter[] = query.tag
    ? [{ field: 'genre', value: query.tag, mode: 'required' }]
    : []
  const filters = [...query.filters, ...tagFilter]
  checkFields(
    table,
    fields,
    { filters, ranges: query.ranges, sortBy: query.sortBy },
    sortPeriod === undefined ? [] : ['listeningScrobbles'],
  )
  await checkPluginTextSort(
    read.tx,
    'album',
    fields,
    albumBrowseFields,
    query.sortBy,
  )
  const words = searchWords(query.q)
  const searched = words.length > 0 ? searchFields(table, fields) : undefined

  const context: AlbumContext = {
    tx: read.tx,
    fold: read.fold,
    tagLevels: query.tagLevels,
  }
  const conditions: Sql[] = []
  if (query.includeArchived !== 'true') conditions.push(sql`t.archived = 0`)
  // An edition is listed under the first album of its record unless asked
  // for, as rows or by an Edition filter in any mode.
  if (
    query.editions !== 'true' &&
    !query.filters.some((filter) => filter.field === 'edition')
  )
    conditions.push(sql`t.is_edition = 0`)
  if (query.creatorId !== undefined)
    conditions.push(sql`t.rid IN (SELECT rid FROM item_credit
      WHERE artist_id = ${query.creatorId} AND entity = 'album' AND role = 'artist')`)
  conditions.push(...(await filterConditions(table, filters, context)))
  for (const range of query.ranges) {
    const spec = table.ranges[range.field]
    if (spec === undefined) return unsupported('unknown-field')
    conditions.push(rangeCondition('album', range, spec))
  }
  if (searched !== undefined)
    conditions.push(...searchConditions('album', words, searched, read.fold))
  const rules = listeningRules(query.listening, (period) =>
    periodCount(albumPlays, period, read.now),
  )
  if (rules !== undefined) conditions.push(rules)

  const sortSpec = table.sorts[query.sortBy]
  const sortSource =
    sortSpec === undefined
      ? undefined
      : typeof sortSpec === 'function'
        ? sortSpec(context)
        : sortSpec
  const primary =
    query.sortBy === 'listeningScrobbles'
      ? sql`t.listening`
      : sortSource === undefined
        ? unsupported('unknown-field')
        : valueExpression('album', sortSource)

  return {
    where: and(conditions),
    listening:
      sortPeriod === undefined
        ? undefined
        : periodCount(albumPlays, sortPeriod, read.now),
    primary,
    sortBy: query.sortBy,
    direction: query.direction,
  }
}

// Statements

/**
 * fieldOrder, browse.ts: the primary value (`title desc` puts nulls first),
 * then the ID. Albums have no natural order.
 */
function albumOrder(plan: AlbumPlan): Sql[] {
  const nulls =
    plan.sortBy === 'title' && plan.direction === 'desc' ? 'first' : 'last'
  return [orderTerm(plan.primary, plan.direction, nulls), sql`t.id ASC`]
}

const PageRowSchema = z.object({
  rid: z.number().int(),
  listening: z.number().int().nonnegative().nullable(),
})
type Row = z.infer<typeof PageRowSchema>
const CountRowSchema = z.object({ total: z.number().int().nonnegative() })

/** Rows of the query's order from `offset`, at most `limit`. */
async function readOrderedRows(
  read: DeviceRead,
  plan: AlbumPlan,
  window: { offset: number; limit: number },
): Promise<Row[]> {
  if (window.limit === 0) return []
  const listening = plan.listening ?? sql`NULL`
  const rows = await readRows(
    read.tx,
    sql`SELECT t.rid AS rid, t.listening AS listening
      FROM (SELECT t.*, ${listening} AS listening FROM album t WHERE ${plan.where}) t
      ${orderBy(albumOrder(plan))} LIMIT ${window.limit} OFFSET ${window.offset}`,
  )
  return rows.map((row) => PageRowSchema.parse(row))
}

async function readTotal(read: DeviceRead, plan: AlbumPlan): Promise<number> {
  const [row] = await readRows(
    read.tx,
    sql`SELECT count(*) AS total FROM album t WHERE ${plan.where}`,
  )
  return CountRowSchema.parse(row).total
}

/** loadAlbums, media.ts: the stored item, with the period count when a sort period applies. */
async function albumItems(
  read: DeviceRead,
  plan: AlbumPlan,
  rows: readonly Row[],
): Promise<AlbumListItem[]> {
  const items = await readItems(
    read.tx,
    'album',
    rows.map((row) => row.rid),
  )
  return rows.map((row) => {
    const item = DeviceAlbumItemSchema.parse(items.get(row.rid))
    return AlbumListItemSchema.parse(
      plan.listening === undefined
        ? item
        : { ...item, listeningScrobbles: row.listening ?? 0 },
    )
  })
}

/**
 * unfilteredBrowseQuery, browse.ts: the query Clear filters leaves, or null
 * when nothing is filtered. The archived and edition toggles and the tag
 * scope stay.
 */
function unfilteredQuery(query: AlbumQuery): AlbumQuery | null {
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
    listening: undefined,
  }
}

// Reads

/** `GET /albums/browse-page`: queryBrowsePageIds and listAlbumBrowsePage. */
export async function albumPage(
  read: DeviceRead,
  query: AlbumQuery,
): Promise<AlbumPage> {
  const plan = await planAlbums(read, query)
  const window = pageWindow(query)
  const rows = window === null ? [] : await readOrderedRows(read, plan, window)
  return {
    items: await albumItems(read, plan, rows.slice(0, query.size)),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

/** `GET /albums/browse-count`: queryBrowseCounts. */
export async function albumCount(
  read: DeviceRead,
  query: AlbumQuery,
): Promise<BrowseCount> {
  const plan = await planAlbums(read, query)
  const total = await readTotal(read, plan)
  const unfiltered = unfilteredQuery(query)
  const unfilteredCount =
    unfiltered === null
      ? total
      : await readTotal(read, await planAlbums(read, unfiltered))
  return { totalCount: capCount(total, query.limitResults), unfilteredCount }
}

const HistogramRowSchema = z.object({
  listening: z.number().int().nonnegative(),
  count: z.number().int().positive(),
})

/**
 * `GET /albums/listening-histogram`: queryListeningHistogram('album'),
 * browse.ts. The query without its listening rules and result cap, with
 * the period as its sort period; how many albums fall in each bar of
 * their scrobble count in the period. A bar holds the counts from its edge
 * up to the next edge; bars without albums count zero.
 */
export async function albumHistogram(
  read: DeviceRead,
  { period, ...query }: AlbumListeningHistogramQuery,
): Promise<ListeningHistogram> {
  const plan = await planAlbums(read, {
    ...query,
    listening: undefined,
    listeningSort: period,
    sortBy: 'listeningScrobbles',
    limitResults: undefined,
    page: 1,
  })
  const listening = plan.listening ?? unsupported('invalid-query')
  const rows = await readRows(
    read.tx,
    sql`SELECT ${listening} AS listening, count(*) AS count
      FROM album t WHERE ${plan.where} GROUP BY 1`,
  )
  return listeningHistogram(
    listeningHistogramEdges.album,
    rows.map((row) => HistogramRowSchema.parse(row)),
  )
}

/** `GET /albums/`: queryBrowseIds and listAlbums. */
export async function albumList(
  read: DeviceRead,
  query: AlbumQuery,
): Promise<AlbumListPage> {
  const plan = await planAlbums(read, query)
  const totalCount = capCount(await readTotal(read, plan), query.limitResults)
  const rows = await readOrderedRows(read, plan, listWindow(query, totalCount))
  return {
    page: query.page,
    size: query.size,
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
    items: await albumItems(read, plan, rows),
  }
}
