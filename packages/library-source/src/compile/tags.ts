import { z } from 'zod'
import type { DeviceTagRow } from '@repo/schemas/device'
import { normalizeTagName } from '@repo/schemas/tags'
import type { SqliteExecutor } from '../driver'
import type { ItemEntity } from '../schema'
import { readRows, sql, values, type Sql } from './sql'

/**
 * Tag filter resolution as music-tags.ts and tag-hierarchy.ts do it, from
 * the `tag`, `tag_identity` and `tag_ancestor` tables. Keys always come
 * from the rows; only the filter value is normalised in TypeScript, with
 * the same `normalizeTagName` the service calls.
 */

export type TagMediaType = DeviceTagRow['mediaType']

const KeyRowSchema = z.object({ key: z.string() })
const IdRowSchema = z.object({ id: z.string() })
const LabelRowSchema = z.object({
  key: z.string(),
  label: z.string().nullable(),
})

/** A filter value as the service normalises it before resolving it. */
export function tagFilterName(value: string): string {
  return normalizeTagName(value)
}

/**
 * matchingTagNames(name, mediaType), music-tags.ts: the name, the keys of
 * its canonical targets (identity keys and aliases, hidden targets
 * included), and the visible descendants of all of them.
 */
export async function matchingTagNames(
  tx: SqliteExecutor,
  name: string,
  mediaType: TagMediaType,
): Promise<string[]> {
  const named = sql`SELECT ${name} AS key
    UNION SELECT target.key FROM tag_identity i
      JOIN tag target ON target.id = i.tag_id
      WHERE i.key = ${name} AND target.media_type = ${mediaType}
    UNION SELECT target.key FROM tag original
      JOIN tag target ON target.id = coalesce(original.alias_target_id, original.id)
      WHERE original.media_type = ${mediaType} AND original.key = ${name}
        AND target.media_type = ${mediaType}`
  const statement = sql`WITH named(key) AS (${named})
    SELECT key FROM named
    UNION SELECT a.key FROM tag_ancestor a
      WHERE a.media_type = ${mediaType} AND a.ancestor_key IN (SELECT key FROM named)
        AND NOT EXISTS (SELECT 1 FROM tag hidden
          WHERE hidden.media_type = a.media_type AND hidden.key = a.key AND hidden.hidden = 1)`
  return readColumn(tx, statement, KeyRowSchema, 'key')
}

/** matchingTagIds(name), music-tags.ts: album-library tags whose key is one of the names. */
export async function tagIdsWithKeys(
  tx: SqliteExecutor,
  keys: readonly string[],
  mediaType: TagMediaType,
): Promise<string[]> {
  if (keys.length === 0) return []
  return readColumn(
    tx,
    sql`SELECT id FROM tag WHERE media_type = ${mediaType} AND key IN ${values(keys)}`,
    IdRowSchema,
    'id',
  )
}

/**
 * The raw artist profile keys mediaIdsWithArtistTag(name), music-tags.ts,
 * looks for: the wanted names, the identity keys and alias keys of the album
 * tags they name, kept when the key's own canonical label (the key of its
 * code-point-least canonical tag name, or the key itself without one) is
 * wanted. Empty keys never match.
 */
export async function artistTagRawKeys(
  tx: SqliteExecutor,
  wanted: readonly string[],
): Promise<string[]> {
  const targets = sql`SELECT id FROM tag WHERE media_type = 'album' AND key IN ${values(wanted)}`
  const candidates = sql`SELECT value AS key FROM json_each(${JSON.stringify(wanted)})
    UNION SELECT key FROM tag_identity WHERE tag_id IN (${targets})
    UNION SELECT original.key FROM tag original
      WHERE original.media_type = 'album' AND original.alias_target_id IN (${targets})`
  const canonical = sql`SELECT i.key AS key, target.name AS name, target.key AS label
      FROM tag_identity i JOIN tag target ON target.id = i.tag_id
      WHERE target.media_type = 'album' AND i.key IN (SELECT key FROM candidates)
    UNION ALL SELECT original.key, target.name, target.key FROM tag original
      JOIN tag target ON target.id = coalesce(original.alias_target_id, original.id)
      WHERE original.media_type = 'album' AND target.media_type = 'album'
        AND original.key IN (SELECT key FROM candidates)`
  const rows = await readRows(
    tx,
    sql`WITH candidates(key) AS (${candidates}),
      canonical AS (${canonical})
      SELECT c.key AS key,
        (SELECT label FROM canonical WHERE canonical.key = c.key
          ORDER BY name LIMIT 1) AS label
      FROM candidates c`,
  )
  const wantedKeys = new Set(wanted)
  return rows
    .map((row) => LabelRowSchema.parse(row))
    .filter((row) => row.key !== '' && wantedKeys.has(row.label ?? row.key))
    .map((row) => row.key)
}

/**
 * Whether any library track has an in-Browse Sonovault tag among the IDs:
 * the uncorrelated test trackIdsWithTag, music-tags.ts, makes before a track
 * with tags of its own inherits album and artist tags.
 */
export async function anyTrackHasSonovaultTag(
  tx: SqliteExecutor,
  tagIds: readonly string[],
): Promise<boolean> {
  if (tagIds.length === 0) return false
  const rows = await readRows(
    tx,
    sql`SELECT 1 AS found FROM item_tag
      WHERE tag_id IN ${values(tagIds)} AND entity = 'track' AND level = 'ownSonovaultTagIds'
      LIMIT 1`,
  )
  return rows.length > 0
}

/** Items carrying one of the tag IDs at an `item_tag` level. */
export function itemsWithTags(
  entity: ItemEntity,
  level: string,
  tagIds: readonly string[],
): Sql {
  return sql`t.rid IN (SELECT rid FROM item_tag
    WHERE tag_id IN ${values(tagIds)} AND entity = ${entity} AND level = ${level})`
}

/** Items whose credited artists' raw profile tag keys include one of the keys. */
export function itemsWithArtistTagKeys(
  entity: ItemEntity,
  keys: readonly string[],
): Sql {
  return sql`t.rid IN (SELECT rid FROM item_artist_tag_key
    WHERE key IN ${values(keys)} AND entity = ${entity} AND kind = 'raw')`
}

async function readColumn<Key extends string>(
  tx: SqliteExecutor,
  statement: Sql,
  schema: z.ZodType<Record<Key, string>>,
  key: Key,
): Promise<string[]> {
  const rows = await readRows(tx, statement)
  return rows.map((row) => schema.parse(row)[key])
}
