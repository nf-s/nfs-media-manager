import { z } from 'zod'
import type {
  BrowseFacetQuery,
  BrowseField,
  TagLevels,
} from '@repo/schemas/browse'
import { artistTagFallbackThreshold } from '@repo/schemas/music-tags'
import { trackSourceLabels } from '@repo/schemas/tracks'
import type { SqliteExecutor } from '../driver'
import type { TrackFilterOption } from '../source'
import { readBrowseFields } from '../compile/fields'
import {
  browseTagFacetFields,
  facetMatch,
  facetValueMatches,
  readFacets,
  type FacetSource,
  type FacetTable,
} from '../compile/facets'
import { isMemberScope } from '../compile/query'
import { TRUE, readRows, sql, values, type Sql } from '../compile/sql'
import { unsupported } from '../compile/unsupported'
import type { DeviceRead } from './read'

/**
 * Tracks suggestions, `GET /tracks/facets`: listBrowseFacets('track') and
 * browseFacetQuery, browse.ts. Text fields count the visible tracks per
 * stored value; Tags, Track tags, Album tags and Artist tags count tracks
 * per tag key with each key's visible ancestors, as trackMusicFacetSources
 * and trackTagFacetRows do.
 */

/**
 * Per tag key, the visible tracks that carry it at each level, and the two
 * sums Auto needs. Own: the track's in-Browse tags; album: its album's
 * release tags; artist: its artists' projected tags.
 */
type TagCounts = {
  own: number
  album: number
  artist: number
  albumAndArtist: number
  ownWithoutAlbum: number
  ownWithoutArtist: number
  ownWithoutEither: number
  /** Album tags, or artist tags on an album with too few release tags, of tracks that inherit the key. */
  inherited: number
  /** Own tags also inherited, for keys no in-Browse Sonovault tag rolls up to. */
  inheritedOverlap: number
}

type TrackFacetContext = {
  tagLevels: TagLevels | undefined
  tagCounts: () => Promise<Map<string, TagCounts>>
}

/** textRows visibility in browseFacetQuery: not archived, no redundant Last.fm placeholder. */
const visibleTrack = sql`t.archived = 0 AND t.redundant_placeholder = 0`

function text(
  field: string,
  visible: Sql = visibleTrack,
): FacetSource<TrackFacetContext> {
  return { kind: 'text', field, from: sql`track t`, visible }
}

function counted(
  count: (counts: TagCounts, levels: TagLevels | undefined) => number,
): FacetSource<TrackFacetContext> {
  return {
    kind: 'counted',
    read: async (context) =>
      [...(await context.tagCounts())].flatMap(([value, counts]) => {
        const total = count(counts, context.tagLevels)
        return total > 0 ? [{ value, count: total }] : []
      }),
  }
}

/**
 * Tags at a location, tagLocationCountColumn, browse.ts. Auto counts a
 * track's own tags and, where it inherits the key, its album's tags and
 * (on an album with too few release tags) its artists'. Track alone is
 * Track tags; other locations count tracks with the key at any ticked level.
 */
function tagsCount(counts: TagCounts, levels: TagLevels | undefined): number {
  switch (levels?.join(',')) {
    case undefined:
      return counts.inherited + counts.own - counts.inheritedOverlap
    case 'track':
      return counts.own
    case 'album':
      return counts.album
    case 'artist':
      return counts.artist
    case 'track,album':
      return counts.album + counts.ownWithoutAlbum
    case 'track,artist':
      return counts.artist + counts.ownWithoutArtist
    case 'album,artist':
      return counts.album + counts.artist - counts.albumAndArtist
    default:
      return (
        counts.album +
        counts.artist -
        counts.albumAndArtist +
        counts.ownWithoutEither
      )
  }
}

