import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  COVERAGE_ITEM_ID_LIMIT,
  CoverageSchema,
  type Coverage,
  type CoverageQuery,
  type CoverageUnavailableReason,
} from '@repo/schemas/coverage'
import { canIdentifyMedia } from '@repo/schemas/provider-identification'
import type { ProviderSummary } from '@repo/schemas/provider'
import { db } from '@/lib/db'
import {
  artist,
  mediaCredit,
  providerCurrentState,
  providerReference,
} from '@/schemas/db'
import { requireCreator } from './creators'
import { getPlaylistSummary, playlistAlbumMembers } from './playlist-directory'
import { listProviders } from './providers'

const AlbumRowsSchema = z.array(z.object({ id: z.string(), title: z.string() }))

const visibleAlbum = sql`m.media_type = 'album'
  and m.metadata->>'legacyHidden' is distinct from 'true'`

function unavailableReason(
  provider: ProviderSummary,
): CoverageUnavailableReason | null {
  if (provider.secrets.some((field) => field.required && !field.configured))
    return 'credentials-missing'
  if (provider.safety?.halted) return 'halted'
  return null
}

/**
 * Per-provider freshness for a set of albums. Uses the Metadata table's rule:
 * only a successful scrape sets `last_scraped_at`, and an album is stale when
 * that is older than `olderThanDays`. Reads stored state only.
 */
async function albumCoverage(
  albumIds: SQL,
  query: CoverageQuery,
  now = Date.now(),
): Promise<Coverage> {
  const albums = AlbumRowsSchema.parse(
    (
      await db.execute(sql`
        select m.id, m.title from media_item m
        where m.id in (${albumIds}) and ${visibleAlbum}
        order by lower(m.title), m.id`)
    ).rows,
  )
  const providers = (await listProviders()).filter(
    (provider) =>
      provider.supportsScrape && provider.mediaTypes.includes('album'),
  )
  const [states, references, credits] = albums.length
    ? await Promise.all([
        db
          .select({
            id: providerCurrentState.mediaItemId,
            provider: providerCurrentState.provider,
            scrapedAt: providerCurrentState.lastScrapedAt,
          })
          .from(providerCurrentState)
          .where(
            and(
              sql`${providerCurrentState.mediaItemId} in (${albumIds})`,
              inArray(
                providerCurrentState.provider,
                providers.map((provider) => provider.id),
              ),
            ),
          ),
        db
          .select({
            id: providerReference.mediaItemId,
            provider: providerReference.provider,
            referenceType: providerReference.referenceType,
            externalId: providerReference.externalId,
          })
          .from(providerReference)
          .where(sql`${providerReference.mediaItemId} in (${albumIds})`),
        db
          .select({ id: mediaCredit.mediaItemId, name: artist.name })
          .from(mediaCredit)
          .innerJoin(artist, eq(artist.id, mediaCredit.artistId))
          .where(
            and(
              sql`${mediaCredit.mediaItemId} in (${albumIds})`,
              eq(mediaCredit.role, 'artist'),
            ),
          ),
      ])
    : [[], [], []]
  const scraped = new Map(
    states.map((state) => [
      JSON.stringify([state.id, state.provider]),
      state.scrapedAt,
    ]),
  )
  const group = <T extends { id: string }>(rows: T[]) => {
    const byId = new Map<string, T[]>()
    for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row])
    return byId
  }
  const referencesById = group(references)
  const artistsById = group(credits)
  const cutoff = now - query.olderThanDays * 86400000

  return CoverageSchema.parse({
    total: albums.length,
    olderThanDays: query.olderThanDays,
    providers: providers.map((provider) => {
      const missing: string[] = []
      const stale: Array<{ id: string; scrapedAt: number }> = []
      let covered = 0
      for (const album of albums) {
        const scrapedAt = scraped.get(JSON.stringify([album.id, provider.id]))
        if (scrapedAt) {
          if (scrapedAt.getTime() < cutoff)
            stale.push({ id: album.id, scrapedAt: scrapedAt.getTime() })
          else covered++
        } else if (
          canIdentifyMedia(provider, {
            mediaType: 'album',
            title: album.title,
            artists: (artistsById.get(album.id) ?? []).map((row) => row.name),
            providerReferences: referencesById.get(album.id) ?? [],
          })
        )
          missing.push(album.id)
      }
      stale.sort(
        (left, right) =>
          left.scrapedAt - right.scrapedAt || left.id.localeCompare(right.id),
      )
      return {
        provider: provider.id,
        displayName: provider.displayName,
        eligible: covered + stale.length + missing.length,
        covered,
        stale: stale.length,
        missing: missing.length,
        unavailableReason: unavailableReason(provider),
        missingItemIds: missing.slice(0, COVERAGE_ITEM_ID_LIMIT),
        staleItemIds: stale
          .slice(0, COVERAGE_ITEM_ID_LIMIT)
          .map((album) => album.id),
      }
    }),
  })
}

// The albums the playlist's album count uses: album entries and the library
// albums of its track entries.
export async function getPlaylistCoverage(id: string, query: CoverageQuery) {
  await getPlaylistSummary(id)
  return albumCoverage(
    sql`select members.album_id from playlist p
      cross join lateral (${playlistAlbumMembers}) members
      where p.id = ${id}`,
    query,
  )
}

// The albums credited to the artist, as on the artist's Albums tab.
export async function getArtistCoverage(id: string, query: CoverageQuery) {
  await requireCreator(id, 'artist')
  return albumCoverage(
    sql`select c.media_item_id from media_credit c
      where c.artist_id = ${id} and c.role = 'artist'`,
    query,
  )
}
