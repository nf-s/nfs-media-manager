import { z } from 'zod'
import { musicDisplayTags } from './music-tags'
import { CamelotKeySchema } from './musical-keys'
import {
  BrowseFilterSchema,
  BrowseKeySchema,
  BrowsePageSliceSchema,
  BrowseRangesParamSchema,
  type BrowseValues,
} from './browse'
import {
  CreatorIdSchema,
  DirectionSchema,
  PaginatedDataSchema,
  PaginationQuerySchema,
} from './common'
import { JobProgressSchema, JobStatusSchema } from './job'
import { ListeningMonthSchema } from './lastfm'
import {
  ListeningFilterParamSchema,
  ListeningHistogramPeriodParamSchema,
  ListeningPeriodParamSchema,
} from './listening'
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
 * `album-track-list`: the track is on the album's stored track list.
 */
export const TrackAlbumLinkStrategySchema = z.enum([
  'album-track-list',
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
 * the track's album and the titles match without qualifiers. `manual`: an
 * explicit identity choice overrides automatic attribution for those names.
 * `record`: the name is owned by another version of the track's record.
 */
export const TrackScrobbleLinkStrategySchema = z.enum([
  'manual',
  'exact',
  'normalized',
  'version',
  'album',
  'record',
])
export type TrackScrobbleLinkStrategy = z.infer<
  typeof TrackScrobbleLinkStrategySchema
>

export const TrackPlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
})

export const TrackSourceSchema = z.enum([
  'album',
  'lastfm',
  'spotify',
  'spotify-liked',
  'spotify-search',
])
export type TrackSource = z.infer<typeof TrackSourceSchema>
export const trackSourceLabels: Record<TrackSource, string> = {
  album: 'Album track list',
  lastfm: 'Last.fm',
  spotify: 'Spotify playlists',
  'spotify-liked': 'Liked Songs',
  'spotify-search': 'Spotify track search',
}

/** Where the current Spotify identity comes from, independent of membership. */
export const TrackSpotifyMatchSchema = z.enum([
  'spotify-import',
  'spotify-search',
  'album-track-list',
  'unmatched',
])
export type TrackSpotifyMatch = z.infer<typeof TrackSpotifyMatchSchema>
export const trackSpotifyMatchLabels: Record<TrackSpotifyMatch, string> = {
  'spotify-import': 'Spotify playlist / Liked Songs',
  'spotify-search': 'Spotify track search',
  'album-track-list': 'Album track list',
  unmatched: 'Unmatched',
}

export function isImportedSpotifyMatch(match: TrackSpotifyMatch) {
  return match === 'spotify-import' || match === 'spotify-search'
}

export const TrackListItemSchema = z.object({
  id: z.string(),
  mediaType: z.literal('track'),
  title: z.string(),
  artworkUrl: z.string().url().nullable(),
  releaseDate: z.string().nullable(),
  artists: z.array(z.string()),
  artistCredits: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .default([]),
  /** The reported album name, whether or not it is in the library. */
  albumName: z.string().nullable(),
  /** The linked library album. */
  album: z.object({ id: z.string(), title: z.string() }).nullable(),
  albumLinkStrategy: TrackAlbumLinkStrategySchema.nullable(),
  /** Tags of the linked library album. */
  albumTags: z.array(z.string()),
  artistTags: z.array(z.string()).default([]),
  playlists: z.array(TrackPlaylistSchema),
  sources: z.array(TrackSourceSchema).default([]),
  durationSec: z.number().int().nonnegative().nullable(),
  /** Tempo in BPM from a verified provider record. */
  bpm: z.number().positive().nullable().default(null),
  /** Key from a verified provider record, as a Camelot key. */
  musicalKey: CamelotKeySchema.nullable().default(null),
  dateAdded: z.string().nullable(),
  spotifyTrackId: z.string().nullable(),
  /** Required evidence for the effective ID; never inferred from listening links. */
  spotifyMatch: TrackSpotifyMatchSchema,
  spotifyUrl: z.string().url().nullable(),
  isrc: z.string().nullable(),
  scrobbles: z.number().int().nonnegative(),
  /** Scrobbles in the requested sort period; only when one was asked for. */
  listeningScrobbles: z.number().int().nonnegative().optional(),
  lastListenedAt: z.string().nullable(),
  /** Matching release versions represented by this grouped Browse row. */
  recordingGroup: z
    .object({ versionCount: z.number().int().min(2) })
    .optional(),
})
export type TrackListItem = z.infer<typeof TrackListItemSchema>

