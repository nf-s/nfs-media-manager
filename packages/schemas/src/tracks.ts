import { z } from 'zod'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowseRangesParamSchema,
  type BrowseValues,
} from './browse'
import { DirectionSchema, PaginationQuerySchema } from './common'
import { JobStatusSchema } from './job'
import { ListeningMonthSchema } from './lastfm'

/** `scrape_job.options.task` of the job that imports one Spotify playlist. */
export const SPOTIFY_PLAYLIST_IMPORT_TASK = 'spotify-playlist-import'

/** Spotify returns at most this many items for one playlist. */
export const SPOTIFY_PLAYLIST_ITEM_LIMIT = 10000

/**
 * How a track was linked to a library album, strictest first.
 * `spotify-album`: the album has the track's Spotify album ID.
 * `spotify-track`: the album's track list has the track's Spotify ID.
 * `album-title`: same album title and a credited artist.
 * `artist-title`: a credited artist's album lists a track with the same title.
 */
export const TrackAlbumLinkStrategySchema = z.enum([
  'spotify-album',
  'spotify-track',
  'album-title',
  'artist-title',
])
export type TrackAlbumLinkStrategy = z.infer<
  typeof TrackAlbumLinkStrategySchema
>

/**
 * The rule that counted a scrobbled name towards a track, strictest first.
 * `exact`: same title and credited artist. `normalized`: ignoring accents,
 * punctuation and a leading "The". `version`: ignoring featured credits,
 * remaster notes and "Original Mix". `album`: the scrobble's linked album is
 * the track's album and the titles match without qualifiers.
 */
export const TrackScrobbleLinkStrategySchema = z.enum([
  'exact',
  'normalized',
  'version',
  'album',
])
export type TrackScrobbleLinkStrategy = z.infer<
  typeof TrackScrobbleLinkStrategySchema
>

export const TrackPlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const TrackListItemSchema = z.object({
  id: z.string(),
  mediaType: z.literal('track'),
  title: z.string(),
  artworkUrl: z.string().url().nullable(),
  releaseDate: z.string().nullable(),
  artists: z.array(z.string()),
  /** The album name Spotify reported, whether or not it is in the library. */
  albumName: z.string().nullable(),
  /** The linked library album. */
  album: z.object({ id: z.string(), title: z.string() }).nullable(),
  albumLinkStrategy: TrackAlbumLinkStrategySchema.nullable(),
  /** Tags of the linked library album. */
  albumTags: z.array(z.string()),
  playlists: z.array(TrackPlaylistSchema),
  durationSec: z.number().int().nonnegative().nullable(),
  dateAdded: z.string().nullable(),
  spotifyTrackId: z.string(),
  spotifyUrl: z.string().url().nullable(),
  isrc: z.string().nullable(),
  scrobbles: z.number().int().nonnegative(),
  lastListenedAt: z.string().nullable(),
})
export type TrackListItem = z.infer<typeof TrackListItemSchema>

export const TrackScrobbleSourceSchema = z.object({
  artistName: z.string(),
  trackName: z.string(),
  count: z.number().int().positive(),
  strategy: TrackScrobbleLinkStrategySchema,
})

export const TrackDetailSchema = TrackListItemSchema.extend({
  listening: z.object({
    total: z.number().int().nonnegative(),
    firstListenedAt: z.string().datetime().nullable(),
    lastListenedAt: z.string().datetime().nullable(),
    /** UTC months with at least one scrobble, oldest first. */
    months: z.array(ListeningMonthSchema),
    /** Scrobbled names counted towards the track, most played first. */
    sources: z.array(TrackScrobbleSourceSchema),
  }),
})
export type TrackDetail = z.infer<typeof TrackDetailSchema>

const TrackFiltersParamSchema = z.preprocess((value) => {
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}, z.array(BrowseFilterSchema).max(100))

export const TrackQuerySchema = PaginationQuerySchema.extend({
  limitResults: z.coerce.number().int().min(1).max(10000).optional(),
  q: z.string().optional(),
  filters: TrackFiltersParamSchema,
  ranges: BrowseRangesParamSchema,
  sortBy: BrowseKeySchema.default('dateAdded'),
  direction: DirectionSchema.default('desc'),
})
export type TrackQuery = z.infer<typeof TrackQuerySchema>

export const TrackFilterOptionSchema = BrowseFilterSchema.extend({
  label: z.string(),
  count: z.number().int().positive(),
})

export const trackAlbumLinkLabels = {
  linked: 'In library',
  unlinked: 'Not in library',
}

