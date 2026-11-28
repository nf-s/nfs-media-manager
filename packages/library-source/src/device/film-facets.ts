import { z } from 'zod'
import {
  filmBrowseFields,
  type ArchivableBrowseFacetQuery,
  type BrowseField,
} from '@repo/schemas/browse'
import type { SqliteExecutor } from '../driver'
import type { FilmFilterOption } from '../source'
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
  type FacetCount,
  type FacetSource,
  type FacetTable,
} from '../compile/facets'
import { isMemberScope } from '../compile/query'
import { TRUE, readRows, sql, type Sql } from '../compile/sql'
import { unsupported } from '../compile/unsupported'
import type { DeviceRead } from './read'

/**
 * Films suggestions, `GET /films/facets`: listFilmFilterOptions, media.ts,
 * which is listBrowseFacets('film') and browseFacetQuery, browse.ts. Every
 * field counts films per value; Tags counts films per film tag key with
 * each key's visible ancestors, as textRows('genre', 'film') rolls them up.
 * Archived films only with `includeArchived`. The query has no creator
 * scope; a catalog scope other than the library falls through.
 */

type FilmFacetContext = { tagCounts: () => Promise<FacetCount[]> }

function visibleFilms(includeArchived: boolean): Sql {
  return includeArchived ? TRUE : sql`t.archived = 0`
}

function text(field: string, visible: Sql): FacetSource<FilmFacetContext> {
  return { kind: 'text', field, from: sql`film t`, visible }
}

/** The facet table for one query: visibility depends on `includeArchived`. */
function filmFacetTable(
  fields: readonly BrowseField[],
  includeArchived: boolean,
): FacetTable<FilmFacetContext> {
  const visible = visibleFilms(includeArchived)
  const table: FacetTable<FilmFacetContext> = {
    entity: 'film',
    sources: {
      // Description and Awards are not filterable, so not suggested unless
      // another field with their key is.
      summary: text('summary', visible),
      awards: text('awards', visible),
      title: text('title', visible),
      director: text('director', visible),
      actor: text('actor', visible),
      writer: text('writer', visible),
      country: text('country', visible),
      language: text('language', visible),
      productionCompany: text('productionCompany', visible),
      collection: text('collection', visible),
      playlist: text('playlist', visible),
      source: text('source', visible),
      watched: text('watched', visible),
      identification: text('identification', visible),
      provider: text('provider', visible),
      genre: { kind: 'counted', read: (context) => context.tagCounts() },
    },
    tagFields: browseTagFacetFields,
    subtagMediaType: 'film',
  }
  return withPluginFacetSources(table, fields, filmBrowseFields, (field) =>
    text(field, visible),
  )
}

const LabelRowSchema = z.object({ value: z.string() })
const CountRowSchema = z.object({
  value: z.string(),
  count: z.number().int().positive(),
})

/** Every key Tags can list: visible film tags and their ancestors. */
async function readTagLabels(tx: SqliteExecutor): Promise<string[]> {
  const rows = await readRows(
    tx,
    sql`SELECT key AS value FROM tag WHERE media_type = 'film' AND hidden = 0
      UNION SELECT ancestor_key FROM tag_ancestor WHERE media_type = 'film'`,
  )
  return rows.map((row) => LabelRowSchema.parse(row).value)
}

/**
 * textRows('genre', 'film', { normalizeTags, rollUpTags }), browse.ts:
 * each visible film tag's key and visible ancestors, counted once per
 * visible film (`distinctItems`). `wanted` limits the keys; null keeps
 * every key.
 */
async function readTagCounts(
  tx: SqliteExecutor,
  includeArchived: boolean,
  wanted: readonly string[] | null,
): Promise<FacetCount[]> {
  if (wanted !== null && wanted.length === 0) return []
  const rows = await readRows(
    tx,
    sql`WITH tag_values AS MATERIALIZED (${tagFacetValues('film', keepValues(wanted))})
      SELECT k.value AS value, count(DISTINCT it.rid) AS count
      FROM item_tag it
        JOIN tag_values k ON k.tag_id = it.tag_id
        CROSS JOIN film t ON t.rid = it.rid
      WHERE it.entity = 'film' AND it.level = 'tagIds' AND k.value <> ''
        AND ${visibleFilms(includeArchived)}
      GROUP BY k.value`,
  )
  return rows.map((row) => CountRowSchema.parse(row))
}

/** `GET /films/facets`. */
export async function filmFacets(
  read: DeviceRead,
  query: ArchivableBrowseFacetQuery,
): Promise<FilmFilterOption[]> {
  if (!isMemberScope(query)) unsupported('catalog-scope')
  const fields = await readBrowseFields(read.tx, 'film')
  const includeArchived = query.includeArchived === 'true'
  const table = filmFacetTable(fields, includeArchived)
  let tagCounts: Promise<FacetCount[]> | undefined
  const context: FilmFacetContext = {
    tagCounts: () => {
      tagCounts ??= wantedFacetValues(
        fields
          .filter(
            (field) => suggestsFilterableText(field) && field.key === 'genre',
          )
          .map((field) => facetMatch(field, query.q, read.fold)),
        () => readTagLabels(read.tx),
        read.fold,
      ).then((wanted) => readTagCounts(read.tx, includeArchived, wanted))
      return tagCounts
    },
  }
  return readFacets(read, table, fields, query, context)
}
