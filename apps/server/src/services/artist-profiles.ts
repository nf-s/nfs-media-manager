import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  ArtistProfileSchema,
  ArtistProviderSnapshotSchema,
  type ArtistProfile,
  type ArtistProviderId,
} from '@repo/schemas/artist-profiles'
import type { PluginArtistResult } from '@repo/media-plugin-sdk'
import { JsonValueSchema, type JsonValue } from '@repo/schemas/common'
import {
  EntityRelationshipCandidateSchema,
  EntityRelationshipSchema,
  type EntityRelationship,
} from '@repo/schemas/entity-relationships'
import type { SourceSnapshot } from '@repo/schemas/media'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import {
  artist,
  artistProviderCurrentState,
  artistProviderSnapshot,
} from '@/schemas/db'
import {
  resolveEntityRelationships,
  visibleArtist,
} from './entity-relationships'

type ArtistProfileTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0]

function lockArtist(database: ArtistProfileTransaction, id: string) {
  return database
    .select({ id: artist.id })
    .from(artist)
    .where(eq(artist.id, id))
    .for('update')
}

/** Look up the library identity and use only a confirmed artist profile ID. */
export async function loadArtistProviderTarget(
  artistId: string,
  provider: ArtistProviderId,
  transaction?: ArtistProfileTransaction,
  options?: { includeCatalog?: boolean },
) {
  if (transaction) await lockArtist(transaction, artistId)
  const [target] = await (transaction ?? db)
    .select({
      name: artist.name,
      catalogProvider: artist.catalogProvider,
      catalogExternalId: artist.catalogExternalId,
      snapshotId: artistProviderSnapshot.id,
      profile: artistProviderSnapshot.normalizedData,
    })
    .from(artist)
    .leftJoin(
      artistProviderCurrentState,
      and(
        eq(artistProviderCurrentState.artistId, artist.id),
        eq(artistProviderCurrentState.provider, provider),
      ),
    )
    .leftJoin(
      artistProviderSnapshot,
      and(
        eq(
          artistProviderSnapshot.id,
          artistProviderCurrentState.latestSnapshotId,
        ),
        eq(artistProviderSnapshot.artistId, artist.id),
        eq(artistProviderSnapshot.provider, provider),
      ),
    )
    .where(
      and(
        eq(artist.id, artistId),
        options?.includeCatalog ? isNull(artist.mergedIntoId) : visibleArtist,
      ),
    )
  return target
    ? {
        name: target.name,
        catalogProvider: target.catalogProvider,
        catalogExternalId: target.catalogExternalId,
        providerArtistId: target.profile?.externalId ?? null,
        snapshotId: target.snapshotId,
        profile: target.profile,
      }
    : null
}

function legacyRelationships(
  entries: NonNullable<ArtistProfile['similarArtists']>,
): EntityRelationship[] {
  return entries.map(({ artistId, ...entry }) => ({
    ...entry,
    kind: 'similar',
    targetType: 'artist',
    ...(artistId ? { targetId: artistId } : {}),
  }))
}

export async function resolveLegacyArtistRelationships(
  artistId: string,
  provider: ArtistProviderId,
  result: PluginArtistResult,
) {
  if (!result.profile.similarArtists?.length) return result
  const resolved = await resolveEntityRelationships(
    { type: 'artist', id: artistId },
    provider,
    legacyRelationships(result.profile.similarArtists),
  )
  return {
    ...result,
    profile: {
      ...result.profile,
      similarArtists: resolved.map(({ name, externalId, targetId }) => ({
        name,
        ...(externalId ? { externalId } : {}),
        ...(targetId ? { artistId: targetId } : {}),
      })),
    },
  }
}

