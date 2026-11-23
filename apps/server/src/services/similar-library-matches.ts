import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  normalizeSimilarGenres,
  type TidalSimilarKind,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { upcVariants } from './spotify-code-search'

type Reader = Pick<typeof db, 'execute'>

const LibraryRowSchema = z.object({
  code: z.string(),
  id: z.string(),
  title: z.string(),
  artwork_url: z.string().nullable(),
  spotify_id: z.string().nullable(),
  album_id: z.string().nullable(),
  album_title: z.string().nullable(),
  album_name: z.string().nullable(),
  track_count: z.number().int().nullable(),
})
export type SimilarLibraryItem = {
  id: string
  title: string
  artworkUrl: string | null
  spotifyId: string | null
  album: { id: string; title: string } | null
  albumName: string | null
  trackCount: number | null
}

const visible = (alias: string) =>
  sql.raw(`${alias}.metadata->>'legacyHidden' is distinct from 'true'`)

const spotifyAlbumIdFromUrl = sql`substring(a.spotify_url from '/album/([A-Za-z0-9]{22})')`

function toItem(row: z.infer<typeof LibraryRowSchema>): SimilarLibraryItem {
  return {
    id: row.id,
    title: row.title,
    artworkUrl: row.artwork_url,
    spotifyId: row.spotify_id,
    album:
      row.album_id && row.album_title
        ? { id: row.album_id, title: row.album_title }
        : null,
    albumName: row.album_name,
    trackCount: row.track_count,
  }
}

function collect(rows: unknown[]) {
  const items = new Map<string, SimilarLibraryItem>()
  for (const row of z.array(LibraryRowSchema).parse(rows))
    if (!items.has(row.code)) items.set(row.code, toItem(row))
  return items
}

/**
 * Library tracks by ISRC reference, or library albums by UPC reference with
 * leading zeros ignored, keyed by the code as given (an ISRC, or a UPC key
 * without leading zeros). The earliest library item wins.
 */
export async function libraryItemsByCode(
  database: Reader,
  kind: TidalSimilarKind,
  codes: readonly string[],
): Promise<Map<string, SimilarLibraryItem>> {
  if (!codes.length) return new Map()
  if (kind === 'track') {
    const result = await database.execute(sql`
      select r.external_id as code, m.id, m.title,
        coalesce(m.artwork_url, am.artwork_url) as artwork_url,
        lt.spotify_track_id as spotify_id, am.id as album_id,
        am.title as album_title, lt.album_name, null::integer as track_count
      from provider_reference r
      join media_item m on m.id = r.media_item_id and m.media_type = 'track'
      join library_track lt on lt.media_item_id = m.id
      left join media_item am on am.id = lt.album_media_item_id
      where r.reference_type = 'isrc'
        and r.external_id = any(${sql.param([...codes])}::text[])
        and ${visible('m')}
      order by m.created_at, m.id`)
    return collect(result.rows)
  }
  const variants = codes.flatMap((code) =>
    upcVariants(code).map((variant) => ({ variant, code })),
  )
  const keyOf = new Map(variants.map(({ variant, code }) => [variant, code]))
  const result = await database.execute(sql`
    select r.external_id as code, m.id, m.title, m.artwork_url,
      ${spotifyAlbumIdFromUrl} as spotify_id, null as album_id,
      null as album_title, null as album_name, a.track_count
    from provider_reference r
    join media_item m on m.id = r.media_item_id and m.media_type = 'album'
    join album a on a.media_item_id = m.id
    where r.reference_type = 'upc'
      and r.external_id = any(${sql.param(variants.map(({ variant }) => variant))}::text[])
      and ${visible('m')}
    order by m.created_at, m.id`)
  return collect(
    result.rows.map((row) => {
      const parsed = z.object({ code: z.string() }).passthrough().parse(row)
      return { ...parsed, code: keyOf.get(parsed.code) ?? parsed.code }
    }),
  )
}

/** Library tracks or albums by their Spotify ID. */
export async function libraryItemsBySpotifyId(
  database: Reader,
  kind: TidalSimilarKind,
  spotifyIds: readonly string[],
): Promise<Map<string, SimilarLibraryItem>> {
  if (!spotifyIds.length) return new Map()
  const ids = sql.param([...spotifyIds])
  const result =
    kind === 'track'
      ? await database.execute(sql`
          select lt.spotify_track_id as code, m.id, m.title,
            coalesce(m.artwork_url, am.artwork_url) as artwork_url,
            lt.spotify_track_id as spotify_id, am.id as album_id,
            am.title as album_title, lt.album_name,
            null::integer as track_count
          from library_track lt
          join media_item m on m.id = lt.media_item_id
          left join media_item am on am.id = lt.album_media_item_id
          where lt.spotify_track_id = any(${ids}::text[]) and ${visible('m')}
          order by m.created_at, m.id`)
      : await database.execute(sql`
          select r.external_id as code, m.id, m.title, m.artwork_url,
            r.external_id as spotify_id, null as album_id,
            null as album_title, null as album_name, a.track_count
          from provider_reference r
          join media_item m on m.id = r.media_item_id and m.media_type = 'album'
          join album a on a.media_item_id = m.id
          where r.provider = 'spotify' and r.reference_type in ('album', 'spotify')
            and r.external_id = any(${ids}::text[]) and ${visible('m')}
          order by m.created_at, m.id`)
  return collect(result.rows)
}

