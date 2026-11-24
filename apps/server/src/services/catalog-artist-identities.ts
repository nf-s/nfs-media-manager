import { and, eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import {
  artist,
  artistProviderCurrentState,
  artistProviderSnapshot,
} from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Resolve an exact current profile once per provider ID, before creating catalog artists. */
export async function observeNamedArtistIdentities(
  tx: Transaction,
  provider: string,
  names: ReadonlyMap<string, string>,
) {
  const identities = new Map<string, string>()
  if (!names.size) return identities
  const externalId = sql<string>`${artistProviderSnapshot.normalizedData}->>'externalId'`
  const stored = await tx
    .selectDistinct({
      externalId,
      artistId: sql<string>`coalesce(${artist.mergedIntoId}, ${artist.id})`,
      verified: sql<boolean>`true`,
    })
    .from(artistProviderCurrentState)
    .innerJoin(
      artistProviderSnapshot,
      and(
        eq(
          artistProviderSnapshot.id,
          artistProviderCurrentState.latestSnapshotId,
        ),
        eq(
          artistProviderSnapshot.artistId,
          artistProviderCurrentState.artistId,
        ),
        eq(
          artistProviderSnapshot.provider,
          artistProviderCurrentState.provider,
        ),
      ),
    )
    .innerJoin(artist, eq(artist.id, artistProviderCurrentState.artistId))
    .where(
      and(
        eq(artistProviderCurrentState.provider, provider),
        inArray(externalId, [...names.keys()]),
      ),
    )
    .unionAll(
      tx
        .select({
          externalId: sql<string>`${artist.catalogExternalId}`,
          artistId: sql<string>`coalesce(${artist.mergedIntoId}, ${artist.id})`,
          verified: sql<boolean>`false`,
        })
        .from(artist)
        .where(
          and(
            eq(artist.catalogProvider, provider),
            inArray(artist.catalogExternalId, [...names.keys()]),
          ),
        ),
    )
  const conflicts = new Set<string>()
  for (const { externalId, artistId, verified } of stored) {
    if (!verified) continue
    if (identities.has(externalId)) conflicts.add(externalId)
    identities.set(externalId, artistId)
  }
  for (const id of conflicts) identities.delete(id)
  for (const { externalId, artistId, verified } of stored)
    if (!verified && !identities.has(externalId))
      identities.set(externalId, artistId)

  const native = [...names].filter(([id]) => !identities.has(id))
  if (native.length) {
    const rows = native.map(([externalId, name]) => ({
      id: createStableId(
        'catalog-artist',
        JSON.stringify([provider, externalId]),
      ),
      name,
      sortName: name,
      catalogProvider: provider,
      catalogExternalId: externalId,
    }))
    await tx.insert(artist).values(rows).onConflictDoNothing()
    for (const { catalogExternalId, id } of rows)
      identities.set(catalogExternalId, id)
  }
  return identities
}
