import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { JsonValueSchema, type JsonValue } from '@repo/schemas/common'
import { db } from '@/lib/db'

/**
 * Projection values for a batch of device rows, read in one statement. Each
 * value is placed at a dot path of the payload (`sort.genre.auto`), so the
 * statement returns finished values and the device never recomputes them.
 */

export type JsonObject = { [key: string]: JsonValue }

/** The batch's IDs, compared as `= any(...)`. */
export function anyId(ids: readonly string[]): SQL {
  return sql`any(${sql.param([...ids])}::text[])`
}

/** A Browse value in epoch milliseconds as microseconds, the stored precision. */
export function microseconds(milliseconds: SQL): SQL {
  return sql`((${milliseconds}) * 1000)`
}

/** A timestamp as epoch microseconds. */
export function epochMicroseconds(timestamp: SQL): SQL {
  return sql`(extract(epoch from ${timestamp}) * 1000000)`
}

/**
 * Distinct non-null texts of `rows` (`id`, `value`) for the batch, as a JSON
 * array in code-point order. Values are distinct by exact value.
 */
export function textValues(rows: SQL, ids: SQL): SQL {
  return sql`select d.id, jsonb_agg(d.value order by d.value) as value from (
    select distinct r.id, r.value::text collate "C" as value from (${rows}) r
    where r.id = ${ids} and r.value is not null
  ) d group by d.id`
}

/**
 * One value per ID at `path`: `rows` returns `id` and a JSON `value`. A path
 * ending in `*` takes an object whose members are placed under the prefix.
 */
export type ProjectionPart = {
  path: string
  rows: SQL
  /** For a `*` path: the members to place. */
  keep?: (key: string) => boolean
}

/** Values read from the base row, one per ID. */
export type ProjectionScalar = readonly [path: string, value: SQL]

export type Projection = {
  /** `with` entries shared by the parts, without the keyword. */
  with?: SQL
  /** The base row: its `from` and `where` decide which IDs have a row. */
  id: SQL
  from: SQL
  where: SQL
  scalars: readonly ProjectionScalar[]
  parts: readonly ProjectionPart[]
}

const ProjectionRowsSchema = z.array(
  z.object({ path: z.string(), id: z.string(), value: JsonValueSchema }),
)

// jsonb_build_object takes at most 100 arguments.
const objectChunk = 40

function jsonObject(entries: readonly ProjectionScalar[]): SQL {
  const chunks: SQL[] = []
  for (let start = 0; start < entries.length; start += objectChunk) {
    const pairs = entries
      .slice(start, start + objectChunk)
      .map(([path, value]) => sql`${path}::text, ${value}`)
    chunks.push(sql`jsonb_build_object(${sql.join(pairs, sql`, `)})`)
  }
  return chunks.length ? sql.join(chunks, sql` || `) : sql`'{}'::jsonb`
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setPath(
  target: JsonObject,
  path: readonly string[],
  value: JsonValue,
) {
  const [head, ...rest] = path
  if (head === undefined) return
  if (!rest.length) {
    target[head] = value
    return
  }
  const child = target[head]
  const next = isJsonObject(child) ? child : {}
  target[head] = next
  setPath(next, rest, value)
}

/**
 * Reads the projection of every ID that has a base row. `defaults` gives each
 * ID's starting payload; read values replace the defaults at their paths.
 */
export async function readProjection(
  projection: Projection,
  defaults: () => JsonObject,
): Promise<Map<string, JsonObject>> {
  const base = sql`select 'base'::text as path, base.id, base.value from (
    select ${projection.id} as id, ${jsonObject(projection.scalars)} as value
    ${projection.from} where ${projection.where}
  ) base`
  const parts = projection.parts.map(
    ({ path, rows }) =>
      sql`select ${path}::text as path, part.id, part.value from (${rows}) part`,
  )
  const result = await db.execute(
    sql`${projection.with ? sql`with ${projection.with} ` : sql``}${sql.join(
      [base, ...parts],
      sql` union all `,
    )}`,
  )
  const rows = ProjectionRowsSchema.parse(result.rows)
  const payloads = new Map<string, JsonObject>()
  for (const row of rows) {
    if (row.path !== 'base' || !isJsonObject(row.value)) continue
    const payload = defaults()
    for (const [path, value] of Object.entries(row.value))
      setPath(payload, path.split('.'), value)
    payloads.set(row.id, payload)
  }
  const keep = new Map(
    projection.parts.map((part): [string, ProjectionPart['keep']] => [
      part.path,
      part.keep,
    ]),
  )
  for (const row of rows) {
    const payload = payloads.get(row.id)
    if (row.path === 'base' || !payload) continue
    const path = row.path.split('.')
    // `text.*`: the value's members are keys of the section.
    if (path.at(-1) === '*' && isJsonObject(row.value)) {
      const keepKey = keep.get(row.path)
      for (const [key, value] of Object.entries(row.value))
        if (!keepKey || keepKey(key))
          setPath(payload, [...path.slice(0, -1), key], value)
    } else setPath(payload, path, row.value)
  }
  return payloads
}

/** Code-point order, as `collate "C"` orders UTF-8 text. */
export function compareCodePoints(a: string, b: string) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

/** A value as the API sends it: JSON, without undefined members. */
export function toJson(value: unknown): JsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(value)))
}
