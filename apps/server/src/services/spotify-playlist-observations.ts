import type { db } from '@/lib/db'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import {
  reconcileSpotifyRecordingCredits,
  type SpotifyRecordingCredit,
} from './catalog-discoveries'
import {
  observeSpotifyCatalogEntries,
  observeSpotifyCatalogEntriesIndividually,
  type SpotifyCatalogEntry,
} from './spotify-catalog-observation-batch'
import { spotifyTrackAndAlbumObservations } from './music-catalog-observations'
import type { PlaylistPage } from './spotify-playlists'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Evidence = {
  jobId?: string
  snapshot?: string | null
  observedAt?: Date
  complete?: boolean
}
function playlistObservations(
  playlistId: string,
  page: PlaylistPage,
  evidence: Evidence,
) {
  return page.entries.map(
    ({ position, track, mention }): SpotifyCatalogEntry => {
      const key = JSON.stringify([
        evidence.snapshot ?? evidence.jobId ?? 'stored',
        position,
      ])
      const origin = {
        operation: 'playlist-contents',
        key,
        subjectKind: 'playlist',
        subjectId: playlistId,
        jobId: evidence.jobId,
        observedAt: evidence.observedAt,
        responseId: page.responseId,
        page: page.page,
        position,
        details: {
          snapshot: evidence.snapshot ?? null,
          version: evidence.jobId ?? evidence.snapshot ?? null,
          total: page.total,
          complete: evidence.complete ?? false,
          addedAt: track?.addedAt ?? null,
        },
        relationshipRole: 'playlist_entry',
      }
      if (track)
        return {
          ...spotifyTrackAndAlbumObservations(
            {
              ...track,
              spotifyUrl: `https://open.spotify.com/track/${track.spotifyTrackId}`,
            },
            origin,
          ),
          isrc: track.isrc,
        }
      return {
        recording: {
          media: {
            kind: 'track',
            title: mention.name,
            provider: 'spotify',
            referenceType: 'track',
            credits: mention.artists.map(({ id, name }) => ({
              name,
              externalId: SpotifyIdSchema.safeParse(id).data,
            })),
          },
          origin: { ...origin, provider: 'spotify', occurrenceKey: key },
        },
      }
    },
  )
}

/** Retain observations when the input has no previously imported tracks. */
export async function observeSpotifyPlaylistPage(
  tx: Transaction,
  playlistId: string,
  page: PlaylistPage,
  evidence: Evidence,
) {
  const pendingSpotifyCredits: SpotifyRecordingCredit[] = []
  await observeSpotifyCatalogEntriesIndividually(
    tx,
    playlistObservations(playlistId, page, evidence),
    pendingSpotifyCredits,
  )
  await reconcileSpotifyRecordingCredits(tx, pendingSpotifyCredits)
}

/** Store every playlist position after the import has resolved and written its native tracks. */
export async function observeSpotifyPlaylistPageBatch(
  tx: Transaction,
  playlistId: string,
  page: PlaylistPage,
  evidence: Evidence,
) {
  await observeSpotifyCatalogEntries(
    tx,
    playlistObservations(playlistId, page, evidence),
    'playlist-import',
  )
}
