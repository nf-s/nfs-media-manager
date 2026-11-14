import { and, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { SourceNavigationLink } from '@repo/schemas/tags'
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

const COLLECTION_PAYLOAD_BATCH = 100

/** Resolve collection provenance with bounded reads of supported legacy payloads. */
export async function getCollectionSourceLinksForItems(
  items: readonly { id: string; metadata: Record<string, unknown> }[],
) {
  const linksByItem = new Map<string, SourceNavigationLink[]>()
  if (!items.length) return linksByItem
  const plugins = await listLoadedScrapePlugins()
  const manifests = plugins.map((plugin) => plugin.manifest)
  for (const item of items)
    linksByItem.set(item.id, collectionSourceLinks(item.metadata, manifests))
  const readers = plugins.filter((plugin) => plugin.readStoredCollections)
  if (readers.length) {
    // Read existing payloads only. Do not normalize/write media or request a scrape.
    const ids = [...linksByItem.keys()]
    for (
      let offset = 0;
      offset < ids.length;
      offset += COLLECTION_PAYLOAD_BATCH
    ) {
      const states = await db
        .select({
          mediaItemId: providerCurrentState.mediaItemId,
          provider: providerCurrentState.provider,
          payload: providerCurrentState.payload,
        })
        .from(providerCurrentState)
        .where(
          and(
            inArray(
              providerCurrentState.mediaItemId,
              ids.slice(offset, offset + COLLECTION_PAYLOAD_BATCH),
            ),
            inArray(providerCurrentState.provider, [
              'legacy-record',
              ...readers.map((plugin) => plugin.manifest.id),
            ]),
          ),
        )
      for (const state of states) {
        const links = linksByItem.get(state.mediaItemId)
        if (!links) continue
        for (const plugin of readers) {
          if (
            state.provider !== 'legacy-record' &&
            state.provider !== plugin.manifest.id
          )
            continue
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
  }
  return linksByItem
}

export async function getCollectionSourceLinks(
  mediaId: string,
  metadata: Record<string, unknown>,
) {
  const links = await getCollectionSourceLinksForItems([
    { id: mediaId, metadata },
  ])
  return links.get(mediaId) ?? []
}