const trackFacetTable: FacetTable<TrackFacetContext> = {
  entity: 'track',
  sources: {
    title: text('title'),
    // A redundant placeholder is listed under the Last.fm source only.
    source: text(
      'source',
      sql`t.archived = 0
        AND (t.redundant_placeholder = 0 OR v.value = ${trackSourceLabels.lastfm})`,
    ),
    spotifyMatch: text('spotifyMatch'),
    provider: text('provider'),
    artist: text('artist'),
    album: text('album'),
    playlist: text('playlist'),
    albumLink: text('albumLink'),
    hasTrackTags: text('hasTrackTags'),
    musicalKey: text('musicalKey'),
    genre: counted(tagsCount),
    trackTag: counted((counts) => counts.own),
    albumTag: counted((counts) => counts.album),
    artistTag: counted((counts) => counts.artist),
  },
  tagFields: browseTagFacetFields,
  subtagMediaType: 'album',
}

const LabelRowSchema = z.object({ value: z.string() })
const TagCountRowSchema = z.object({
  value: z.string(),
  own: z.number().int(),
  album: z.number().int(),
  artist: z.number().int(),
  album_and_artist: z.number().int(),
  own_without_album: z.number().int(),
  own_without_artist: z.number().int(),
  own_without_either: z.number().int(),
  inherited: z.number().int(),
  inherited_overlap: z.number().int(),
})

/** Every key a tag facet can list: visible album tags, ancestors and projected artist tags. */
async function readTagLabels(tx: SqliteExecutor): Promise<string[]> {
  const rows = await readRows(
    tx,
    sql`SELECT key AS value FROM tag WHERE media_type = 'album' AND hidden = 0
      UNION SELECT ancestor_key FROM tag_ancestor WHERE media_type = 'album'
      UNION SELECT key FROM item_artist_tag_key WHERE entity = 'track' AND kind = 'label'`,
  )
  return rows.map((row) => LabelRowSchema.parse(row).value)
}

/**
 * The per-key counts of trackMusicFacetSources (with own tags) and
 * trackTagFacetRows, browse.ts, over the visible tracks. Keys are
 * browse_release_facet_keys (a visible album tag's key and its visible
 * ancestors) and browse_artist_facet_keys (a projected artist tag key and
 * its visible ancestors). `wanted` limits the keys, as the service limits
 * them to those a typed word can match; null keeps every key.
 */
