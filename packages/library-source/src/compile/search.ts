import type { ItemEntity } from '../schema'
import { foldText, globContains } from '../fold'
import type { SearchFields } from './fields'
import { FALSE, join, sql, values, type Sql } from './sql'

/** The trigram index serves a pattern with this many characters in a row. */
const TRIGRAM_LENGTH = 3

/**
 * `q` as browseSearchWords, browse.ts: split on whitespace, empty strings
 * dropped, each word once. Words are not trimmed or folded further.
 */
export function searchWords(q: string | undefined): string[] {
  return [...new Set(q?.split(/\s+/u).filter(Boolean))]
}

/**
 * Every word must appear in some searched field as a substring, compared
 * case-insensitively as `ILIKE '%word%'` with the pattern characters taken
 * literally. A word of three or more characters reads the trigram index;
 * a shorter one scans the entity's values.
 */
export function searchConditions(
  entity: ItemEntity,
  words: readonly string[],
  fields: SearchFields,
): Sql[] {
  return words.map((word) => wordCondition(entity, word, fields))
}

function wordCondition(
  entity: ItemEntity,
  word: string,
  fields: SearchFields,
): Sql {
  const pattern = globContains(word)
  const indexed = [...foldText(word)].length >= TRIGRAM_LENGTH
  const sources: Sql[] = []
  if (fields.text.length > 0) {
    sources.push(
      indexed
        ? sql`SELECT v.rid FROM item_text_fts f JOIN item_text v ON v.tid = f.rowid
            WHERE f.folded GLOB ${pattern} AND v.entity = ${entity}
              AND v.field IN ${values(fields.text)}`
        : sql`SELECT rid FROM item_text
            WHERE entity = ${entity} AND field IN ${values(fields.text)}
              AND folded GLOB ${pattern}`,
    )
  }
  if (fields.search.length > 0) {
    sources.push(
      indexed
        ? sql`SELECT s.rid FROM item_search_fts f JOIN item_search s ON s.sid = f.rowid
            WHERE f.folded GLOB ${pattern} AND s.entity = ${entity}
              AND s.field IN ${values(fields.search)}`
        : sql`SELECT rid FROM item_search
            WHERE entity = ${entity} AND field IN ${values(fields.search)}
              AND folded GLOB ${pattern}`,
    )
  }
  if (sources.length === 0) return FALSE
  return sql`t.rid IN (${join(sources, ' UNION ')})`
}
