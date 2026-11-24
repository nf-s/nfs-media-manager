import { eq, inArray, sql } from 'drizzle-orm'
import type { SpotifyTrackSearchCandidate } from '@repo/schemas/spotify-track-search'
import type { ManualMediaAddResult } from '@repo/schemas/manual-add'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { parseOptionalDate, slugifyParts } from '@/lib/media-utils'
import { libraryTrack, mediaItem } from '@/schemas/db'
import {
  lockLibraryTrackWrites,
  spotifyAlbumReleaseIds,
  type AlbumFallbackArtistCreditCorrection,
} from './album-library-tracks'
import {
  replaceSpotifyTrackCredits,
  resolveSpotifyTrackIds,
  spotifyTrackItemId,
} from './spotify-playlists'
import { recordTrackIsrcs, sonovaultPrimaryIsrcSql } from './track-isrcs'
import { promoteCatalogMediaInTransaction } from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type SpotifyRecording = Omit<SpotifyTrackSearchCandidate, 'durationSec'> & {
  durationSec: number | null
}

export async function libraryRecording(tx: Transaction, id: string) {
  const [row] = await tx
    .select({
      id: mediaItem.id,
      title: mediaItem.title,
      inLibrary: mediaItem.inLibrary,
      source: mediaItem.sourceLabel,
      spotifyId: libraryTrack.spotifyTrackId,
      hasArtists: sql<boolean>`exists (select 1 from media_credit c where c.media_item_id = ${mediaItem.id} and c.role = 'artist')`,
      hidden: sql<boolean>`coalesce(${mediaItem.metadata}->>'legacyHidden' = 'true', false)`,
    })
    .from(mediaItem)
    .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
    .where(eq(mediaItem.id, id))
  return row
}

export async function storeConfirmedRecording(
  tx: Transaction,
  targetId: string,
  candidate: SpotifyRecording,
  provenance:
    | {
        jobId: string
        matchMethod: 'automatic' | 'manual'
        albumFallbackArtistCreditCorrection?: AlbumFallbackArtistCreditCorrection
      }
    | { addedAt: Date; releaseDate: string | null },
) {
  const existing = await libraryRecording(tx, targetId)
  if (existing?.hidden)
    throw new ServerError({
      statusCode: 409,
      message: 'The selected Spotify recording is hidden in the library.',
    })
  const addition = 'addedAt' in provenance ? provenance : null
  const matchMethod =
    'matchMethod' in provenance ? provenance.matchMethod : 'manual'
  const albumFallbackArtistCreditCorrection =
    'albumFallbackArtistCreditCorrection' in provenance
      ? provenance.albumFallbackArtistCreditCorrection
      : undefined
  const metadata = {
    spotifyTrackSearch: {
      title: candidate.title,
      artists: candidate.artists,
      spotifyTrackId: candidate.spotifyTrackId,
      matchMethod,
    },
    ...(addition
      ? { spotifyTrackManualAddedAt: addition.addedAt.toISOString() }
      : {}),
    ...(candidate.artistCredits.length
      ? {
          spotifyArtistCredits: candidate.artistCredits,
          spotifyArtistBilling: candidate.artistBilling ?? null,
          spotifyArtistCreditsSource: {
            source: 'spotify-search',
            ...('jobId' in provenance ? { jobId: provenance.jobId } : {}),
          },
        }
      : {}),
    ...(albumFallbackArtistCreditCorrection
      ? { albumFallbackArtistCreditCorrection }
      : {}),
  }
  await tx
    .insert(mediaItem)
    .values({
      id: targetId,
      mediaType: 'track',
      slug: slugifyParts(candidate.title, targetId),
      title: candidate.title,
      artworkUrl: candidate.artworkUrl,
      releaseDate: parseOptionalDate(addition?.releaseDate),
      sourceLabel: 'spotify-search',
      metadata,
    })
    .onConflictDoUpdate({
      target: mediaItem.id,
      set: {
        sourceLabel:
          existing?.spotifyId === candidate.spotifyTrackId
            ? existing.source
            : 'spotify-search',
        artworkUrl: sql`coalesce(${mediaItem.artworkUrl}, excluded.artwork_url)`,
        ...(addition
          ? {
              releaseDate: sql`coalesce(${mediaItem.releaseDate}, excluded.release_date)`,
            }
          : {}),
        metadata: sql`coalesce(${mediaItem.metadata}, '{}'::jsonb) ||
          case when ${matchMethod} = 'automatic' and ${mediaItem.metadata} ? 'spotifyTrackSearch'
            then excluded.metadata - 'spotifyTrackSearch' else excluded.metadata end`,
        updatedAt: new Date(),
      },
    })
  await tx
    .insert(libraryTrack)
    .values({
      mediaItemId: targetId,
      spotifyTrackId: candidate.spotifyTrackId,
      spotifyUrl: candidate.spotifyUrl,
      durationSec: candidate.durationSec,
      isrc: candidate.isrc,
      spotifyAlbumId: candidate.spotifyAlbumId,
      albumName: candidate.albumName,
      dateAdded: addition?.addedAt,
    })
    .onConflictDoUpdate({
      target: libraryTrack.mediaItemId,
      set: {
        spotifyTrackId: candidate.spotifyTrackId,
        spotifyUrl: candidate.spotifyUrl,
        ...(addition
          ? {
              dateAdded: sql`least(${libraryTrack.dateAdded}, excluded.date_added)`,
            }
          : {}),
        durationSec: sql`coalesce(${libraryTrack.durationSec}, excluded.duration_sec)`,
        // Spotify's ISRC replaces one Sonovault gave (SONO-07), never another.
        isrc: sql`case when ${sonovaultPrimaryIsrcSql(sql`library_track.media_item_id`, sql`library_track.isrc`)}
          then coalesce(excluded.isrc, ${libraryTrack.isrc})
          else coalesce(${libraryTrack.isrc}, excluded.isrc) end`,
        spotifyAlbumId: sql`coalesce(excluded.spotify_album_id, ${libraryTrack.spotifyAlbumId})`,
        albumName:
          matchMethod === 'automatic' || albumFallbackArtistCreditCorrection
            ? sql`coalesce(${libraryTrack.albumName}, excluded.album_name)`
            : sql`coalesce(excluded.album_name, ${libraryTrack.albumName})`,
        updatedAt: new Date(),
      },
    })
  await recordTrackIsrcs(tx, [
    {
      mediaItemId: targetId,
      isrc: candidate.isrc,
      provider: 'spotify',
      source:
        'jobId' in provenance
          ? { kind: 'spotify-track-search', jobId: provenance.jobId }
          : { kind: 'spotify-manual-add' },
    },
  ])
  if (!existing?.hasArtists || albumFallbackArtistCreditCorrection)
    await replaceSpotifyTrackCredits(tx, [
      {
        id: targetId,
        artists: candidate.artists,
        artistCredits: candidate.artistCredits,
        artistBilling: candidate.artistBilling,
      },
    ])
  if (candidate.spotifyAlbumId)
    await tx.execute(sql`
    update library_track set album_media_item_id = matched.id, album_link_strategy = 'spotify-album'
    from (select min(r.album_id) as id from (${spotifyAlbumReleaseIds()}) r
      join media_item album on album.id = r.album_id where r.spotify_id = ${candidate.spotifyAlbumId}
        and album.metadata->>'legacyHidden' is distinct from 'true' having count(distinct r.album_id) = 1) matched
    where media_item_id = ${targetId} and not exists (
      select 1 from track position where position.track_media_item_id = library_track.media_item_id
        and position.album_media_item_id = library_track.album_media_item_id)`)
}

