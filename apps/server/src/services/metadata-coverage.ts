import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  COVERAGE_ITEM_ID_LIMIT,
  CoverageEntriesSchema,
  CoverageSchema,
  type Coverage,
  type CoverageEntries,
  type CoverageEntriesQuery,
  type CoverageGap,
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
import { readAlbumMetadataInventory } from './album-metadata-inventory'
import { artistPlaylistCredits } from './artist-library'
import {
  artistFreshnessConditions,
  artistLastScrapedAt,
} from './artist-metadata'
import { requireCreator } from './creators'
import { getPlaylistSummary, playlistAlbumMembers } from './playlist-directory'
import { listProviders } from './providers'
import { getPlaylistDetail } from './tracks'

const AlbumRowsSchema = z.array(z.object({ id: z.string(), title: z.string() }))
const ArtistGapsSchema = z.object({
  total: z.coerce.number().int().nonnegative(),
  providers: z.array(
    z.object({
      missing: z.coerce.number().int().nonnegative(),
      notFresh: z.coerce.number().int().nonnegative(),
      missingIds: z.array(z.string()).nullable(),
      staleIds: z.array(z.string()).nullable(),
    }),
  ),
})
const EntryAlbumRowsSchema = z.array(
  z.object({ id: z.string(), album_id: z.string() }),
)

