import { z } from 'zod'
import type { LibraryRead } from '@repo/library-source'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import {
  LibraryPlaylistLibrarySchema,
  LibraryPlaylistViewSchema,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistView,
} from '@repo/schemas/browse'
import {
  parseLibraryBrowseView,
  type LibraryBrowseQuery,
} from '@repo/schemas/library-playlists'
import { parityPool, readApi } from './harness'
import { expectedHole, type DataFacts } from './holes'
import { apiPath } from './matrix'

/** The data some Known holes depend on, read from PostgreSQL (DEVICE-33). */

const FoundSchema = z.object({ found: z.boolean() })
const KeysSchema = z.array(
  z.object({ media_type: z.string(), key: z.string() }),
)
const FoldRowsSchema = z.array(
  z.object({ code_point: z.number().int(), lower: z.string() }),
)
const LibraryPlaylistRowsSchema = z.array(
  z.object({
    id: z.string(),
    library: LibraryPlaylistLibrarySchema,
    name: z.string(),
    view: LibraryPlaylistViewSchema.nullable(),
  }),
)

/** The view without the parameters that only order it, as the directory counts it. */
function countCriteria(view: LibraryPlaylistView): LibraryPlaylistView {
  return Object.fromEntries(
    Object.entries(view).filter(
      ([key]) => !['sortBy', 'direction', 'listeningSort'].includes(key),
    ),
  )
}

/** The count read of a parsed view and its route, for the libraries the device reads. */
function countRead(
  browse: LibraryBrowseQuery,
): { read: LibraryRead; route: string } | undefined {
  switch (browse.library) {
    case 'tracks':
      return {
        read: { method: 'trackCount', query: browse.query },
        route: 'tracks/browse-count',
      }
    case 'albums':
      return {
        read: { method: 'albumCount', query: browse.query },
        route: 'albums/browse-count',
      }
    case 'films':
      return {
        read: { method: 'filmCount', query: browse.query },
        route: 'films/browse-count',
      }
    case 'subscriptions':
    case 'mixes':
      return undefined
  }
}

/**
 * Known holes, `smart-count`: a library is countable when each smart
 * playlist of it that is not deleted and whose view without its ordering
 * parses has a count read the device serves (no Known hole holds for it,
 * as the API answers the same count path). Subscriptions and Mixes have no
 * count read on the device.
 */
async function readSmartCountable(
  rows: z.infer<typeof LibraryPlaylistRowsSchema>,
  facts: DataFacts,
): Promise<Record<LibraryPlaylistLibrary, boolean>> {
  const countable = allCountable()
  for (const row of rows) {
    if (row.view === null) continue
    const criteria = countCriteria(row.view)
    const parsed = parseLibraryBrowseView(row.library, criteria)
    if (!parsed.success) continue
    const count = countRead(parsed.data)
    if (count === undefined) {
      countable[row.library] = false
      continue
    }
    const answer = await readApi(apiPath(count.route, criteria))
    const hole = await expectedHole(count.read, {
      ...answer,
      facts,
      readApi,
    })
    if (hole !== undefined) countable[row.library] = false
  }
  return countable
}

const allCountable = (): Record<LibraryPlaylistLibrary, boolean> => ({
  albums: true,
  tracks: true,
  films: true,
  subscriptions: true,
  mixes: true,
})

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
  const libraryPlaylists = LibraryPlaylistRowsSchema.parse(
    (
      await parityPool.query(`select id, library, name, view from library_playlist
        where deleted_at is null order by id`)
    ).rows,
  )
  const facts: DataFacts = {
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
    playlistNames: new Map(libraryPlaylists.map((row) => [row.id, row.name])),
    // Replaced below: the count reads it decides never read it.
    smartCountable: allCountable(),
  }
  return {
    ...facts,
    smartCountable: await readSmartCountable(libraryPlaylists, facts),
  }
}
