import { z } from 'zod'
import { parseOptionalDate } from '@/lib/media-utils'
import {
  AlbumReleaseDateSchema,
  SpotifyAlbumTypeSchema,
  SpotifyIdSchema,
  UpcSchema,
  spotifyArtworkUrl,
} from '@/lib/spotify-api'

export const spotifyArtistAlbumsPageSize = 10
export const spotifyArtistAlbumGroups = 'album,single,compilation,appears_on'

const ProviderTitle = z
  .string()
  .transform((value) => value.replaceAll('\u0000', '').trim().slice(0, 500))
const ReleaseSchema = z.object({
  id: SpotifyIdSchema,
  name: ProviderTitle,
  artists: z.array(z.object({ id: SpotifyIdSchema, name: ProviderTitle })),
  album_group: z
    .enum(['album', 'single', 'compilation', 'appears_on'])
    .optional(),
  album_type: SpotifyAlbumTypeSchema.optional(),
  images: z.array(z.object({ url: z.string() })).optional(),
  release_date: z.string().optional(),
  total_tracks: z.number().int().nonnegative().optional(),
  external_ids: z
    .object({ upc: UpcSchema.optional() })
    .optional()
    .catch(undefined),
})

const PageSchema = z.object({
  items: z.array(ReleaseSchema).max(spotifyArtistAlbumsPageSize),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().max(2_147_483_647),
  next: z.string().url().nullable(),
})

export function spotifyArtistAlbumsPath(artistId: string) {
  return `artists/${artistId}/albums`
}

function nextAlbumPageOffset(
  { next, offset, items }: z.infer<typeof PageSchema>,
  artistId: string,
) {
  if (next === null) return null
  const url = new URL(next)
  const rawOffset = url.searchParams.get('offset') ?? ''
  const nextOffset = Number(rawOffset)
  if (
    url.origin !== 'https://api.spotify.com' ||
    url.pathname !== `/v1/${spotifyArtistAlbumsPath(artistId)}` ||
    !/^\d+$/.test(rawOffset) ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset > 2_147_483_637 ||
    nextOffset <= offset ||
    nextOffset < offset + items.length ||
    nextOffset > offset + spotifyArtistAlbumsPageSize
  )
    throw new Error('Spotify returned an invalid next album page.')
  return nextOffset
}

function releaseDate(value: string | undefined) {
  const parsed = AlbumReleaseDateSchema.safeParse(value)
  return parsed.success
    ? (parseOptionalDate(parsed.data) ?? undefined)
    : undefined
}

export function parseSpotifyArtistAlbumPage(
  value: unknown,
  artistId: string,
  offset: number,
) {
  const page = PageSchema.parse(value)
  if (page.offset !== offset)
    throw new Error('Spotify returned an unexpected album page.')
  const nextOffset = nextAlbumPageOffset(page, artistId)
  return {
    nextOffset,
    total: page.total,
    releases: page.items.map((release, index) => {
      const credits = release.artists.flatMap(({ id, name }) =>
        name ? [{ name, externalId: id }] : [],
      )
      const credited = credits.some(({ externalId }) => externalId === artistId)
      const primary = credits[0]?.externalId === artistId
      return {
        externalId: release.id,
        title: release.name || 'Untitled album',
        spotifyUrl: `https://open.spotify.com/album/${release.id}`,
        artworkUrl: spotifyArtworkUrl(release.images) ?? undefined,
        releaseDate: releaseDate(release.release_date),
        trackCount: release.total_tracks,
        ...(release.external_ids?.upc ? { upc: release.external_ids.upc } : {}),
        credits,
        primary,
        relationshipRole:
          release.album_group ??
          (credited ? (release.album_type ?? 'credited') : 'related'),
        position: offset + index + 1,
      }
    }),
  }
}
