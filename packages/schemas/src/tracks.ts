import { z } from 'zod'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowseRangesParamSchema,
  type BrowseValues,
} from './browse'
import {
  DirectionSchema,
  PaginatedDataSchema,
  PaginationQuerySchema,
} from './common'
import { JobProgressSchema, JobStatusSchema } from './job'
import { ListeningMonthSchema } from './lastfm'
import { YoutubeSyncScheduleSchema } from './youtube'

/** `scrape_job.options.task` of the job that imports one Spotify playlist. */
export const SPOTIFY_PLAYLIST_IMPORT_TASK = 'spotify-playlist-import'

/** `scrape_job.options.task` of the job that reads the account's playlist list. */
export const SPOTIFY_PLAYLIST_LISTING_TASK = 'spotify-playlist-listing'

/** `scrape_job.options.task` of the job that adds one album to one Spotify playlist. */
export const SPOTIFY_PLAYLIST_ADD_ALBUM_TASK = 'spotify-playlist-add-album'

/** Spotify returns at most this many items for one playlist. */
export const SPOTIFY_PLAYLIST_ITEM_LIMIT = 10000

/** Entries per page when the playlist list or a playlist's tracks are read. */
export const SPOTIFY_PLAYLIST_PAGE_SIZE = 50

/** The YouTube and Last.fm schedule options; a playlist's schedule defaults to off. */
export const PlaylistSyncScheduleSchema = YoutubeSyncScheduleSchema
export type PlaylistSyncSchedule = z.infer<typeof PlaylistSyncScheduleSchema>
export const PlaylistSyncSettingsSchema = z
  .object({ schedule: PlaylistSyncScheduleSchema })
  .strict()

/** The latest job of a playlist task, with its progress while it reads. */
export const SpotifyPlaylistJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  errorMessage: z.string().nullable(),
  finishedAt: z.string().nullable(),
  progress: JobProgressSchema.nullable().default(null),
})
export type SpotifyPlaylistJob = z.infer<typeof SpotifyPlaylistJobSchema>

/** A playlist's scheduled import. */
export const PlaylistSyncSchema = z.object({
  /** Imported Spotify playlists and Liked Songs can be synced; legacy-only playlists cannot. */
  syncable: z.boolean(),
  schedule: PlaylistSyncScheduleSchema,
  /** The last completed import, including one that found the playlist unchanged. */
  lastCheckedAt: z.string().datetime().nullable(),
  /** When the schedule will next queue an import; null when off, active, or after a failed or cancelled import. */
  nextScheduledAt: z.string().datetime().nullable(),
  /** The latest import job, whatever its status. */
  job: SpotifyPlaylistJobSchema.nullable(),
})
export type PlaylistSync = z.infer<typeof PlaylistSyncSchema>

/**
 * How a track was linked to a library album, strictest first.
 * `spotify-album`: the album has the track's Spotify album ID.
 * `spotify-track`: the album's track list has the track's Spotify ID.
 * `album-title`: same album title and a credited artist.
 * `artist-title`: a credited artist's album lists a track with the same title.
 * `lastfm`: the scrobbled album names consistently link to this library album.
 */
