import { z } from 'zod'
import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import { SpotifyTrackSearchMarketSchema } from '@repo/schemas/spotify-track-search'
import {
  SpotifyCodeMatchSchema,
  TidalSimilarKindSchema,
  normalizeSimilarGenres,
  type SpotifyCodeMatch,
} from '@repo/schemas/tidal'
import { validIsrc } from '@/lib/isrc'
import {
  SpotifyAlbumSchema,
  SpotifyAlbumTypeSchema,
  UpcSchema,
  spotifyArtworkUrl,
  spotifyJson,
} from '@/lib/spotify-api'
import { normalizeSpotifyCatalogTrack } from './provider-search-task-replay'

type Request = MediaPluginTestContext['request']

/** Spotify results read for one `isrc:` search; one recording rarely has more. */
const TRACK_RESULT_LIMIT = 10

export const SpotifyCodeSearchSchema = z
  .object({
    kind: TidalSimilarKindSchema,
    code: z.string().min(1).max(40),
    market: SpotifyTrackSearchMarketSchema.optional(),
  })
  .strict()
export type SpotifyCodeSearch = z.infer<typeof SpotifyCodeSearchSchema>

/** A track `isrc:` search result, with what the choice reads. */
export type SpotifyCodeTrackCandidate = SpotifyCodeMatch & {
  isrc: string | null
  albumType: z.infer<typeof SpotifyAlbumTypeSchema> | null
  releaseDate: string | null
}

const AlbumTypeSchema = z.object({
  album: z.object({ album_type: SpotifyAlbumTypeSchema }),
})

/** A UPC without leading zeros: TIDAL and Spotify pad barcodes differently. */
export function upcKey(value: string): string | null {
  const parsed = UpcSchema.safeParse(value.trim())
  return parsed.success ? parsed.data.replace(/^0+/, '') || '0' : null
}

/** The stored form of a code, or null when it is not a valid ISRC or UPC. */
export function codeKey(kind: 'album' | 'track', value: string) {
  return kind === 'album' ? upcKey(value) : validIsrc(value)
}

/** The UPC as 12, 13 and 14 digits, as references may store it. */
export function upcVariants(key: string): string[] {
  return [
    ...new Set(
      [key, ...[12, 13, 14].map((length) => key.padStart(length, '0'))].filter(
        (value) => UpcSchema.safeParse(value).success,
      ),
    ),
  ]
}

async function searchTracks(
  request: Request,
  token: string,
  isrc: string,
  market: string | undefined,
): Promise<SpotifyCodeTrackCandidate[]> {
  const { tracks } = z
    .object({
      tracks: z.object({
        items: z.array(z.unknown()).max(TRACK_RESULT_LIMIT),
      }),
    })
    .parse(
      await spotifyJson(request, token, 'search', {
        ...(market ? { market } : {}),
        q: `isrc:${isrc}`,
        type: 'track',
        limit: String(TRACK_RESULT_LIMIT),
      }),
    )
  const seen = new Set<string>()
  return tracks.items.flatMap((item) => {
    const track = normalizeSpotifyCatalogTrack(item)
    if (!track || seen.has(track.spotifyTrackId)) return []
    seen.add(track.spotifyTrackId)
    const albumType = AlbumTypeSchema.safeParse(item)
    const match = SpotifyCodeMatchSchema.safeParse({
      spotifyId: track.spotifyTrackId,
      url: track.spotifyUrl,
      title: track.title,
      artists: track.artists,
      albumName: track.albumName,
      spotifyAlbumId: track.spotifyAlbumId,
      artworkUrl: track.artworkUrl,
      durationSec: track.durationSec,
      trackCount: null,
    })
    return match.success
      ? [
          {
            ...match.data,
            isrc: validIsrc(track.isrc),
            albumType: albumType.success
              ? albumType.data.album.album_type
              : null,
            releaseDate: track.releaseDate,
          },
        ]
      : []
  })
}

