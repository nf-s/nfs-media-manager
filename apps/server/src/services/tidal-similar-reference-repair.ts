import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { mapSuggestions } from './similar-library-matches'
import { codeKey } from './spotify-code-search'
import { readStoredSimilarPages } from './stored-tidal-similar-pages'
import { shareSimilarReferences } from './tidal-similar-references'

export async function repairTidalSimilarReferences(
  database: typeof db,
  apply: boolean,
) {
  const { pages, unreadable } = await readStoredSimilarPages(database)
  const identities = new Map<string, Set<string>>()
  const disputed = new Set<string>()
  for (const { kind, items } of pages)
    for (const item of items) {
      const key = codeKey(kind, item.code ?? '')
      if (!key) continue
      const ids = identities.get(key) ?? new Set<string>()
      ids.add(item.tidalId)
      identities.set(key, ids)
      if (ids.size > 1) disputed.add(key)
    }
  let writes = 0
  const rollback = new Error('Finish dry run')
  for (const { kind, items, origin } of pages) {
    const located = items.map((item) => ({
      ...item,
      catalogMediaItemId:
        item.catalogMediaItemId ??
        createStableId(
          `catalog-${kind}`,
          JSON.stringify(['tidal', kind, item.tidalId]),
        ),
    }))
    try {
      await database.transaction(async (tx) => {
        const mapped = await mapSuggestions(tx, kind, located)
        writes += await shareSimilarReferences(
          tx,
          kind,
          mapped,
          origin,
          disputed,
        )
        if (!apply) throw rollback
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  }
  return {
    pages: pages.length,
    unreadable,
    disputedCodes: disputed.size,
    writes,
  }
}
