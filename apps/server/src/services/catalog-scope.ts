import { sql, type SQL } from 'drizzle-orm'
import type { CatalogScopeQuery } from '@repo/schemas/catalog'

export function catalogScopeCondition(id: SQL, member: SQL, query: CatalogScopeQuery, kind?: string): SQL {
  const target = kind ? sql`o.target_kind = ${kind} and o.target_id = ${id}` : sql`o.media_item_id = ${id}`
  const scope = query.libraryScope ?? 'library'
  if (scope === 'library') return member
  const operations = [...new Set(query.discoverySources?.split(',') ?? [])]
  if (scope === 'all' && !operations.length) return sql`true`
  const outside = operations.length === 0
    ? sql`true`
    : query.discoverySourceMode === 'all'
      ? sql`(select count(distinct o.operation) from catalog_observation o
          where ${target} and o.operation = any(${sql.param(operations)}::text[])) = ${operations.length}`
      : sql`exists (select 1 from catalog_observation o
          where ${target} and o.operation = any(${sql.param(operations)}::text[]))`
  return scope === 'outside' ? sql`(not (${member}) and ${outside})` : sql`((${member}) or ${outside})`
}

export function memberScope(query: CatalogScopeQuery) {
  return !query.libraryScope || query.libraryScope === 'library'
}
