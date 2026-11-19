import { and, sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { type BrowseFilter } from '@repo/schemas/browse'
import type { ArtistMixQuery } from '@repo/schemas/creators'
import {
  MatchDiagnosticsPageSchema,
  type MatchDiagnosticsQuery,
} from '@repo/schemas/match-diagnostics'
import {
  SubscriptionFacetQuerySchema,
  SubscriptionItemIdSchema,
  SubscriptionItemPageSchema,
  SubscriptionItemSchema,
  SubscriptionProviderSchema,
  SubscriptionPublishedPrecisionSchema,
  SubscriptionRangeFieldSchema,
  SubscriptionSourceDetailSchema,
  SubscriptionSourceIdSchema,
  SubscriptionSourceListSchema,
  SubscriptionSourceQuerySchema,
  SubscriptionTextFieldSchema,
  SubscriptionTypeSchema,
  subscriptionBrowseFieldsFor,
  subscriptionItemUrl,
  subscriptionLibraryHasRange,
  subscriptionLibraryHasSort,
  subscriptionLibraryHasTextFilter,
  subscriptionLibraryOf,
  subscriptionLibraryTypes,
  subscriptionSourceUrl,
  subscriptionTypeLabels,
  type SubscriptionFacetQuery,
  type SubscriptionItem,
  type SubscriptionItemPage,
  type SubscriptionItemPatch,
  type SubscriptionItemQuery,
  type SubscriptionLibrary,
  type SubscriptionSort,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { ServerError } from '@/lib/error'
import { visibleArtist } from './entity-relationships'
import { matchingTagNames } from './music-tags'
import { normalizedTagSql, normalizeTagName } from './tag-state'

// Every query reads stored rows only and makes no provider requests. In SQL,
// `i` is a subscription_item and `s` its subscription_source. A row belongs
// to the library of its type; lists, counts and facets read one library.

/**
 * Title (A), source title and tags (B), description (D): English stems for
 * word forms, then the same fields unstemmed for partial words. A mix's billed
 * artists go with its tags, so search and the artist lookups find them.
 * Migration 0021 rebuilt stored YouTube rows with the same expression.
 */
export function subscriptionSearchVector(
  title: SQL,
  sourceTitle: SQL,
  tags: SQL,
  description: SQL,
) {
  return sql`setweight(to_tsvector('english', ${title}), 'A') ||
    setweight(to_tsvector('english', ${sourceTitle} || ' ' || ${tags}), 'B') ||
    setweight(to_tsvector('english', ${description}), 'D') ||
    setweight(to_tsvector('simple', ${title}), 'A') ||
    setweight(to_tsvector('simple', ${sourceTitle} || ' ' || ${tags}), 'B') ||
    setweight(to_tsvector('simple', ${description}), 'D')`
}

const isoSeconds = (value: number | null) =>
  value === null ? null : new Date(value * 1000).toISOString()

/** The row's type is one of the library's. */
export function inSubscriptionLibrary(type: SQL, library: SubscriptionLibrary) {
  return sql`${type} in (${sql.join(
    subscriptionLibraryTypes[library].map((value) => sql`${value}`),
    sql`, `,
  )})`
}

/** Compares names ignoring case and surrounding spaces. */
const nameKey = (value: SQL) => sql`lower(btrim(${value}))`

const CountSchema = z.coerce.number().nullable()

type SearchTerm = { text: string; phrase: boolean; exclude: boolean }

// An optional run of dashes, then a quoted phrase (an unclosed quote runs to
// the end) or a word.
const SEARCH_TOKEN = /(-*)(?:"([^"]*)"?|([^\s"]+))/g
const WORD_PARTS = /[\p{L}\p{M}\p{N}]+/gu

/**
 * Reads web-search syntax as `websearch_to_tsquery` does: groups separated by
 * `or`, matched if any group matches, each holding terms that must all match.
 */
