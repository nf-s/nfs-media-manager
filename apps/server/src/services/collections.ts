import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
import type { SelectedFields } from 'drizzle-orm/pg-core'
import {
  AlbumCollectionBrowsePageSchema,
  AlbumCollectionDetailSchema,
  type AlbumCollectionBrowseQuery,
  type AlbumCollectionQuery,
} from '@repo/schemas/album-collections'
import type { CollectionQuery } from '@repo/schemas/collections'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import {
  FilmCollectionBrowsePageSchema,
  FilmCollectionDetailSchema,
  type FilmCollectionBrowseQuery,
  type FilmCollectionQuery,
} from '@repo/schemas/film-collections'
import type { SourceNavigationLink } from '@repo/schemas/tags'
import { albumAddedDateExpression } from './album-added-dates'
import { catalogScopeCondition } from './catalog-scope'
import {
  getCollectionSourceLinksForItems,
  matchingCollectionNames,
} from './source-navigation'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { toIsoString } from '@/lib/media-utils'
import { album, film, mediaItem, playlist, playlistItem } from '@/schemas/db'

type CollectionMediaType = 'album' | 'film'

const collectionColumns = {
  id: playlist.id,
  name: playlist.name,
  createdAt: playlist.createdAt,
}

const memberColumns = {
  position: playlistItem.position,
  title: mediaItem.title,
  artworkUrl: mediaItem.artworkUrl,
  releaseDate: mediaItem.releaseDate,
  source: mediaItem.sourceLabel,
}

const memberSortColumns = {
  position: playlistItem.position,
  title: sql`lower(${mediaItem.title})`,
  releaseDate: mediaItem.releaseDate,
  source: sql`lower(${mediaItem.sourceLabel})`,
}

function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

function collectionMembers<T extends SelectedFields>(
  mediaType: CollectionMediaType,
  columns: T,
) {
  const detail = mediaType === 'album' ? album : film
  return db
    .select({ ...columns, id: mediaItem.id })
    .from(playlistItem)
    .$dynamic()
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(detail, eq(detail.mediaItemId, mediaItem.id))
}

function collectionMemberCount(
  mediaType: CollectionMediaType,
  where: SQL | undefined,
) {
  const detail = mediaType === 'album' ? album : film
  return db
    .select({ count: count() })
    .from(playlistItem)
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(detail, eq(detail.mediaItemId, mediaItem.id))
    .where(where)
}

function visibleMember(
  mediaType: CollectionMediaType,
  scope: CatalogScopeQuery,
) {
  return and(
    eq(mediaItem.mediaType, mediaType),
    sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
    catalogScopeCondition(
      sql`${mediaItem.id}`,
      sql`${mediaItem.inLibrary}`,
      scope,
    ),
  )
}

const COLLECTION_LINK_BATCH = 100

async function collectionLinks(
  mediaType: CollectionMediaType,
  collections: readonly { id: string; name: string }[],
  scope: CatalogScopeQuery,
) {
  const links = new Map<string, SourceNavigationLink[]>()
  if (!collections.length) return links
  const names = new Map(
    collections.map((collection) => [
      collection.id,
      collection.name.toLowerCase(),
    ]),
  )
  const detail = mediaType === 'album' ? album : film
  const collectionIds = [...names.keys()]
  const collectionNames = [...new Set(names.values())]
  let after: string | undefined
  do {
    const members = await collectionMembers(mediaType, {
      collectionIds: sql<string[]>`array_agg(${playlistItem.playlistId})`,
    })
      .where(
        and(
          inArray(playlistItem.playlistId, collectionIds),
          visibleMember(mediaType, scope),
          after ? gt(mediaItem.id, after) : undefined,
        ),
      )
      .groupBy(mediaItem.id)
      .orderBy(asc(mediaItem.id))
      .limit(COLLECTION_LINK_BATCH)
    if (!members.length) break

    const items = await db
      .select({
        id: mediaItem.id,
        // Match detail's merge precedence and project only relevant collection entries.
        metadata: sql<Record<string, unknown>>`coalesce((
          select jsonb_object_agg(entry.key, jsonb_build_object('collections', matched.entries))
          from jsonb_each(
            (case when jsonb_typeof(${detail.metadata}) = 'object' then ${detail.metadata} else '{}'::jsonb end)
            || (case when jsonb_typeof(${mediaItem.metadata}) = 'object'
                then ${mediaItem.metadata} else '{}'::jsonb end)
          ) entry
          cross join lateral (
            select jsonb_agg(value) as entries
            from jsonb_array_elements(case when jsonb_typeof(entry.value->'collections') = 'array'
              then entry.value->'collections' else '[]'::jsonb end) value
            where ${matchingCollectionNames(sql`value->>'name'`, collectionNames)}
          ) matched
          where entry.key like 'plugin.%.details' and matched.entries is not null
        ), '{}'::jsonb)`,
      })
      .from(mediaItem)
      .innerJoin(detail, eq(detail.mediaItemId, mediaItem.id))
      .where(
        inArray(
          mediaItem.id,
          members.map((member) => member.id),
        ),
      )
    const byItem = await getCollectionSourceLinksForItems(
      items,
      mediaType,
      collectionNames,
    )
    for (const member of members) {
      for (const collectionId of member.collectionIds) {
        const existing = links.get(collectionId) ?? []
        for (const link of byItem.get(member.id) ?? [])
          if (
            link.name.toLowerCase() === names.get(collectionId) &&
            !existing.some((source) => source.url === link.url)
          )
            existing.push(link)
        links.set(collectionId, existing)
      }
    }

    after =
      members.length === COLLECTION_LINK_BATCH ? members.at(-1)?.id : undefined
  } while (after !== undefined)
  return links
}

