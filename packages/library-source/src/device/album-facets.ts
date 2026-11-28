import { z } from 'zod'
import {
  albumBrowseFields,
  type ArchivableBrowseFacetQuery,
  type BrowseField,
  type TagLevels,
} from '@repo/schemas/browse'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import type { SqliteExecutor } from '../driver'
import type { AlbumFilterOption } from '../source'
import { readBrowseFields } from '../compile/fields'
import {
  browseTagFacetFields,
  facetMatch,
  keepValues,
  readFacets,
  suggestsFilterableText,
  tagFacetValues,
  wantedFacetValues,
  withPluginFacetSources,
  type FacetSource,
  type FacetTable,
} from '../compile/facets'
import { isMemberScope } from '../compile/query'
import { TRUE, or, readRows, sql, type Sql } from '../compile/sql'
import { unsupported } from '../compile/unsupported'
import type { DeviceRead } from './read'

/**
 * Albums suggestions, `GET /albums/facets`: listAlbumFilterOptions,
 * media.ts, which is listBrowseFacets('album') and browseFacetQuery,
 * browse.ts. Text fields count albums per stored value; Tags, Album tags
 * and Artist tags count albums per tag key with each key's visible
 * ancestors, as albumTagFacetRows does. Editions are counted; archived
 * albums only with `includeArchived`.
 */

/** Per tag key, the albums carrying it: release tags, artist tags, and Tags at the query's location. */
type TagCounts = { release: number; artist: number; tags: number }

type AlbumFacetContext = {
  tagCounts: () => Promise<Map<string, TagCounts>>
}

const tagFields = ['genre', 'albumTag', 'artistTag']

function visibleAlbums(includeArchived: boolean): Sql {
  return includeArchived ? TRUE : sql`t.archived = 0`
}

function text(field: string, visible: Sql): FacetSource<AlbumFacetContext> {
  return { kind: 'text', field, from: sql`album t`, visible }
}

function counted(
  count: (counts: TagCounts) => number,
): FacetSource<AlbumFacetContext> {
  return {
    kind: 'counted',
    read: async (context) =>
      [...(await context.tagCounts())].flatMap(([value, counts]) => {
        const total = count(counts)
        return total > 0 ? [{ value, count: total }] : []
      }),
  }
}

/** The facet table for one query: visibility depends on `includeArchived`. */
function albumFacetTable(
  fields: readonly BrowseField[],
  includeArchived: boolean,
): FacetTable<AlbumFacetContext> {
  const visible = visibleAlbums(includeArchived)
  const table: FacetTable<AlbumFacetContext> = {
    entity: 'album',
    sources: {
      title: text('title', visible),
      artist: text('artist', visible),
      country: text('country', visible),
      playlist: text('playlist', visible),
      collection: text('collection', visible),
      source: text('source', visible),
      provider: text('provider', visible),
      edition: text('edition', visible),
      genre: counted((counts) => counts.tags),
      albumTag: counted((counts) => counts.release),
      artistTag: counted((counts) => counts.artist),
    },
    tagFields: browseTagFacetFields,
    subtagMediaType: 'album',
  }
  return withPluginFacetSources(table, fields, albumBrowseFields, (field) =>
    text(field, visible),
  )
}

/**
 * Whether Tags at the query's location reads artist tags: at Auto (on an
 * album with too few release tags) and at any location with Artist.
 */
function tagsReadArtistTags(levels: TagLevels | undefined): boolean {
  return levels === undefined || levels.includes('artist')
}

/**
 * artistTagFacetKeys('album'), music-tags.ts, reads the tags of artists
 * credited on an album that is not archived (in or out of the library). An
 * archived album's artist tags therefore leave out an artist credited on
 * archived albums only, while the row holds the labels of all its artists
 * together. The device cannot tell those apart, so with `includeArchived`
 * the read falls through when any archived album with artist tags credits
 * an artist no listed album credits.
 */
async function checkArchivedArtistTags(
  tx: SqliteExecutor,
  fields: readonly BrowseField[],
  query: ArchivableBrowseFacetQuery,
): Promise<void> {
  if (query.includeArchived !== 'true') return
  const keys = new Set(
    fields.filter(suggestsFilterableText).map((field) => field.key),
  )
  if (
    !keys.has('artistTag') &&
    !(keys.has('genre') && tagsReadArtistTags(query.tagLevels))
  )
    return
  const rows = await readRows(
    tx,
    sql`SELECT 1 AS found FROM album t
      JOIN item_credit c ON c.entity = 'album' AND c.rid = t.rid AND c.role = 'artist'
      WHERE t.archived = 1
        AND EXISTS (SELECT 1 FROM item_artist_tag_key k
          WHERE k.entity = 'album' AND k.rid = t.rid AND k.kind = 'label')
        AND NOT EXISTS (SELECT 1 FROM item_credit listed
          JOIN album v ON v.rid = listed.rid
          WHERE listed.entity = 'album' AND listed.role = 'artist'
            AND listed.artist_id = c.artist_id AND v.archived = 0)
      LIMIT 1`,
  )
  if (rows.length > 0) unsupported('catalog-scope')
}

const LabelRowSchema = z.object({ value: z.string() })
const TagCountRowSchema = z.object({
  value: z.string(),
  release: z.number().int(),
  artist: z.number().int(),
  tags: z.number().int(),
})

