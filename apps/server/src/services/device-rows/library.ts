import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { JsonValueSchema } from '@repo/schemas/common'
import {
  DeviceBrowseLibrarySchema,
  type DeviceBrowseLibrary,
} from '@repo/schemas/device'
import { db } from '@/lib/db'
import { normalizedTagSql } from '@/lib/tag-sql'
import { listBrowseFields } from '../browse'
import { listeningHistoryStart } from '../listening-series'
import { providerDisplayNames } from '../provider-names'
import {
  anyId,
  compareCodePoints,
  idAfter,
  isJsonObject,
  toJson,
  type JsonObject,
} from './projection'

/** Tag rows, tag keys with their ancestors, and the library-wide `meta` rows. */

const IdRowsSchema = z.array(z.object({ id: z.string() }))
const PayloadRowsSchema = z.array(
  z.object({ id: z.string(), payload: JsonValueSchema }),
)
const tagMediaTypes = sql`('album', 'film')`

async function readIds(source: SQL, afterId: string | null, limit: number) {
  const result = await db.execute(sql`select id from (${source}) published
    where ${idAfter(sql`id`, afterId)}
    order by id limit ${limit}`)
  return IdRowsSchema.parse(result.rows).map((row) => row.id)
}

async function readPayloads(query: SQL) {
  const result = await db.execute(query)
  const payloads = new Map<string, JsonObject>()
  for (const { id, payload } of PayloadRowsSchema.parse(result.rows))
    if (isJsonObject(payload)) payloads.set(id, payload)
  return payloads
}

export function listTagIds(afterId: string | null, limit: number) {
  return readIds(
    sql`select t.id from tag t where t.media_type in ${tagMediaTypes}`,
    afterId,
    limit,
  )
}

/**
 * canonicalTagRows and matchingTagNames, music-tags.ts, read these per tag.
 * `sonovault` is the test trackIdsWithTag (Auto) and
 * browse_track_sonovault_values, browse.ts, make of a tag: they read every
 * library_track's track tags, so it covers tracks the feed does not publish.
 */
export function renderTags(ids: string[]) {
  const sorted = (rows: SQL) =>
    sql`coalesce((select jsonb_agg(d.value order by d.value) from (${rows}) d), '[]'::jsonb)`
  return readPayloads(sql`select t.id, jsonb_build_object(
      'mediaType', t.media_type,
      'name', t.name,
      'key', ${normalizedTagSql(sql`t.name`)},
      'kind', t.kind,
      'hidden', t.hidden,
      'aliasTargetId', (select a.target_tag_id from tag_alias a where a.source_tag_id = t.id),
      'identityKeys', ${sorted(sql`select distinct i.normalized_name collate "C" as value
        from tag_identity i where i.tag_id = t.id and i.media_type = t.media_type`)},
      'sonovault', exists (select 1 from track_tag sonovault_tag
        where sonovault_tag.tag_id = t.id and sonovault_tag.in_browse and sonovault_tag.sonovault)
    ) as payload
    from tag t where t.id = ${anyId(ids)} and t.media_type in ${tagMediaTypes}`)
}

export function listTagKeyIds(afterId: string | null, limit: number) {
  return readIds(
    sql`select distinct a.media_type::text || ':' || a.descendant_key as id
      from tag_ancestor a where a.media_type in ${tagMediaTypes}`,
    afterId,
    limit,
  )
}

const TagKeyIdSchema = z
  .string()
  .regex(/^(album|film):/)
  .transform((id) => {
    const separator = id.indexOf(':')
    return {
      id,
      mediaType: id.slice(0, separator),
      key: id.slice(separator + 1),
    }
  })

/** tag_ancestor, tag-hierarchy.ts: every stored ancestor of one normalised name. */
export function renderTagKeys(ids: string[]) {
  const keys = ids.flatMap((id) => {
    const parsed = TagKeyIdSchema.safeParse(id)
    return parsed.success ? [parsed.data] : []
  })
  if (!keys.length) return Promise.resolve(new Map<string, JsonObject>())
  return readPayloads(sql`select requested.id, jsonb_build_object(
      'mediaType', requested.media_type,
      'key', requested.key,
      'ancestorKeys', jsonb_agg(a.ancestor_key collate "C" order by a.ancestor_key collate "C")
    ) as payload
    from unnest(
      ${sql.param(keys.map((key) => key.id))}::text[],
      ${sql.param(keys.map((key) => key.mediaType))}::text[],
      ${sql.param(keys.map((key) => key.key))}::text[]
    ) requested(id, media_type, key)
    join tag_ancestor a on a.media_type::text = requested.media_type
      and a.descendant_key = requested.key
    group by requested.id, requested.media_type, requested.key`)
}

const metaIds = [
  ...DeviceBrowseLibrarySchema.options.map((library) => `fields:${library}`),
  'listening',
  'providers',
  'fold',
]

export function listMetaIds(afterId: string | null, limit: number) {
  return readIds(
    sql`select unnest(${sql.param(metaIds)}::text[]) as id`,
    afterId,
    limit,
  )
}

async function libraryFields(library: DeviceBrowseLibrary) {
  return library === 'artist' ? artistBrowseFields : listBrowseFields(library)
}

const HistoryStartSchema = z.array(
  z.object({ history_start: z.string().nullable() }),
)

const FoldRowsSchema = z.array(
  z.object({ code_points: z.array(z.number()), lower: z.array(z.string()) }),
)

/**
 * The `fold` row: every code point this database's `lower()` changes, with
 * its result, so a device folds text as the Browse services' `lower()` and
 * `ILIKE` do on this server. The surrogates and zero have no `chr()`. About
 * 1,500 code points (14 kB of JSON) and 0.2 to 0.4 s of one CPU, without
 * reading a table; it is rendered once per sweep.
 */
const foldMapping = sql`select
    coalesce(array_agg(c order by c), '{}') as code_points,
    coalesce(array_agg(lower(chr(c)) order by c), '{}') as lower
  from (select generate_series(1, 1114111) as c) code_point
  where (c < 55296 or c > 57343) and lower(chr(c)) <> chr(c)`

async function renderMetaRow(id: string): Promise<JsonObject | undefined> {
  const library = DeviceBrowseLibrarySchema.safeParse(
    id.startsWith('fields:') ? id.slice('fields:'.length) : undefined,
  )
  if (library.success) {
    const value = toJson({
      kind: 'fields',
      library: library.data,
      fields: await libraryFields(library.data),
    })
    return isJsonObject(value) ? value : undefined
  }
  if (id === 'listening') {
    const result = await db.execute(
      sql`select ${listeningHistoryStart} as history_start`,
    )
    const [row] = HistoryStartSchema.parse(result.rows)
    return { kind: 'listening', historyStart: row?.history_start ?? null }
  }
  if (id === 'providers')
    return {
      kind: 'providers',
      names: [...(await providerDisplayNames())]
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([providerId, displayName]) => ({ id: providerId, displayName })),
    }
  if (id === 'fold') {
    const [row] = FoldRowsSchema.parse((await db.execute(foldMapping)).rows)
    return {
      kind: 'fold',
      codePoints: row?.code_points ?? [],
      lower: row?.lower ?? [],
    }
  }
}

export async function renderMeta(ids: string[]) {
  const payloads = new Map<string, JsonObject>()
  for (const id of new Set(ids)) {
    const payload = await renderMetaRow(id)
    if (payload) payloads.set(id, payload)
  }
  return payloads
}
