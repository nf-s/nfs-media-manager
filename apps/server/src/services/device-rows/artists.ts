import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import { DeviceArtistRowSchema } from '@repo/schemas/device'
import { db } from '@/lib/db'
import { normalizedTagSql } from '@/lib/tag-sql'
import {
  artistMusicCounts,
  artistNameOrder,
  artistTextOrderRows,
  loadArtists,
  numericValue,
  scopedArtists,
  textRows,
} from '../artist-browse'
import { artistPlaylistCredits, visiblePlaylist } from '../artist-library'
import {
  anyId,
  microseconds,
  readProjection,
  textValues,
  toJson,
  type JsonObject,
  type ProjectionPart,
  type ProjectionScalar,
} from './projection'

/** Artist rows: the Artists list item and the Artists Browse values. */

const defaultScope: CatalogScopeQuery = {}
const published = scopedArtists(defaultScope)

const IdRowsSchema = z.array(z.object({ id: z.string() }))

export async function listArtistIds(afterId: string | null, limit: number) {
  const result = await db.execute(sql`select a.id from artist a
    where ${published} ${afterId === null ? sql`` : sql`and a.id collate "C" > ${afterId}`}
    order by a.id collate "C" limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

/**
 * The batch's visible playlists through artistPlaylistCredits, read once:
 * textRows('playlist'), its sort, playlistIds and artistPlaylistCounts are
 * this membership.
 */
const batchPlaylists = sql`select id, playlist_id, value from device_artist_playlists`

function artistProjection(ids: SQL) {
  const scalars: ProjectionScalar[] = [['sort.name', artistNameOrder]]
  const parts: ProjectionPart[] = [
    { path: 'text.playlist', rows: textValues(batchPlaylists, ids) },
    {
      path: 'sort.playlist',
      rows: sql`select id, to_jsonb(min(lower(value))) as value
        from (${batchPlaylists}) playlists group by id`,
    },
  ]
  for (const field of artistBrowseFields) {
    if (field.type !== 'text') {
      const value = numericValue(field.key)
      scalars.push([
        `num.${field.key}`,
        field.type === 'date' ? microseconds(value) : value,
      ])
      continue
    }
    if (field.key === 'playlist') continue
    parts.push({
      path: `text.${field.key}`,
      rows: textValues(textRows(field.key), ids),
    })
    if (field.key !== 'name')
      parts.push({
        path: `sort.${field.key}`,
        rows: sql`select o.id, to_jsonb(o.value) as value
          from (${artistTextOrderRows(field.key)}) o where o.id = ${ids}`,
      })
  }
  parts.push(
    {
      path: 'search.name',
      rows: textValues(
        sql`select a.id, a.name as value from artist a
          union all select a.id, a.sort_name from artist a`,
        ids,
      ),
    },
    {
      path: 'extra.rawTagKeys',
      rows: textValues(
        sql`select tags.id, ${normalizedTagSql(sql`tags.value`)} as value
          from (${textRows('genre')}) tags`,
        ids,
      ),
    },
    {
      path: 'extra.playlistIds',
      rows: textValues(
        sql`select id, playlist_id as value from (${batchPlaylists}) playlists`,
        ids,
      ),
    },
  )
  return {
    with: sql`device_artist_playlists as materialized (
      select credits.artist_id as id, playlist.id as playlist_id, playlist.name as value
      from (${artistPlaylistCredits(ids)}) credits
      join playlist on playlist.id = credits.playlist_id where ${visiblePlaylist})`,
    id: sql`a.id`,
    from: sql`from artist a
      left join (select * from (${artistMusicCounts}) counts where counts.artist_id = ${ids}) music_counts
        on music_counts.artist_id = a.id
      left join (select id as artist_id, count(distinct playlist_id)::int as playlist_count
        from (${batchPlaylists}) playlists group by id) playlist_counts
        on playlist_counts.artist_id = a.id`,
    where: sql`a.id = ${ids} and ${published}`,
    scalars,
    parts,
  }
}

function artistDefaults(): JsonObject {
  const { shape } = DeviceArtistRowSchema
  const section = (keys: string[], value: () => JsonObject[string]) =>
    Object.fromEntries(keys.map((key) => [key, value()]))
  return {
    text: section(Object.keys(shape.text.shape), () => []),
    search: section(Object.keys(shape.search.shape), () => []),
    num: section(Object.keys(shape.num.shape), () => null),
    sort: section(Object.keys(shape.sort.shape), () => null),
    extra: { rawTagKeys: [], playlistIds: [] },
  }
}

export async function renderArtists(
  ids: string[],
): Promise<Map<string, JsonObject>> {
  const [projections, items] = await Promise.all([
    readProjection(artistProjection(anyId(ids)), artistDefaults),
    loadArtists(ids, undefined, { includeListeningMonths: false }),
  ])
  const payloads = new Map<string, JsonObject>()
  for (const item of items) {
    const projection = projections.get(item.id)
    if (projection) payloads.set(item.id, { ...projection, item: toJson(item) })
  }
  return payloads
}