type TrackMatch = { id: string; hidden: boolean; inLibrary: boolean }

export async function findManualTrackMatches(
  spotifyIds: string[],
  database: Pick<typeof db, 'select'> = db,
): Promise<Map<string, TrackMatch>> {
  if (!spotifyIds.length) return new Map()
  const tracks = await database
    .select({
      id: libraryTrack.mediaItemId,
      inLibrary: mediaItem.inLibrary,
      spotifyId: libraryTrack.spotifyTrackId,
      hidden: sql<boolean>`coalesce(${mediaItem.metadata}->>'legacyHidden' = 'true', false)`,
    })
    .from(libraryTrack)
    .innerJoin(mediaItem, eq(mediaItem.id, libraryTrack.mediaItemId))
    .where(inArray(libraryTrack.spotifyTrackId, spotifyIds))
  return new Map(
    tracks.flatMap((track) =>
      track.spotifyId ? [[track.spotifyId, track]] : [],
    ),
  )
}

export function existingManualTrack(
  match: TrackMatch | undefined,
): ManualMediaAddResult | null {
  if (match?.hidden)
    throw new ServerError({
      statusCode: 409,
      message: 'The selected Spotify recording is hidden in the library.',
    })
  return match?.inLibrary ? { mediaItemId: match.id, created: false } : null
}

export async function storeManualTrack(
  candidate: SpotifyTrackSearchCandidate & { releaseDate: string | null },
): Promise<ManualMediaAddResult> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    return storeManualTrackInTransaction(tx, candidate)
  })
}

export async function storeManualTrackInTransaction(
  tx: Transaction,
  candidate: SpotifyRecording & { releaseDate: string | null },
): Promise<ManualMediaAddResult> {
  const spotifyId = candidate.spotifyTrackId
  const match = (await findManualTrackMatches([spotifyId], tx)).get(spotifyId)
  const existing = existingManualTrack(match)
  if (existing) return existing
  if (match) return promoteCatalogMediaInTransaction(tx, match.id)
  const resolved = (await resolveSpotifyTrackIds(tx, [candidate])).get(
    spotifyId,
  )
  const id = resolved ?? spotifyTrackItemId(spotifyId)
  await storeConfirmedRecording(tx, id, candidate, {
    addedAt: new Date(),
    releaseDate: candidate.releaseDate,
  })
  return { mediaItemId: id, created: resolved === undefined }
}
