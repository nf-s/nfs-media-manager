import { z } from 'zod'
import { parityPool } from './harness'
import type { DataFacts } from './holes'

/** The data some Known holes depend on, read from PostgreSQL (DEVICE-33). */

const FoundSchema = z.object({ found: z.boolean() })
const KeysSchema = z.array(
  z.object({ media_type: z.string(), key: z.string() }),
)

/** `pluginTextKeys`: the plugin fields declared as text. */
export async function readDataFacts(
  pluginTextKeys: ReadonlySet<string>,
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
  return {
    archivedOnlyArtistTags: archived,
    numericPluginText: { album: numeric('album'), film: numeric('film') },
  }
}