export async function loadCurrentArtistPayloads(
  provider: ArtistProviderId,
  artistIds: string[],
) {
  if (!artistIds.length) return []
  return db
    .select({
      artistId: artist.id,
      name: artist.name,
      payload: artistProviderSnapshot.payload,
    })
    .from(artistProviderCurrentState)
    .innerJoin(artist, eq(artist.id, artistProviderCurrentState.artistId))
    .innerJoin(
      artistProviderSnapshot,
      and(
        eq(
          artistProviderSnapshot.id,
          artistProviderCurrentState.latestSnapshotId,
        ),
        eq(artistProviderSnapshot.artistId, artist.id),
        eq(artistProviderSnapshot.provider, provider),
      ),
    )
    .where(
      and(
        inArray(artist.id, artistIds),
        eq(artistProviderCurrentState.provider, provider),
      ),
    )
}

export async function saveArtistProviderResult(
  artistId: string,
  provider: ArtistProviderId,
  result: { profile: ArtistProfile; payload: JsonValue; scrapeJobId: string },
  transaction?: ArtistProfileTransaction,
  options?: { onlyIfMissing: true },
) {
  const id = nanoid()
  const normalizedData = ArtistProfileSchema.parse(result.profile)
  const payload = JsonValueSchema.parse(result.payload)
  const save = async (database: ArtistProfileTransaction) => {
    // Serialize the first album's write with explicit artist refreshes.
    await lockArtist(database, artistId)
    if (options?.onlyIfMissing) {
      const existing =
        await database.query.artistProviderCurrentState.findFirst({
          where: (table, operators) =>
            operators.and(
              operators.eq(table.artistId, artistId),
              operators.eq(table.provider, provider),
            ),
        })
      if (existing) return
    }
    await database.insert(artistProviderSnapshot).values({
      id,
      artistId,
      provider,
      normalizedData,
      payload,
      scrapeJobId: result.scrapeJobId,
    })
    await database
      .insert(artistProviderCurrentState)
      .values({ artistId, provider, latestSnapshotId: id })
      .onConflictDoUpdate({
        target: [
          artistProviderCurrentState.artistId,
          artistProviderCurrentState.provider,
        ],
        set: { latestSnapshotId: id, updatedAt: sql`now()` },
      })
  }
  await (transaction ? save(transaction) : db.transaction(save))
}

const snapshotColumns = {
  id: artistProviderSnapshot.id,
  provider: artistProviderSnapshot.provider,
  profile: artistProviderSnapshot.normalizedData,
  scrapeJobId: artistProviderSnapshot.scrapeJobId,
  createdAt: artistProviderSnapshot.createdAt,
}
const snapshotSummaryColumns = {
  id: artistProviderSnapshot.id,
  provider: artistProviderSnapshot.provider,
  jobId: artistProviderSnapshot.scrapeJobId,
  createdAt: artistProviderSnapshot.createdAt,
}
function formatSnapshotSummary(
  row: Pick<
    typeof artistProviderSnapshot.$inferSelect,
    'id' | 'provider' | 'createdAt'
  > & { jobId: string | null },
) {
  return { ...row, createdAt: row.createdAt.toISOString(), source: null }
}
const formatSnapshot = (
  row: Pick<
    typeof artistProviderSnapshot.$inferSelect,
    'id' | 'provider' | 'scrapeJobId' | 'createdAt'
  > & { profile: ArtistProfile },
) => {
  const profile = row.profile
  const relationships =
    profile.relationships ??
    (profile.similarArtists &&
      legacyRelationships(profile.similarArtists).filter(
        (relationship) =>
          EntityRelationshipSchema.safeParse(relationship).success,
      ))
  return ArtistProviderSnapshotSchema.parse({
    ...row,
    profile: relationships ? { ...profile, relationships } : profile,
    createdAt: row.createdAt.toISOString(),
  })
}