export function getTrackBrowseValues(item: TrackListItem): BrowseValues {
  return {
    title: item.title,
    artist: item.artists,
    album: item.albumName,
    playlist: item.playlists.map((playlist) => playlist.name),
    genre: item.albumTags,
    albumLink: item.album
      ? trackAlbumLinkLabels.linked
      : trackAlbumLinkLabels.unlinked,
    releaseDate: item.releaseDate ? Date.parse(item.releaseDate) : null,
    dateAdded: item.dateAdded ? Date.parse(item.dateAdded) : null,
    durationSec: item.durationSec,
    scrobbles: item.scrobbles,
    lastListenedAt: item.lastListenedAt
      ? Date.parse(item.lastListenedAt)
      : null,
  }
}

export const PlaylistSourceSchema = z.enum(['spotify', 'spotify-liked'])
export type PlaylistSource = z.infer<typeof PlaylistSourceSchema>

export const PlaylistSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Null for a playlist that was not imported from Spotify. */
  source: PlaylistSourceSchema.nullable(),
  ownerName: z.string().nullable(),
  description: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  spotifyUrl: z.string().url().nullable(),
  importedAt: z.string().datetime().nullable(),
  trackCount: z.number().int().nonnegative(),
  /** Tracks linked to a library album. */
  linkedTrackCount: z.number().int().nonnegative(),
  /** Library albums in the playlist, directly or through a linked track. */
  albumCount: z.number().int().nonnegative(),
  durationSec: z.number().int().nonnegative(),
})
export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>

export const PlaylistRemovalSchema = z.object({
  removedTracks: z.number().int().nonnegative(),
})

/** Playlists holding tracks of one album, and those tracks. */
export const AlbumPlaylistsSchema = z.object({
  playlists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** Tracks of this album in the playlist; zero for a direct album membership. */
      trackCount: z.number().int().nonnegative(),
    }),
  ),
  tracks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      spotifyTrackId: z.string(),
      playlists: z.array(z.string()),
    }),
  ),
})
export type AlbumPlaylists = z.infer<typeof AlbumPlaylistsSchema>

export const SpotifyPlaylistImportJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  errorMessage: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export const SpotifyPlaylistStoredSchema = z.object({
  playlistId: z.string(),
  importedAt: z.string().datetime().nullable(),
  trackCount: z.number().int().nonnegative(),
})

export const SpotifyPlaylistSchema = z.object({
  spotifyId: z.string(),
  name: z.string(),
  ownerName: z.string().nullable(),
  /** Spotify returns tracks only for playlists the account owns or collaborates on. */
  importable: z.boolean(),
  trackTotal: z.number().int().nonnegative(),
  artworkUrl: z.string().url().nullable(),
  /** The stored import, when the playlist has been imported. */
  stored: SpotifyPlaylistStoredSchema.nullable(),
  /** False when Spotify reports a newer version than the stored import. */
  current: z.boolean(),
  job: SpotifyPlaylistImportJobSchema.nullable(),
})
export type SpotifyPlaylist = z.infer<typeof SpotifyPlaylistSchema>

export const SpotifyPlaylistListSchema = z.object({
  playlists: z.array(SpotifyPlaylistSchema),
  total: z.number().int().nonnegative(),
})

/** Stored import state; read without contacting Spotify. */
export const SpotifyPlaylistImportsSchema = z.object({
  likedSongs: z.object({
    stored: SpotifyPlaylistStoredSchema.nullable(),
    job: SpotifyPlaylistImportJobSchema.nullable(),
  }),
  /** The latest import job of each playlist, by Spotify playlist ID. */
  jobs: z.record(z.string(), SpotifyPlaylistImportJobSchema),
})

export const SpotifyPlaylistImportInputSchema = z
  .object({
    playlists: z
      .array(
        z
          .object({
            spotifyId: z.string().regex(/^[A-Za-z0-9]{22}$/),
            name: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    likedSongs: z.boolean().default(false),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.playlists.length > 0 || input.likedSongs, {
    message: 'Choose a playlist to import',
    path: ['playlists'],
  })
  .refine(
    (input) =>
      input.playlists.length + Number(input.likedSongs) <= 5 ||
      input.confirmBroadRun,
    {
      message: 'Confirm importing more than five playlists',
      path: ['confirmBroadRun'],
    },
  )
export type SpotifyPlaylistImportInput = z.infer<
  typeof SpotifyPlaylistImportInputSchema
>
