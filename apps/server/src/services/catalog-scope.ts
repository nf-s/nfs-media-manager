import { sql, type SQL } from 'drizzle-orm'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'

export function catalogScopeCondition(
  id: SQL,
  member: SQL,
  query: CatalogScopeQuery,
  kind?: string,
): SQL {
  const scope = query.libraryScope ?? 'library'
  if (scope === 'library' && query.discoverySourceScope !== 'selection')
    return member
  const operations = [...new Set(query.discoverySources?.split(',') ?? [])]
  if (scope === 'all' && !operations.length) return sql`true`
  const target = kind
    ? sql`o.target_kind = ${kind} and o.target_id = ${id}`
    : sql`o.media_item_id = ${id}`
  const exists = (
    operation: SQL,
  ) => sql`exists (select 1 from catalog_observation o
    where ${target} and ${operation})`
  // Keep an indexed existence test for each required origin. A correlated
  // aggregate has to collect and deduplicate evidence for every counted row.
  const matchesOrigins =
    operations.length === 0
      ? sql`true`
      : query.discoverySourceMode === 'all'
        ? sql`(${sql.join(
            operations.map((operation) =>
              exists(sql`o.operation = ${operation}`),
            ),
            sql` and `,
          )})`
        : exists(sql`o.operation = any(${sql.param(operations)}::text[])`)
  const origin =
    query.discoverySourceMode === 'exclude' && operations.length
      ? sql`not (${matchesOrigins})`
      : matchesOrigins
  if (scope === 'outside') return sql`(not (${member}) and ${origin})`
  if (scope === 'library') return sql`((${member}) and ${origin})`
  return query.discoverySourceScope === 'selection'
    ? origin
    : sql`((${member}) or ${origin})`
}

export function memberScope(query: CatalogScopeQuery) {
  return (
    (!query.libraryScope || query.libraryScope === 'library') &&
    !(query.discoverySources && query.discoverySourceScope === 'selection')
  )
}
