import { and, asc, count, eq, exists, ilike, inArray, sql } from 'drizzle-orm'
import {
  FilmCollectionBrowsePageSchema,
  FilmCollectionDetailSchema,
  type FilmCollectionBrowseQuery,
  type FilmCollectionQuery,
  type FilmCollectionSummary,
} from '@repo/schemas/film-collections'
import type { SourceNavigationLink } from '@repo/schemas/tags'
import { getCollectionSourceLinksForItems } from './source-navigation'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { film, mediaItem, playlist, playlistItem } from '@/schemas/db'

const summaryColumns = {
  id: playlist.id,
  name: playlist.name,
  createdAt: playlist.createdAt,
  filmCount: count(),
}

const visibleFilm = and(
  eq(mediaItem.mediaType, 'film'),
  sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
)

function containsPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}

const COLLECTION_LINK_BATCH = 100

async function collectionLinks(
  collections: readonly Pick<FilmCollectionSummary, 'id' | 'name'>[],
) {
  const links = new Map<string, SourceNavigationLink[]>()
  if (!collections.length) return links
  const names = new Map(
    collections.map((collection) => [
      collection.id,
      collection.name.toLowerCase(),
    ]),
  )
  const collectionsByItem = new Map<string, string[]>()
  const collectionIds = [...names.keys()]
  // Membership carries IDs only: films shared by collections must not repeat metadata.
  for (
    let offset = 0;
    offset < collectionIds.length;
    offset += COLLECTION_LINK_BATCH
  ) {
    const members = await db
      .select({ collectionId: playlistItem.playlistId, id: mediaItem.id })
      .from(playlistItem)
      .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
      .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
      .where(
        and(
          inArray(
            playlistItem.playlistId,
            collectionIds.slice(offset, offset + COLLECTION_LINK_BATCH),
          ),
          visibleFilm,
        ),
      )
    for (const member of members) {
      const memberships = collectionsByItem.get(member.id) ?? []
      memberships.push(member.collectionId)
      collectionsByItem.set(member.id, memberships)
    }
  }
  const itemIds = [...collectionsByItem.keys()]
  for (
    let offset = 0;
    offset < itemIds.length;
    offset += COLLECTION_LINK_BATCH
  ) {
    const items = await db
      .select({
        id: mediaItem.id,
        // The generic reader only consumes collections within plugin detail objects.
        metadata: sql<Record<string, unknown>>`coalesce((
          select jsonb_object_agg(detail.key, jsonb_build_object('collections', detail.value->'collections'))
          from jsonb_each(case when jsonb_typeof(${mediaItem.metadata}) = 'object'
            then ${mediaItem.metadata} else '{}'::jsonb end) detail
          where jsonb_typeof(detail.value->'collections') = 'array'
        ), '{}'::jsonb)`,
      })
      .from(mediaItem)
      .where(
        inArray(
          mediaItem.id,
          itemIds.slice(offset, offset + COLLECTION_LINK_BATCH),
        ),
      )
    const byItem = await getCollectionSourceLinksForItems(items)
    for (const [id, sources] of byItem)
      for (const collectionId of collectionsByItem.get(id) ?? []) {
        const existing = links.get(collectionId) ?? []
        for (const link of sources)
          if (
            link.name.toLowerCase() === names.get(collectionId) &&
            !existing.some((source) => source.url === link.url)
          )
            existing.push(link)
        links.set(collectionId, existing)
      }
  }
  return links
}

function collectionFilmCount() {
  return db
    .select({ value: count() })
    .from(playlistItem)
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(and(eq(playlistItem.playlistId, playlist.id), visibleFilm))
}

function matchingCollections(query: FilmCollectionBrowseQuery) {
  const matchingFilm = db
    .select({ id: playlistItem.mediaItemId })
    .from(playlistItem)
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(and(eq(playlistItem.playlistId, playlist.id), visibleFilm))
  return and(
    eq(playlist.kind, 'collection'),
    query.q ? ilike(playlist.name, containsPattern(query.q)) : undefined,
    exists(matchingFilm),
  )
}

