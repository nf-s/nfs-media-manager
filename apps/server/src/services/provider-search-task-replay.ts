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
  z.object({ restrictions: z.object({ reason: z.string().trim().min(1) }) }),
])

const SpotifyCatalogTrackPopularitySchema = z.object({
  popularity: SpotifyTrackSearchCandidateSchema.shape.popularity,
})

type Request = MediaPluginTestContext['request']
type SearchInput = z.infer<typeof SearchInputSchema>
type AlbumSearchInput = z.infer<typeof AlbumSearchInputSchema>

const ALBUM_PAGE_SIZE = 10

export async function searchSpotifyCatalogTracks(
  request: Request,
  token: string,
  { query, market }: SearchInput,
) {
  const { tracks } = z
    .object({
      tracks: z.object({
        items: z.array(z.unknown()).max(SPOTIFY_TRACK_SEARCH_LIMIT),
        offset: z.literal(0),
      }),
    })
    .parse(
      await spotifyJson(request, token, 'search', {
        ...(market ? { market } : {}),
        q: query,
        type: 'track',
        limit: String(SPOTIFY_TRACK_SEARCH_LIMIT),
      }),
    )
  const seen = new Set<string>()
  return tracks.items.flatMap((item) => {
    if (UnavailableSpotifyCatalogTrackSchema.safeParse(item).success) return []
    const { track } = normalizeSpotifyTrackEntry({ item })
    if (!track || seen.has(track.spotifyTrackId)) return []
    const candidate = SpotifyTrackSearchCandidateSchema.safeParse({
      ...track,
      ...SpotifyCatalogTrackPopularitySchema.safeParse(item).data,
      spotifyUrl: `https://open.spotify.com/track/${track.spotifyTrackId}`,
    })
    if (!candidate.success) return []
    seen.add(track.spotifyTrackId)
    return [candidate.data]
  })
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
