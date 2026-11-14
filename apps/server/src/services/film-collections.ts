import { and, asc, count, eq, sql } from 'drizzle-orm'
import {
  FilmCollectionDetailSchema,
  FilmCollectionSummarySchema,
  type FilmCollectionQuery,
} from '@repo/schemas/film-collections'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { film, mediaItem, playlist, playlistItem } from '@/schemas/db'

const summaryColumns = {
  id: playlist.id,
  name: playlist.name,
  createdAt: playlist.createdAt,
  filmCount: count(),
}

/** Only collections with film members; music playlists cannot appear here. */
export async function listFilmCollections() {
  const rows = await db
    .select(summaryColumns)
    .from(playlist)
    .innerJoin(playlistItem, eq(playlistItem.playlistId, playlist.id))
    .innerJoin(mediaItem, eq(mediaItem.id, playlistItem.mediaItemId))
    .innerJoin(film, eq(film.mediaItemId, mediaItem.id))
    .where(
      and(eq(playlist.kind, 'collection'), eq(mediaItem.mediaType, 'film')),
    )
    .groupBy(playlist.id)
    .orderBy(sql`lower(${playlist.name})`, asc(playlist.id))
  return rows.map((row) =>
    FilmCollectionSummarySchema.parse({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }),
  )
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
      and(
        eq(playlist.id, id),
        eq(playlist.kind, 'collection'),
        eq(mediaItem.mediaType, 'film'),
      ),
    )
    .groupBy(playlist.id)
  if (!summary)
    throw new ServerError({ statusCode: 404, message: 'Collection not found' })

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
    .where(
      and(eq(playlistItem.playlistId, id), eq(mediaItem.mediaType, 'film')),
    )
    .orderBy(
      sql`${sortColumns[query.sortBy]} ${direction} nulls last`,
      sql`lower(${mediaItem.title})`,
      asc(mediaItem.id),
    )
    .limit(query.size)
    .offset((query.page - 1) * query.size)

  return FilmCollectionDetailSchema.parse({
    ...summary,
    createdAt: summary.createdAt.toISOString(),
    items: {
      page: query.page,
      size: query.size,
      totalCount: summary.filmCount,
      pageCount: Math.ceil(summary.filmCount / query.size),
      items: rows.map((row) => ({
        ...row,
        releaseDate: row.releaseDate?.toISOString() ?? null,
        dateAdded: row.dateAdded.toISOString(),
      })),
    },
  })
}
