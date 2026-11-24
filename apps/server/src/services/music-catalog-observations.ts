import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { SpotifyTrackSearchCandidate } from '@repo/schemas/spotify-track-search'
import {
  tidalSuggestionTitle,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { parseOptionalDate } from '@/lib/media-utils'
import { providerResponse } from '@/schemas/db'
import { observeCatalogMedia } from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Origin = {
  operation: string
  key: string
  subjectKind?: string
  subjectId?: string
  jobId?: string
  responseId?: string
  page?: number
  position: number
  observedAt?: Date
}

export async function latestCatalogResponseId(
  database: Pick<typeof db, 'select'>,
  jobId: string,
  provider: string,
) {
  const [latest] = await database
    .select({ id: providerResponse.id })
    .from(providerResponse)
    .where(
      and(
        eq(providerResponse.jobId, jobId),
        eq(providerResponse.provider, provider),
        eq(providerResponse.phase, 'task'),
        gte(providerResponse.status, 200),
        lt(providerResponse.status, 300),
      ),
    )
    .orderBy(desc(providerResponse.attempt), desc(providerResponse.ordinal))
    .limit(1)
  return latest?.id
}

function occurrence(provider: string, { key, ...origin }: Origin) {
  return {
    ...origin,
    provider,
    occurrenceKey: JSON.stringify([key, origin.page, origin.position]),
  }
}

export async function observeSpotifySearchTrack(
  tx: Transaction,
  track: SpotifyTrackSearchCandidate & { releaseDate?: string | null },
  origin: Origin,
) {
  return observeCatalogMedia(
    tx,
    {
      kind: 'track',
      title: track.title,
      provider: 'spotify',
      referenceType: 'track',
      externalId: track.spotifyTrackId,
      artworkUrl: track.artworkUrl ?? undefined,
      releaseDate: parseOptionalDate(track.releaseDate) ?? undefined,
      spotifyUrl: track.spotifyUrl,
      durationSec: track.durationSec,
      spotifyAlbumId: track.spotifyAlbumId ?? undefined,
      albumName: track.albumName ?? undefined,
      credits: track.artistCredits.length
        ? track.artistCredits.map(({ id, name }) => ({ externalId: id, name }))
        : track.artists.map((name) => ({ name })),
    },
    occurrence('spotify', origin),
  )
}

export async function observeTidalSuggestion(
  tx: Transaction,
  kind: TidalSimilarKind,
  item: TidalSuggestion,
  origin: Origin,
) {
  return observeCatalogMedia(
    tx,
    {
      kind,
      title: tidalSuggestionTitle(item),
      provider: 'tidal',
      referenceType: kind,
      externalId: item.tidalId,
      releaseDate: parseOptionalDate(item.releaseDate) ?? undefined,
      durationSec: item.durationSec ?? undefined,
      credits: item.artists.map((name) => ({ name })),
      referenceMetadata: {
        url: item.url,
        version: item.version,
        durationSec: item.durationSec,
        code: item.code,
      },
    },
    occurrence('tidal', origin),
  )
}
