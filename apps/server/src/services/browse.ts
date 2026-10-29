import { and, eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  albumBrowseFields,
  filmBrowseFields,
  BrowseFieldSchema,
  type BrowseField,
} from '@repo/schemas/browse'
import type { AlbumQuery, FilmQuery } from '@repo/schemas/media'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { mediaItem, album, film } from '@/schemas/db'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import { normalizedTagSql, normalizeTagName } from './tag-state'

type MediaType = 'album' | 'film'

export type BrowseQueryOptions = {
  conditions?: SQL[]
  sort?: { field: BrowseField; expression: SQL; missingFirst?: boolean }
}

export async function listBrowseFields(
  mediaType: MediaType,
): Promise<BrowseField[]> {
  const base = mediaType === 'album' ? albumBrowseFields : filmBrowseFields
  const plugins = await listLoadedScrapePlugins()
  const extra = plugins
    .filter((plugin) => plugin.manifest.mediaTypes.includes(mediaType))
    .flatMap((plugin) => plugin.manifest.browseFields ?? [])
    .map((field) => BrowseFieldSchema.parse(field))
  return [...base, ...extra]
}

function valueExpression(key: string): SQL {
  switch (key) {
    case 'title':
      return sql`to_jsonb(${mediaItem.title})`
    case 'summary':
      return sql`to_jsonb(${mediaItem.summary})`
    case 'releaseDate':
      return sql`to_jsonb(extract(epoch from ${mediaItem.releaseDate}) * 1000)`
    case 'updatedAt':
      return sql`to_jsonb(extract(epoch from ${mediaItem.updatedAt}) * 1000)`
    case 'dateAdded':
      return sql`to_jsonb(extract(epoch from case when ${mediaItem.mediaType} = 'film' then coalesce(${film.dateAdded}, ${mediaItem.createdAt}) else ${album.dateAdded} end) * 1000)`
    case 'durationSec':
      return sql`to_jsonb(${album.durationSec})`
    case 'trackCount':
      return sql`to_jsonb(${album.trackCount})`
    case 'runtimeMinutes':
      return sql`to_jsonb(${film.runtimeMinutes})`
    case 'budget':
      return sql`to_jsonb(${film.budget})`
    case 'boxOffice':
      return sql`to_jsonb(${film.boxOffice})`
    case 'source':
      return sql`to_jsonb(coalesce(${mediaItem.sourceLabel}, ${film.sourceKind}))`
    case 'watched':
      return sql`to_jsonb(case when ${film.watched} then 'Yes'::text else 'No'::text end)`
    case 'identification':
      return sql`to_jsonb(case when exists (select 1 from provider_reference r where r.media_item_id = ${mediaItem.id} and ((r.reference_type = 'imdb' and r.external_id ~ '^tt[0-9]+$') or (r.reference_type = 'tmdb' and r.external_id ~ '^[0-9]+$'))) then 'Identified'::text else 'Needs ID'::text end)`
    case 'artist':
    case 'director':
    case 'actor':
    case 'writer':
      return sql`(select jsonb_agg(a.name order by c.billing_order, a.name) from media_credit c join artist a on a.id = c.artist_id where c.media_item_id = ${mediaItem.id} and c.role = ${key})`
    case 'genre':
    case 'keyword':
      return sql`(select jsonb_agg(distinct t.name order by t.name) from media_item_tag mt join tag t on t.id = mt.tag_id where mt.media_item_id = ${mediaItem.id} and t.media_type = ${mediaItem.mediaType} and not t.hidden)`
    case 'playlist':
    case 'collection':
      return sql`(select jsonb_agg(p.name order by p.name) from playlist_item pi join playlist p on p.id = pi.playlist_id where pi.media_item_id = ${mediaItem.id} and p.kind = ${key})`
    case 'provider':
      return sql`(select jsonb_agg(distinct r.provider) from provider_reference r where r.media_item_id = ${mediaItem.id})`
    default:
      return sql`(${mediaItem.metadata}->'browse'->${key}::text)`
  }
}

function textExpression(key: string): SQL {
  const value = valueExpression(key)
  return sql`case when jsonb_typeof(${value}) = 'array' then ${value}->>0 else ${value} #>> '{}' end`
}