/** Every key a tag facet can list: visible album tags, ancestors and artist tag labels. */
async function readTagLabels(tx: SqliteExecutor): Promise<string[]> {
  const rows = await readRows(
    tx,
    sql`SELECT key AS value FROM tag WHERE media_type = 'album' AND hidden = 0
      UNION SELECT ancestor_key FROM tag_ancestor WHERE media_type = 'album'
      UNION SELECT key FROM item_artist_tag_key WHERE entity = 'album' AND kind = 'label'`,
  )
  return rows.map((row) => LabelRowSchema.parse(row).value)
}

/**
 * Tags at a location, albumTagFacetRows, browse.ts, on one album and key:
 * at Auto its release tags, or its artists' tags when it has too few
 * release tags; at levels, Track (a library track of the album carries the
 * key), Album and Artist, any of those ticked.
 */
function tagsFlag(levels: TagLevels | undefined): Sql {
  if (levels === undefined) return sql`(f.release OR (f.artist AND f.sparse))`
  const ticked: Sql[] = []
  if (levels.includes('track')) ticked.push(sql`f.track`)
  if (levels.includes('album')) ticked.push(sql`f.release`)
  if (levels.includes('artist')) ticked.push(sql`f.artist`)
  return or(ticked)
}

/**
 * The per-key album counts of albumTagFacetRows, browse.ts, over the
 * visible albums, each album and key once (`deduplicateRows`). Release and
 * track keys are browse_release_facet_keys (a visible album tag's key and
 * its visible ancestors); artist keys are browse_artist_facet_keys (an
 * artist tag label and its visible ancestors). `wanted` limits the keys;
 * null keeps every key.
 */
async function readTagCounts(
  tx: SqliteExecutor,
  query: ArchivableBrowseFacetQuery,
  wanted: readonly string[] | null,
): Promise<Map<string, TagCounts>> {
  if (wanted !== null && wanted.length === 0) return new Map()
  const keep = keepValues(wanted)
  const rows = await readRows(
    tx,
    sql`WITH release_values AS MATERIALIZED (${tagFacetValues('album', keep)}),
      label_keys AS MATERIALIZED (
        SELECT DISTINCT key FROM item_artist_tag_key
        WHERE entity = 'album' AND kind = 'label'
      ),
      artist_values AS MATERIALIZED (
        SELECT key, value FROM (
          SELECT key, key AS value FROM label_keys
          UNION ALL
          SELECT l.key, a.ancestor_key FROM label_keys l
            JOIN tag_ancestor a ON a.media_type = 'album' AND a.key = l.key
            WHERE a.ancestor_key NOT IN (SELECT key FROM tag
              WHERE media_type = 'album' AND hidden = 1)
        ) k WHERE ${keep(sql`k.value`)}
      ),
      pairs AS (
        SELECT it.rid AS rid, k.value AS value, 1 AS release, 0 AS artist, 0 AS track
          FROM item_tag it JOIN release_values k ON k.tag_id = it.tag_id
          WHERE it.entity = 'album' AND it.level = 'tagIds'
        UNION ALL
        SELECT l.rid, k.value, 0, 1, 0
          FROM item_artist_tag_key l JOIN artist_values k ON k.key = l.key
          WHERE l.entity = 'album' AND l.kind = 'label'
        UNION ALL
        SELECT it.rid, k.value, 0, 0, 1
          FROM item_tag it JOIN release_values k ON k.tag_id = it.tag_id
          WHERE it.entity = 'album' AND it.level = 'trackTagIds'
      ),
      flags AS MATERIALIZED (
        SELECT p.value AS value, max(p.release) AS release, max(p.artist) AS artist,
          max(p.track) AS track,
          max(t.release_tag_count < ${artistTagFallbackThreshold}) AS sparse
        FROM pairs p CROSS JOIN album t ON t.rid = p.rid
        WHERE ${visibleAlbums(query.includeArchived === 'true')}
        GROUP BY p.rid, p.value
      )
      SELECT f.value AS value, sum(f.release) AS release, sum(f.artist) AS artist,
        sum(${tagsFlag(query.tagLevels)}) AS tags
      FROM flags f
      WHERE f.value <> ''
      GROUP BY f.value`,
  )
  return new Map(
    rows.map((row) => {
      const parsed = TagCountRowSchema.parse(row)
      return [
        parsed.value,
        { release: parsed.release, artist: parsed.artist, tags: parsed.tags },
      ]
    }),
  )
}

/** `GET /albums/facets`. */
export async function albumFacets(
  read: DeviceRead,
  query: ArchivableBrowseFacetQuery,
): Promise<AlbumFilterOption[]> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  const fields = await readBrowseFields(read.tx, 'album')
  const table = albumFacetTable(fields, query.includeArchived === 'true')
  await checkArchivedArtistTags(read.tx, fields, query)
  let tagCounts: Promise<Map<string, TagCounts>> | undefined
  const context: AlbumFacetContext = {
    tagCounts: () => {
      tagCounts ??= wantedFacetValues(
        fields
          .filter(
            (field) =>
              suggestsFilterableText(field) && tagFields.includes(field.key),
          )
          .map((field) => facetMatch(field, query.q)),
        () => readTagLabels(read.tx),
      ).then((wanted) => readTagCounts(read.tx, query, wanted))
      return tagCounts
    },
  }
  return readFacets(read.tx, table, fields, query, context)
}