async function searchAlbum(
  request: Request,
  token: string,
  upc: string,
  market: string | undefined,
): Promise<Array<SpotifyCodeMatch & { releaseDate?: string }>> {
  const { albums } = z
    .object({
      albums: z.object({ items: z.array(SpotifyAlbumSchema).max(5) }),
    })
    .parse(
      await spotifyJson(request, token, 'search', {
        ...(market ? { market } : {}),
        q: `upc:${upc}`,
        type: 'album',
        limit: '5',
      }),
    )
  return albums.items.map((album) => {
    const genres = normalizeSimilarGenres(album.genres ?? [])
    const match = SpotifyCodeMatchSchema.parse({
      spotifyId: album.id,
      url: `https://open.spotify.com/album/${album.id}`,
      title: album.name,
      artists: [...new Set(album.artists.map((artist) => artist.name))],
      albumName: null,
      spotifyAlbumId: album.id,
      artworkUrl: spotifyArtworkUrl(album.images),
      durationSec: null,
      trackCount: album.total_tracks ?? null,
      ...(genres.length ? { genres } : {}),
    })
    return { ...match, releaseDate: album.release_date }
  })
}

/**
 * Chooses among the Spotify tracks of one ISRC: one already in the library,
 * then the earliest release that is not a compilation, then Spotify's first.
 * Tracks Spotify returned with another ISRC are left out.
 */
export function chooseSpotifyTrack(
  isrc: string,
  candidates: readonly SpotifyCodeTrackCandidate[],
  librarySpotifyIds: ReadonlySet<string>,
): SpotifyCodeTrackCandidate | null {
  const exact = candidates.filter((candidate) => candidate.isrc === isrc)
  const inLibrary = exact.find(({ spotifyId }) =>
    librarySpotifyIds.has(spotifyId),
  )
  if (inLibrary) return inLibrary
  const [earliest] = exact
    .filter(({ albumType }) => albumType !== 'compilation')
    .sort((left, right) =>
      (left.releaseDate ?? '9999').localeCompare(right.releaseDate ?? '9999'),
    )
  return earliest ?? exact[0] ?? null
}

/** One `isrc:` or `upc:` search: the tracks of an ISRC, or the album of a UPC. */
export async function searchSpotifyCode(
  request: Request,
  token: string,
  input: SpotifyCodeSearch,
  observe?: (
    candidates: ReadonlyArray<
      SpotifyCodeMatch & { releaseDate?: string | null }
    >,
  ) => Promise<void>,
): Promise<
  | { kind: 'album'; album: SpotifyCodeMatch | null }
  | { kind: 'track'; tracks: SpotifyCodeTrackCandidate[] }
> {
  const { kind, code, market } = SpotifyCodeSearchSchema.parse(input)
  if (kind === 'album') {
    // Searched as TIDAL wrote it: Spotify matches the digits exactly.
    const upc = UpcSchema.safeParse(code.trim())
    if (!upc.success) throw new Error('Invalid UPC')
    const candidates = await searchAlbum(request, token, upc.data, market)
    await observe?.(candidates)
    const [first] = candidates
    return { kind, album: first ? SpotifyCodeMatchSchema.parse(first) : null }
  }
  const isrc = validIsrc(code)
  if (!isrc) throw new Error('Invalid ISRC')
  const tracks = await searchTracks(request, token, isrc, market)
  await observe?.(tracks)
  return { kind, tracks }
}

/** Reads a Spotify similar lookup again from its recorded responses. */
export async function replaySpotifyCodeSearches(
  steps: readonly { operation: string; args: unknown }[],
  request: Request,
) {
  const results = []
  for (const step of steps) {
    if (step.operation !== 'code-search')
      throw new Error('Unexpected Spotify similar lookup step')
    results.push(
      await searchSpotifyCode(
        request,
        'offline-catalog-replay',
        SpotifyCodeSearchSchema.parse(step.args),
      ),
    )
  }
  return results
}