export async function countFilmCollections(query: FilmCollectionBrowseQuery) {
  const [result] = await db
    .select({ totalCount: count() })
    .from(playlist)
    .where(matchingCollections(query))
  return { totalCount: result?.totalCount ?? 0 }
}

export async function listFilmCollectionBrowsePage(
  query: FilmCollectionBrowseQuery,
) {
  const filmCount = sql<number>`(${collectionFilmCount()})`.mapWith(Number)
  const name = sql`lower(${playlist.name})`
  const sortColumns = { name, filmCount, createdAt: playlist.createdAt }
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const rows = await db
    .select({ ...summaryColumns, filmCount })
    .from(playlist)
    .where(matchingCollections(query))
    .orderBy(
      sql`${sortColumns[query.sortBy]} ${direction}`,
      ...(query.sortBy === 'name' ? [] : [name]),
      asc(playlist.id),
    )
    .limit(query.size + 1)
    .offset((query.page - 1) * query.size)
  const page = rows.slice(0, query.size)
  const links =
    query.includeSources === 'true' ? await collectionLinks(page) : undefined
  return FilmCollectionBrowsePageSchema.parse({
    page: query.page,
    size: query.size,
    hasMore: rows.length > query.size,
    items: page.map((row) => ({
      ...row,
      sourceLinks: links?.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
    })),
  })
}

export async function getFilmCollection(
  id: string,
  query: FilmCollectionQuery,
) {
  const [summary] = await db
    .select(summaryColumns)
    .from(playlist)
    .innerJoin(playlistItem, eq(playlistItem.playlistId, playlist.id))
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(
      and(eq(playlist.id, id), eq(playlist.kind, 'collection'), visibleFilm),
    )
    .groupBy(playlist.id)
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Collection not found' })

  const watchedStates =
    query.watchedStates ?? (query.watched ? [query.watched] : [])
  const dateAdded =
    sql<Date>`coalesce(${film.dateAdded}, ${mediaItem.createdAt})`.mapWith(
      mediaItem.createdAt,
    )
  const sortColumns = {
    position: playlistItem.position,
    title: sql`lower(${mediaItem.title})`,
    releaseDate: mediaItem.releaseDate,
    runtimeMinutes: film.runtimeMinutes,
    watched: film.watched,
    source: sql`lower(${mediaItem.sourceLabel})`,
    dateAdded,
  }
  const direction = query.direction === 'asc' ? sql`asc` : sql`desc`
  const members = and(
    eq(playlistItem.playlistId, id),
    visibleFilm,
    query.q ? ilike(mediaItem.title, containsPattern(query.q)) : undefined,
    watchedStates.length
      ? inArray(
          film.watched,
          watchedStates.map((value) => value === 'watched'),
        )
      : undefined,
  )
  const [matching] = await db
    .select({ count: count() })
    .from(playlistItem)
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(members)
  const totalCount = matching?.count ?? 0
  const rows = await db
    .select({
      id: mediaItem.id,
      position: playlistItem.position,
      title: mediaItem.title,
      artworkUrl: mediaItem.artworkUrl,
      releaseDate: mediaItem.releaseDate,
      runtimeMinutes: film.runtimeMinutes,
      watched: film.watched,
      source: mediaItem.sourceLabel,
      dateAdded,
    })
    .from(playlistItem)
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(members)
    .orderBy(
      sql`${sortColumns[query.sortBy]} ${direction} nulls last`,
      sql`lower(${mediaItem.title})`,
      asc(mediaItem.id),
    )
    .limit(query.size)
    .offset((query.page - 1) * query.size)
  const links =
    query.includeSources === 'false'
      ? undefined
      : await collectionLinks([summary])

  return FilmCollectionDetailSchema.parse({
    ...summary,
    sourceLinks: links?.get(summary.id) ?? [],
    createdAt: summary.createdAt.toISOString(),
    items: {
      page: query.page,
      size: query.size,
      totalCount,
      pageCount: Math.ceil(totalCount / query.size),
      items: rows.map((row) => ({
        ...row,
        releaseDate: row.releaseDate?.toISOString() ?? null,
        dateAdded: row.dateAdded.toISOString(),
      })),
    },
  })
}