export const TrackAlbumLinkStrategySchema = z.enum([
  'lastfm',
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

export const TrackSourceSchema = z.enum(['lastfm', 'spotify', 'spotify-liked'])
export type TrackSource = z.infer<typeof TrackSourceSchema>
export const trackSourceLabels: Record<TrackSource, string> = {
  lastfm: 'Last.fm',
  spotify: 'Spotify playlists',
  'spotify-liked': 'Liked Songs',
}

export const TrackListItemSchema = z.object({
  id: z.string(),
  mediaType: z.literal('track'),
  title: z.string(),
  artworkUrl: z.string().url().nullable(),
  releaseDate: z.string().nullable(),
  artists: z.array(z.string()),
  /** The reported album name, whether or not it is in the library. */
  albumName: z.string().nullable(),
  /** The linked library album. */
  album: z.object({ id: z.string(), title: z.string() }).nullable(),
  albumLinkStrategy: TrackAlbumLinkStrategySchema.nullable(),
  /** Tags of the linked library album. */
  albumTags: z.array(z.string()),
  playlists: z.array(TrackPlaylistSchema),
  sources: z.array(TrackSourceSchema).default([]),
  durationSec: z.number().int().nonnegative().nullable(),
  dateAdded: z.string().nullable(),
  spotifyTrackId: z.string().nullable(),
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
    source: item.sources.map((source) => trackSourceLabels[source]),
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
  /** When this playlist was first added to this library, not saved on Spotify. */
  createdAt: z.string().datetime().nullable().default(null),
  id: z.string(),
  name: z.string(),
  /** Null for a playlist that was not imported from Spotify. */
  source: PlaylistSourceSchema.nullable(),
  ownerName: z.string().nullable(),
  description: z.string().nullable(),
  artworkUrl: z.string().url().nullable(),
  spotifyUrl: z.string().url().nullable(),
  /** When the contents were last read from Spotify and stored. */
  importedAt: z.string().datetime().nullable(),
  trackCount: z.number().int().nonnegative(),
  /** Tracks linked to a library album. */
  linkedTrackCount: z.number().int().nonnegative(),
  /** Library albums in the playlist, directly or through a linked track. */
  albumCount: z.number().int().nonnegative(),
  durationSec: z.number().int().nonnegative(),
  /** An imported Spotify playlist the account owns or collaborates on; albums can be added to it. */
  acceptsAdditions: z.boolean().default(false),
  sync: PlaylistSyncSchema.default({
    syncable: false,
    schedule: 'off',
    lastCheckedAt: null,
    nextScheduledAt: null,
    job: null,
  }),
})
export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>

export const PlaylistRemovalSchema = z.object({
  removedTracks: z.number().int().nonnegative(),
})

export const PlaylistEntrySortSchema = z.enum([
  'position',
  'title',
  'artists',
  'album',
  'duration',
  'added',
  'releaseDate',
  'scrobbles',
  'lastListened',
  'kind',
])
export type PlaylistEntrySort = z.infer<typeof PlaylistEntrySortSchema>

export const PlaylistDetailQuerySchema = PaginationQuerySchema.extend({
  sortBy: PlaylistEntrySortSchema.default('position'),
  direction: DirectionSchema.default('asc'),
  size: z.coerce.number().int().positive().max(100).default(100),
})
export type PlaylistDetailQuery = z.infer<typeof PlaylistDetailQuerySchema>

/** An album member of a playlist from the legacy album import. */
export const PlaylistAlbumSchema = z.object({
  id: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  artworkUrl: z.string().nullable(),
  releaseDate: z.string().nullable(),
  spotifyUrl: z.string().nullable(),
})
export type PlaylistAlbum = z.infer<typeof PlaylistAlbumSchema>

/** One playlist entry: tracks in playlist order, then legacy album members. */
export const PlaylistEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('track'),
    position: z.number().int().nonnegative(),
    addedAt: z.string().datetime().nullable(),
    track: TrackListItemSchema,
  }),
  z.object({
    kind: z.literal('album'),
    position: z.number().int().nonnegative(),
    addedAt: z.string().datetime().nullable(),
    album: PlaylistAlbumSchema,
  }),
])
export type PlaylistEntry = z.infer<typeof PlaylistEntrySchema>

export const PlaylistDetailSchema = PlaylistSummarySchema.extend({
  items: PaginatedDataSchema(PlaylistEntrySchema),
})
export type PlaylistDetail = z.infer<typeof PlaylistDetailSchema>

export const PlaylistAlbumAdditionInputSchema = z
  .object({ albumId: z.string().min(1).max(200) })
  .strict()
export const PlaylistAlbumAdditionsQuerySchema = z.object({
  albumId: z.string().min(1).max(200),
})

/** The latest job adding an album to one playlist. */
export const PlaylistAlbumAdditionSchema = z.object({
  playlistId: z.string(),
  albumId: z.string(),
  job: SpotifyPlaylistJobSchema,
})
export type PlaylistAlbumAddition = z.infer<typeof PlaylistAlbumAdditionSchema>

export const PlaylistAlbumAdditionsSchema = z.object({
  additions: z.array(PlaylistAlbumAdditionSchema),
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
      spotifyTrackId: z.string().nullable(),
      playlists: z.array(z.string()),
    }),
  ),
})
export type AlbumPlaylists = z.infer<typeof AlbumPlaylistsSchema>

export const SpotifyPlaylistImportJobSchema = SpotifyPlaylistJobSchema

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
  /** Why the playlist cannot be imported: not owned or shared, or over the item limit. */
  notImportableReason: z.string().nullable().default(null),
  trackTotal: z.number().int().nonnegative(),
  artworkUrl: z.string().url().nullable(),
  spotifyUrl: z.string().url().nullable().default(null),
  /** The stored import, when the playlist has been imported. */
  stored: SpotifyPlaylistStoredSchema.nullable(),
  /** False when the listing reports a newer version than the stored import. */
  current: z.boolean(),
  /** The latest import job. */
  job: SpotifyPlaylistImportJobSchema.nullable(),
})
export type SpotifyPlaylist = z.infer<typeof SpotifyPlaylistSchema>

/** The stored playlist list; read without contacting Spotify. */
export const SpotifyPlaylistListSchema = z.object({
  playlists: z.array(SpotifyPlaylistSchema),
  total: z.number().int().nonnegative(),
  /** When the listing job last completed; null before the first listing. */
  listedAt: z.string().datetime().nullable().default(null),
  /** The latest listing job, with its progress while it runs. */
  job: SpotifyPlaylistJobSchema.nullable().default(null),
})
export type SpotifyPlaylistList = z.infer<typeof SpotifyPlaylistListSchema>

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
