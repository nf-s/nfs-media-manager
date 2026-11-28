import { z } from 'zod'
import type {
  BrowseField,
  BrowseFilter,
  BrowseRange,
} from '@repo/schemas/browse'
import {
  DeviceMetaRowSchema,
  type DeviceBrowseLibrary,
} from '@repo/schemas/device'
import type { SqliteExecutor } from '../driver'
import type { ItemEntity } from '../schema'
import { foldText } from '../fold'
import { and, or, not, sql, type Sql } from './sql'
import { unsupported } from './unsupported'

/**
 * A library's field table: how the device reads each Browse field from the
 * store. Every query reads the item table as `t`; conditions and values
 * below are written against it. A library supplies one table and the core
 * does the rest (validation, filter modes, ranges, search, sorting).
 */
export type FieldTable<Context> = {
  entity: ItemEntity
  /** The `meta` row `fields:<library>` that lists the fields the API accepts. */
  library: DeviceBrowseLibrary
  /** Text filters: the condition one value gives. */
  filters: Record<string, FilterMatch<Context>>
  /** Range fields. */
  ranges: Record<string, RangeSpec>
  /** Sort keys other than the listening sort. */
  sorts: Record<string, SortSpec<Context>>
  /** What `q` reads for each searched text field. */
  search: SearchSpec
}

/** The condition one filter value gives, on the item table `t`. May throw `UnsupportedQuery`. */
export type FilterMatch<Context> = (
  value: string,
  context: Context,
  filter: BrowseFilter,
) => Promise<Sql> | Sql

export type SortSpec<Context> =
  | ValueSource
  | ((context: Context) => ValueSource)

/** Where a value is stored: a column of the item table, or a row of `item_num` or `item_sort`. */
export type ValueSource =
  | { kind: 'column'; expression: Sql }
  | { kind: 'num'; field: string }
  | { kind: 'sort'; field: string }

/** Dates arrive in milliseconds and are stored in whole microseconds. */
export type RangeSpec = { source: ValueSource; unit: 'date' | 'number' }

/** The `item_text` and `item_search` fields one `q` word is matched against. */
export type SearchFields = {
  text: readonly string[]
  search: readonly string[]
}

/**
 * For each text field the service searches, the store field holding its
 * values: `text` (`item_text`) or `search` (`item_search`). Text fields the
 * service leaves out of `q` are listed in `unsearched`.
 */
export type SearchSpec = {
  fields: Record<string, { table: 'text' | 'search'; field: string }>
  unsearched: readonly string[]
}

const FieldsMetaSchema = z.object({ value: z.string() })

/**
 * The fields the API accepts for a library, as the server published them.
 * A store without the row cannot judge a query.
 */
export async function readBrowseFields(
  tx: SqliteExecutor,
  library: DeviceBrowseLibrary,
): Promise<BrowseField[]> {
  const [row] = await tx.all('SELECT value FROM meta WHERE id = ?', [
    `fields:${library}`,
  ])
  if (row === undefined) return unsupported('not-ready')
  const meta = DeviceMetaRowSchema.parse(
    JSON.parse(FieldsMetaSchema.parse(row).value),
  )
  if (meta.kind !== 'fields' || meta.library !== library)
    return unsupported('store-error')
  return meta.fields
}

/**
 * Checks filter, range and sort fields as the API does: a field the API
 * rejects is `invalid-query`; one it accepts that this table cannot read is
 * `unknown-field`.
 */
export function checkFields<Context>(
  table: FieldTable<Context>,
  fields: readonly BrowseField[],
  query: {
    filters: readonly BrowseFilter[]
    ranges: readonly BrowseRange[]
    sortBy: string
  },
  extraSorts: readonly string[] = [],
): void {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  if (!byKey.has(query.sortBy) && !extraSorts.includes(query.sortBy))
    unsupported('invalid-query')
  if (
    !extraSorts.includes(query.sortBy) &&
    !Object.hasOwn(table.sorts, query.sortBy)
  )
    unsupported('unknown-field')
  for (const filter of query.filters) {
    if (byKey.get(filter.field)?.type !== 'text') unsupported('invalid-query')
    if (!Object.hasOwn(table.filters, filter.field))
      unsupported('unknown-field')
  }
  for (const range of query.ranges) {
    const field = byKey.get(range.field)
    if (field === undefined || field.type === 'text')
      unsupported('invalid-query')
    if (!Object.hasOwn(table.ranges, range.field)) unsupported('unknown-field')
  }
}

/**
 * The store fields `q` reads, from the API's field list as
 * browseTextSearchIds, browse.ts, chooses them: every text field it does
 * not leave out. A searched field this table cannot read is `unknown-field`.
 */
export function searchFields<Context>(
  table: FieldTable<Context>,
  fields: readonly BrowseField[],
): SearchFields {
  const text: string[] = []
  const search: string[] = []
  for (const field of fields) {
    if (field.type !== 'text' || table.search.unsearched.includes(field.key))
      continue
    const source = table.search.fields[field.key]
    if (source === undefined) return unsupported('unknown-field')
    if (source.table === 'text') text.push(source.field)
    else search.push(source.field)
  }
  return { text, search }
}

/**
 * Filter modes as browseFieldConditions, browse.ts: required filters are
 * ANDed, exclude filters negated, and every `any` or unset filter goes into
 * one OR group across fields.
 */