function numericExpression(key: string): SQL {
  const value = valueExpression(key)
  return sql`case when jsonb_typeof(${value}) = 'number' then (${value} #>> '{}')::numeric else null end`
}

function matchesValue(key: string, value: string, mediaType: MediaType): SQL {
  const match = sql`lower(${value}::text)`
  if (['artist', 'director', 'actor', 'writer'].includes(key)) {
    return sql`exists (select 1 from media_credit c join artist a on a.id = c.artist_id where c.media_item_id = ${mediaItem.id} and c.role = ${key} and lower(a.name) = ${match})`
  }
  if (key === 'genre' || key === 'keyword') {
    // Resolve merged names once for this library, not once per media/tag pair.
    const name = normalizeTagName(value)
    return sql`${mediaItem.id} in (
      select mt.media_item_id from media_item_tag mt join tag t on t.id = mt.tag_id
      where t.media_type = ${mediaType} and ${normalizedTagSql(sql`t.name`)} in (
        select ${name}::text
        union select ${normalizedTagSql(sql`target.name`)}
          from tag_identity i join tag target on target.id = i.tag_id
          where i.media_type = ${mediaType} and target.media_type = ${mediaType} and i.normalized_name = ${name}
        union select ${normalizedTagSql(sql`target.name`)}
          from tag_alias a join tag original on original.id = a.source_tag_id join tag target on target.id = a.target_tag_id
          where original.media_type = ${mediaType} and target.media_type = ${mediaType} and ${normalizedTagSql(sql`original.name`)} = ${name}
      )
    )`
  }
  if (key === 'playlist' || key === 'collection')
    return sql`exists (select 1 from playlist_item pi join playlist p on p.id = pi.playlist_id where pi.media_item_id = ${mediaItem.id} and p.kind = ${key} and lower(p.name) = ${match})`
  if (key === 'provider')
    return sql`exists (select 1 from provider_reference r where r.media_item_id = ${mediaItem.id} and lower(r.provider) = ${match})`
  const expression = valueExpression(key)
  return sql`exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(${expression}) = 'array' then ${expression} else jsonb_build_array(${expression}) end) filter_value(value) where lower(filter_value.value) = ${match})`
}

export async function queryBrowseIds(
  mediaType: MediaType,
  query: AlbumQuery | FilmQuery,
  options: BrowseQueryOptions = {},
) {
  const fields = await listBrowseFields(mediaType)
  if (options.sort) fields.push(options.sort.field)
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const sortField = byKey.get(query.sortBy)
  if (!sortField)
    throw new ServerError({ statusCode: 422, message: 'Unknown sort field' })
  const conditions: SQL[] = [eq(mediaItem.mediaType, mediaType)]
  conditions.push(...(options.conditions ?? []))
  if (query.includeArchived !== 'true')
    conditions.push(
      sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
    )
  const filters = [...query.filters]
  if (query.tag)
    filters.push({ field: 'genre', value: query.tag, mode: 'required' })
  if ('sourceKind' in query && query.sourceKind)
    conditions.push(eq(film.sourceKind, query.sourceKind))
  const any: SQL[] = []
  for (const filter of filters) {
    if (byKey.get(filter.field)?.type !== 'text')
      throw new ServerError({ statusCode: 422, message: 'Unknown text filter' })
    const match = matchesValue(filter.field, filter.value, mediaType)
    if (filter.mode === 'exclude') conditions.push(sql`not (${match})`)
    else if (filter.mode === 'required') conditions.push(match)
    else any.push(match)
  }
  if (any.length) conditions.push(sql`(${sql.join(any, sql` or `)})`)
  for (const range of query.ranges) {
    const field = byKey.get(range.field)
    if (!field || field.type === 'text')
      throw new ServerError({
        statusCode: 422,
        message: 'Unknown numeric filter',
      })
    const value = numericExpression(range.field)
    const bounds: SQL[] = [sql`${value} is not null`]
    if (range.min !== undefined) bounds.push(sql`${value} >= ${range.min}`)
    if (range.max !== undefined) bounds.push(sql`${value} <= ${range.max}`)
    const predicate = sql`(${sql.join(bounds, sql` and `)})`
    conditions.push(
      range.includeMissing
        ? sql`(${predicate} or ${value} is null)`
        : predicate,
    )
  }
  if (query.q?.trim()) {
    const search = `%${query.q.trim().replace(/[\\%_]/g, '\\$&')}%`
    const expressions = fields
      .filter((field) => field.type === 'text')
      .map(
        (field) =>
          sql`(${valueExpression(field.key)} #>> '{}') ilike ${search}`,
      )
    conditions.push(sql`(${sql.join(expressions, sql` or `)})`)
  }
  const where = and(...conditions)
  const sort =
    options.sort?.field.key === sortField.key
      ? options.sort.expression
      : sortField.type === 'text'
        ? sql`lower(${textExpression(sortField.key)})`
        : numericExpression(sortField.key)
  const missing =
    options.sort?.field.key === sortField.key && options.sort.missingFirst
      ? sql`nulls first`
      : sql`nulls last`
  const order =
    query.direction === 'asc'
      ? sql`${sort} asc ${missing}`
      : sql`${sort} desc ${missing}`
  const base = () =>
    db
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
      .leftJoin(film, eq(film.mediaItemId, mediaItem.id))
  const total = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(mediaItem)
    .leftJoin(album, eq(album.mediaItemId, mediaItem.id))
    .leftJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(where)
  const offset = (query.page - 1) * query.size
  const totalCount = Math.min(
    total[0]?.value ?? 0,
    query.limitResults ?? Number.MAX_SAFE_INTEGER,
  )
  const rows = await base()
    .where(where)
    .orderBy(order, mediaItem.id)
    .limit(Math.min(query.size, Math.max(0, totalCount - offset)))
    .offset(offset)
  return {
    ids: rows.map((row) => row.id),
    totalCount,
    pageCount: Math.ceil(totalCount / query.size),
  }
}