export const TrackSpotifyAlternateSchema = z.object({
  trackId: z.string(),
  name: z.string(),
  albumName: z.string().nullable(),
  album: TrackListItemSchema.shape.album.optional(),
  artworkUrl: TrackListItemSchema.shape.artworkUrl.optional(),
  identifier: z.string(),
})
export type TrackSpotifyAlternate = z.infer<typeof TrackSpotifyAlternateSchema>

const RecordedScrobbleKeySchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (key) => key === key.trim() && !key.includes('\0'),
    'Invalid recorded name key',
  )

export const TrackScrobbleNameKeySchema = z
  .object({
    artistKey: RecordedScrobbleKeySchema,
    trackKey: RecordedScrobbleKeySchema,
  })
  .strict()
export type TrackScrobbleNameKey = z.infer<typeof TrackScrobbleNameKeySchema>

// Stored name keys can predate the mutation input limits.
const TrackScrobbleNameSchema = z.object({
  artistKey: z.string(),
  trackKey: z.string(),
  artistName: z.string(),
  trackName: z.string(),
  count: z.number().int().positive(),
})

export const TrackScrobbleSourceSchema = TrackScrobbleNameSchema.extend({
  strategy: TrackScrobbleLinkStrategySchema,
})

export const TrackLastfmSourceSchema = TrackScrobbleNameSchema.extend({
  /** Distinct recorded album names; empty when no album name was supplied. */
  albumNames: z.array(z.string()),
  /** Includes an explicit owner choice for this library identity. */
  manuallyMatched: z.boolean(),
  /** The owner chose to keep this recorded name on its own Last.fm track. */
  keptSeparate: z.boolean(),
})

export const TrackScrobbleNamesQuerySchema = PaginationQuerySchema.extend({
  q: z
    .string()
    .trim()
    .max(200)
    .refine((query) => !query.includes('\0'), 'Invalid search')
    .optional(),
  size: PaginationQuerySchema.shape.size.default(25),
})
export type TrackScrobbleNamesQuery = z.infer<
  typeof TrackScrobbleNamesQuerySchema
>
const TrackScrobbledNameSchema = TrackLastfmSourceSchema.extend({
  trackId: z.string(),
})
export type TrackScrobbledName = z.infer<typeof TrackScrobbledNameSchema>
export const TrackScrobbleNamesPageSchema = PaginatedDataSchema(
  TrackScrobbledNameSchema,
)
export type TrackScrobbleNamesPage = z.infer<
  typeof TrackScrobbleNamesPageSchema
>

export const TrackMatchIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((id) => !id.includes('\0'), 'Invalid track ID')

export const TrackMergeInputSchema = z
  .object({ targetId: TrackMatchIdSchema, namesOnly: z.boolean().optional() })
  .strict()
export type TrackMergeInput = z.infer<typeof TrackMergeInputSchema>
export const TrackMergeResultSchema = z.object({
  targetId: z.string().min(1),
  /** The source track was removed after its Last.fm names were moved. */
  sourceRemoved: z.literal(true).optional(),
  /** The recorded library change, when the action moved a name. */
  changeId: z.string().optional(),
})
export type TrackMergeResult = z.infer<typeof TrackMergeResultSchema>

export const TrackScrobbleMatchInputSchema = TrackScrobbleNameKeySchema.extend({
  targetId: TrackMatchIdSchema,
})
export type TrackScrobbleMatchInput = z.infer<
  typeof TrackScrobbleMatchInputSchema
>

export const TrackScrobbleRemoveInputSchema = TrackScrobbleNameKeySchema.extend(
  {
    mode: z.enum(['separate', 'automatic']).default('separate'),
  },
)
export type TrackScrobbleRemoveInput = z.infer<
  typeof TrackScrobbleRemoveInputSchema
>

/** An ISRC recorded for a track and the services that reported it. */
export const TrackIsrcSchema = z.object({
  isrc: z.string(),
  providers: z.array(z.string()),
})
export type TrackIsrc = z.infer<typeof TrackIsrcSchema>