const visibleAlbum = sql`m.in_library and m.media_type = 'album'
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
  stored?: number
  /** Eligible albums without data for the selected coverage view, by title. */
  missing: string[]
  /** Eligible albums scraped before the cutoff, oldest scrape first. */
  stale: string[]
}

async function albumGaps(
  albumIds: SQL,
  olderThanDays: number,
  options: { stored?: boolean; providers?: ProviderSummary[] } = {},
): Promise<{
  total: number
  storedAlbums?: number
  providers: ProviderGaps[]
}> {
  const cutoff = Date.now() - olderThanDays * 86400000
  const albums = AlbumRowsSchema.parse(
    (
      await db.execute(sql`
        select m.id, m.title from media_item m
        where m.id in (${albumIds}) and ${visibleAlbum}
        order by lower(m.title), m.id`)
    ).rows,
  )
  const providers =
    options.providers ??
    (await listProviders()).filter(
      (provider) =>
        provider.supportsScrape && provider.mediaTypes.includes('album'),
    )
  const [states, references, credits, inventory] = albums.length
    ? await Promise.all([
        options.stored
          ? []
          : db
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
        options.stored
          ? readAlbumMetadataInventory(
              albums.map(({ id }) => id),
              providers,
            )
          : undefined,
      ])
    : [[], [], [], undefined]
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
  return {
    total: albums.length,
    storedAlbums: options.stored
      ? [...(inventory?.values() ?? [])].filter(({ hasData }) => hasData).length
      : undefined,
    providers: providers.map((provider) => {
      const missing: string[] = []
      const stale: Array<{ id: string; scrapedAt: number }> = []
      let covered = 0
      let stored = 0
      for (const album of albums) {
        const evidence = inventory?.get(album.id)
        const scrapedAt = options.stored
          ? evidence?.scrapedAt.get(provider.id)
          : scraped.get(JSON.stringify([album.id, provider.id]))
        const hasData = options.stored
          ? evidence?.providers.has(provider.id)
          : Boolean(scrapedAt)
        const canLookUp = () =>
          canIdentifyMedia(provider, {
            mediaType: 'album',
            title: album.title,
            artists: (artistsById.get(album.id) ?? []).map((row) => row.name),
            providerReferences: referencesById.get(album.id) ?? [],
          })
        if (hasData) {
          stored++
          if (!scrapedAt) continue
          if (scrapedAt.getTime() >= cutoff) covered++
          else if (!options.stored || canLookUp())
            stale.push({ id: album.id, scrapedAt: scrapedAt.getTime() })
        } else if (canLookUp()) missing.push(album.id)
      }
      stale.sort(
        (left, right) =>
          left.scrapedAt - right.scrapedAt || left.id.localeCompare(right.id),
      )
      return {
        provider,
        covered,
        stored: options.stored ? stored : undefined,
        missing,
        stale: stale.map((album) => album.id),
      }
    }),
  }
}

async function albumCoverage(
  albumIds: SQL,
  query: CoverageQuery,
  stored = false,
): Promise<Coverage> {
  const gaps = await albumGaps(albumIds, query.olderThanDays, { stored })
  return CoverageSchema.parse({
    total: gaps.total,
    storedAlbums: gaps.storedAlbums,
    olderThanDays: query.olderThanDays,
    providers: gaps.providers.map(
      ({ provider, covered, stored, missing, stale }) => ({
        provider: provider.id,
        displayName: provider.displayName,
        eligible: (stored ?? covered + stale.length) + missing.length,
        covered,
        stored,
        stale: stale.length,
        missing: missing.length,
        unavailableReason: unavailableReason(provider),
        missingItemIds: missing.slice(0, COVERAGE_ITEM_ID_LIMIT),
        staleItemIds: stale.slice(0, COVERAGE_ITEM_ID_LIMIT),
      }),
    ),
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
  return albumCoverage(playlistAlbums(id), query, true)
}

/** Recheck the exact playlist gap on the explicitly selected albums before queueing. */
export async function albumCoverageGapSelection(
  ids: string[],
  providers: ProviderSummary[],
  gap: CoverageGap,
  olderThanDays: number,
) {
  const coverage = await albumGaps(
    sql`select unnest(${sql.param(ids)}::text[])`,
    olderThanDays,
    { providers, stored: true },
  )
  return coverage.providers.flatMap((row) =>
    row[gap].map((mediaItemId) => ({ mediaItemId, provider: row.provider.id })),
  )
}

/**
 * Per artist provider, how many of the playlist's artists have a current
 * profile, a stale one or none. The artists are those the Metadata page's
 * playlist filter matches: credited on its tracks, on its album entries and
 * on the albums of its tracks, leaving hidden items out. Missing and stale
 * use the artist queue's freshness filters (`unscraped`, and `older` without
 * the never scraped), so queueing the IDs rechecks the same rule. One
 * aggregate over the playlist's artists; reads stored state only.
 */
export async function getPlaylistArtistCoverage(
  id: string,
  query: CoverageQuery,
): Promise<Coverage> {
  await getPlaylistSummary(id)
  const providers = (await listProviders()).filter(
    (provider) => provider.supportsArtistEnrichment,
  )
  const artistId = sql`m.id`
  const columns = providers.map(({ id: provider }) => {
    const [missing] = artistFreshnessConditions(artistId, [
      { provider, mode: 'unscraped' },
    ])
    const [notFresh] = artistFreshnessConditions(artistId, [
      { provider, mode: 'older', olderThanDays: query.olderThanDays },
    ])
    const isMissing = missing ?? sql`false`
    const isNotFresh = notFresh ?? sql`false`
    return sql`json_build_object(
      'missing', count(*) filter (where ${isMissing}),
      'notFresh', count(*) filter (where ${isNotFresh}),
      'missingIds', (array_agg(m.id order by m.sort_key, m.id)
        filter (where ${isMissing}))[1:${COVERAGE_ITEM_ID_LIMIT}::int],
      'staleIds', (array_agg(m.id order by ${artistLastScrapedAt(artistId, provider)}, m.id)
        filter (where ${isNotFresh} and not ${isMissing}))[1:${COVERAGE_ITEM_ID_LIMIT}::int]
    )`
  })
  const [row] = (
    await db.execute(sql`
      select count(*)::int as total,
        json_build_array(${sql.join(columns, sql`, `)}) as providers
      from (
        select a.id, lower(coalesce(a.sort_name, a.name)) as sort_key
        from artist a
        where a.merged_into_id is null and a.id in (
          select artist_id from (${artistPlaylistCredits(
            undefined,
            sql`playlist.id = ${id}`,
          )}) memberships
        )
      ) m`)
  ).rows
  const gaps = ArtistGapsSchema.parse(row)
  return CoverageSchema.parse({
    total: gaps.total,
    olderThanDays: query.olderThanDays,
    providers: providers.map((provider, index) => {
      const counts = gaps.providers[index]
      const missing = counts?.missing ?? 0
      const stale = (counts?.notFresh ?? 0) - missing
      return {
        provider: provider.id,
        displayName: provider.displayName,
        eligible: gaps.total,
        covered: gaps.total - missing - stale,
        stale,
        missing,
        unavailableReason: unavailableReason(provider),
        missingItemIds: counts?.missingIds ?? [],
        staleItemIds: counts?.staleIds ?? [],
      }
    }),
  })
}

/**
 * A page of the playlist's entries whose albums have the gap, in the entry
 * query's order, each with its gaps by provider. Uses the same albums and
 * rules as the playlist's coverage, so the albums of all returned entries
 * are the albums Coverage counts. An entry's albums are an album entry
 * itself, a track's library album and the albums whose track list has it.
 * Grouped results show each library album with the gap once.
 */
export async function getPlaylistCoverageEntries(
  id: string,
  query: CoverageEntriesQuery,
): Promise<CoverageEntries> {
  const { gap, provider, olderThanDays, ...entryQuery } = query
  const gaps = await albumGaps(playlistAlbums(id), olderThanDays, {
    stored: true,
  })
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
  const detail = await getPlaylistDetail(id, entryQuery, [
    ...providersByAlbum.keys(),
  ])
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
export async function getArtistCoverage(
  requestedId: string,
  query: CoverageQuery,
) {
  const id = await requireCreator(requestedId, 'artist')
  return albumCoverage(
    sql`select c.media_item_id from media_credit c
      where c.artist_id = ${id} and c.role = 'artist'`,
    query,
  )
}
