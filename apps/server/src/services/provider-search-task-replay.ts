import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import { LASTFM_SPOTIFY_SEARCH_TASK } from '@repo/schemas/lastfm'
import { ManualMediaSearchResultSchema } from '@repo/schemas/manual-add'
import {
  SPOTIFY_TRACK_SEARCH_LIMIT,
  SPOTIFY_TRACK_SEARCH_TASK,
  SpotifyTrackSearchCandidateSchema,
  SpotifyTrackSearchMarketSchema,
} from '@repo/schemas/spotify-track-search'
import {
  SpotifyAlbumSchema,
  normalizeSpotifyTrackEntry,
  spotifyTrackMention,
  spotifyJson,
} from '@/lib/spotify-api'
import { ServerError } from '@/lib/error'
import type { ProviderTaskReplayStep } from './provider-task-replay'

const SearchInputSchema = z.strictObject({
  query: z.string().min(1).max(200),
  market: SpotifyTrackSearchMarketSchema.optional(),
})

const AlbumSearchInputSchema = SearchInputSchema.extend({
  page: z.number().int().min(1).max(50),
})

const UnavailableSpotifyCatalogTrackSchema = z.union([
  z.object({ is_playable: z.literal(false) }),
  z.object({ is_local: z.literal(true) }),
  z.object({ restrictions: z.object({ reason: z.string().trim().min(1) }) }),
])

const SpotifyCatalogTrackPopularitySchema = z.object({
  popularity: SpotifyTrackSearchCandidateSchema.shape.popularity,
})

type Request = MediaPluginTestContext['request']
type SearchInput = z.infer<typeof SearchInputSchema>
type AlbumSearchInput = z.infer<typeof AlbumSearchInputSchema>

const ALBUM_PAGE_SIZE = 10

export function normalizeSpotifyCatalogTrack(
  item: unknown,
  includeUnavailable = false,
) {
  if (
    !includeUnavailable &&
    UnavailableSpotifyCatalogTrackSchema.safeParse(item).success
  )
    return null
  const { track } = normalizeSpotifyTrackEntry({ item })
  if (!track) return null
  const candidate = SpotifyTrackSearchCandidateSchema.safeParse({
    ...track,
    ...SpotifyCatalogTrackPopularitySchema.safeParse(item).data,
    spotifyUrl: `https://open.spotify.com/track/${track.spotifyTrackId}`,
  })
  return candidate.success
    ? {
        ...candidate.data,
        releaseDate: track.releaseDate,
        albumArtistCredits: track.albumArtistCredits,
      }
    : null
}

export type SpotifySearchObservation = {
  position: number
  playable: boolean
} & (
  | {
      track: NonNullable<ReturnType<typeof normalizeSpotifyCatalogTrack>>
      mention?: never
    }
  | {
      track?: never
      mention: NonNullable<ReturnType<typeof spotifyTrackMention>>
    }
)

export function spotifySearchObservations(items: unknown[], offset: number) {
  return items.flatMap((item, index): SpotifySearchObservation[] => {
    const position = offset + index + 1
    const track = normalizeSpotifyCatalogTrack(item, true)
    const playable =
      !UnavailableSpotifyCatalogTrackSchema.safeParse(item).success
    const local = z
      .object({ is_local: z.literal(true) })
      .safeParse(item).success
    if (local) return []
    if (track) return [{ track, playable, position }]
    const mention = spotifyTrackMention({ item })
    return mention ? [{ mention, playable: false, position }] : []
  })
}

export async function searchSpotifyCatalogTrackPage(
  request: Request,
  token: string,
  { query, market, page }: SearchInput & { page?: number },
) {
  const offset = ((page ?? 1) - 1) * SPOTIFY_TRACK_SEARCH_LIMIT
  const { tracks } = z
    .object({
      tracks: z.object({
        items: z.array(z.unknown()).max(SPOTIFY_TRACK_SEARCH_LIMIT),
        offset: z.literal(offset),
        total:
          page === undefined
            ? z.number().int().nonnegative().optional()
            : z.number().int().nonnegative(),
      }),
    })
    .parse(
      await spotifyJson(request, token, 'search', {
        ...(market ? { market } : {}),
        q: query,
        type: 'track',
        limit: String(SPOTIFY_TRACK_SEARCH_LIMIT),
        ...(page === undefined ? {} : { offset: String(offset) }),
      }),
    )
  const seen = new Set<string>()
  const items = tracks.items.flatMap((item, index) => {
    const track = normalizeSpotifyCatalogTrack(item)
    if (!track || seen.has(track.spotifyTrackId)) return []
    seen.add(track.spotifyTrackId)
    return [{ ...track, catalogPosition: offset + index + 1 }]
  })
  return {
    items,
    observations: spotifySearchObservations(tracks.items, offset),
    hasMore:
      page !== undefined &&
      page < 50 &&
      tracks.items.length > 0 &&
      offset + tracks.items.length < (tracks.total ?? 0),
  }
}

