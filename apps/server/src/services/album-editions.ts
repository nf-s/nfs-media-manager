import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { AlbumEdition } from '@repo/schemas/media'
import { db } from '@/lib/db'

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )

const CountRowsSchema = z.array(
  z.object({ id: z.string(), count: z.number().int().nonnegative() }),
)

/** How many editions each of the given first albums has. */
export async function readEditionCounts(albumIds: string[]) {
  if (!albumIds.length) return new Map<string, number>()
  return new Map(
    CountRowsSchema.parse(
      (
        await db.execute(sql`
          select edition_of_id as id, count(*)::int as count from album
          where edition_of_id in (${idList(albumIds)})
          group by edition_of_id`)
      ).rows,
    ).map((row) => [row.id, row.count]),
  )
}

const EditionRowsSchema = z.array(
  z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    artworkUrl: z.string().nullable(),
    releaseDate: z.string().nullable(),
    trackCount: z.number().int().nonnegative(),
    scrobbles: z.number().int().nonnegative(),
  }),
)

async function readEditions(condition: SQL) {
  return EditionRowsSchema.parse(
    (
      await db.execute(sql`
        select mi.id, mi.slug, mi.title, mi.artwork_url as "artworkUrl",
          to_char(mi.release_date, 'YYYY-MM-DD') as "releaseDate",
          al.track_count as "trackCount",
          (select count(*)::int from lastfm_scrobble s
            where s.album_media_item_id = al.media_item_id) as scrobbles
        from album al join media_item mi on mi.id = al.media_item_id
        where ${condition}
        order by mi.release_date nulls last, mi.title, mi.id`)
    ).rows,
  )
}

/**
 * The record an album belongs to: for a first album its editions, for an
 * edition its first album.
 */
export async function readAlbumRecord(
  albumId: string,
  editionOfId: string | null,
): Promise<{ editions: AlbumEdition[]; editionOf: AlbumEdition | null }> {
  if (editionOfId) {
    const [first] = await readEditions(sql`al.media_item_id = ${editionOfId}`)
    return { editions: [], editionOf: first ?? null }
  }
  return {
    editions: await readEditions(sql`al.edition_of_id = ${albumId}`),
    editionOf: null,
  }
}