const FacetRowSchema = z.object({
  field: z.string(),
  value: z.string(),
  count: z.coerce.number().int().positive(),
})

export async function listBrowseFacets(mediaType: MediaType) {
  const fields = (await listBrowseFields(mediaType)).filter(
    (field) => field.type === 'text' && field.filterable,
  )
  const queries = fields.map((field) => {
    let source: SQL = sql`select media_item.id, v.value from media_item left join film on film.media_item_id = media_item.id
      cross join lateral jsonb_array_elements_text(case when jsonb_typeof(${valueExpression(field.key)}) = 'array' then ${valueExpression(field.key)} else jsonb_build_array(${valueExpression(field.key)}) end) v(value)
      where media_item.media_type = ${mediaType} and media_item.metadata->>'legacyHidden' is distinct from 'true'`
    const visible = sql`media_item.media_type = ${mediaType} and media_item.metadata->>'legacyHidden' is distinct from 'true'`
    if (['artist', 'director', 'actor', 'writer'].includes(field.key)) {
      source = sql`select media_item.id, a.name as value from media_item join media_credit c on c.media_item_id = media_item.id join artist a on a.id = c.artist_id where ${visible} and c.role = ${field.key}`
    } else if (field.key === 'genre' || field.key === 'keyword') {
      source = sql`select media_item.id, ${normalizedTagSql(sql`t.name`)} as value from media_item join media_item_tag mt on mt.media_item_id = media_item.id join tag t on t.id = mt.tag_id where ${visible} and t.media_type = media_item.media_type and not t.hidden`
    } else if (field.key === 'playlist' || field.key === 'collection') {
      source = sql`select media_item.id, p.name as value from media_item join playlist_item pi on pi.media_item_id = media_item.id join playlist p on p.id = pi.playlist_id where ${visible} and p.kind = ${field.key}`
    } else if (field.key === 'provider') {
      source = sql`select media_item.id, r.provider as value from media_item join provider_reference r on r.media_item_id = media_item.id where ${visible}`
    }
    return sql`select ${field.key}::text as field, value, count(distinct id)::int as count from (${source}) values_for_field where value is not null and value <> '' group by value`
  })
  const result = await db.execute(sql.join(queries, sql` union all `))
  return z
    .array(FacetRowSchema)
    .parse(result.rows)
    .map((row) => ({
      ...row,
      label: `${fields.find((f) => f.key === row.field)?.label ?? row.field}: ${row.value}`,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}
