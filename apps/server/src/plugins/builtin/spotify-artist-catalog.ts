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

export function selectSpotifyCatalogRecordings(
  recordings: readonly SpotifyArtistCatalogRecording[],
) {
  const distinct = new Map<string, { title: string; release: string }>()
  for (const { title, albumName } of recordings) {
    const key = trackBaseKey(title)
    if (!key || !albumName?.trim() || distinct.has(key)) continue
    distinct.set(key, { title, release: albumName })
    if (distinct.size === 2) break
  }
  return [...distinct.values()]
}

type SpotifyCatalogCredit = {
  spotifyTrackId: string
  title: string
  release: string
  artistId: string
}

/** Corroborate an ambiguous artist lookup using two independently recorded titles. */
export async function verifySpotifyArtistCatalogRecordings(
  context: MediaPluginTestContext,
  name: string,
  token: string,
  recordings: readonly SpotifyArtistCatalogRecording[],
  conflictingCredits?: (credits: SpotifyCatalogCredit[]) => void,
) {
  const [first, second] = selectSpotifyCatalogRecordings(recordings)
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
      SpotifyCatalogCredit & { artistName: string }
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
      const namesake = track.artists.find(
        (artist) =>
          artist.id !== primary.id && albumNameKey(artist.name) === artistKey,
      )
      const credit = {
        spotifyTrackId: track.id,
        title: track.name,
        release: track.album.name,
        artistId: primary.id,
      }
      if (namesake) {
        conflictingCredits?.([credit, { ...credit, artistId: namesake.id }])
        return null
      }
      matches.set(primary.id, {
        ...credit,
        artistName: primary.name,
      })
    }
    if (matches.size > 1)
      conflictingCredits?.(
        [...matches.values()]
          .slice(0, 2)
          .map(({ spotifyTrackId, title, release, artistId }) => ({
            spotifyTrackId,
            title,
            release,
            artistId,
          })),
      )
    return matches.size === 1 ? (matches.values().next().value ?? null) : null
  }
  const firstMatch = await searchRecording(first)
  if (!firstMatch) return null
  const secondMatch = await searchRecording(second)
  if (!secondMatch || firstMatch.spotifyTrackId === secondMatch.spotifyTrackId)
    return null
  const matched = [firstMatch, secondMatch].map(
    ({ spotifyTrackId, title, release, artistId }) => ({
      spotifyTrackId,
      title,
      release,
      artistId,
    }),
  )
  if (firstMatch.artistId !== secondMatch.artistId) {
    conflictingCredits?.(matched)
    return null
  }
  return {
    artistId: firstMatch.artistId,
    artistName: firstMatch.artistName,
    recordings: matched,
  }
}