function collectionMemberStatus(mediaType: CollectionMediaType) {
  const qualifying = collectionMembers(mediaType, {}).where(and(eq(playlistItem.playlistId, playlist.id), visibleMember(mediaType, {})))
  return sql<boolean>`(${playlist.addedToLibrary} or (${playlist.catalogProvider} is null and exists (${qualifying})))`
}

function matchingCollections(
  mediaType: CollectionMediaType,
  query: CollectionQuery,
) {
  const matchingMember = collectionMembers(mediaType, {}).where(
    and(
      eq(playlistItem.playlistId, playlist.id),
      visibleMember(mediaType, {libraryScope:'all'}),
    ),
  )
  return and(
    eq(playlist.kind, 'collection'),
    query.q ? ilike(playlist.name, containsPattern(query.q)) : undefined,
    exists(matchingMember),
    catalogScopeCondition(sql`${playlist.id}`, collectionMemberStatus(mediaType),query,'collection'),
  )
}

async function countCollections(
  mediaType: CollectionMediaType,
  query: CollectionQuery,
) {
  const [result] = await db
    .select({ totalCount: count() })
    .from(playlist)
    .where(matchingCollections(mediaType, query))
  return { totalCount: result?.totalCount ?? 0 }
}

export const countFilmCollections = (query: FilmCollectionBrowseQuery) =>
  countCollections('film', query)
export const countAlbumCollections = (query: AlbumCollectionBrowseQuery) =>
  countCollections('album', query)

async function listCollectionBrowsePage(
  mediaType: CollectionMediaType,
  query: FilmCollectionBrowseQuery | AlbumCollectionBrowseQuery,
) {
  const memberCountQuery = collectionMemberCount(
    mediaType,
    and(
      eq(playlistItem.playlistId, playlist.id),
      visibleMember(mediaType, query),
    ),
  )
  const memberCount = sql<number>`(${memberCountQuery})`.mapWith(Number)
  const name = sql`lower(${playlist.name})`
  const sortColumns = {
    name,
    albumCount: memberCount,
    filmCount: memberCount,
    createdAt: playlist.createdAt,
  }
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const rows = await db
    .select({ ...collectionColumns, memberCount, inLibrary: collectionMemberStatus(mediaType) })
    .from(playlist)
    .where(matchingCollections(mediaType, query))
    .orderBy(
      sql`${sortColumns[query.sortBy]} ${direction}`,
      ...(query.sortBy === 'name' ? [] : [name]),
      asc(playlist.id),
    )
    .limit(query.size + 1)
    .offset((query.page - 1) * query.size)
  const page = rows.slice(0, query.size)
  const links =
    query.includeSources === 'true'
      ? await collectionLinks(mediaType, page, query)
      : undefined
  return {
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
    items: page.map((row) => ({
      ...row,
      sourceLinks: links?.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
    })),
  }
}

export async function listFilmCollectionBrowsePage(
  query: FilmCollectionBrowseQuery,
) {
  const page = await listCollectionBrowsePage('film', query)
  return FilmCollectionBrowsePageSchema.parse({
    ...page,
    items: page.items.map((row) => ({ ...row, filmCount: row.memberCount })),
  })
}

export async function listAlbumCollectionBrowsePage(
  query: AlbumCollectionBrowseQuery,
) {
  const page = await listCollectionBrowsePage('album', query)
  return AlbumCollectionBrowsePageSchema.parse({
    ...page,
    items: page.items.map((row) => ({ ...row, albumCount: row.memberCount })),
  })
}

