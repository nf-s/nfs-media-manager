import { z } from 'zod'
import { isSpotifyAudioFeatureKey } from '@repo/schemas/audio-features'
import {
  compareBrowseFacets,
  type BrowseFacetQuery,
  type BrowseField,
} from '@repo/schemas/browse'
import { DeviceMetaRowSchema } from '@repo/schemas/device'
import { parseMusicalKey } from '@repo/schemas/musical-keys'
import { formatTagName } from '@repo/schemas/tags'
import type { SqliteExecutor } from '../driver'
import { foldText, globContains } from '../fold'
import type { ItemEntity } from '../schema'
import { and, or, readRows, sql, values, type Sql } from './sql'
import type { TagMediaType } from './tags'
import { unsupported } from './unsupported'

/**
 * Filter suggestions (DEVICE-25) as listBrowseFacets and queryBrowseFacets,
 * browse.ts, give them: for each text field the API filters on, the values
 * of the whole library in scope with how many items carry each. Only `q`,
 * `limitPerField`, `tagLevels` and, on Albums and Films, `includeArchived`
 * change the answer; the page's filters, search and sort never narrow the
 * counts. A library supplies a facet table
 * (one source per field) and the core does the rest: matching the typed
 * words, the order and limit of each field, labels, subtags and the
 * response order.
 */

/** One value of a field with the number of items counted under it. */
export type FacetCount = { value: string; count: number }

/** A facet row as listBrowseFacets returns it. */
export type FacetRow = {
  field: string
  value: string
  count: number
  /** Tag rows only: the visible tags beneath the value, which the count covers. */
  subtags?: number
  label: string
}

/** One typed word, as facetValueMatches, browse.ts, matches it. */
export type FacetWord = {
  /** The word as the service binds it to `ILIKE`: see FacetWordRule. */
  word: string
  /** Provider fields: the IDs whose display name contains the word. */
  ids: readonly string[]
}

/** What `q` asks of the values of one field. */
export type FacetMatch =
  /** Every value. */
  | { kind: 'any' }
  /** A musical key in any notation: the Camelot key, compared exactly. */
  | { kind: 'equals'; value: string }
  /** Each word is in the value, compared case-insensitively as `ILIKE '%word%'`. */
  | { kind: 'words'; words: readonly FacetWord[] }

/** Where one field's counts come from. */
export type FacetSource<Context> =
  /**
   * The field's `item_text` values, counted once per item. `from` names the
   * item table as `t`; `visible` is the condition an item must meet. By
   * default values are grouped by exact value (case-sensitive, as
   * browse.ts groups them); `folded` groups them by `lower(value)` and
   * lists the code-point-least value of each group, as
   * listArtistBrowseFacets, artist-browse.ts, does.
   */
  | {
      kind: 'text'
      field: string
      from: Sql
      visible: Sql
      grouping?: 'value' | 'folded'
    }
  /**
   * Counts the library computes itself, every value in one list; the core
   * matches, orders and limits them. `match` lets the read skip values
   * nothing typed can match.
   */
  | {
      kind: 'counted'
      read: (context: Context, match: FacetMatch) => Promise<FacetCount[]>
    }

/** A library's facets: one source per field it serves. */
export type FacetTable<Context> = {
  entity: ItemEntity
  sources: Record<string, FacetSource<Context>>
  /** Fields whose values are normalised tag keys: labelled with formatTagName and given subtags. */
  tagFields: readonly string[]
  /** The tag library subtags are counted in. */
  subtagMediaType: TagMediaType
  /** The per-field limit; facetFieldLimit, browse.ts, by default. */
  fieldLimit?: (limitPerField: number, fieldCount: number) => number
  /** The fields suggested; filterable text fields, as listBrowseFacets takes them, by default. */
  suggests?: (field: BrowseField) => boolean
  /** How `q` is split into words; browseWordRule by default. */
  wordRule?: FacetWordRule
}

/** How a library's service turns `q` into the words each value must contain. */
export type FacetWordRule = {
  /** browse.ts splits `q.toLowerCase()`; artist-browse.ts splits `q` as typed. */
  lowerCaseQuery: boolean
  /** The field whose label words still count as words: Title, or the artist Name. */
  labelWordsKept: string
  /** On Key, a `q` that parses as a musical key asks for that key (browse.ts only). */
  parsesMusicalKey: boolean
}

/** facetValueMatches, browse.ts. */
export const browseWordRule: FacetWordRule = {
  lowerCaseQuery: true,
  labelWordsKept: 'title',
  parsesMusicalKey: true,
}