async function readTagCounts(
  tx: SqliteExecutor,
  wanted: readonly string[] | null,
): Promise<Map<string, TagCounts>> {
  if (wanted !== null && wanted.length === 0) return new Map()
  const keep = (value: Sql) =>
    wanted === null ? TRUE : sql`${value} IN ${values(wanted)}`
  const rows = await readRows(
    tx,
    sql`WITH hidden_keys AS MATERIALIZED (
        SELECT DISTINCT key FROM tag WHERE media_type = 'album' AND hidden = 1
      ),
      release_values AS MATERIALIZED (
        SELECT tag_id, value FROM (
          SELECT id AS tag_id, key AS value FROM tag
            WHERE media_type = 'album' AND hidden = 0
          UNION ALL
          SELECT g.id, a.ancestor_key FROM tag g
            JOIN tag_ancestor a ON a.media_type = 'album' AND a.key = g.key
            WHERE g.media_type = 'album' AND g.hidden = 0
              AND a.ancestor_key NOT IN (SELECT key FROM hidden_keys)
        ) k WHERE ${keep(sql`k.value`)}
      ),
      label_keys AS MATERIALIZED (
        SELECT DISTINCT key FROM item_artist_tag_key
        WHERE entity = 'track' AND kind = 'label'
      ),
      artist_values AS MATERIALIZED (
        SELECT key, value FROM (
          SELECT key, key AS value FROM label_keys
          UNION ALL
          SELECT l.key, a.ancestor_key FROM label_keys l
            JOIN tag_ancestor a ON a.media_type = 'album' AND a.key = l.key
            WHERE a.ancestor_key NOT IN (SELECT key FROM hidden_keys)
        ) k WHERE ${keep(sql`k.value`)}
      ),
      pairs AS (
        SELECT it.rid AS rid, k.value AS value, 1 AS own, 0 AS album, 0 AS artist
          FROM item_tag it JOIN release_values k ON k.tag_id = it.tag_id
          WHERE it.entity = 'track' AND it.level = 'ownTagIds'
        UNION ALL
        SELECT it.rid, k.value, 0, 1, 0
          FROM item_tag it JOIN release_values k ON k.tag_id = it.tag_id
          WHERE it.entity = 'track' AND it.level = 'albumTagIds'
        UNION ALL
        SELECT l.rid, k.value, 0, 0, 1
          FROM item_artist_tag_key l JOIN artist_values k ON k.key = l.key
          WHERE l.entity = 'track' AND l.kind = 'label'
      ),
      flags AS MATERIALIZED (
        SELECT p.value AS value, max(p.own) AS own, max(p.album) AS album,
          max(p.artist) AS artist, max(t.has_own_tags) AS has_own,
          max(t.album_id IS NULL
            OR coalesce(t.album_release_tag_count, 0) < ${artistTagFallbackThreshold}) AS sparse
        FROM pairs p CROSS JOIN track t ON t.rid = p.rid
        WHERE t.archived = 0 AND t.redundant_placeholder = 0
        GROUP BY p.rid, p.value
      ),
      sonovault AS MATERIALIZED (
        SELECT DISTINCT k.value AS value
        FROM item_tag it JOIN release_values k ON k.tag_id = it.tag_id
        WHERE it.entity = 'track' AND it.level = 'ownSonovaultTagIds'
      )
      SELECT f.value AS value,
        sum(f.own) AS own, sum(f.album) AS album, sum(f.artist) AS artist,
        sum(f.album AND f.artist) AS album_and_artist,
        sum(f.own AND NOT f.album) AS own_without_album,
        sum(f.own AND NOT f.artist) AS own_without_artist,
        sum(f.own AND NOT (f.album OR f.artist)) AS own_without_either,
        sum((NOT f.has_own OR s.value IS NULL)
          AND (f.album OR (f.sparse AND f.artist))) AS inherited,
        sum(f.own AND (f.album OR (f.artist AND f.sparse))
          AND s.value IS NULL) AS inherited_overlap
      FROM flags f LEFT JOIN sonovault s ON s.value = f.value
      WHERE f.value <> ''
      GROUP BY f.value`,
  )
  return new Map(
    rows.map((row) => {
      const parsed = TagCountRowSchema.parse(row)
      return [
        parsed.value,
        {
          own: parsed.own,
          album: parsed.album,
          artist: parsed.artist,
          albumAndArtist: parsed.album_and_artist,
          ownWithoutAlbum: parsed.own_without_album,
          ownWithoutArtist: parsed.own_without_artist,
          ownWithoutEither: parsed.own_without_either,
          inherited: parsed.inherited,
          inheritedOverlap: parsed.inherited_overlap,
        },
      ]
    }),
  )
}

/**
 * The keys any requested tag field can match, as browseFacetQuery limits
 * the expansion; null when one of them takes every key.
 */
async function wantedTagLabels(
  tx: SqliteExecutor,
  fields: readonly BrowseField[],
  q: string | undefined,
): Promise<string[] | null> {
  const matches = fields
    .filter(
      (field) =>
        field.type === 'text' &&
        field.filterable &&
        trackFacetTable.tagFields.includes(field.key),
    )
    .map((field) => facetMatch(field, q))
  if (matches.some((match) => match.kind === 'any')) return null
  const labels = await readTagLabels(tx)
  return labels.filter((label) =>
    matches.some((match) => facetValueMatches(match, label)),
  )
}

/** `GET /tracks/facets`. */
export async function trackFacets(
  read: DeviceRead,
  query: BrowseFacetQuery,
): Promise<TrackFilterOption[]> {
  if (!isMemberScope(query, 'track')) unsupported('catalog-scope')
  const fields = await readBrowseFields(read.tx, 'track')
  let tagCounts: Promise<Map<string, TagCounts>> | undefined
  const context: TrackFacetContext = {
    tagLevels: query.tagLevels,
    tagCounts: () => {
      tagCounts ??= wantedTagLabels(read.tx, fields, query.q).then((wanted) =>
        readTagCounts(read.tx, wanted),
      )
      return tagCounts
    },
  }
  return readFacets(read.tx, trackFacetTable, fields, query, context)
}