/** Tempo and key one provider reported for a track. */
export const TrackFactSchema = z.object({
  provider: z.string(),
  bpm: z.number().positive().nullable(),
  keyCamelot: z.string().nullable(),
  keyMusical: z.string().nullable(),
  keyOpen: z.string().nullable(),
  /** False when the record's title or duration did not agree with the track: it may describe another version. */
  verified: z.boolean(),
  fetchedAt: z.string().datetime(),
})
export type TrackFact = z.infer<typeof TrackFactSchema>

export const TrackDetailSchema = TrackListItemSchema.extend({
  /** Playback coverage from a confirmed version when this entry has no usable Spotify ID. */
  spotifyAlternate: TrackSpotifyAlternateSchema.optional(),
  /** Recorded names with strict Last.fm membership, most played first, up to 50. */
  lastfmSources: z.array(TrackLastfmSourceSchema),
  /** The Spotify album the track was imported from, whether or not it is in the library. */
  spotifyAlbumId: z.string().nullable(),
  /**
   * Library albums that scrobbles counted towards the track are linked to but
   * that hold neither the track nor a version of it, most scrobbles first, up to 5.
   */
  scrobbledAlbums: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      scrobbles: z.number().int().positive(),
    }),
  ),
  /** Every ISRC recorded for the track, in code order. */
  isrcs: z.array(TrackIsrcSchema),
  /** Tempo and key by provider, verified records first. */
  facts: z.array(TrackFactSchema).default([]),
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

const TrackFiltersParamSchema = z.preprocess(
  (value) => {
    if (Array.isArray(value)) return value
    if (typeof value !== 'string' || value.length === 0) return []
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  },
  z
    .array(BrowseFilterSchema)
    .max(100)
    .transform((filters) =>
      filters.map((filter) =>
        filter.field === 'spotifyMatch' &&
        filter.value.toLowerCase() === 'spotify import'
          ? { ...filter, value: trackSpotifyMatchLabels['spotify-import'] }
          : filter,
      ),
    ),
)

export const TrackQuerySchema = PaginationQuerySchema.extend({
  creatorId: CreatorIdSchema.optional(),
  groupRecordings: z
    .union([
      z.boolean(),
      z.enum(['true', 'false']).transform((value) => value === 'true'),
    ])
    .optional(),
  limitResults: z.coerce.number().int().min(1).max(10000).optional(),
  q: z.string().optional(),
  filters: TrackFiltersParamSchema,
  ranges: BrowseRangesParamSchema,
  listening: ListeningFilterParamSchema,
  listeningSort: ListeningPeriodParamSchema,
  sortBy: BrowseKeySchema.default('dateAdded'),
  direction: DirectionSchema.default('desc'),
})
export type TrackQuery = z.infer<typeof TrackQuerySchema>

/** A track browse query and the period its listening histogram counts over. */
export const TrackListeningHistogramQuerySchema = TrackQuerySchema.extend({
  period: ListeningHistogramPeriodParamSchema,
})
export type TrackListeningHistogramQuery = z.infer<
  typeof TrackListeningHistogramQuerySchema
>

export const TRACK_POSITIONS_MAX = 50
/**
 * Zero-based positions in a track query's order, comma-separated. Shuffled
 * playback reads tracks spread over a list this way instead of a page each.
 */
export const TrackPositionsQuerySchema = TrackQuerySchema.extend({
  positions: z
    .string()
    .regex(/^\d{1,7}(,\d{1,7})*$/)
    .transform((value) => [...new Set(value.split(',').map(Number))])
    .pipe(z.array(z.number().int().nonnegative()).max(TRACK_POSITIONS_MAX)),
})
export type TrackPositionsQuery = z.infer<typeof TrackPositionsQuerySchema>

export const TrackPositionsSchema = z.object({
  items: z.array(
    z.object({
      position: z.number().int().nonnegative(),
      item: TrackListItemSchema,
    }),
  ),
})

