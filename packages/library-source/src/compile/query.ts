import type { CatalogScopeQuery } from '@repo/schemas/catalog'
import { isTrackDiscoverySource } from '@repo/schemas/catalog'
import { join, sql, type Sql } from './sql'

/**
 * Pieces every Browse library shares: the catalog scope test, ordering
 * terms and the paging rules of queryBrowsePageIds, queryBrowseIds,
 * browseRanks and queryBrowseCounts, browse.ts.
 */

/**
 * memberScope, catalog-scope.ts: the library, with no selection-scoped
 * discovery operations. The device holds library rows only.
 */
export function isMemberScope(
  query: CatalogScopeQuery,
  kind?: 'track',
): boolean {
  const operations = [...new Set(query.discoverySources?.split(','))]
  const counted =
    kind === 'track' ? operations.filter(isTrackDiscoverySource) : operations
  return (
    (query.libraryScope === undefined || query.libraryScope === 'library') &&
    !(query.discoverySourceScope === 'selection' && counted.length > 0)
  )
}

export type Direction = 'asc' | 'desc'

/** `value dir NULLS LAST`, or `NULLS FIRST` where the service asks for it. */
export function orderTerm(
  value: Sql,
  direction: Direction,
  nulls: 'first' | 'last' = 'last',
): Sql {
  const order = direction === 'desc' ? sql`DESC` : sql`ASC`
  return nulls === 'first'
    ? sql`${value} ${order} NULLS FIRST`
    : sql`${value} ${order} NULLS LAST`
}

export function orderBy(terms: readonly Sql[]): Sql {
  return sql`ORDER BY ${join(terms, ', ')}`
}

type Paged = { page: number; size: number; limitResults?: number }

/**
 * A Browse page (queryBrowsePageIds): `size + 1` rows, so the extra one
 * says whether the page continues, fewer when `limitResults` ends the
 * result first. Null when the cap leaves nothing to read.
 */
export function pageWindow(
  query: Paged,
): { offset: number; limit: number } | null {
  const offset = (query.page - 1) * query.size
  const remaining =
    query.limitResults === undefined
      ? query.size + 1
      : Math.max(0, query.limitResults - offset)
  if (remaining === 0) return null
  return { offset, limit: Math.min(query.size + 1, remaining) }
}

/** The older paginated list (queryBrowseIds): the rows left after the offset, up to `size`. */
export function listWindow(
  query: Paged,
  totalCount: number,
): { offset: number; limit: number } {
  const offset = (query.page - 1) * query.size
  return {
    offset,
    limit: Math.min(query.size, Math.max(0, totalCount - offset)),
  }
}

/** A total capped by `limitResults`. */
export function capCount(total: number, limitResults?: number): number {
  return Math.min(total, limitResults ?? total)
}

/** browseRanks: distinct positions below `limitResults`. */
export function positionsWithin(
  positions: readonly number[],
  limitResults?: number,
): number[] {
  return [...new Set(positions)].filter(
    (position) => position < (limitResults ?? Infinity),
  )
}