export async function filterConditions<Context>(
  table: FieldTable<Context>,
  filters: readonly BrowseFilter[],
  context: Context,
): Promise<Sql[]> {
  const conditions: Sql[] = []
  const any: Sql[] = []
  for (const filter of filters) {
    const match = table.filters[filter.field]
    if (match === undefined) return unsupported('unknown-field')
    const condition = await match(filter.value, context, filter)
    if (filter.mode === 'exclude') conditions.push(not(condition))
    else if (filter.mode === 'required') conditions.push(condition)
    else any.push(condition)
  }
  if (any.length > 0) conditions.push(or(any))
  return conditions
}

/** Items with a stored text value of `field` equal to `folded`, compared by code point. */
export function textEquals(
  entity: ItemEntity,
  field: string,
  folded: string,
): Sql {
  return sql`t.rid IN (SELECT rid FROM item_text
    WHERE entity = ${entity} AND field = ${field} AND folded = ${folded})`
}

/** `lower(value) = lower(query value)`: the query value folded as PostgreSQL folds. */
export function textMatch(
  entity: ItemEntity,
  field: string,
): (value: string) => Sql {
  return (value) => textEquals(entity, field, foldText(value))
}

/** The value of a source for the current row of `t`; null when missing. */
export function valueExpression(entity: ItemEntity, source: ValueSource): Sql {
  switch (source.kind) {
    case 'column':
      return source.expression
    case 'num':
      return sql`(SELECT value FROM item_num
        WHERE entity = ${entity} AND rid = t.rid AND field = ${source.field})`
    case 'sort':
      return sql`(SELECT value FROM item_sort
        WHERE entity = ${entity} AND rid = t.rid AND field = ${source.field})`
  }
}

/**
 * A range as rangeCondition, lib/browse-range.ts: inclusive bounds; with
 * `includeMissing` a missing value also passes; without bounds the value
 * must be present unless `includeMissing`.
 */
export function rangeCondition(
  entity: ItemEntity,
  range: BrowseRange,
  spec: RangeSpec,
): Sql {
  const min =
    range.min === undefined ? undefined : scaledBound(range.min, spec, 'min')
  const max =
    range.max === undefined ? undefined : scaledBound(range.max, spec, 'max')
  if (spec.source.kind === 'num') {
    const field = spec.source.field
    const present = sql`(SELECT rid FROM item_num WHERE entity = ${entity} AND field = ${field})`
    if (min === undefined && max === undefined)
      return range.includeMissing ? and([]) : sql`t.rid IN ${present}`
    const bounds: Sql[] = []
    if (min !== undefined) bounds.push(sql`value >= ${min}`)
    if (max !== undefined) bounds.push(sql`value <= ${max}`)
    const within = sql`t.rid IN (SELECT rid FROM item_num
      WHERE entity = ${entity} AND field = ${field} AND ${and(bounds)})`
    return range.includeMissing
      ? or([within, sql`t.rid NOT IN ${present}`])
      : within
  }
  return boundsCondition(valueExpression(entity, spec.source), {
    min,
    max,
    includeMissing: range.includeMissing,
  })
}

/** Inclusive bounds on an expression that is null when the value is missing. */
export function boundsCondition(
  value: Sql,
  range: {
    min: number | undefined
    max: number | undefined
    includeMissing: boolean
  },
): Sql {
  const bounds: Sql[] = []
  if (range.min !== undefined) bounds.push(sql`${value} >= ${range.min}`)
  if (range.max !== undefined) bounds.push(sql`${value} <= ${range.max}`)
  if (bounds.length === 0)
    return range.includeMissing ? and([]) : sql`${value} IS NOT NULL`
  return range.includeMissing
    ? or([and(bounds), sql`${value} IS NULL`])
    : and(bounds)
}

/**
 * A bound in the stored unit. Dates are stored in whole microseconds, so a
 * millisecond bound becomes the whole number of microseconds on the right
 * side of it; this stays exact when the bound has a fraction, which the
 * server compares as `numeric`.
 */
export function scaledBound(
  value: number,
  spec: RangeSpec,
  side: 'min' | 'max',
): number {
  if (spec.unit === 'number') return value
  return millisecondsToMicroseconds(value, side)
}

/**
 * `value` milliseconds in whole microseconds: rounded up for a lower bound
 * and down for an upper bound, so `stored >= result` holds exactly when
 * `stored >= value * 1000` for every whole stored value. The decimal form
 * of the number is the one the server binds.
 */
export function millisecondsToMicroseconds(
  value: number,
  side: 'min' | 'max',
): number {
  const scaled = value * 1000
  if (Number.isSafeInteger(value) && Number.isSafeInteger(scaled)) return scaled
  const exact = decimalTimesThousand(value)
  const rounded = side === 'min' ? exact.ceil : exact.floor
  const limit = BigInt(Number.MAX_SAFE_INTEGER) + 1n
  if (rounded > limit) return Number(limit)
  if (rounded < -limit) return -Number(limit)
  return Number(rounded)
}

/** floor and ceil of `value * 1000`, computed on the shortest decimal form of `value`. */
function decimalTimesThousand(value: number): { floor: bigint; ceil: bigint } {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(value))
  if (match === null) throw new Error(`Cannot scale the bound ${value}.`)
  const [, sign = '', whole = '0', fraction = '', exponent = '0'] = match
  const digits = BigInt(`${whole}${fraction}`)
  const shift = Number(exponent) + 3 - fraction.length
  let floor: bigint
  let exact: boolean
  if (shift >= 0) {
    floor = digits * 10n ** BigInt(shift)
    exact = true
  } else {
    const divisor = 10n ** BigInt(-shift)
    floor = digits / divisor
    exact = digits % divisor === 0n
  }
  if (sign === '-') {
    return exact
      ? { floor: -floor, ceil: -floor }
      : { floor: -floor - 1n, ceil: -floor }
  }
  return exact ? { floor, ceil: floor } : { floor, ceil: floor + 1n }
}