/** The filterable text fields, as listBrowseFacets, browse.ts, suggests them. */
export function suggestsFilterableText(field: BrowseField): boolean {
  return field.type === 'text' && field.filterable
}

/** tagFacetFields, browse.ts: the fields of Tracks, Albums and Films whose values are tag keys. */
export const browseTagFacetFields: readonly string[] = [
  'genre',
  'albumTag',
  'artistTag',
  'trackTag',
  'keyword',
]

/**
 * facetFieldLimit, browse.ts: at most `limitPerField` values per field, and
 * about 1000 values over all fields.
 */
export function facetFieldLimit(
  limitPerField: number,
  fieldCount: number,
): number {
  return Math.min(limitPerField, Math.max(1, Math.floor(1000 / fieldCount)))
}

/**
 * facetValueMatches, browse.ts: on Key a `q` that parses as a musical key
 * asks for that key. Otherwise `q` is lower-cased and split on whitespace;
 * a word found in the field's label with a colon (`artists:`) is dropped
 * for that field, except on Title; each other word must be in the value.
 * On Provider a word also matches the IDs whose display name contains it.
 * Another `rule` changes the case of the words, the field that keeps label
 * words and the Key rule.
 */
export function facetMatch(
  field: BrowseField,
  q: string | undefined,
  providerNames: ReadonlyMap<string, string> = new Map(),
  rule: FacetWordRule = browseWordRule,
): FacetMatch {
  const key =
    rule.parsesMusicalKey && field.key === 'musicalKey'
      ? parseMusicalKey(q ?? '')
      : null
  if (key !== null) return { kind: 'equals', value: key }
  const label = `${field.label}:`.toLowerCase()
  const query = q ?? ''
  const words = (rule.lowerCaseQuery ? query.toLowerCase() : query)
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (word) =>
        field.key === rule.labelWordsKept ||
        !label.includes(word.toLowerCase()),
    )
    .map((word) => ({
      word,
      ids:
        field.key === 'provider'
          ? [...providerNames]
              .filter(([, name]) =>
                name.toLowerCase().includes(word.toLowerCase()),
              )
              .map(([id]) => id)
          : [],
    }))
  return words.length === 0 ? { kind: 'any' } : { kind: 'words', words }
}

/**
 * Whether a value passes the match. `ILIKE` folds both sides with
 * PostgreSQL's `lower()`, which `foldText` reproduces.
 */
export function facetValueMatches(match: FacetMatch, value: string): boolean {
  switch (match.kind) {
    case 'any':
      return true
    case 'equals':
      return value === match.value
    case 'words': {
      const folded = foldText(value)
      return match.words.every(
        ({ word, ids }) =>
          folded.includes(foldText(word)) || ids.includes(value),
      )
    }
  }
}

/** The match as a condition on a stored value and its folded form. */
export function facetMatchCondition(
  match: FacetMatch,
  value: Sql,
  folded: Sql,
): Sql {
  switch (match.kind) {
    case 'any':
      return and([])
    case 'equals':
      return sql`${value} = ${match.value}`
    case 'words':
      return and(
        match.words.map(({ word, ids }) => {
          const contains = sql`${folded} GLOB ${globContains(word)}`
          return ids.length === 0
            ? contains
            : or([contains, sql`${value} IN ${values(ids)}`])
        }),
      )
  }
}

/**
 * The folded text an exact match equals: facetOrder, browse.ts, puts first
 * the value whose `lower()` is `q.toLowerCase()`.
 */
export function exactFacetText(q: string | undefined): string {
  return q?.toLowerCase() ?? ''
}

/** Code-point order, as SQLite `BINARY` and PostgreSQL `C.UTF-8` compare text (DEVICE-26). */
export function compareCodePoints(a: string, b: string): number {
  let index = 0
  while (index < a.length && index < b.length) {
    const left = a.codePointAt(index) ?? 0
    const right = b.codePointAt(index) ?? 0
    if (left !== right) return left - right
    index += left > 0xffff ? 2 : 1
  }
  return a.length - b.length
}

/**
 * facetOrder, browse.ts, on counts read whole: the matching values, the
 * exact match first, then by count (highest first) and value, at most
 * `limit` of them.
 */
export function selectFacetCounts(
  counts: readonly FacetCount[],
  match: FacetMatch,
  q: string | undefined,
  limit: number,
): FacetCount[] {
  const exact = exactFacetText(q)
  const rank = (value: string) => (foldText(value) === exact ? 0 : 1)
  return counts
    .filter((row) => row.value !== '' && facetValueMatches(match, row.value))
    .sort(
      (a, b) =>
        rank(a.value) - rank(b.value) ||
        b.count - a.count ||
        compareCodePoints(a.value, b.value),
    )
    .slice(0, limit)
}

