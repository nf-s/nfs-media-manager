import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { SpotifyTrackSearchCandidate } from '@repo/schemas/spotify-track-search'
import {
  tidalSuggestionTitle,
  type TidalSimilarKind,
  type TidalSuggestion,
} from '@repo/schemas/tidal'
import { db } from '@/lib/db'
import { parseOptionalDate } from '@/lib/media-utils'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { providerResponse } from '@/schemas/db'
import {
  observeCatalogMedia,
  observeCatalogOccurrences,
  type CatalogMedia,
  type CatalogOrigin,
} from './catalog-discoveries'
import type { SpotifySearchObservation } from './provider-search-task-replay'
import { mapSuggestions } from './similar-library-matches'
import { spotifyTrackBilling } from './spotify-artist-credits'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type MusicObservationOrigin = Omit<
  CatalogOrigin,
  'occurrenceKey' | 'provider'
> & {
  key: string
  position: number
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

function occurrence(
  provider: string,
  { key, ...origin }: MusicObservationOrigin,
) {
  return {
    ...origin,
    provider,
    occurrenceKey: JSON.stringify([key, origin.page, origin.position]),
  }
}

export function spotifyTrackAndAlbumObservations(
  track: Omit<
    Pick<
      SpotifyTrackSearchCandidate,
      | 'spotifyTrackId'
      | 'title'
      | 'durationSec'
      | 'spotifyAlbumId'
      | 'albumName'
      | 'artworkUrl'
      | 'artists'
      | 'artistCredits'
      | 'artistBilling'
      | 'spotifyUrl'
    >,
    'durationSec'
  > & {
    durationSec?: number | null
    playable?: boolean
    releaseDate?: string | null
    albumArtistCredits?: { id?: string; name: string }[]
  },
  origin: MusicObservationOrigin,
) {
  const trackOrigin = occurrence('spotify', origin)
  const spotifyAlbumId = SpotifyIdSchema.safeParse(track.spotifyAlbumId).data
  const releaseDate = parseOptionalDate(track.releaseDate)
  const album = track.albumName
    ? {
        media: {
          kind: 'album',
          title: track.albumName,
          provider: 'spotify',
          referenceType: 'spotify',
          externalId: spotifyAlbumId,
          provisionalKey: JSON.stringify([
            'spotify-track-album',
            track.spotifyTrackId,
            track.albumName,
          ]),
          artworkUrl: track.artworkUrl,
          releaseDate,
          spotifyUrl: spotifyAlbumId
            ? `https://open.spotify.com/album/${spotifyAlbumId}`
            : undefined,
          credits: track.albumArtistCredits?.map(({ id, name }) => ({
            externalId: id,
            name,
          })),
        } satisfies CatalogMedia,
        origin: {
          ...trackOrigin,
          relationshipRole: 'candidate_album',
        },
      }
    : undefined
  const recording = {
    media: {
      kind: 'track',
      title: track.title,
      provider: 'spotify',
      referenceType: 'track',
      externalId: track.spotifyTrackId,
      artworkUrl: track.artworkUrl ?? undefined,
      releaseDate,
      spotifyUrl: track.spotifyUrl,
      playable: track.playable,
      durationSec: track.durationSec,
      spotifyAlbumId,
      albumName: track.albumName ?? undefined,
      credits: spotifyTrackBilling(track).map(({ id, name }) => ({
        externalId: id,
        name,
      })),
    } satisfies CatalogMedia,
    origin: trackOrigin,
  }
  return { album, recording }
}

export async function observeSpotifyTrackAndAlbum(
  tx: Transaction,
  track: Parameters<typeof spotifyTrackAndAlbumObservations>[0],
  origin: MusicObservationOrigin,
) {
  const { album, recording } = spotifyTrackAndAlbumObservations(track, origin)
  const albumId = album
    ? await observeCatalogMedia(tx, album.media, album.origin)
    : undefined
  const trackId = await observeCatalogMedia(
    tx,
    { ...recording.media, albumId },
    recording.origin,
  )
  return { trackId, albumId }
}

export async function observeSpotifySearchTrack(
  tx: Transaction,
  track: Parameters<typeof observeSpotifyTrackAndAlbum>[1],
  origin: MusicObservationOrigin,
) {
  return (await observeSpotifyTrackAndAlbum(tx, track, origin)).trackId
}

export async function observeSpotifySearchResults(
  tx: Transaction,
  observations: SpotifySearchObservation[],
  origin: Omit<MusicObservationOrigin, 'position'>,
) {
  const ids = new Map<string, string>()
  for (const observation of observations) {
    const { position, playable, track, mention } = observation
    const source = {
      ...origin,
      position,
      details: { ...origin.details, playable },
    }
    if (track) {
      const id = await observeSpotifySearchTrack(
        tx,
        { ...track, playable },
        source,
      )
      ids.set(track.spotifyTrackId, id)
    } else if (mention) {
      await observeCatalogMedia(
        tx,
        {
          kind: 'track',
          title: mention.name,
          provider: 'spotify',
          referenceType: 'track',
          playable: false,
          credits: mention.artists.map(({ id, name }) => ({
            name,
            externalId: SpotifyIdSchema.safeParse(id).data,
          })),
        },
        occurrence('spotify', source),
      )
    }
  }
  return ids
}

export async function observeTidalSuggestion(
  tx: Transaction,
  kind: TidalSimilarKind,
  item: TidalSuggestion,
  origin: MusicObservationOrigin,
) {
  const observed = occurrence('tidal', origin)
  const trackId = await observeCatalogMedia(
    tx,
    {
      kind,
      title: tidalSuggestionTitle(item),
      provider: 'tidal',
      referenceType: kind,
      externalId: item.tidalId,
      releaseDate: parseOptionalDate(item.releaseDate) ?? undefined,
      durationSec: item.durationSec ?? undefined,
      credits:
        item.artistCredits?.map(({ id, name }) => ({ name, externalId: id })) ??
        item.artists.map((name) => ({ name })),
      referenceMetadata: {
        url: item.url,
        version: item.version,
        durationSec: item.durationSec,
        code: item.code,
      },
    },
    observed,
  )
  for (const [index, release] of (item.linkedAlbums ?? []).entries())
    await observeCatalogMedia(
      tx,
      {
        kind: 'album',
        title: release.title,
        provider: 'tidal',
        referenceType: 'album',
        externalId: release.id,
        releaseDate: parseOptionalDate(release.releaseDate),
        credits: release.artistCredits?.map(({ id, name }) => ({
          name,
          externalId: id,
        })),
      },
      {
        ...observed,
        subjectKind: 'track',
        subjectId: trackId,
        relationshipRole: 'release',
        position: index + 1,
        occurrenceKey: JSON.stringify([
          observed.occurrenceKey,
          'release',
          index + 1,
        ]),
      },
    )
  return trackId
}

/** Preserve the link to the library track a saved Similar result opens. */
export async function observeTidalSimilarLibraryMatches(
  tx: Transaction,
  suggestions: readonly TidalSuggestion[],
  input: {
    seedId: string
    jobId?: string
    responseId?: string
    observedAt?: Date
  },
) {
  const items = await mapSuggestions(tx, 'track', suggestions)
  await observeCatalogOccurrences(
    tx,
    items.flatMap((item, index) => {
      const id = item.library?.id
      if (
        !id ||
        id === item.catalogMediaItemId ||
        id === input.seedId ||
        !item.libraryMatch
      )
        return []
      return [
        {
          target: { kind: 'track', id },
          origin: occurrence('tidal', {
            operation: 'similar',
            key: input.jobId ?? input.seedId,
            subjectKind: 'track',
            subjectId: input.seedId,
            jobId: input.jobId,
            responseId: input.responseId,
            observedAt: input.observedAt,
            page: 1,
            position: item.catalogPosition ?? index + 1,
            relationshipRole: 'library-match',
            details: { [item.libraryMatch.basis]: item.libraryMatch.value },
          }),
        },
      ]
    }),
  )
}