export const TrackFilterOptionSchema = BrowseFilterSchema.extend({
  label: z.string(),
  count: z.number().int().positive(),
  // Visible tags beneath a tag value; the count covers them too.
  subtags: z.number().int().positive().optional(),
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
    spotifyMatch: trackSpotifyMatchLabels[item.spotifyMatch],
    genre: musicDisplayTags(item.albumTags, item.artistTags).map(
      (tag) => tag.name,
    ),
    albumTag: item.albumTags,
    artistTag: item.artistTags,
    albumLink: item.album
      ? trackAlbumLinkLabels.linked
      : trackAlbumLinkLabels.unlinked,
    releaseDate: item.releaseDate ? Date.parse(item.releaseDate) : null,
    dateAdded: item.dateAdded ? Date.parse(item.dateAdded) : null,
    durationSec: item.durationSec,
    bpm: item.bpm,
    musicalKey: item.musicalKey,
    scrobbles: item.scrobbles,
    listeningScrobbles: item.listeningScrobbles ?? null,
    lastListenedAt: item.lastListenedAt
      ? Date.parse(item.lastListenedAt)
      : null,
  }
}

export const PlaylistSourceSchema = z.enum(['spotify', 'spotify-liked'])
export type PlaylistSource = z.infer<typeof PlaylistSourceSchema>

export const PlaylistPresentationSchema = z.enum(['albums', 'tracks'])
export type PlaylistPresentation = z.infer<typeof PlaylistPresentationSchema>

export const UpdatePlaylistPresentationSchema = z
  .object({ presentation: PlaylistPresentationSchema.nullable() })
  .strict()

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
  /** Default view after applying the saved override, if any. */
  presentation: PlaylistPresentationSchema.default('tracks'),
  /** Null follows automatic detection. */
  presentationOverride: PlaylistPresentationSchema.nullable().default(null),
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

export const PlaylistBrowseSortSchema = z.enum([
  'name',
  'source',
  'owner',
  'tracks',
  'linkedTracks',
  'albums',
  'duration',
  'imported',
  'schedule',
  'checked',
  'added',
  'description',
  'nextSync',
])
export type PlaylistBrowseSort = z.infer<typeof PlaylistBrowseSortSchema>

function readJsonQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export const PlaylistBrowseQuerySchema = PaginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  name: z.string().trim().max(200).optional(),
  size: PaginationQuerySchema.shape.size.default(100),
  sortBy: PlaylistBrowseSortSchema.default('name'),
  direction: DirectionSchema.default('asc'),
  sources: z.preprocess(
    readJsonQuery,
    z
      .array(z.enum(['library', ...PlaylistSourceSchema.options]))
      .max(3)
      .optional(),
  ),
  ids: z.preprocess(
    readJsonQuery,
    z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
  ),
  acceptsAdditions: z.enum(['true', 'false']).optional(),
})
export type PlaylistBrowseQuery = z.infer<typeof PlaylistBrowseQuerySchema>

export const PlaylistBrowsePageSchema = BrowsePageSliceSchema(
  PlaylistSummarySchema,
)
export type PlaylistBrowsePage = z.infer<typeof PlaylistBrowsePageSchema>

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
  'source',
  'spotifyMatch',
  'kind',
])
export type PlaylistEntrySort = z.infer<typeof PlaylistEntrySortSchema>

const PlaylistKindsParamSchema = z.preprocess(
  readJsonQuery,
  z
    .array(z.enum(['track', 'album']))
    .max(2)
    .transform((values) => [...new Set(values)])
    .optional(),
)

export const PlaylistDetailQuerySchema = PaginationQuerySchema.extend({
  /** Collapse library album memberships to one entry per album. */
  groupBy: z.literal('album').optional(),
  q: z.string().trim().max(200).optional(),
  kind: z.enum(['track', 'album']).optional(),
  kinds: PlaylistKindsParamSchema,
  sortBy: PlaylistEntrySortSchema.default('position'),
  direction: DirectionSchema.default('asc'),
  size: z.coerce.number().int().positive().max(100).default(100),
})
export type PlaylistDetailQuery = z.infer<typeof PlaylistDetailQuerySchema>

/** A library album represented in a playlist. */
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

export const SpotifyPlaylistStoredMetadataSchema = PlaylistSummarySchema.pick({
  id: true,
  createdAt: true,
  linkedTrackCount: true,
  albumCount: true,
  durationSec: true,
  description: true,
}).extend({ sync: PlaylistSyncSchema.omit({ job: true }) })
export type SpotifyPlaylistStoredMetadata = z.infer<
  typeof SpotifyPlaylistStoredMetadataSchema
>

export const SpotifyPlaylistStoredSchema = z.object({
  playlistId: z.string(),
  importedAt: z.string().datetime().nullable(),
  trackCount: z.number().int().nonnegative(),
  summary: SpotifyPlaylistStoredMetadataSchema.optional(),
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