const CountRowSchema = z.object({
  value: z.string(),
  count: z.number().int().positive(),
})

/**
 * browseFacetRows, browse.ts, on `item_text`: grouped by value, ordered and
 * limited in SQL. A value is stored once per item, so `count(*)` counts
 * items; a folded group can hold several values of one item.
 */
async function readTextFacet(
  tx: SqliteExecutor,
  entity: ItemEntity,
  source: {
    field: string
    from: Sql
    visible: Sql
    grouping?: 'value' | 'folded'
  },
  match: FacetMatch,
  q: string | undefined,
  limit: number,
): Promise<FacetCount[]> {
  const folded = source.grouping === 'folded'
  const value = folded ? sql`min(v.value)` : sql`v.value`
  const count = folded ? sql`count(DISTINCT v.rid)` : sql`count(*)`
  const rows = await readRows(
    tx,
    sql`SELECT ${value} AS value, ${count} AS count
      FROM item_text v JOIN ${source.from} ON t.rid = v.rid
      WHERE v.entity = ${entity} AND v.field = ${source.field} AND v.value <> ''
        AND ${source.visible}
        AND ${facetMatchCondition(match, sql`v.value`, sql`v.folded`)}
      GROUP BY ${folded ? sql`v.folded` : sql`v.value`}
      ORDER BY CASE WHEN min(v.folded) = ${exactFacetText(q)} THEN 0 ELSE 1 END,
        ${count} DESC, ${value}
      LIMIT ${limit}`,
  )
  return rows.map((row) => CountRowSchema.parse(row))
}

/**
 * Keys textRows, browse-expressions.ts, reads from somewhere other than
 * `metadata.browse` on Albums or Films. A plugin field with such a key is
 * counted from those rows, which a row does not carry for it.
 */
const keysWithOwnTextRows: ReadonlySet<string> = new Set([
  'title',
  'summary',
  'artist',
  'director',
  'actor',
  'writer',
  'genre',
  'artistTag',
  'albumTag',
  'keyword',
  'playlist',
  'collection',
  'provider',
  'source',
  'watched',
  'identification',
  'edition',
  'country',
])

/**
 * The table with a source for each plugin text field of Albums or Films:
 * the fields of `fields` beyond `builtin`. textRows' default branch counts
 * each element of `metadata.browse->key` as text, the values
 * storedBrowseParts, device-rows/media.ts, writes to the row. A key with
 * rows of its own, or a Spotify audio feature the row leaves out, gets no
 * source and falls through as `unknown-field`.
 */
export function withPluginFacetSources<Context>(
  table: FacetTable<Context>,
  fields: readonly BrowseField[],
  builtin: readonly BrowseField[],
  source: (field: string) => FacetSource<Context>,
): FacetTable<Context> {
  const builtinKeys = new Set(builtin.map((field) => field.key))
  const sources = { ...table.sources }
  for (const field of fields) {
    const { key } = field
    if (
      field.type !== 'text' ||
      builtinKeys.has(key) ||
      keysWithOwnTextRows.has(key) ||
      isSpotifyAudioFeatureKey(key)
    )
      continue
    sources[key] = source(key)
  }
  return { ...table, sources }
}

/**
 * A tag facet's values as browse_release_facet_keys, browse.ts, and the
 * rolled-up tag rows of textRows, browse-expressions.ts, read them: each
 * visible tag row of the library as `(tag_id, value)` with its key, and
 * again with each visible key above it (tagAncestorRows, tag-hierarchy.ts).
 * `keep` limits the values, as the service limits them to those a typed
 * word can match.
 */
export function tagFacetValues(
  mediaType: TagMediaType,
  keep: (value: Sql) => Sql,
): Sql {
  return sql`SELECT tag_id, value FROM (
      SELECT id AS tag_id, key AS value FROM tag
        WHERE media_type = ${mediaType} AND hidden = 0
      UNION ALL
      SELECT g.id, a.ancestor_key FROM tag g
        JOIN tag_ancestor a ON a.media_type = g.media_type AND a.key = g.key
        WHERE g.media_type = ${mediaType} AND g.hidden = 0
          AND a.ancestor_key NOT IN (SELECT key FROM tag
            WHERE media_type = ${mediaType} AND hidden = 1)
    ) k WHERE ${keep(sql`k.value`)}`
}

/**
 * The values any of the tag fields' matches accepts, read from `labels`
 * (a superset of the values), or null when one of them takes every value.
 */
