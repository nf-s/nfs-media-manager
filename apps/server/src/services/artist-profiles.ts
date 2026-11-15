import { and, count, desc, eq, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  ArtistProfileSchema,
  ArtistProviderSnapshotSchema,
  type ArtistProfile,
  type ArtistProfileProvider,
} from '@repo/schemas/artist-profiles'
import { JsonValueSchema, type JsonValue } from '@repo/schemas/common'
import { db } from '@/lib/db'
import {
  artist,
  artistProviderCurrentState,
  artistProviderSnapshot,
} from '@/schemas/db'

type ArtistProfileTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0]

/** Look up the library identity and use only a confirmed artist profile ID. */
export async function loadArtistProviderTarget(
  artistId: string,
  provider: ArtistProfileProvider,
) {
  const [target] = await db
    .select({
      name: artist.name,
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
      eq(
        artistProviderSnapshot.id,
        artistProviderCurrentState.latestSnapshotId,
      ),
    )
    .where(
      and(
        eq(artist.id, artistId),
        sql`exists (
          select 1 from media_credit c
          join media_item m on m.id = c.media_item_id
          left join album a on a.media_item_id = m.id
          left join library_track t on t.media_item_id = m.id
          where c.artist_id = ${artist.id} and c.role = 'artist'
            and ((m.media_type = 'album' and a.media_item_id is not null)
              or (m.media_type = 'track' and t.media_item_id is not null))
            and m.metadata->>'legacyHidden' is distinct from 'true'
        )`,
      ),
    )
  return target
    ? {
        name: target.name,
        providerArtistId: target.profile?.externalId ?? null,
      }
    : null
}

export async function saveArtistProviderResult(
  artistId: string,
  provider: ArtistProfileProvider,
  result: { profile: ArtistProfile; payload: JsonValue; scrapeJobId: string },
  transaction?: ArtistProfileTransaction,
) {
  const id = nanoid()
  const normalizedData = ArtistProfileSchema.parse(result.profile)
  const payload = JsonValueSchema.parse(result.payload)
  const save = async (database: ArtistProfileTransaction) => {
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
const formatSnapshot = (
  row: Pick<
    typeof artistProviderSnapshot.$inferSelect,
    'id' | 'provider' | 'scrapeJobId' | 'createdAt'
  > & { profile: ArtistProfile },
) =>
  ArtistProviderSnapshotSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  })

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
    .where(eq(artistProviderCurrentState.artistId, artistId))
    .orderBy(
      desc(artistProviderSnapshot.createdAt),
      desc(artistProviderSnapshot.id),
    )
  return rows.map(formatSnapshot)
}

function profileHistoryFilter(
  artistId: string,
  provider: ArtistProfileProvider | undefined,
) {
  return and(
    eq(artistProviderSnapshot.artistId, artistId),
    provider === undefined
      ? undefined
      : eq(artistProviderSnapshot.provider, provider),
  )
}

export async function countArtistProfileHistory(
  artistId: string,
  provider?: ArtistProfileProvider,
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
  provider?: ArtistProfileProvider,
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