function searchGroups(text: string) {
  let group: SearchTerm[] = []
  const groups = [group]
  for (const [, dashes, phrase, word] of text.matchAll(SEARCH_TOKEN)) {
    if (phrase === undefined && !dashes && word?.toLowerCase() === 'or') {
      group = []
      groups.push(group)
    } else
      group.push({
        text: phrase ?? word ?? '',
        phrase: phrase !== undefined,
        exclude: Boolean(dashes),
      })
  }
  return groups.filter((terms) => terms.length)
}

/**
 * A phrase matches its English stems in order. A word matches its English
 * stem or the start of an unstemmed stored word, so `depressio` finds
 * "depression"; a stop word matches nothing. Operator characters in the text
 * are never read as tsquery syntax: the text is a parameter, and each prefix
 * holds only letters, marks and digits.
 */
function termQuery({ text, phrase }: SearchTerm) {
  const stems = sql`phraseto_tsquery('english', ${text})`
  const parts = phrase ? [] : (text.match(WORD_PARTS) ?? [])
  if (!parts.length) return stems
  const prefix = sql.join(
    parts.map((part) => sql`to_tsquery('simple', ${`${part}:*`})`),
    sql` <-> `,
  )
  return sql`case when numnode(${stems}) = 0 then ${stems} else ${stems} || (${prefix}) end`
}

/** The tsquery for a search, or null when it has no terms. */
function searchQuery(text: string) {
  const groups = searchGroups(text).map(
    (terms) =>
      sql`(${sql.join(
        terms.map((term) =>
          term.exclude
            ? sql`!!(${termQuery(term)})`
            : sql`(${termQuery(term)})`,
        ),
        sql` && `,
      )})`,
  )
  return groups.length ? sql`(${sql.join(groups, sql` || `)})` : null
}

const LexemeRowsSchema = z.array(z.object({ nodes: z.coerce.number() }))
const TotalRowsSchema = z.array(z.object({ total: z.coerce.number() }))
const countCache = createDatabaseReadCache<number>({
  maxEntries: 128,
  maxValueBytes: 64,
})
const dialect = new PgDialect()

const ItemRowsSchema = z.array(
  z.object({
    id: z.string(),
    type: SubscriptionTypeSchema,
    source_id: z.string(),
    source_title: z.string(),
    source_thumbnail_url: z.string().nullable(),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    published: z.coerce.number(),
    published_precision: SubscriptionPublishedPrecisionSchema.catch('time'),
    duration_sec: z.coerce.number(),
    view_count: CountSchema,
    like_count: CountSchema,
    comment_count: CountSchema,
    live: z.enum(['none', 'live', 'upcoming']).catch('none'),
    artwork_url: z.string().nullable(),
    artists: z.array(z.string()),
    url: z.string().nullable(),
    audio_url: z.string().nullable(),
    watched: z.coerce.number().nullable(),
    total: z.coerce.number().optional(),
  }),
)
type SubscriptionItemRow = z.infer<typeof ItemRowsSchema>[number]

/** A page of stored items from subscribed sources. */
type SubscriptionItemSearch = {
  /** Reads rows of this library only; a read by ID leaves it out. */
  library?: SubscriptionLibrary
  /** Web-search syntax over the stored search text. */
  text?: string
  /** `title` leaves the description out of a ranked search. */
  fields: 'title' | 'all'
  /** Further conditions over `i` and `s`. */
  conditions: SQL[]
  /** The ordering before the ID tie-breaker; `ranked` is null without a ranked search. */
  order: (ranked: SQL | null) => SQL
  page: number
  size: number
}

/**
 * Searches items of subscribed sources. A search made only of stop words,
 * such as "The Who", or of punctuation has no lexemes to match; it falls back
 * to the literal text in the item or source title, or a mix's billed artist.
 */