export async function listCurrentArtistProfiles(artistId: string) {
  const rows = await db
    .select(snapshotColumns)
    .from(artistProviderCurrentState)
    .innerJoin(
      artistProviderSnapshot,
      eq(
        artistProviderSnapshot.id,
        artistProviderCurrentState.latestSnapshotId,
      ),
    )
    .where(
      or(
        eq(artistProviderCurrentState.artistId, artistId),
        inArray(artistProviderCurrentState.artistId, mergedArtistIds(artistId)),
      ),
    )
    .orderBy(
      desc(eq(artistProviderCurrentState.artistId, artistId)),
      desc(artistProviderSnapshot.createdAt),
      desc(artistProviderSnapshot.id),
    )
  return Promise.all(
    rows
      .filter(
        (row, index) =>
          rows.findIndex((other) => other.provider === row.provider) === index,
      )
      .map(async (row) => {
        const snapshot = formatSnapshot(row)
        if (!snapshot.profile.relationships?.length) return snapshot
        const candidates = snapshot.profile.relationships.map((relationship) =>
          EntityRelationshipCandidateSchema.parse(relationship),
        )
        return {
          ...snapshot,
          profile: {
            ...snapshot.profile,
            relationships: await resolveEntityRelationships(
              { type: 'artist', id: artistId },
              snapshot.provider,
              candidates,
            ),
          },
        }
      }),
  )
}

function mergedArtistIds(id: string) {
  return db
    .select({ id: artist.id })
    .from(artist)
    .where(eq(artist.mergedIntoId, id))
}

function profileHistoryFilter(
  artistId: string,
  provider: ArtistProviderId | undefined,
) {
  return and(
    or(
      eq(artistProviderSnapshot.artistId, artistId),
      inArray(artistProviderSnapshot.artistId, mergedArtistIds(artistId)),
    ),
    provider === undefined
      ? undefined
      : eq(artistProviderSnapshot.provider, provider),
  )
}

export async function countArtistProfileHistory(
  artistId: string,
  provider?: ArtistProviderId,
) {
  const [row] = await db
    .select({ value: count() })
    .from(artistProviderSnapshot)
    .where(profileHistoryFilter(artistId, provider))
  return row?.value ?? 0
}

export async function listArtistProfileHistory(
  artistId: string,
  size: number,
  offset = 0,
  provider?: ArtistProviderId,
) {
  const rows = await db
    .select(snapshotColumns)
    .from(artistProviderSnapshot)
    .where(profileHistoryFilter(artistId, provider))
    .orderBy(
      desc(artistProviderSnapshot.createdAt),
      desc(artistProviderSnapshot.id),
    )
    .limit(size)
    .offset(offset)
  return rows.map(formatSnapshot)
}

export async function listArtistSourceSnapshots(
  id: string,
  provider: ArtistProviderId,
  { page, size }: { page: number; size: number },
) {
  const [totalCount, rows] = await Promise.all([
    countArtistProfileHistory(id, provider),
    db
      .select(snapshotSummaryColumns)
      .from(artistProviderSnapshot)
      .where(profileHistoryFilter(id, provider))
      .orderBy(
        desc(artistProviderSnapshot.createdAt),
        desc(artistProviderSnapshot.id),
      )
      .limit(size)
      .offset((page - 1) * size),
  ])
  return {
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
    items: rows.map(formatSnapshotSummary),
  }
}

export async function getArtistSourceSnapshot(
  id: string,
  provider: ArtistProviderId,
  snapshotId: string,
): Promise<SourceSnapshot> {
  const [row] = await db
    .select({
      ...snapshotSummaryColumns,
      data: artistProviderSnapshot.payload,
      normalizedData: artistProviderSnapshot.normalizedData,
    })
    .from(artistProviderSnapshot)
    .where(
      and(
        profileHistoryFilter(id, provider),
        eq(artistProviderSnapshot.id, snapshotId),
      ),
    )
  if (!row)
    throw new ServerError({ statusCode: 404, message: 'Snapshot not found.' })
  const { data, normalizedData, ...summary } = row
  return { ...formatSnapshotSummary(summary), data, normalizedData }
}