async function getCollectionPage<T extends SelectedFields>(
  mediaType: CollectionMediaType,
  id: string,
  query: CollectionQuery,
  columns: T,
  sort: SQLWrapper,
  filter?: SQLWrapper,
) {
  const membership = and(
    eq(playlistItem.playlistId, id),
    visibleMember(mediaType, query),
  )
  const knownMembers = collectionMembers(mediaType, {}).where(
    and(
      eq(playlistItem.playlistId, id),
      visibleMember(mediaType, { libraryScope: 'all' }),
    ),
  )
  const memberCountQuery = collectionMemberCount(mediaType, membership)
  const [summary] = await db
    .select({
      ...collectionColumns,
      inLibrary: collectionMemberStatus(mediaType),
      memberCount: sql<number>`(${memberCountQuery})`.mapWith(Number),
    })
    .from(playlist)
    .where(
      and(
        eq(playlist.id, id),
        eq(playlist.kind, 'collection'),
        exists(knownMembers),
      ),
    )
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Collection not found' })

  const members = and(membership, filter)
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const [matching] = filter
    ? await collectionMemberCount(mediaType, members)
    : []
  const totalCount = matching?.count ?? summary.memberCount
  const rows = await collectionMembers(mediaType, columns)
    .where(members)
    .orderBy(
      sql`${sort} ${direction} nulls last`,
      memberSortColumns.title,
      asc(mediaItem.id),
    )
    .limit(query.size)
    .offset((query.page - 1) * query.size)
  const links =
    query.includeSources === 'false'
      ? undefined
      : await collectionLinks(mediaType, [summary], { libraryScope: 'all' })
  return {
    ...summary,
    sourceLinks: links?.get(summary.id) ?? [],
    createdAt: summary.createdAt.toISOString(),
    items: {
      page: query.page,
      size: query.size,
      totalCount,
      pageCount: Math.ceil(totalCount / query.size),
      items: rows,
    },
  }
}

export async function getFilmCollection(
  id: string,
  query: FilmCollectionQuery,
) {
  const watchedStates =
    query.watchedStates ?? (query.watched ? [query.watched] : [])
  const dateAdded =
    sql<Date | null>`case when ${mediaItem.inLibrary} then coalesce(${film.dateAdded}, ${mediaItem.createdAt}) end`.mapWith(
      mediaItem.createdAt,
    )
  const sortColumns = {
    ...memberSortColumns,
    runtimeMinutes: film.runtimeMinutes,
    watched: film.watched,
    dateAdded,
  }
  const filter = and(
    query.q ? ilike(mediaItem.title, containsPattern(query.q)) : undefined,
    watchedStates.length
      ? inArray(
          film.watched,
          watchedStates.map((value) => value === 'watched'),
        )
      : undefined,
  )
  const collection = await getCollectionPage(
    'film',
    id,
    query,
    {
      ...memberColumns,
      runtimeMinutes: film.runtimeMinutes,
      watched: film.watched,
      dateAdded,
    },
    sortColumns[query.sortBy],
    filter,
  )
  return FilmCollectionDetailSchema.parse({
    ...collection,
    filmCount: collection.memberCount,
    items: {
      ...collection.items,
      items: collection.items.items.map((row) => ({
        ...row,
        releaseDate: toIsoString(row.releaseDate),
        dateAdded: toIsoString(row.dateAdded),
      })),
    },
  })
}

export async function getAlbumCollection(
  id: string,
  query: AlbumCollectionQuery,
) {
  const artistCredits = sql`from media_credit c join artist a on a.id = c.artist_id
    where c.media_item_id = ${mediaItem.id} and c.role = 'artist'`
  const artists = sql<
    string[]
  >`coalesce((select array_agg(a.name order by c.billing_order, a.name) ${artistCredits}), '{}')`
  const dateAdded =
    sql<Date | null>`case when ${mediaItem.inLibrary} then ${albumAddedDateExpression} end`.mapWith(
      album.dateAdded,
    )
  const sortColumns = {
    ...memberSortColumns,
    artists: sql`(select lower(a.name) ${artistCredits} order by c.billing_order, a.name limit 1)`,
    durationSec: album.durationSec,
    dateAdded,
  }
  const pattern = query.q ? containsPattern(query.q) : undefined
  const filter = pattern
    ? or(
        ilike(mediaItem.title, pattern),
        sql`exists (select 1 ${artistCredits} and a.name ilike ${pattern})`,
      )
    : undefined
  const collection = await getCollectionPage(
    'album',
    id,
    query,
    { ...memberColumns, artists, durationSec: album.durationSec, dateAdded },
    sortColumns[query.sortBy],
    filter,
  )
  return AlbumCollectionDetailSchema.parse({
    ...collection,
    albumCount: collection.memberCount,
    items: {
      ...collection.items,
      items: collection.items.items.map((row) => ({
        ...row,
        releaseDate: toIsoString(row.releaseDate),
        dateAdded: toIsoString(row.dateAdded),
      })),
    },
  })
}
