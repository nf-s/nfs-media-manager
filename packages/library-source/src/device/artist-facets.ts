import { z } from 'zod'
import type { BrowseFacetQuery } from '@repo/schemas/browse'
import type { ArtistFilterOption } from '../source'
import { readBrowseFields } from '../compile/fields'
import {
  readFacets,
  type FacetCount,
  type FacetSource,
  type FacetTable,
  type FacetWordRule,
} from '../compile/facets'
import { isMemberScope } from '../compile/query'
import type { QueryKeys } from '../compile/query-keys'
import { TRUE, readRows, sql } from '../compile/sql'
import { unsupported } from '../compile/unsupported'
import type { DeviceRead } from './read'

/**
 * Artists suggestions, `GET /artists/facets`: listArtistBrowseFacets,
 * artist-browse.ts, which has rules of its own. Every text field is
 * suggested; values are grouped by `lower(value)` and listed by the least
 * value of each group, each artist counted once; Tags groups the
 * normalised tag keys exactly, with each key's visible ancestors. Words
 * are matched as typed, Name keeps label words, and each field lists at
 * most `limitPerField` values. The device holds the artists of the library
 * scope, all of them visible.
 */

type ArtistFacetContext = {
  tagCounts: () => Promise<FacetCount[]>
}

function text(field: string): FacetSource<ArtistFacetContext> {
  return {
    kind: 'text',
    field,
    from: sql`artist t`,
    visible: TRUE,
    grouping: 'folded',
  }
}

/** listArtistBrowseFacets: `q` split as typed; the label rule spares Name. */
const artistWordRule: FacetWordRule = {
  lowerCaseQuery: false,
  labelWordsKept: 'name',
  parsesMusicalKey: false,
}

const artistFacetTable: FacetTable<ArtistFacetContext> = {
  entity: 'artist',
  sources: {
    name: text('name'),
    playlist: text('playlist'),
    country: text('country'),
    type: text('type'),
    provider: text('provider'),
    genre: { kind: 'counted', read: (context) => context.tagCounts() },
  },
  tagFields: ['genre'],
  subtagMediaType: 'album',
  // `limit ${query.limitPerField}` on every field, whatever their number.
  fieldLimit: (limitPerField) => limitPerField,
  suggests: (field) => field.type === 'text',
  wordRule: artistWordRule,
}

const CountRowSchema = z.object({
  value: z.string(),
  count: z.number().int().positive(),
})

/**
 * Tags, listArtistBrowseFacets: artist_tag_keys (the normalised key of
 * each raw snapshot tag, which the row holds as `rawTagKeys`) and, for a
 * key that is not hidden, each visible ancestor (tagAncestorKeys('album',
 * true), tag-hierarchy.ts), each artist and key once.
 */
async function readTagCounts(read: DeviceRead): Promise<FacetCount[]> {
  const rows = await readRows(
    read.tx,
    sql`WITH hidden_keys AS MATERIALIZED (
        SELECT DISTINCT key FROM tag WHERE media_type = 'album' AND hidden = 1
      ),
      raw AS MATERIALIZED (
        SELECT rid, key FROM item_artist_tag_key
        WHERE entity = 'artist' AND kind = 'raw'
      ),
      pairs AS (
        SELECT rid, key AS value FROM raw
        UNION
        SELECT r.rid, a.ancestor_key FROM raw r
          JOIN tag_ancestor a ON a.media_type = 'album' AND a.key = r.key
          WHERE r.key NOT IN (SELECT key FROM hidden_keys)
            AND a.ancestor_key NOT IN (SELECT key FROM hidden_keys)
      )
      SELECT value, count(*) AS count FROM pairs
      WHERE value <> '' GROUP BY value`,
  )
  return rows.map((row) => CountRowSchema.parse(row))
}

/**
 * DEVICE-34: the keys of an Artists facets query. The scope keys are read
 * by isMemberScope; `discoverySourceMode` changes only a scope the device
 * leaves to the API. listArtistBrowseFacets does not read `tagLevels`.
 */
export const artistFacetQueryKeys: QueryKeys<BrowseFacetQuery> = {
  libraryScope: 'served',
  discoverySources: 'served',
  discoverySourceMode: 'served',
  discoverySourceScope: 'served',
  q: 'served',
  limitPerField: 'served',
  tagLevels: 'served',
}

/** `GET /artists/facets`, in the film suggestion shape the route uses. */
export async function artistFacets(
  read: DeviceRead,
  query: BrowseFacetQuery,
): Promise<ArtistFilterOption[]> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  const fields = await readBrowseFields(read.tx, 'artist')
  let tagCounts: Promise<FacetCount[]> | undefined
  const context: ArtistFacetContext = {
    tagCounts: () => {
      tagCounts ??= readTagCounts(read)
      return tagCounts
    },
  }
  return readFacets(read, artistFacetTable, fields, query, context)
}
