import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { normalizeTagName } from '@repo/schemas/tags'
import {
  albumsWithEnoughTags,
  matchingTagIds,
  mediaIdsWithArtistTag,
} from '@/services/music-tags'
import { parityDatabase, parityPool } from './harness'
import type { DataFacts } from './holes'

/** The data some Known holes depend on, read from PostgreSQL (DEVICE-33). */

const FoundSchema = z.object({ found: z.boolean() })
const KeysSchema = z.array(
  z.object({ media_type: z.string(), key: z.string() }),
)

/**
 * `pluginTextKeys`: the plugin fields declared as text. `tagValues`: the
 * Tags filter values the matrix uses.
 */
export async function readDataFacts(
  pluginTextKeys: ReadonlySet<string>,
  tagValues: readonly string[],
): Promise<DataFacts> {
  const archived = FoundSchema.parse(
    (
      await parityPool.query(`select exists (
        select 1 from media_item a
        join album on album.media_item_id = a.id
        join media_credit c on c.media_item_id = a.id and c.role = 'artist'
        join artist_provider_current_state s on s.artist_id = c.artist_id
        join artist_provider_snapshot p on p.id = s.latest_snapshot_id
        where a.in_library and a.metadata->>'legacyHidden' = 'true'
          and jsonb_array_length(coalesce(p.normalized_data->'tags', '[]')) > 0
          and not exists (
            select 1 from media_credit other
            join media_item o on o.id = other.media_item_id
            join album oa on oa.media_item_id = o.id
            where other.artist_id = c.artist_id and other.role = 'artist'
              and o.in_library and o.metadata->>'legacyHidden' is distinct from 'true')
      ) as found`)
    ).rows[0],
  ).found
  const keys = KeysSchema.parse(
    (
      await parityPool.query(`select distinct m.media_type::text as media_type, b.key
        from media_item m cross join lateral jsonb_each(m.metadata->'browse') b
        where m.in_library and m.media_type in ('album', 'film')
          and jsonb_typeof(b.value) = 'number'`)
    ).rows,
  )
  const numeric = (mediaType: string) =>
    new Set(
      keys
        .filter(
          (row) => row.media_type === mediaType && pluginTextKeys.has(row.key),
        )
        .map((row) => row.key),
    )
  const sonovaultUndecided = new Map<string, boolean>()
  for (const value of tagValues)
    sonovaultUndecided.set(value, await sonovaultUndecides(value))
  return {
    archivedOnlyArtistTags: archived,
    numericPluginText: { album: numeric('album'), film: numeric('film') },
    sonovaultUndecided,
  }
}

/**
 * The service's Auto Tags rule (trackIdsWithTag, music-tags.ts) reads the
 * Sonovault tags of every track; the store holds the published tracks'. The
 * answer is undecided on the device when no published track holds the tag
 * set from Sonovault and a visible library track with tags of its own would
 * inherit the tag without carrying it.
 */
async function sonovaultUndecides(filterValue: string): Promise<boolean> {
  // The service normalises a filter value before it reads the tag set.
  const value = normalizeTagName(filterValue)
  const result = await parityDatabase.execute(sql`
    with location_tags as materialized (${matchingTagIds(value)})
    select exists (select 1 from location_tags)
      and not exists (
        select 1 from track_tag tt
        join library_track lt on lt.media_item_id = tt.media_item_id
        join media_item mi on mi.id = lt.media_item_id
        where mi.in_library and tt.in_browse and tt.sonovault
          and tt.tag_id in (select id from location_tags))
      and exists (
        select 1 from library_track lt
        join media_item mi on mi.id = lt.media_item_id
        where mi.in_library and mi.metadata->>'legacyHidden' is distinct from 'true'
          and lt.has_own_tags
          and lt.media_item_id not in (select tt.media_item_id from track_tag tt
            where tt.in_browse and tt.tag_id in (select id from location_tags))
          and (lt.album_media_item_id in (select mt.media_item_id from media_item_tag mt
              where mt.tag_id in (select id from location_tags))
            or (lt.media_item_id in (select media_item_id from (${mediaIdsWithArtistTag(value)}) artists)
              and (lt.album_media_item_id is null
                or lt.album_media_item_id not in (${albumsWithEnoughTags()}))))) as undecided`)
  return z.object({ undecided: z.boolean() }).parse(result.rows[0]).undecided
}
