import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import { db } from '@/lib/db'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { normalizeArtistProviderId } from '@/plugins/builtin/artist-providers'
import { artist } from '@/schemas/db'

/** Kept artist names retain their original catalog IDs for later reads and undo. */
export function spotifyArtistCatalogIdentities(artistId: SQL) {
  return sql`
    select id, name, catalog_external_id, created_at
    from artist catalog_artist
    where (catalog_artist.id = ${artistId} or catalog_artist.merged_into_id = ${artistId})
      and catalog_provider = 'spotify'
      and catalog_external_id collate "C" ~ ${spotifyIdPattern.source}
  `
}

export function spotifyArtistCatalogIdentityList(artistId: SQL) {
  return sql`coalesce((
    select jsonb_agg(jsonb_build_object('artistId', id, 'externalId', catalog_external_id)
      order by (id = ${artistId}) desc, id)
    from (${spotifyArtistCatalogIdentities(artistId)}) spotify_catalog
  ), '[]'::jsonb)`
}

const SpotifyCatalogIdentitiesSchema = z.array(
  z.object({ artistId: z.string(), externalId: SpotifyIdSchema }),
)

export function resolveSpotifyArtistIdentity(
  artistId: string,
  profileId: string | null | undefined,
  catalog: unknown,
) {
  const saved = profileId
    ? normalizeArtistProviderId('spotify', profileId)
    : null
  if (saved) return { externalId: saved, conflictingIds: [] }
  const identities = SpotifyCatalogIdentitiesSchema.parse(catalog)
  const [first] = identities
  if (first && (identities.length === 1 || first.artistId === artistId))
    return { externalId: first.externalId, conflictingIds: [] }
  return {
    externalId: null,
    conflictingIds: identities.map(({ externalId }) => externalId),
  }
}

export async function readSpotifyArtistCatalogIdentity(artistId: string) {
  const [row] = await db
    .select({ catalog: spotifyArtistCatalogIdentityList(sql`${artist.id}`) })
    .from(artist)
    .where(eq(artist.id, artistId))
  return resolveSpotifyArtistIdentity(artistId, null, row?.catalog ?? [])
}