export async function searchSpotifyCatalogTracks(
  request: Request,
  token: string,
  input: SearchInput,
  observe?: (observations: SpotifySearchObservation[]) => void,
) {
  const page = await searchSpotifyCatalogTrackPage(request, token, input)
  observe?.(page.observations)
  return page.items.map((track) =>
    SpotifyTrackSearchCandidateSchema.parse(track),
  )
}

const TrackLookupInputSchema = z.strictObject({
  spotifyTrackId: z.string().regex(/^[A-Za-z0-9]{22}$/),
  market: SpotifyTrackSearchMarketSchema.optional(),
})
type TrackLookupInput = z.infer<typeof TrackLookupInputSchema>

/**
 * One catalog track by its Spotify ID, as a search candidate: the step that
 * takes a Sonovault candidate's Spotify ID (SONO-25). Empty when Spotify
 * marks it unavailable or has no such track.
 */
export async function lookupSpotifyCatalogTrack(
  request: Request,
  token: string,
  input: TrackLookupInput,
  observe?: (observations: SpotifySearchObservation[]) => void,
) {
  const { spotifyTrackId, market } = TrackLookupInputSchema.parse(input)
  const value = await spotifyJson(
    request,
    token,
    `tracks/${spotifyTrackId}`,
    market ? { market } : {},
  )
  observe?.(
    spotifySearchObservations([value], 0).filter(
      (item) => item.track?.spotifyTrackId === spotifyTrackId,
    ),
  )
  const track = normalizeSpotifyCatalogTrack(value)
  return track && track.spotifyTrackId === spotifyTrackId
    ? [SpotifyTrackSearchCandidateSchema.parse(track)]
    : []
}

export async function searchSpotifyCatalogAlbums(
  request: Request,
  token: string,
  { query, market, page }: AlbumSearchInput,
) {
  const offset = (page - 1) * ALBUM_PAGE_SIZE
  return z
    .object({
      albums: z.object({
        items: z.array(SpotifyAlbumSchema).max(ALBUM_PAGE_SIZE),
        total: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
      }),
    })
    .parse(
      await spotifyJson(request, token, 'search', {
        ...(market ? { market } : {}),
        q: query,
        type: 'album',
        limit: String(ALBUM_PAGE_SIZE),
        offset: String(offset),
      }),
    ).albums
}

export function projectSpotifyCatalogAlbums(
  page: Awaited<ReturnType<typeof searchSpotifyCatalogAlbums>>,
  pageNumber: number,
) {
  if (page.offset !== (pageNumber - 1) * ALBUM_PAGE_SIZE) {
    throw new ServerError({
      statusCode: 422,
      message: 'Spotify returned an unexpected search page.',
    })
  }
  return ManualMediaSearchResultSchema.parse({
    items: page.items.map((item) => ({
      externalId: item.id,
      title: item.name,
      subtitle: item.artists.map((artist) => artist.name).join(', '),
      releaseDate: item.release_date ?? null,
      artworkUrl: item.images[0]?.url ?? null,
      url: `https://open.spotify.com/album/${item.id}`,
      mediaItemId: null,
      trackCount: item.total_tracks,
    })),
    page: pageNumber,
    totalCount: Math.min(page.total, 500),
    hasMore:
      pageNumber < 50 &&
      page.items.length > 0 &&
      page.offset + page.items.length < page.total,
  })
}

export async function replayProviderSearchTask(
  task: string,
  steps: readonly ProviderTaskReplayStep[],
  request: Request,
): Promise<unknown[]> {
  const [step] = steps
  if (steps.length !== 1 || !step)
    throw new Error('Expected one Spotify catalog search step')
  const token = 'offline-catalog-replay'
  if (task === SPOTIFY_TRACK_SEARCH_TASK && step.operation === 'track-search') {
    return [
      await searchSpotifyCatalogTracks(
        request,
        token,
        SearchInputSchema.parse(step.args),
      ),
    ]
  }
  if (task === SPOTIFY_TRACK_SEARCH_TASK && step.operation === 'track-lookup')
    return [
      await lookupSpotifyCatalogTrack(
        request,
        token,
        TrackLookupInputSchema.parse(step.args),
      ),
    ]
  if (
    task === LASTFM_SPOTIFY_SEARCH_TASK &&
    step.operation === 'album-search'
  ) {
    const input = AlbumSearchInputSchema.parse(step.args)
    const page = await searchSpotifyCatalogAlbums(request, token, input)
    // Replay returns the catalog data without matching or writing library items.
    return [projectSpotifyCatalogAlbums(page, input.page)]
  }
  throw new Error('Unexpected Spotify catalog search step')
}
