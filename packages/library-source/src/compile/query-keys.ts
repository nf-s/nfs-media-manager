/**
 * DEVICE-34: every key of every parsed query a read takes is named in a
 * table beside the code that reads it, `served` or `api`. The table's type
 * names each key of the query type, so a key added to or removed from a
 * schema fails `tsc` in this package until someone decides; `api` is the
 * safe decision.
 */

/**
 * How the device treats one key of a parsed query. `served`: the reader
 * reads the key, answering it as the service does or falling through with
 * a reason of its own, or the service ignores it on every read the device
 * answers (the table's comment says which). `api`: a read holding a value
 * for the key goes to the API with `unimplemented-field`.
 */
export type QueryKeyUse = 'served' | 'api'

/** One entry for every key of `Query`, optional keys included. */
export type QueryKeys<Query> = { readonly [Key in keyof Query]-?: QueryKeyUse }

/** One parsed query object and the table of its type. */
export type QueryKeyCheck = {
  readonly query: Readonly<Record<string, unknown>>
  readonly keys: Readonly<Record<string, QueryKeyUse>>
}

/** Pairs a parsed query with the table of its type, checked by `tsc`. */
export function queryKeyCheck<Query extends Readonly<Record<string, unknown>>>(
  query: Query,
  keys: QueryKeys<Query>,
): QueryKeyCheck {
  return { query, keys }
}

/**
 * The first key of the queries that holds a value and is not `served`, or
 * undefined. A value is anything but `undefined`: an empty array, an empty
 * string or an empty object counts, and so does a schema default, so a key
 * marked `api` must have none (the unit tests assert it). A key the table
 * does not name counts as `api`.
 */
export function unservedQueryKey(
  checks: readonly QueryKeyCheck[],
): string | undefined {
  for (const { query, keys } of checks)
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && keys[key] !== 'served') return key
  return undefined
}
