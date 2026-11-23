import { inArray, or, sql, type SQL } from 'drizzle-orm'
import { getBuiltinProviderCatalog } from '@/lib/provider-catalog'
import { listLoadedScrapePlugins } from '@/plugins/registry'

/**
 * Each provider's display name from the catalog `/api/v1/providers` serves:
 * the built-in providers and the loaded plugins. A Provider filter value is
 * the ID; a provider missing from the catalog is shown by its ID.
 */
export async function providerDisplayNames(): Promise<
  ReadonlyMap<string, string>
> {
  const names = new Map<string, string>(
    getBuiltinProviderCatalog().map((provider) => [
      provider.id,
      provider.displayName,
    ]),
  )
  for (const plugin of await listLoadedScrapePlugins())
    names.set(plugin.manifest.id, plugin.manifest.displayName)
  return names
}

/**
 * A word typed for a Provider suggestion matches the stored ID (`matchesId`)
 * or the display name of the provider it identifies.
 */
export function providerWordMatch(
  value: SQL,
  word: string,
  matchesId: SQL,
  names: ReadonlyMap<string, string>,
): SQL {
  const lower = word.toLowerCase()
  const named = [...names]
    .filter(([, name]) => name.toLowerCase().includes(lower))
    .map(([id]) => id)
  return named.length
    ? (or(matchesId, inArray(sql`${value}`, named)) ?? matchesId)
    : matchesId
}