/** Library items with a TIDAL reference to this exact suggestion. */
export async function libraryItemsByTidalId(
  database: Reader,
  kind: TidalSimilarKind,
  tidalIds: readonly string[],
): Promise<Map<string, SimilarLibraryItem>> {
  if (!tidalIds.length) return new Map()
  const ids = sql.param([...tidalIds])
  const result =
    kind === 'track'
      ? await database.execute(sql`
          select r.external_id as code, m.id, m.title,
            coalesce(m.artwork_url, am.artwork_url) as artwork_url,
            lt.spotify_track_id as spotify_id, am.id as album_id,
            am.title as album_title, lt.album_name,
            null::integer as track_count
          from provider_reference r
          join media_item m on m.id = r.media_item_id and m.media_type = 'track'
          join library_track lt on lt.media_item_id = m.id
          left join media_item am on am.id = lt.album_media_item_id
          where r.provider = 'tidal' and r.reference_type = 'track'
            and r.external_id = any(${ids}::text[]) and ${visible('m')}
          order by m.created_at, m.id`)
      : await database.execute(sql`
          select r.external_id as code, m.id, m.title, m.artwork_url,
            ${spotifyAlbumIdFromUrl} as spotify_id, null as album_id,
            null as album_title, null as album_name, a.track_count
          from provider_reference r
          join media_item m on m.id = r.media_item_id and m.media_type = 'album'
          join album a on a.media_item_id = m.id
          where r.provider = 'tidal' and r.reference_type = 'album'
            and r.external_id = any(${ids}::text[]) and ${visible('m')}
          order by m.created_at, m.id`)
  return collect(result.rows)
}

const GenreRowsSchema = z.array(
  z.object({
    id: z.string(),
    source: z.enum(['track', 'album', 'member-tracks']),
    names: z.array(z.string()),
  }),
)

/** Read genre tags for the matched library items and exact Spotify album members. */
export async function librarySimilarGenres(
  database: Reader,
  input: {
    trackIds: readonly string[]
    albumIds: readonly string[]
    spotifyAlbumIds: readonly string[]
  },
) {
  const genres = {
    track: new Map<string, string[]>(),
    album: new Map<string, string[]>(),
    'member-tracks': new Map<string, string[]>(),
  }
  const { trackIds, albumIds, spotifyAlbumIds } = input
  if (!trackIds.length && !albumIds.length && !spotifyAlbumIds.length)
    return genres
  const exactKinds = sql`('genre', 'subgenre', 'style')`
  const result = await database.execute(sql`
    select tt.media_item_id as id, 'track' as source,
      coalesce(array_agg(distinct t.name order by t.name)
        filter (where tt.in_browse and not t.hidden), '{}') as names
    from track_tag tt
    join tag t on t.id = tt.tag_id
    where tt.media_item_id = any(${sql.param([...trackIds])}::text[])
      and (tt.owner = 'removed' or (
        tt.in_browse and (t.kind in ${exactKinds} or (tt.sonovault and tt.verified))
      ))
    group by tt.media_item_id
    union all
    select mt.media_item_id, 'album',
      array_agg(distinct t.name order by t.name)
    from media_item_tag mt
    join tag t on t.id = mt.tag_id
    join media_item m on m.id = mt.media_item_id
    where mt.media_item_id = any(${sql.param([...albumIds])}::text[])
      and not t.hidden and ${visible('m')}
      and (t.kind in ${exactKinds} or exists (
        select 1 from tag_occurrence o
        where o.tag_id = t.id and o.media_item_id = mt.media_item_id
          and o.kind in ${exactKinds}
      ))
    group by mt.media_item_id
    union all
    select lt.spotify_album_id, 'member-tracks',
      array_agg(distinct t.name order by t.name)
    from library_track lt
    join media_item m on m.id = lt.media_item_id
    join track_tag tt on tt.media_item_id = lt.media_item_id
    join tag t on t.id = tt.tag_id
    where lt.spotify_album_id = any(${sql.param([...spotifyAlbumIds])}::text[])
      and ${visible('m')} and not t.hidden and tt.in_browse
      and tt.sonovault and tt.verified
    group by lt.spotify_album_id`)
  for (const row of GenreRowsSchema.parse(result.rows))
    genres[row.source].set(row.id, normalizeSimilarGenres(row.names))
  return genres
}