export async function wantedFacetValues(
  matches: readonly FacetMatch[],
  labels: () => Promise<string[]>,
): Promise<string[] | null> {
  if (matches.length === 0 || matches.some((match) => match.kind === 'any'))
    return null
  return (await labels()).filter((label) =>
    matches.some((match) => facetValueMatches(match, label)),
  )
}

/** A condition keeping the wanted values; true when every value is wanted. */
export function keepValues(
  wanted: readonly string[] | null,
): (value: Sql) => Sql {
  return (value) =>
    wanted === null ? and([]) : sql`${value} IN ${values(wanted)}`
}

const SubtagRowSchema = z.object({
  key: z.string(),
  count: z.number().int().positive(),
})

/** visibleSubtagCounts, tag-hierarchy.ts: the visible tags beneath each key. */
export async function visibleSubtagCounts(
  tx: SqliteExecutor,
  mediaType: TagMediaType,
  keys: readonly string[],
): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map()
  const rows = await readRows(
    tx,
    sql`SELECT a.ancestor_key AS key, count(*) AS count FROM tag_ancestor a
      WHERE a.media_type = ${mediaType} AND a.ancestor_key IN ${values(keys)}
        AND NOT EXISTS (SELECT 1 FROM tag hidden
          WHERE hidden.media_type = a.media_type AND hidden.key = a.key AND hidden.hidden = 1)
      GROUP BY a.ancestor_key`,
  )
  return new Map(
    rows.map((row) => {
      const parsed = SubtagRowSchema.parse(row)
      return [parsed.key, parsed.count]
    }),
  )
}

const MetaValueSchema = z.object({ value: z.string() })

/** providerDisplayNames, provider-names.ts, as the feed published them. */
export async function readProviderNames(
  tx: SqliteExecutor,
): Promise<Map<string, string>> {
  const [row] = await tx.all('SELECT value FROM meta WHERE id = ?', [
    'providers',
  ])
  if (row === undefined) return unsupported('not-ready')
  const meta = DeviceMetaRowSchema.parse(
    JSON.parse(MetaValueSchema.parse(row).value),
  )
  if (meta.kind !== 'providers') return unsupported('store-error')
  return new Map(meta.names.map((name) => [name.id, name.displayName]))
}

/**
 * listBrowseFacets, browse.ts, over a library's facet table. `fields` is
 * the API's field list; every field the table suggests (by default each
 * text field it filters on) needs a source, or the read is `unknown-field`.
 */
export async function readFacets<Context>(
  tx: SqliteExecutor,
  table: FacetTable<Context>,
  fields: readonly BrowseField[],
  query: BrowseFacetQuery,
  context: Context,
): Promise<FacetRow[]> {
  const suggested = fields.filter(table.suggests ?? suggestsFilterableText)
  if (suggested.length === 0) return []
  const planned = suggested.map((field) => {
    const source = table.sources[field.key]
    return source === undefined
      ? unsupported('unknown-field')
      : { field, source }
  })
  const providerNames = suggested.some((field) => field.key === 'provider')
    ? await readProviderNames(tx)
    : new Map<string, string>()
  const limit = (table.fieldLimit ?? facetFieldLimit)(
    query.limitPerField,
    suggested.length,
  )
  // Fields in list order, each in its own order: the order of the service's
  // union, which the final sort keeps for labels that compare equal.
  const counted: { field: string; value: string; count: number }[] = []
  for (const { field, source } of planned) {
    const match = facetMatch(field, query.q, providerNames, table.wordRule)
    const counts =
      source.kind === 'text'
        ? await readTextFacet(tx, table.entity, source, match, query.q, limit)
        : selectFacetCounts(
            await source.read(context, match),
            match,
            query.q,
            limit,
          )
    for (const row of counts) counted.push({ field: field.key, ...row })
  }
  const isTag = (field: string) => table.tagFields.includes(field)
  const subtags = await visibleSubtagCounts(tx, table.subtagMediaType, [
    ...new Set(
      counted.filter((row) => isTag(row.field)).map((row) => row.value),
    ),
  ])
  return counted
    .map((row): FacetRow => {
      const subtagCount = isTag(row.field) ? subtags.get(row.value) : undefined
      const fieldLabel =
        suggested.find((field) => field.key === row.field)?.label ?? row.field
      const valueLabel = isTag(row.field)
        ? formatTagName(row.value)
        : row.field === 'provider'
          ? (providerNames.get(row.value) ?? row.value)
          : row.value
      return {
        ...row,
        ...(subtagCount === undefined ? {} : { subtags: subtagCount }),
        label: `${fieldLabel}: ${valueLabel}`,
      }
    })
    .sort(compareBrowseFacets)
}
