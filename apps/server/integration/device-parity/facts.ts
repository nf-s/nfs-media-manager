import { z } from 'zod'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { parityPool } from './harness'
import type { DataFacts } from './holes'

/** The data some Known holes depend on, read from PostgreSQL (DEVICE-33). */

const FoundSchema = z.object({ found: z.boolean() })
const KeysSchema = z.array(
  z.object({ media_type: z.string(), key: z.string() }),
)
const FoldRowsSchema = z.array(
  z.object({ code_point: z.number().int(), lower: z.string() }),
)

/** `pluginTextKeys`: the plugin fields declared as text. */
export async function readDataFacts(
  pluginTextKeys: ReadonlySet<string>,
): Promise<DataFacts> {
  // An archived album whose row carries artist tags (one of its artists has
  // snapshot tags) and that credits an artist no listed album credits.
  const archived = FoundSchema.parse(
    (
      await parityPool.query(`select exists (
        select 1 from media_item a
        join album on album.media_item_id = a.id
        where a.in_library and a.metadata->>'legacyHidden' = 'true'
          and exists (
            select 1 from media_credit tagged
            join artist_provider_current_state s on s.artist_id = tagged.artist_id
            join artist_provider_snapshot p on p.id = s.latest_snapshot_id
            where tagged.media_item_id = a.id and tagged.role = 'artist'
              and jsonb_array_length(coalesce(p.normalized_data->'tags', '[]')) > 0)
          and exists (
            select 1 from media_credit c
            where c.media_item_id = a.id and c.role = 'artist'
              and not exists (
                select 1 from media_credit other
                join media_item o on o.id = other.media_item_id
                join album oa on oa.media_item_id = o.id
                where other.artist_id = c.artist_id and other.role = 'artist'
                  and o.in_library and o.metadata->>'legacyHidden' is distinct from 'true'))
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
  const fold = FoldRowsSchema.parse(
    (
      await parityPool.query(`select c as code_point, lower(chr(c)) as lower
        from (select generate_series(1, 1114111) as c) code_point
        where (c < 55296 or c > 57343) and lower(chr(c)) <> chr(c)`)
    ).rows,
  )
  const { listBrowseFields } = await import('@/services/browse')
  const { providerDisplayNames } = await import('@/services/provider-names')
  const providers = [...(await providerDisplayNames()).values()]
  const texts = (fields: readonly { label: string }[]) => [
    ...fields.map((field) => `${field.label}:`),
    ...providers,
  ]
  return {
    archivedOnlyArtistTags: archived,
    numericPluginText: { album: numeric('album'), film: numeric('film') },
    fold: {
      lower: new Map(fold.map((row) => [row.code_point, row.lower])),
      yields: new Set(
        fold.flatMap((row) =>
          [...row.lower].map((character) => character.codePointAt(0) ?? 0),
        ),
      ),
    },
    facetTexts: {
      track: texts(await listBrowseFields('track')),
      album: texts(await listBrowseFields('album')),
      film: texts(await listBrowseFields('film')),
      artist: texts(artistBrowseFields),
    },
  }
}
