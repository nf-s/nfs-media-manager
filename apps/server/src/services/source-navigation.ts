import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { providerCurrentState, providerSnapshot } from '@/schemas/db'
import { listLoadedScrapePlugins } from '@/plugins/registry'
import {
  collectionSourceLinks,
  expandSourceTemplate,
  sourceLink,
} from '@/lib/source-navigation'

const StoredCollectionsSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string().min(1) }),
)

function discogsTagProjection(payload: SQL, provider: SQL): SQL<unknown> {
  const record = sql`case when ${provider} = 'legacy-record' then ${payload}->'discogs' else ${payload} end`
  return sql<unknown>`jsonb_build_object(
    'genres', ${record}->'genres', 'styles', ${record}->'styles',
    'master', jsonb_build_object('genres', ${record}->'master'->'genres', 'styles', ${record}->'master'->'styles'),
    'release', jsonb_build_object('genres', ${record}->'release'->'genres', 'styles', ${record}->'release'->'styles'),
    'mainRelease', jsonb_build_object('genres', ${record}->'mainRelease'->'genres', 'styles', ${record}->'mainRelease'->'styles')
  )`
}

export async function getStoredDiscogsTagPayloads(mediaIds: string[]) {
  if (!mediaIds.length) return []
  const history = await db
    .select({
      mediaItemId: providerSnapshot.mediaItemId,
      payload: discogsTagProjection(
        sql`${providerSnapshot.payload}`,
        sql`${providerSnapshot.provider}`,
      ),
    })
    .from(providerSnapshot)
    .where(
      and(
        inArray(providerSnapshot.mediaItemId, mediaIds),
        inArray(providerSnapshot.provider, ['discogs', 'legacy-record']),
      ),
    )
  const current = await db
    .select({
      mediaItemId: providerCurrentState.mediaItemId,
      payload: discogsTagProjection(
        sql`${providerCurrentState.payload}`,
        sql`${providerCurrentState.provider}`,
      ),
    })
    .from(providerCurrentState)
    .where(
      and(
        inArray(providerCurrentState.mediaItemId, mediaIds),
        inArray(providerCurrentState.provider, ['discogs', 'legacy-record']),
      ),
    )
  return [...history, ...current]
}

export async function getCollectionSourceLinks(
  mediaId: string,
  metadata: Record<string, unknown>,
) {
  const plugins = await listLoadedScrapePlugins()
  const links = collectionSourceLinks(
    metadata,
    plugins.map((plugin) => plugin.manifest),
  )
  const readers = plugins.filter((plugin) => plugin.readStoredCollections)
  if (readers.length) {
    // Read existing payloads only. Do not normalize/write media or request a scrape.
    const states = await db
      .select({
        provider: providerCurrentState.provider,
        payload: providerCurrentState.payload,
      })
      .from(providerCurrentState)
      .where(
        and(
          eq(providerCurrentState.mediaItemId, mediaId),
          inArray(providerCurrentState.provider, [
            'legacy-record',
            ...readers.map((plugin) => plugin.manifest.id),
          ]),
        ),
      )
    for (const plugin of readers) {
      for (const state of states.filter(
        (state) =>
          state.provider === 'legacy-record' ||
          state.provider === plugin.manifest.id,
      )) {
        let stored: unknown
        try {
          stored = plugin.readStoredCollections?.(state.payload)
        } catch {
          // Optional legacy enrichment must not make an otherwise valid detail unavailable.
          continue
        }
        const collections = StoredCollectionsSchema.safeParse(stored)
        if (!collections.success) continue
        for (const collection of collections.data) {
          const link = sourceLink(
            plugin.manifest.id,
            plugin.manifest.displayName,
            collection.name,
            expandSourceTemplate(
              plugin.manifest.sourceNavigation?.collectionUrlTemplate,
              collection,
            ),
          )
          if (
            link &&
            !links.some(
              (existing) =>
                existing.name === link.name && existing.url === link.url,
            )
          )
            links.push(link)
        }
      }
    }
  }
  return links
}
