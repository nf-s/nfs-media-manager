import { isSpotifyAudioFeatureKey } from '@repo/schemas/audio-features'
import type { BrowseField } from '@repo/schemas/browse'
import type { SqliteExecutor } from '../driver'
import type { ItemEntity } from '../schema'
import { textMatch, type FieldTable, type ValueSource } from './fields'
import { readRows, sql } from './sql'
import { unsupported } from './unsupported'

/**
 * Plugin fields of Albums and Films: the fields the API lists beyond the
 * built-in ones. Their values are the row's other `metadata.browse` keys,
 * as storedBrowseParts, device-rows/media.ts, writes them: every value as
 * text, a JSON number in `num` (dates in microseconds) and any other value
 * lower-cased in `sort`. Spotify audio features are never in a row, so a
 * field with such a key gets no entry and falls through as unknown.
 */
export function withPluginFields<Context>(
  table: FieldTable<Context>,
  fields: readonly BrowseField[],
  builtin: readonly BrowseField[],
): FieldTable<Context> {
  const builtinKeys = new Set(builtin.map((field) => field.key))
  const filters = { ...table.filters }
  const ranges = { ...table.ranges }
  const sorts = { ...table.sorts }
  const searched = { ...table.search.fields }
  for (const field of fields) {
    const { key } = field
    if (builtinKeys.has(key) || isSpotifyAudioFeatureKey(key)) continue
    if (field.type === 'text') {
      // storedBrowseField(key), browse.ts: lower() of each element as text.
      filters[key] = textMatch(table.entity, key)
      sorts[key] = { kind: 'sort', field: key }
      searched[key] = { table: 'text', field: key }
      continue
    }
    // storedBrowseNumber(key), browse.ts: a JSON number, else missing.
    const source: ValueSource = { kind: 'num', field: key }
    ranges[key] = { source, unit: field.type === 'date' ? 'date' : 'number' }
    sorts[key] = source
  }
  return {
    ...table,
    filters,
    ranges,
    sorts,
    search: { ...table.search, fields: searched },
  }
}

/**
 * The service sorts a plugin text field by the text of its first value,
 * which for a JSON number is the number's text; the row's `sort` value
 * leaves numbers out. A plugin text sort is served only while no item of
 * the library holds a number for the key.
 */
export async function checkPluginTextSort(
  tx: SqliteExecutor,
  entity: ItemEntity,
  fields: readonly BrowseField[],
  builtin: readonly BrowseField[],
  sortBy: string,
): Promise<void> {
  const field = new Map(fields.map((entry) => [entry.key, entry])).get(sortBy)
  if (
    field === undefined ||
    field.type !== 'text' ||
    builtin.some((entry) => entry.key === sortBy)
  )
    return
  const rows = await readRows(
    tx,
    sql`SELECT 1 AS found FROM item_num
      WHERE entity = ${entity} AND field = ${sortBy} LIMIT 1`,
  )
  if (rows.length > 0) unsupported('unknown-field')
}
