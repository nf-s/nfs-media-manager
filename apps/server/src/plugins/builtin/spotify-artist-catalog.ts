import type { MediaPluginTestContext } from '@repo/media-plugin-sdk'
import { SPOTIFY_TRACK_SEARCH_LIMIT } from '@repo/schemas/spotify-track-search'
import { z } from 'zod'
import { albumNameKey } from '@/lib/album-import-candidates'
import {
  SpotifyAlbumTypeSchema,
  SpotifyIdSchema,
  spotifyJson,
} from '@/lib/spotify-api'
import { trackBaseKey } from '@/lib/track-matching'
import { spotifyMarket } from './spotify'

export type SpotifyArtistCatalogRecording = {
  title: string
  albumName: string | null
}

const Text = z.string().trim().min(1)
const Credit = z.object({ id: SpotifyIdSchema, name: Text })
const TrackSearchPage = z.object({
  tracks: z.object({
    offset: z.literal(0),
    next: z.null(),
    total: z.number().int().nonnegative(),
    items: z
      .array(
        z.object({
          id: SpotifyIdSchema,
          name: Text,
          artists: z.array(Credit),
          album: z.object({
            name: Text,
            album_type: SpotifyAlbumTypeSchema,
            artists: z.array(Credit),
          }),
        }),
      )
      .max(SPOTIFY_TRACK_SEARCH_LIMIT),
  }),
})

function quoteSearchValue(value: string) {
  return '"' + value.replace(/["\\]/g, ' ') + '"'
}

/** Corroborate an ambiguous artist lookup using two independently recorded titles. */
export async function verifySpotifyArtistCatalogRecordings(
  context: MediaPluginTestContext,
  name: string,
  token: string,
  recordings: readonly SpotifyArtistCatalogRecording[],
) {
  const distinct = new Map<string, { title: string; release: string }>()
  for (const { title, albumName } of recordings) {
    const key = trackBaseKey(title)
    if (!key || !albumName?.trim() || distinct.has(key)) continue
    distinct.set(key, { title, release: albumName })
    if (distinct.size === 2) break
  }
  const [first, second] = distinct.values()
  if (!first || !second) return null

  const market = spotifyMarket(context.secrets)
  const artistKey = albumNameKey(name)
  async function searchRecording({
    title,
    release,
  }: {
    title: string
    release: string
  }) {
    const raw = await spotifyJson(context.request, token, 'search', {
      ...market,
      q: `artist:${quoteSearchValue(name)} track:${quoteSearchValue(title)} album:${quoteSearchValue(release)}`,
      type: 'track',
      limit: String(SPOTIFY_TRACK_SEARCH_LIMIT),
    })
    const parsed = TrackSearchPage.safeParse(raw)
    if (!parsed.success) return null
    const { total, items } = parsed.data.tracks
    if (items.length !== total) return null
    const matches = new Map<
      string,
      {
        spotifyTrackId: string
        title: string
        release: string
        artistId: string
        artistName: string
      }
    >()
    for (const track of items) {
      const [primary] = track.artists
      if (
        !primary ||
        albumNameKey(primary.name) !== artistKey ||
        albumNameKey(track.name) !== albumNameKey(title) ||
        albumNameKey(track.album.name) !== albumNameKey(release)
      )
        continue
      if (
        track.album.album_type === 'compilation' &&
        track.album.artists[0]?.id !== primary.id
      )
        continue
      if (
        track.artists.some(
          (artist) =>
            artist.id !== primary.id && albumNameKey(artist.name) === artistKey,
        )
      )
        return null
      matches.set(primary.id, {
        spotifyTrackId: track.id,
        title: track.name,
        release: track.album.name,
        artistId: primary.id,
        artistName: primary.name,
      })
    }
    return matches.size === 1 ? (matches.values().next().value ?? null) : null
  }
  const firstMatch = await searchRecording(first)
  if (!firstMatch) return null
  const secondMatch = await searchRecording(second)
  if (
    !secondMatch ||
    firstMatch.artistId !== secondMatch.artistId ||
    firstMatch.spotifyTrackId === secondMatch.spotifyTrackId
  )
    return null
  const { artistId, artistName } = firstMatch
  return {
    artistId,
    artistName,
    recordings: [firstMatch, secondMatch].map(
      ({ spotifyTrackId, title, release, artistId }) => ({
        spotifyTrackId,
        title,
        release,
        artistId,
      }),
    ),
  }
}
