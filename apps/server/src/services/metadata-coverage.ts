import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  COVERAGE_ITEM_ID_LIMIT,
  CoverageEntriesSchema,
  CoverageSchema,
  type Coverage,
  type CoverageEntries,
  type CoverageEntriesQuery,
  type CoverageQuery,
  type CoverageUnavailableReason,
  type EntryGap,
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
import { getPlaylistDetail } from './tracks'

const AlbumRowsSchema = z.array(z.object({ id: z.string(), title: z.string() }))
const EntryAlbumRowsSchema = z.array(
  z.object({ id: z.string(), album_id: z.string() }),
)

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

type ProviderGaps = {
  provider: ProviderSummary
  covered: number
  /** Eligible albums never scraped, by title. */
  missing: string[]
  /** Eligible albums scraped before the cutoff, oldest scrape first. */
  stale: string[]
}

/**
 * Per-provider freshness for a set of albums. Uses the Metadata table's rule:
 * only a successful scrape sets `last_scraped_at`, and an album is stale when
 * that is older than `olderThanDays`. Albums a provider cannot look up are
 * neither missing nor stale. Reads stored state only.
 */
async function albumGaps(
  albumIds: SQL,
  olderThanDays: number,
  now = Date.now(),
): Promise<{ total: number; providers: ProviderGaps[] }> {
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
  const cutoff = now - olderThanDays * 86400000

  return {
    total: albums.length,
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
        provider,
        covered,
        missing,
        stale: stale.map((album) => album.id),
      }
    }),
  }
}

async function albumCoverage(
  albumIds: SQL,
  query: CoverageQuery,
): Promise<Coverage> {
  const gaps = await albumGaps(albumIds, query.olderThanDays)
  return CoverageSchema.parse({
    total: gaps.total,
    olderThanDays: query.olderThanDays,
    providers: gaps.providers.map(({ provider, covered, missing, stale }) => ({
      provider: provider.id,
      displayName: provider.displayName,
      eligible: covered + stale.length + missing.length,
      covered,
      stale: stale.length,
      missing: missing.length,
      unavailableReason: unavailableReason(provider),
      missingItemIds: missing.slice(0, COVERAGE_ITEM_ID_LIMIT),
      staleItemIds: stale.slice(0, COVERAGE_ITEM_ID_LIMIT),
    })),
  })
}

// The albums the playlist's album count uses: album entries and the library
// albums of its track entries.
function playlistAlbums(id: string) {
  return sql`select members.album_id from playlist p
    cross join lateral (${playlistAlbumMembers}) members
    where p.id = ${id}`
}

export async function getPlaylistCoverage(id: string, query: CoverageQuery) {
  await getPlaylistSummary(id)
  return albumCoverage(playlistAlbums(id), query)
}

/**
 * A page of the playlist's entries whose albums have the gap, in the entry
 * query's order, each with its gaps by provider. Uses the same albums and
 * rules as the playlist's coverage, so the albums of all returned entries
 * are the albums Coverage counts. An entry's albums are an album entry
 * itself, a track's library album and the albums whose track list has it.
 */
export async function getPlaylistCoverageEntries(
  id: string,
  query: CoverageEntriesQuery,
): Promise<CoverageEntries> {
  const { gap, provider, olderThanDays, ...entryQuery } = query
  const gaps = await albumGaps(playlistAlbums(id), olderThanDays)
  const providers = gaps.providers.filter(
    (row) => provider === undefined || row.provider.id === provider,
  )
  const providersByAlbum = new Map<string, ProviderSummary[]>()
  for (const row of providers)
    for (const albumId of row[gap])
      providersByAlbum.set(albumId, [
        ...(providersByAlbum.get(albumId) ?? []),
        row.provider,
      ])
  const gapAlbums = sql`${sql.param([...providersByAlbum.keys()])}::text[]`
  const detail = await getPlaylistDetail(
    id,
    entryQuery,
    sql`and (a.media_item_id = any(${gapAlbums})
      or lt.album_media_item_id = any(${gapAlbums})
      or exists (select 1 from track t
        where t.track_media_item_id = lt.media_item_id
          and t.album_media_item_id = any(${gapAlbums})))`,
  )
  const trackIds = detail.items.items.flatMap((entry) =>
    entry.kind === 'track' ? [entry.track.id] : [],
  )
  const trackAlbums = trackIds.length
    ? EntryAlbumRowsSchema.parse(
        (
          await db.execute(sql`
            select lt.media_item_id as id, lt.album_media_item_id as album_id
            from library_track lt
            where lt.media_item_id = any(${sql.param(trackIds)}::text[])
              and lt.album_media_item_id is not null
            union
            select t.track_media_item_id, t.album_media_item_id from track t
            where t.track_media_item_id = any(${sql.param(trackIds)}::text[])
            order by 1, 2`)
        ).rows,
      )
    : []
  const albumsByTrack = new Map<string, string[]>()
  for (const row of trackAlbums)
    albumsByTrack.set(row.id, [
      ...(albumsByTrack.get(row.id) ?? []),
      row.album_id,
    ])

  function entryGaps(albumIds: readonly string[]): EntryGap[] {
    return providers.flatMap(({ provider: summary }) => {
      const matching = albumIds.filter((albumId) =>
        providersByAlbum
          .get(albumId)
          ?.some((candidate) => candidate.id === summary.id),
      )
      return matching.length
        ? [
            {
              provider: summary.id,
              displayName: summary.displayName,
              albumIds: matching,
            },
          ]
        : []
    })
  }

  return CoverageEntriesSchema.parse({
    ...detail.items,
    items: detail.items.items.map((entry) => ({
      entry,
      gaps: entryGaps(
        entry.kind === 'album'
          ? [entry.album.id]
          : (albumsByTrack.get(entry.track.id) ?? []),
      ),
    })),
    name: detail.name,
    gap,
    provider: provider ?? null,
    olderThanDays,
    albumCount: providersByAlbum.size,
  })
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
