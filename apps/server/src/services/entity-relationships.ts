import { and, asc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  EntityRelationshipCandidateSchema,
  type EntityRelationship,
  type EntityRelationshipCandidate,
  type EntityRelationshipSource,
} from '@repo/schemas/entity-relationships'
import { db } from '@/lib/db'
import {
  album,
  artist,
  artistProviderCurrentState,
  artistProviderSnapshot,
  mediaItem,
  providerCurrentState,
  providerReference,
  providerSnapshot,
} from '@/schemas/db'

export const visibleArtist = sql`exists (
  select 1 from media_credit c
  join media_item m on m.id = c.media_item_id
  left join album a on a.media_item_id = m.id
  left join library_track t on t.media_item_id = m.id
  where c.artist_id = ${artist.id} and c.role = 'artist'
    and ((m.media_type = 'album' and a.media_item_id is not null)
      or (m.media_type = 'track' and t.media_item_id is not null))
    and m.metadata->>'legacyHidden' is distinct from 'true'
)`

function candidateIds(candidates: EntityRelationshipCandidate[]) {
  return [
    ...new Set(
      candidates.flatMap(({ externalId }) => (externalId ? [externalId] : [])),
    ),
  ]
}

async function artistMatches(
  provider: string,
  candidates: EntityRelationshipCandidate[],
) {
  if (!candidates.length) return []
  const names = [...new Set(candidates.map(({ name }) => name.toLowerCase()))]
  const nameKey = sql<string>`lower(btrim(${artist.name}))`
  const externalId = sql<
    string | null
  >`${artistProviderSnapshot.normalizedData}->>'externalId'`
  return db
    .select({ id: artist.id, name: nameKey, externalId })
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
        visibleArtist,
        or(
          inArray(nameKey, names),
          inArray(externalId, candidateIds(candidates)),
        ),
      ),
    )
}

async function albumMatches(
  provider: string,
  candidates: EntityRelationshipCandidate[],
) {
  const ids = candidateIds(candidates)
  if (!ids.length) return []
  return db
    .select({
      id: mediaItem.id,
      referenceType: providerReference.referenceType,
      externalId: providerReference.externalId,
    })
    .from(providerReference)
    .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
    .innerJoin(album, eq(album.mediaItemId, mediaItem.id))
    .where(
      and(
        eq(providerReference.provider, provider),
        inArray(providerReference.externalId, ids),
        eq(mediaItem.mediaType, 'album'),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
}

function matchingArtist(
  candidate: EntityRelationshipCandidate,
  matches: Awaited<ReturnType<typeof artistMatches>>,
) {
  const ids = candidate.externalId
    ? matches.filter((match) => match.externalId === candidate.externalId)
    : []
  if (ids.length) return ids.length === 1 ? ids[0]?.id : undefined
  const names = matches.filter(
    (match) => match.name === candidate.name.toLowerCase(),
  )
  const [named] = names
  if (names.length === 1 && (!candidate.externalId || !named?.externalId))
    return named?.id
  return undefined
}

function matchingAlbum(
  candidate: EntityRelationshipCandidate,
  matches: Awaited<ReturnType<typeof albumMatches>>,
) {
  const ids = new Set(
    matches.flatMap((match) =>
      match.externalId === candidate.externalId &&
      (candidate.referenceType === undefined ||
        match.referenceType === candidate.referenceType)
        ? [match.id]
        : [],
    ),
  )
  return ids.size === 1 ? ids.values().next().value : undefined
}

/** Project stored evidence onto existing library identities without any provider calls. */
export async function resolveEntityRelationships(
  source: { id: string; type: EntityRelationshipCandidate['targetType'] },
  provider: string,
  candidates: EntityRelationshipCandidate[],
): Promise<EntityRelationship[]> {
  const [artists, albums] = await Promise.all([
    artistMatches(
      provider,
      candidates.filter((item) => item.targetType === 'artist'),
    ),
    albumMatches(
      provider,
      candidates.filter((item) => item.targetType === 'album'),
    ),
  ])
  return candidates.map((candidate) => {
    const targetId =
      candidate.targetType === 'artist'
        ? matchingArtist(candidate, artists)
        : matchingAlbum(candidate, albums)
    return targetId &&
      (targetId !== source.id || candidate.targetType !== source.type)
      ? { ...candidate, targetId }
      : candidate
  })
}

export async function listAlbumRelationshipSources(
  id: string,
): Promise<EntityRelationshipSource[]> {
  const candidates = sql<unknown>`${providerSnapshot.normalizedData}->'relationships'`
  const rows = await db
    .select({
      provider: providerSnapshot.provider,
      snapshotId: providerSnapshot.id,
      jobId: providerSnapshot.scrapeJobId,
      createdAt: providerSnapshot.createdAt,
      candidates,
    })
    .from(providerCurrentState)
    .innerJoin(
      providerSnapshot,
      and(
        eq(providerSnapshot.id, providerCurrentState.latestSnapshotId),
        eq(providerSnapshot.mediaItemId, providerCurrentState.mediaItemId),
        eq(providerSnapshot.provider, providerCurrentState.provider),
      ),
    )
    .where(
      and(
        eq(providerCurrentState.mediaItemId, id),
        sql`jsonb_typeof(${candidates}) = 'array'`,
      ),
    )
    .orderBy(asc(providerSnapshot.provider))
  const current = rows.flatMap(({ candidates, createdAt, ...row }) => {
    if (!Array.isArray(candidates)) return []
    const parsed = candidates.slice(0, 100).flatMap((value: unknown) => {
      const result = EntityRelationshipCandidateSchema.safeParse(value)
      return result.success ? [result.data] : []
    })
    if (!parsed.length) return []
    return [
      {
        ...row,
        createdAt: createdAt.toISOString(),
        candidates: parsed,
      },
    ]
  })
  return Promise.all(
    current.map(async ({ candidates, ...row }) => ({
      ...row,
      relationships: await resolveEntityRelationships(
        { type: 'album', id },
        row.provider,
        candidates,
      ),
    })),
  )
}
