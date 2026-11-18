import {
  and,
  asc,
  eq,
  gt,
  inArray,
  notExists,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue, MediaProviderPlugin } from '@repo/media-plugin-sdk'
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
const legacyCollectionProviders = ['legacy-record', 'legacy-browser']

export function matchingCollectionNames(field: SQL, names: readonly string[]) {
  // Membership keys use JavaScript lowercasing. Retain Unicode candidates for
  // exact comparison in JavaScript, independent of the database's locale.
  return sql`(${inArray(sql`lower(${field} collate "C")`, [...names])}
    or octet_length(${field}) > char_length(${field}))`
}

function matchingCollectionPayload(
  normalized: SQLWrapper,
  names: readonly string[],
) {
  const memberships = sql`from jsonb_array_elements(
    case when jsonb_typeof(${normalized}->'playlists') = 'array'
      then ${normalized}->'playlists' else '[]'::jsonb end
  ) membership where membership->>'kind' = 'collection'`
  // Older payloads can lack normalized memberships and require the plugin reader.
  return sql`(not exists (select 1 ${memberships}) or exists (
    select 1 ${memberships} and ${matchingCollectionNames(sql`membership->>'name'`, names)}
  ))`
}

type CollectionPayload = {
  mediaItemId: string | null
  provider: string
  payload: JsonValue
}

function appendPayloadLinks(
  state: CollectionPayload,
  readers: readonly MediaProviderPlugin[],
  linksByItem: Map<string, SourceNavigationLink[]>,
) {
  const links = state.mediaItemId
    ? linksByItem.get(state.mediaItemId)
    : undefined
  if (!links) return
  for (const plugin of readers) {
    if (
      state.provider !== plugin.manifest.id &&
      !legacyCollectionProviders.includes(state.provider)
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

async function appendCollectionHistory(
  ids: string[],
  providers: string[],
  names: readonly string[],
  readers: readonly MediaProviderPlugin[],
  linksByItem: Map<string, SourceNavigationLink[]>,
) {
  let after: string | undefined
  do {
    const snapshots = await db
      .select({
        id: providerSnapshot.id,
        mediaItemId: providerSnapshot.mediaItemId,
        provider: providerSnapshot.provider,
        payload: providerSnapshot.payload,
      })
      .from(providerSnapshot)
      .where(
        and(
          inArray(providerSnapshot.mediaItemId, ids),
          inArray(providerSnapshot.provider, providers),
          matchingCollectionPayload(providerSnapshot.normalizedData, names),
          after ? gt(providerSnapshot.id, after) : undefined,
          notExists(
            db
              .select({ id: providerCurrentState.id })
              .from(providerCurrentState)
              .where(
                and(
                  eq(
                    providerCurrentState.mediaItemId,
                    providerSnapshot.mediaItemId,
                  ),
                  eq(providerCurrentState.provider, providerSnapshot.provider),
                  eq(
                    providerCurrentState.latestSnapshotId,
                    providerSnapshot.id,
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(providerSnapshot.id))
      .limit(COLLECTION_PAYLOAD_BATCH)
    for (const snapshot of snapshots)
      appendPayloadLinks(snapshot, readers, linksByItem)
    after =
      snapshots.length === COLLECTION_PAYLOAD_BATCH
        ? snapshots.at(-1)?.id
        : undefined
  } while (after !== undefined)
}

/** Resolve collection provenance with bounded reads of supported legacy payloads. */
export async function getCollectionSourceLinksForItems(
  items: readonly { id: string; metadata: Record<string, unknown> }[],
  mediaType?: 'album' | 'film',
  collectionNames?: readonly string[],
) {
  const linksByItem = new Map<string, SourceNavigationLink[]>()
  if (!items.length) return linksByItem
  const plugins = (await listLoadedScrapePlugins()).filter(
    (plugin) => !mediaType || plugin.manifest.mediaTypes.includes(mediaType),
  )
  const manifests = plugins.map((plugin) => plugin.manifest)
  for (const item of items)
    linksByItem.set(item.id, collectionSourceLinks(item.metadata, manifests))
  const readers = plugins.filter((plugin) => plugin.readStoredCollections)
  if (readers.length) {
    // Read existing payloads only. Do not normalize/write media or request a scrape.
    const ids = [...linksByItem.keys()]
    const providers = [
      ...legacyCollectionProviders,
      ...readers.map((plugin) => plugin.manifest.id),
    ]
    for (
      let offset = 0;
      offset < ids.length;
      offset += COLLECTION_PAYLOAD_BATCH
    ) {
      const batch = ids.slice(offset, offset + COLLECTION_PAYLOAD_BATCH)
      const states = await db
        .select({
          mediaItemId: providerCurrentState.mediaItemId,
          provider: providerCurrentState.provider,
          payload: providerCurrentState.payload,
        })
        .from(providerCurrentState)
        .where(
          and(
            inArray(providerCurrentState.mediaItemId, batch),
            inArray(providerCurrentState.provider, providers),
            collectionNames
              ? matchingCollectionPayload(
                  providerCurrentState.normalizedData,
                  collectionNames,
                )
              : undefined,
          ),
        )
      for (const state of states)
        appendPayloadLinks(state, readers, linksByItem)
      if (collectionNames)
        await appendCollectionHistory(
          batch,
          providers,
          collectionNames,
          readers,
          linksByItem,
        )
    }
  }
  return linksByItem
}

export async function getCollectionSourceLinks(
  mediaId: string,
  metadata: Record<string, unknown>,
  mediaType?: 'album' | 'film',
) {
  const links = await getCollectionSourceLinksForItems(
    [{ id: mediaId, metadata }],
    mediaType,
  )
  return links.get(mediaId) ?? []
}
