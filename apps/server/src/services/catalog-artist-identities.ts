import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { createStableId } from '@/lib/media-utils'
import { reconcileArtistPair } from './catalog-artist-reconciliation'
import {
  artist,
  artistProviderCurrentState,
  artistProviderSnapshot,
} from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** A name locates candidate library artists. Their own Spotify recordings must agree on one native ID. */
async function librarySpotifyOwners(
  tx: Pick<Transaction, 'execute'>,
  names: ReadonlyMap<string, string>,
  allNames = false,
) {
  if (!names.size) return []
  const rows = await tx.execute(sql`
    with wanted as (
      select * from jsonb_to_recordset(${JSON.stringify(Array.from(names, ([id, name]) => ({ id, name })))}::jsonb)
        as w(id text, name text)
    ), evidence as (
      select a.id, a.name, min(b->>'id') as external_id
      from artist a join media_credit c on c.artist_id=a.id and c.role='artist'
      join library_track t on t.media_item_id=c.media_item_id and t.spotify_track_id is not null
      join media_item m on m.id=t.media_item_id and m.in_library
      cross join lateral jsonb_array_elements(case when jsonb_typeof(m.metadata->'spotifyArtistCredits')='array'
        then m.metadata->'spotifyArtistCredits' else '[]'::jsonb end) b
      where a.catalog_provider is null and a.merged_into_id is null ${allNames ? sql`` : sql`and a.name in (select name from wanted)`}
        and b->>'name'=coalesce(c.credited_as,a.name) and b->>'id' ~ '^[a-zA-Z0-9]{22}$'
      group by a.id, a.name having count(distinct b->>'id')=1
    )
    select min(e.id) as id, min(e.name) as name, e.external_id from evidence e join wanted w on w.id=e.external_id
    where not exists (
      select 1 from artist_provider_current_state s join artist_provider_snapshot p on p.id=s.latest_snapshot_id
      join artist profiled on profiled.id=s.artist_id
      where s.provider='spotify' and p.normalized_data->>'externalId'=e.external_id
        and coalesce(profiled.merged_into_id,profiled.id)<>e.id
    )
    group by e.external_id having count(distinct e.id)=1`)
  return z
    .array(
      z.object({ id: z.string(), name: z.string(), external_id: z.string() }),
    )
    .parse(rows.rows)
}

export async function repairLibrarySpotifyArtists(
  apply: boolean,
  database: typeof db,
) {
  const natives = await database
    .select({
      id: artist.id,
      externalId: artist.catalogExternalId,
      name: artist.name,
    })
    .from(artist)
    .where(
      sql`${artist.catalogProvider}='spotify' and ${artist.catalogExternalId} is not null and ${artist.mergedIntoId} is null`,
    )
  const byId = new Map(natives.map((row) => [row.externalId, row.id]))
  const names = new Map<string, string>()
  for (const row of natives)
    if (row.externalId) names.set(row.externalId, row.name)
  let count = 0
  for (const row of await librarySpotifyOwners(database, names, true)) {
    const source = byId.get(row.external_id)
    const name = names.get(row.external_id)
    if (!source || !name) continue
    const merged = await database.transaction(async (tx) => {
      if (apply) {
        await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
        const current = await librarySpotifyOwners(
          tx,
          new Map([[row.external_id, row.name]]),
        )
        if (current.length !== 1 || current[0]?.id !== row.id) return false
      }
      return reconcileArtistPair(
        tx,
        source,
        row.id,
        'recording-native-artist-credit',
        apply,
      )
    })
    if (merged) count++
  }
  return count
}

/** Resolve an exact current profile once per provider ID, before creating catalog artists. */
export async function observeNamedArtistIdentities(
  tx: Transaction,
  provider: string,
  names: ReadonlyMap<string, string>,
  observedIds?: Map<string, string>,
) {
  const identities = await observeArtistIdentities(
    tx,
    provider,
    names,
    observedIds,
    true,
  )
  if (!identities)
    throw new Error('Catalog artist identities could not be resolved.')
  return identities
}

/** A merge can change the identity or credits of later entries in a page. */
export function observeNamedArtistIdentitiesWithoutMerging(
  tx: Transaction,
  provider: string,
  names: ReadonlyMap<string, string>,
  observedIds: Map<string, string>,
) {
  return observeArtistIdentities(tx, provider, names, observedIds, false)
}

async function observeArtistIdentities(
  tx: Transaction,
  provider: string,
  names: ReadonlyMap<string, string>,
  observedIds: Map<string, string> | undefined,
  reconcile: boolean,
) {
  const identities = new Map<string, string>()
  if (!names.size) return identities
  const externalId = sql<string>`${artistProviderSnapshot.normalizedData}->>'externalId'`
  const stored = await tx
    .selectDistinct({
      externalId,
      artistId: sql<string>`coalesce(${artist.mergedIntoId}, ${artist.id})`,
      verified: sql<boolean>`true`,
      alias: sql<boolean>`false`,
      original: artist.id,
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
          alias: sql<boolean>`${artist.mergedIntoId} is not null`,
          original: artist.id,
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
    if (identities.has(externalId) && identities.get(externalId) !== artistId)
      conflicts.add(externalId)
    identities.set(externalId, artistId)
  }
  for (const id of conflicts) identities.delete(id)
  for (const { externalId, artistId, verified, alias, original } of stored) {
    if (verified) continue
    observedIds?.set(externalId, original)
    const target = identities.get(externalId)
    if (target && target !== artistId && !alias) {
      if (!reconcile) return
      if (
        await reconcileArtistPair(
          tx,
          artistId,
          target,
          'exact-provider-artist-id',
          true,
        )
      )
        continue
    }
    identities.set(externalId, artistId)
  }

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
  if (provider === 'spotify') {
    const candidates = new Map(names)
    for (const row of stored)
      if (row.verified || row.alias) candidates.delete(row.externalId)
    for (const { id, external_id } of await librarySpotifyOwners(
      tx,
      candidates,
    )) {
      const source = identities.get(external_id)
      if (!source || source === id) continue
      if (!reconcile) return
      if (
        await reconcileArtistPair(
          tx,
          source,
          id,
          'recording-native-artist-credit',
          true,
        )
      ) {
        identities.set(external_id, id)
        observedIds?.set(external_id, source)
      }
    }
  }
  return identities
}