async function subscriptionSearchQueries(search: SubscriptionItemSearch) {
  const text = search.text || null
  const match = text === null ? null : searchQuery(text)
  const literal =
    text !== null &&
    (match === null ||
      LexemeRowsSchema.parse(
        (await db.execute(sql`select numnode(${match}) as nodes`)).rows,
      )[0]?.nodes === 0)
  const pattern = `%${(text ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const ranked = literal ? null : match
  const where = sql.join(
    [
      sql`s.subscribed`,
      ...(search.library
        ? [inSubscriptionLibrary(sql`i.type`, search.library)]
        : []),
      ...(literal
        ? [
            sql`(i.title ilike ${pattern} or s.title ilike ${pattern}${
              search.library === 'mixes'
                ? sql` or exists (select 1 from jsonb_array_elements_text(i.artists) billed(value)
                    where billed.value ilike ${pattern})`
                : sql``
            })`,
          ]
        : []),
      ...(ranked
        ? [
            sql`i.search @@ ${ranked}`,
            // The index narrows on every field; titles-only rechecks the heavier weights.
            ...(search.fields === 'title'
              ? [sql`ts_filter(i.search, '{a,b}') @@ ${ranked}`]
              : []),
          ]
        : []),
      ...search.conditions,
    ],
    sql` and `,
  )
  const members = sql`from subscription_item i
    join subscription_source s on s.id = i.source_id
    where ${where}`
  const offset = (search.page - 1) * search.size
  async function readPage(size: number, withCount = false) {
    return ItemRowsSchema.parse(
      (
        await db.execute(sql`
        select i.id, i.type, i.source_id, s.title as source_title,
          s.thumbnail_url as source_thumbnail_url, i.title, i.description,
          i.tags, extract(epoch from i.published_at)::float8 as published,
          i.published_precision, i.duration_sec, i.view_count, i.like_count,
          i.comment_count, i.live, i.artwork_url, i.artists, i.url,
          i.audio_url, extract(epoch from i.watched_at)::float8 as watched
          ${withCount ? sql`, count(*) over () as total` : sql``}
        ${members}
        order by ${search.order(ranked)}, i.id
        limit ${size} offset ${offset}`)
      ).rows,
    )
  }
  async function readCount() {
    const result = await db.execute(sql`select count(*) as total ${members}`)
    return TotalRowsSchema.parse(result.rows)[0]?.total ?? 0
  }
  return { members, offset, readPage, readCount }
}

async function searchSubscriptionItemRows(search: SubscriptionItemSearch) {
  const { offset, readPage, readCount } =
    await subscriptionSearchQueries(search)
  const rows = await readPage(search.size, true)
  // A page past the end has no rows to carry the window count.
  const totalCount = rows[0]?.total ?? (offset === 0 ? 0 : await readCount())
  return { rows, totalCount }
}

type LibraryArtist = { id: string; name: string }

function subscriptionItem(
  row: SubscriptionItemRow,
  libraryArtists: LibraryArtist[] = [],
): SubscriptionItem {
  const shared = {
    id: row.id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    sourceThumbnailUrl: row.source_thumbnail_url,
    title: row.title,
    description: row.description,
    tags: row.tags,
    publishedAt: new Date(row.published * 1000).toISOString(),
    publishedPrecision: row.published_precision,
    durationSec: row.duration_sec > 0 ? row.duration_sec : null,
    url: subscriptionItemUrl(row.type, row.id, row.url),
    watchedAt: isoSeconds(row.watched),
  }
  if (row.type === 'youtube')
    return SubscriptionItemSchema.parse({
      type: row.type,
      ...shared,
      viewCount: row.view_count,
      likeCount: row.like_count,
      commentCount: row.comment_count,
      live: row.live,
    })
  if (row.type === 'spotify')
    return SubscriptionItemSchema.parse({
      type: row.type,
      ...shared,
      artworkUrl: row.artwork_url,
    })
  return SubscriptionItemSchema.parse({
    type: row.type,
    ...shared,
    artworkUrl: row.artwork_url,
    artists: row.artists,
    audioUrl: row.audio_url,
    libraryArtists,
  })
}

const typeLabel = sql`(case i.type ${sql.join(
  SubscriptionTypeSchema.options.map(
    (type) => sql`when ${type} then ${subscriptionTypeLabels[type]}::text`,
  ),
  sql` `,
)} end)`

const textValues: Record<z.infer<typeof SubscriptionTextFieldSchema>, SQL> = {
  title: sql`i.title`,
  source: sql`s.title`,
  type: typeLabel,
  artist: sql`artist.value`,
  genre: sql`tag.value`,
  // Yes or No, as the film Watched field.
  watched: sql`(case when i.watched_at is null then 'No'::text else 'Yes'::text end)`,
}

/** Facets read one row per value of an array field. */
const textValueRows: Partial<
  Record<z.infer<typeof SubscriptionTextFieldSchema>, SQL>
> = {
  artist: sql`cross join lateral jsonb_array_elements_text(i.artists) artist(value)`,
  genre: sql`cross join lateral jsonb_array_elements_text(i.tags) tag(value)`,
}

/**
 * Exact, case-insensitive matches, as the other libraries' text filters. A
 * mix's tags are music genres: a tag filter resolves merged names and matches
 * the visible tags beneath it in the album tag hierarchy, by normalized name.
 */
function filterMatch(filter: BrowseFilter, library: SubscriptionLibrary) {
  const field = SubscriptionTextFieldSchema.safeParse(filter.field)
  if (!field.success || !subscriptionLibraryHasTextFilter(library, field.data))
    throw new ServerError({ statusCode: 422, message: 'Unknown text filter' })
  const value = sql`lower(${filter.value}::text)`
  if (field.data === 'genre' && library === 'mixes')
    return sql`exists (select 1 from jsonb_array_elements_text(i.tags) tag(value)
      where ${normalizedTagSql(sql`tag.value`)} in (
        ${matchingTagNames(normalizeTagName(filter.value), 'album')}
      ))`
  if (field.data === 'genre')
    return sql`exists (select 1 from jsonb_array_elements_text(i.tags) tag(value) where lower(tag.value) = ${value})`
  if (field.data === 'artist')
    return sql`exists (select 1 from jsonb_array_elements_text(i.artists) artist(value) where lower(artist.value) = ${value})`
  return sql`lower(${textValues[field.data]}) = ${value}`
}

// Durations of zero are unknown: a live stream or premiere that has not finished.
const rangeColumns: Record<
  z.infer<typeof SubscriptionRangeFieldSchema>,
  { value: SQL; bound: (value: number) => SQL }
> = {
  publishedAt: {
    value: sql`i.published_at`,
    // Epoch milliseconds to the stored UTC timestamp, so the index applies.
    bound: (value) =>
      sql`(to_timestamp(${value}::float8 / 1000) at time zone 'UTC')`,
  },
  durationSec: {
    value: sql`nullif(i.duration_sec, 0)`,
    bound: (value) => sql`${value}`,
  },
  watchedAt: {
    value: sql`i.watched_at`,
    bound: (value) =>
      sql`(to_timestamp(${value}::float8 / 1000) at time zone 'UTC')`,
  },
  viewCount: { value: sql`i.view_count`, bound: (value) => sql`${value}` },
  likeCount: { value: sql`i.like_count`, bound: (value) => sql`${value}` },
  commentCount: {
    value: sql`i.comment_count`,
    bound: (value) => sql`${value}`,
  },
}

function sortOrder(
  sortBy: SubscriptionSort,
  direction: 'asc' | 'desc',
  ranked: SQL | null,
) {
  const dir = direction === 'asc' ? sql`asc` : sql`desc`
  // Missing values sort last in both directions.
  const orders: Record<SubscriptionSort, SQL> = {
    // Relevance without a ranked search is by published date.
    relevance: ranked
      ? sql`ts_rank(i.search, ${ranked}) ${dir}, i.published_at desc`
      : sql`i.published_at ${dir}`,
    publishedAt: sql`i.published_at ${dir}`,
    title: sql`lower(i.title) ${dir}`,
    source: sql`lower(s.title) ${dir}`,
    durationSec: sql`nullif(i.duration_sec, 0) ${dir} nulls last`,
    watchedAt: sql`i.watched_at ${dir} nulls last`,
    viewCount: sql`i.view_count ${dir} nulls last`,
    likeCount: sql`i.like_count ${dir} nulls last`,
    commentCount: sql`i.comment_count ${dir} nulls last`,
  }
  return orders[sortBy]
}

/**
 * Browses stored videos and podcast episodes from subscribed sources with the
 * other libraries' filter semantics: required and excluded filters, one any-of
 * group across fields, and inclusive ranges with an optional missing value.
 */
function subscriptionBrowseSearch(
  query: SubscriptionItemQuery,
  sourceId = query.sourceId,
): SubscriptionItemSearch {
  const { library } = query
  const conditions =
    sourceId === undefined ? [] : [sql`i.source_id = ${sourceId}`]
  const any: SQL[] = []
  for (const filter of query.filters) {
    const match = filterMatch(filter, library)
    if (filter.mode === 'exclude') conditions.push(sql`not (${match})`)
    else if (filter.mode === 'required') conditions.push(match)
    else any.push(match)
  }
  if (any.length) conditions.push(sql`(${sql.join(any, sql` or `)})`)
  for (const range of query.ranges) {
    const field = SubscriptionRangeFieldSchema.safeParse(range.field)
    if (!field.success || !subscriptionLibraryHasRange(library, field.data))
      throw new ServerError({
        statusCode: 422,
        message: 'Unknown numeric filter',
      })
    const { value, bound } = rangeColumns[field.data]
    const bounds: SQL[] = [sql`${value} is not null`]
    if (range.min !== undefined)
      bounds.push(sql`${value} >= ${bound(range.min)}`)
    if (range.max !== undefined)
      bounds.push(sql`${value} <= ${bound(range.max)}`)
    const predicate = sql`(${sql.join(bounds, sql` and `)})`
    conditions.push(
      range.includeMissing
        ? sql`(${predicate} or ${value} is null)`
        : predicate,
    )
  }
  const sortBy = query.sortBy ?? (query.q ? 'relevance' : 'publishedAt')
  if (!subscriptionLibraryHasSort(library, sortBy))
    throw new ServerError({ statusCode: 422, message: 'Unknown sort' })
  return {
    library,
    text: query.q,
    fields: query.fields,
    conditions,
    order: (ranked) => sortOrder(sortBy, query.direction, ranked),
    page: query.page,
    size: query.size,
  }
}

async function subscriptionItemPage(
  search: SubscriptionItemSearch,
): Promise<SubscriptionItemPage> {
  const { rows, totalCount } = await searchSubscriptionItemRows(search)
  return SubscriptionItemPageSchema.parse({
    items: rows.map((row) => subscriptionItem(row)),
    totalCount,
    page: search.page,
    size: search.size,
    pageCount: Math.ceil(totalCount / search.size),
  })
}

export async function listSubscriptionItems(
  query: SubscriptionItemQuery,
  sourceId = query.sourceId,
): Promise<SubscriptionItemPage> {
  return subscriptionItemPage(subscriptionBrowseSearch(query, sourceId))
}

/**
 * Mixes billing the name, or on a show of that name, ignoring case and
 * surrounding spaces. The search text holds both, so its index narrows the
 * rows before the exact comparison; a name without letters or digits has no
 * words to look up and is compared on every mix.
 */
function artistMixes(name: string, query: ArtistMixQuery) {
  const key = nameKey(sql`${name}::text`)
  const named = sql`(${nameKey(sql`s.title`)} = ${key} or exists (
    select 1 from jsonb_array_elements_text(i.artists) billed(value)
    where ${nameKey(sql`billed.value`)} = ${key}))`
  const search = subscriptionBrowseSearch({
    library: 'mixes',
    q: query.q,
    fields: 'all',
    filters: [],
    ranges: [],
    sortBy: query.sortBy,
    direction: query.direction,
    page: query.page,
    size: query.size,
  })
  search.conditions.push(
    name.match(WORD_PARTS)
      ? sql`i.search @@ plainto_tsquery('simple', ${name}) and ${named}`
      : named,
  )
  return search
}

/** A page of the mixes that bill a library artist's name or are on its show. */
export async function listMixesNamingArtist(
  name: string,
  query: ArtistMixQuery,
) {
  return subscriptionItemPage(artistMixes(name, query))
}

export async function countMixesNamingArtist(name: string) {
  const { readCount } = await subscriptionSearchQueries(
    artistMixes(name, {
      page: 1,
      size: 1,
      sortBy: 'publishedAt',
      direction: 'desc',
    }),
  )
  return readCount()
}

const SubscriptionDiagnosticRowsSchema = z.array(
  z.object({
    id: SubscriptionItemIdSchema,
    source_id: SubscriptionSourceIdSchema,
    type: SubscriptionProviderSchema,
    title: z.string(),
    source_title: z.string(),
  }),
)

/** Videos and episodes are stored by native ID together with their source ID; mixes are left out. */
export async function listSubscriptionMatchDiagnostics(
  query: MatchDiagnosticsQuery,
) {
  const provider = SubscriptionProviderSchema.safeParse(query.sortBy)
  let sort: SQL
  if (provider.success)
    sort = sql`case when i.type = ${provider.data} then lower(i.title) end`
  else if (query.sortBy === 'creator') sort = sql`lower(s.title)`
  else if (query.sortBy === 'name') sort = sql`lower(i.title)`
  else
    throw new ServerError({
      statusCode: 422,
      message: 'Unknown subscription diagnostics sort.',
    })

  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const conditions = (query.q ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const pattern = `%${word.replace(/[\\%_]/g, '\\$&')}%`
      return sql`(i.title ilike ${pattern} or s.title ilike ${pattern}
        or i.id ilike ${pattern} or s.id ilike ${pattern})`
    })
  const members = sql`from subscription_item i
    join subscription_source s on s.id = i.source_id
    where ${sql.join(
      [
        sql`s.subscribed`,
        inSubscriptionLibrary(sql`i.type`, 'subscriptions'),
        ...conditions,
      ],
      sql` and `,
    )}`
  const [count, page] = await Promise.all([
    db.execute(sql`select count(*) as total ${members}`),
    db.execute(sql`
      select i.id, i.source_id, i.type, i.title, s.title as source_title
      ${members}
      order by ${sort} ${direction} nulls last, lower(i.title), i.id
      limit ${query.size} offset ${(query.page - 1) * query.size}
    `),
  ])
  const totalCount = TotalRowsSchema.parse(count.rows)[0]?.total ?? 0
  return MatchDiagnosticsPageSchema.parse({
    providers: [
      { key: 'youtube', label: 'YouTube' },
      { key: 'spotify', label: 'Spotify' },
    ],
    items: SubscriptionDiagnosticRowsSchema.parse(page.rows).map((row) => ({
      id: row.id,
      name: row.title,
      creator: row.source_title,
      sourceId: row.source_id,
      matches: [
        {
          provider: row.type,
          name: row.title,
          creator: row.source_title,
          identifier: row.id,
        },
      ],
    })),
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
  })
}

export async function listSubscriptionBrowsePage(query: SubscriptionItemQuery) {
  const { readPage } = await subscriptionSearchQueries(
    subscriptionBrowseSearch(query),
  )
  const rows = await readPage(query.size + 1)
  return {
    items: rows.slice(0, query.size).map((row) => subscriptionItem(row)),
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
  }
}

export async function countSubscriptionBrowseItems(
  query: SubscriptionItemQuery,
) {
  const { members, readCount } = await subscriptionSearchQueries(
    subscriptionBrowseSearch(query),
  )
  const totalCount = await countCache(
    JSON.stringify(dialect.sqlToQuery(members)),
    readCount,
  )
  return { totalCount }
}

/**
 * The filtered count and, for "N of M", the count Clear filters leaves:
 * every stored item of a subscribed source, without search, filters, ranges
 * or a channel.
 */
export async function subscriptionBrowseCounts(query: SubscriptionItemQuery) {
  const filtered =
    Boolean(query.q) ||
    query.filters.length > 0 ||
    query.ranges.length > 0 ||
    query.sourceId !== undefined
  const [{ totalCount }, unfiltered] = await Promise.all([
    countSubscriptionBrowseItems(query),
    filtered
      ? countSubscriptionBrowseItems({
          ...query,
          q: undefined,
          filters: [],
          ranges: [],
          sourceId: undefined,
        })
      : undefined,
  ])
  return { totalCount, unfilteredCount: unfiltered?.totalCount ?? totalCount }
}

const LibraryArtistRowsSchema = z.array(
  z.object({ id: z.string(), name: z.string() }),
)

/**
 * Library artists, with albums or tracks to show, whose name equals one of
 * the names ignoring case and surrounding spaces. Reads only; no artist is
 * created for a station's names.
 */
async function libraryArtistsNamed(names: string[]) {
  const keys = [...new Set(names.map((name) => name.trim()))].filter(Boolean)
  if (!keys.length) return []
  return LibraryArtistRowsSchema.parse(
    (
      await db.execute(sql`
        select artist.id, artist.name from artist
        where ${nameKey(sql`artist.name`)} in (${sql.join(
          keys.map((key) => nameKey(sql`${key}::text`)),
          sql`, `,
        )}) and ${visibleArtist}
        order by lower(artist.name), artist.id`)
    ).rows,
  )
}

/**
 * One stored item of a subscribed source, of either library, for a link to a
 * row outside the loaded pages. A mix carries the library artists named by
 * its billed artists or its show.
 */
export async function getSubscriptionItem(id: string) {
  const { rows } = await searchSubscriptionItemRows({
    fields: 'all',
    conditions: [sql`i.id = ${id}`],
    order: () => sql`i.published_at desc`,
    page: 1,
    size: 1,
  })
  const [row] = rows
  if (!row) return null
  return subscriptionItem(
    row,
    subscriptionLibraryOf(row.type) === 'mixes'
      ? await libraryArtistsNamed([...row.artists, row.source_title])
      : [],
  )
}

const UpdatedRowsSchema = z.array(z.object({ id: z.string() }))

/**
 * Sets the watched date of a stored item of a subscribed source, or clears it
 * with null. No provider supplies it and a sync never changes it.
 */
export async function setSubscriptionItemWatched(
  id: string,
  { watchedAt }: SubscriptionItemPatch,
) {
  const value =
    watchedAt === null
      ? sql`null`
      : sql`(${watchedAt}::timestamptz at time zone 'UTC')`
  const updated = UpdatedRowsSchema.parse(
    (
      await db.execute(sql`
        update subscription_item i set watched_at = ${value}
        from subscription_source s
        where i.id = ${id} and s.id = i.source_id and s.subscribed
        returning i.id`)
    ).rows,
  )
  const item = updated.length ? await getSubscriptionItem(id) : null
  if (!item)
    throw new ServerError({ statusCode: 404, message: 'Item not found' })
  return item
}

const SourceRowsSchema = z.array(
  z.object({
    id: z.string(),
    type: SubscriptionTypeSchema,
    title: z.string(),
    handle: z.string().nullable(),
    description: z.string().nullable(),
    thumbnail_url: z.string().nullable(),
    url: z.string().nullable(),
    subscriber_count: CountSchema,
    item_total: CountSchema,
    history_complete: z.boolean(),
    stored: z.coerce.number(),
    latest: z.coerce.number().nullable(),
  }),
)

/** Sources with their stored item counts; a read by ID leaves the library out. */
async function readSubscriptionSources(input: {
  library?: SubscriptionLibrary
  type?: SubscriptionType
  id?: string
}) {
  const rows = SourceRowsSchema.parse(
    (
      await db.execute(sql`
        select s.id, s.type, s.title, s.handle, s.description, s.thumbnail_url,
          s.url, s.subscriber_count, s.item_total, s.history_complete,
          count(i.id) as stored,
          extract(epoch from max(i.published_at))::float8 as latest
        from subscription_source s
        left join subscription_item i on i.source_id = s.id
        where s.subscribed
          ${input.library ? sql`and ${inSubscriptionLibrary(sql`s.type`, input.library)}` : sql``}
          ${input.type ? sql`and s.type = ${input.type}` : sql``}
          ${input.id === undefined ? sql`` : sql`and s.id = ${input.id}`}
        group by s.id
        order by lower(s.title), s.id`)
    ).rows,
  )
  return SubscriptionSourceListSchema.parse({
    items: rows.map((row) => {
      const shared = {
        id: row.id,
        title: row.title,
        description: row.description,
        thumbnailUrl: row.thumbnail_url,
        url: subscriptionSourceUrl(row.type, row.id, row.url),
        storedItems: row.stored,
        latestItemAt: isoSeconds(row.latest),
        historyComplete: row.history_complete,
      }
      return row.type === 'youtube'
        ? {
            type: row.type,
            ...shared,
            handle: row.handle,
            subscriberCount: row.subscriber_count,
          }
        : { type: row.type, ...shared, itemTotal: row.item_total }
    }),
  })
}

/**
 * Every subscribed channel and podcast, or every station show, with its
 * stored item count.
 */
export async function listSubscriptionSources(
  input: z.input<typeof SubscriptionSourceQuerySchema> = {},
) {
  return readSubscriptionSources(SubscriptionSourceQuerySchema.parse(input))
}

/** A channel, podcast or show and its items, read in the library of its type. */
export async function getSubscriptionSource(
  id: string,
  query: SubscriptionItemQuery,
) {
  const {
    items: [source],
  } = await readSubscriptionSources({ id })
  if (!source)
    throw new ServerError({ statusCode: 404, message: 'Channel not found' })
  return SubscriptionSourceDetailSchema.parse({
    source,
    items: await listSubscriptionItems(
      { ...query, library: subscriptionLibraryOf(source.type) },
      id,
    ),
  })
}

const FacetRowSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})
const facetCache = createDatabaseReadCache<z.infer<typeof FacetRowSchema>[]>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})

const facetFields = (library: SubscriptionLibrary) =>
  subscriptionBrowseFieldsFor(library).filter(
    (field) => field.type === 'text' && field.filterable,
  )

async function queryFacets(query: SubscriptionFacetQuery) {
  const fields = facetFields(query.library)
  const limit = Math.min(
    query.limitPerField,
    Math.max(1, Math.floor(1000 / fields.length)),
  )
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const queries = fields.map((field) => {
    const key = SubscriptionTextFieldSchema.parse(field.key)
    // A word in the field's label, such as "channel", selects the field
    // instead of filtering its values.
    const matches = words
      .filter(
        (word) =>
          key === 'title' || !`${field.label}:`.toLowerCase().includes(word),
      )
      .map((word) => sql`value ilike ${`%${word.replace(/[\\%_]/g, '\\$&')}%`}`)
    const search = matches.length ? sql`and ${and(...matches)}` : sql``
    // Values differing only in case are one filter, as filters ignore case.
    return sql`(select ${key}::text as field, min(value) as value,
        count(distinct id)::int as count
      from (select i.id, ${textValues[key]} as value
        from subscription_item i
        join subscription_source s on s.id = i.source_id ${textValueRows[key] ?? sql``}
        where s.subscribed and ${inSubscriptionLibrary(sql`i.type`, query.library)}) values_for_field
      where value is not null and value <> '' ${search}
      group by lower(value)
      order by case when lower(value) = ${query.q?.toLowerCase() ?? ''} then 0 else 1 end,
        count desc, min(value) asc
      limit ${limit})`
  })
  const result = await db.execute(sql.join(queries, sql` union all `))
  return z.array(FacetRowSchema).parse(result.rows)
}

/**
 * Filter suggestions for each text field of one library (title, channel or
 * show, type or station, artist and tag values), counted over every item of
 * that library and limited per field.
 */
export async function listSubscriptionFacets(
  input: Partial<SubscriptionFacetQuery> = {},
) {
  const query = SubscriptionFacetQuerySchema.parse(input)
  const fields = facetFields(query.library)
  const rows = await facetCache(JSON.stringify(query), () => queryFacets(query))
  return rows
    .map((row) => ({
      ...row,
      label: `${fields.find((field) => field.key === row.field)?.label ?? row.field}: ${row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
