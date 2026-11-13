import { and, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  BrowseFacetQuerySchema,
  type BrowseFacetQuery,
  type BrowseFilter,
} from '@repo/schemas/browse'
import {
  SubscriptionItemPageSchema,
  SubscriptionItemSchema,
  SubscriptionPublishedPrecisionSchema,
  SubscriptionRangeFieldSchema,
  SubscriptionSourceListSchema,
  SubscriptionTextFieldSchema,
  SubscriptionTypeSchema,
  subscriptionBrowseFields,
  subscriptionItemUrl,
  subscriptionSourceUrl,
  subscriptionTypeLabels,
  type SubscriptionItem,
  type SubscriptionItemPage,
  type SubscriptionItemQuery,
  type SubscriptionSort,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'
import { createDatabaseReadCache } from '@/lib/database-read-cache'
import { ServerError } from '@/lib/error'

// Every query reads stored rows only and makes no provider requests. In SQL,
// `i` is a subscription_item and `s` its subscription_source.

/**
 * Title (A), source title and tags (B), description (D): English stems for
 * word forms, then the same fields unstemmed for partial words. Migration 0021
 * rebuilt stored YouTube rows with the same expression.
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
    total: z.coerce.number(),
  }),
)
type SubscriptionItemRow = z.infer<typeof ItemRowsSchema>[number]

/** A page of stored items from subscribed sources. */
type SubscriptionItemSearch = {
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
 * to the literal text in the item or source title.
 */
async function searchSubscriptionItemRows(search: SubscriptionItemSearch) {
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
      ...(literal
        ? [sql`(i.title ilike ${pattern} or s.title ilike ${pattern})`]
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
  const offset = (search.page - 1) * search.size
  const rows = ItemRowsSchema.parse(
    (
      await db.execute(sql`
        select i.id, i.type, i.source_id, s.title as source_title,
          s.thumbnail_url as source_thumbnail_url, i.title, i.description,
          i.tags, extract(epoch from i.published_at)::float8 as published,
          i.published_precision, i.duration_sec, i.view_count, i.like_count,
          i.comment_count, i.live, i.artwork_url,
          count(*) over () as total
        from subscription_item i
        join subscription_source s on s.id = i.source_id
        where ${where}
        order by ${search.order(ranked)}, i.id
        limit ${search.size} offset ${offset}`)
    ).rows,
  )
  // A page past the end has no rows to carry the window count.
  const totalCount =
    rows[0]?.total ??
    (offset === 0
      ? 0
      : (TotalRowsSchema.parse(
          (
            await db.execute(sql`
              select count(*) as total from subscription_item i
              join subscription_source s on s.id = i.source_id
              where ${where}`)
          ).rows,
        )[0]?.total ?? 0))
  return { rows, totalCount }
}

function subscriptionItem(row: SubscriptionItemRow): SubscriptionItem {
  const shared = {
    sourceTitle: row.source_title,
    sourceThumbnailUrl: row.source_thumbnail_url,
    title: row.title,
    description: row.description,
    tags: row.tags,
    publishedAt: new Date(row.published * 1000).toISOString(),
    publishedPrecision: row.published_precision,
    durationSec: row.duration_sec > 0 ? row.duration_sec : null,
    url: subscriptionItemUrl(row.type, row.id),
  }
  return SubscriptionItemSchema.parse(
    row.type === 'youtube'
      ? {
          type: row.type,
          id: row.id,
          sourceId: row.source_id,
          ...shared,
          viewCount: row.view_count,
          likeCount: row.like_count,
          commentCount: row.comment_count,
          live: row.live,
        }
      : {
          type: row.type,
          id: row.id,
          sourceId: row.source_id,
          ...shared,
          artworkUrl: row.artwork_url,
        },
  )
}

const typeLabel = sql`(case i.type when 'youtube' then ${subscriptionTypeLabels.youtube}::text when 'spotify' then ${subscriptionTypeLabels.spotify}::text end)`

const textValues: Record<z.infer<typeof SubscriptionTextFieldSchema>, SQL> = {
  title: sql`i.title`,
  source: sql`s.title`,
  type: typeLabel,
  genre: sql`tag.value`,
}

/** Exact, case-insensitive matches, as the other libraries' text filters. */
function filterMatch(filter: BrowseFilter) {
  const field = SubscriptionTextFieldSchema.safeParse(filter.field)
  if (!field.success)
    throw new ServerError({ statusCode: 422, message: 'Unknown text filter' })
  const value = sql`lower(${filter.value}::text)`
  return field.data === 'genre'
    ? sql`exists (select 1 from jsonb_array_elements_text(i.tags) tag(value) where lower(tag.value) = ${value})`
    : sql`lower(${textValues[field.data]}) = ${value}`
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
export async function listSubscriptionItems(
  query: SubscriptionItemQuery,
): Promise<SubscriptionItemPage> {
  const conditions: SQL[] = []
  const any: SQL[] = []
  for (const filter of query.filters) {
    const match = filterMatch(filter)
    if (filter.mode === 'exclude') conditions.push(sql`not (${match})`)
    else if (filter.mode === 'required') conditions.push(match)
    else any.push(match)
  }
  if (any.length) conditions.push(sql`(${sql.join(any, sql` or `)})`)
  for (const range of query.ranges) {
    const field = SubscriptionRangeFieldSchema.safeParse(range.field)
    if (!field.success)
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
  const { rows, totalCount } = await searchSubscriptionItemRows({
    text: query.q,
    fields: query.fields,
    conditions,
    order: (ranked) => sortOrder(sortBy, query.direction, ranked),
    page: query.page,
    size: query.size,
  })
  return SubscriptionItemPageSchema.parse({
    items: rows.map(subscriptionItem),
    totalCount,
    page: query.page,
    size: query.size,
    pageCount: Math.ceil(totalCount / query.size),
  })
}

/** One stored item of a subscribed source, for a link to a row outside the loaded pages. */
export async function getSubscriptionItem(id: string) {
  const { rows } = await searchSubscriptionItemRows({
    fields: 'all',
    conditions: [sql`i.id = ${id}`],
    order: () => sql`i.published_at desc`,
    page: 1,
    size: 1,
  })
  const [row] = rows
  return row ? subscriptionItem(row) : null
}

const SourceRowsSchema = z.array(
  z.object({
    id: z.string(),
    type: SubscriptionTypeSchema,
    title: z.string(),
    handle: z.string().nullable(),
    description: z.string().nullable(),
    thumbnail_url: z.string().nullable(),
    subscriber_count: CountSchema,
    item_total: CountSchema,
    history_complete: z.boolean(),
    stored: z.coerce.number(),
    latest: z.coerce.number().nullable(),
  }),
)

/** Every subscribed channel and podcast with its stored item count. */
export async function listSubscriptionSources(
  input: { type?: SubscriptionType } = {},
) {
  const rows = SourceRowsSchema.parse(
    (
      await db.execute(sql`
        select s.id, s.type, s.title, s.handle, s.description, s.thumbnail_url,
          s.subscriber_count, s.item_total, s.history_complete,
          count(i.id) as stored,
          extract(epoch from max(i.published_at))::float8 as latest
        from subscription_source s
        left join subscription_item i on i.source_id = s.id
        where s.subscribed ${input.type ? sql`and s.type = ${input.type}` : sql``}
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
        url: subscriptionSourceUrl(row.type, row.id),
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

const FacetRowSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})
const facetCache = createDatabaseReadCache<z.infer<typeof FacetRowSchema>[]>({
  maxEntries: 4,
  maxValueBytes: 512 * 1024,
})

const facetFields = subscriptionBrowseFields.filter(
  (field) => field.type === 'text' && field.filterable,
)

async function queryFacets(query: BrowseFacetQuery) {
  const limit = Math.min(
    query.limitPerField,
    Math.max(1, Math.floor(1000 / facetFields.length)),
  )
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const queries = facetFields.map((field) => {
    const key = SubscriptionTextFieldSchema.parse(field.key)
    const tags =
      key === 'genre'
        ? sql`cross join lateral jsonb_array_elements_text(i.tags) tag(value)`
        : sql``
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
        join subscription_source s on s.id = i.source_id ${tags}
        where s.subscribed) values_for_field
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
 * Filter suggestions for title, channel, type and tag values, counted over
 * every item of a subscribed source and limited per field.
 */
export async function listSubscriptionFacets(
  input: Partial<BrowseFacetQuery> = {},
) {
  const query = BrowseFacetQuerySchema.parse(input)
  const rows = await facetCache(JSON.stringify(query), () => queryFacets(query))
  return rows
    .map((row) => ({
      ...row,
      label: `${facetFields.find((field) => field.key === row.field)?.label ?? row.field}: ${row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
