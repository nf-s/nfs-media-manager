import { z } from 'zod'
import { PaginatedDataSchema } from './common'
import { JobStatusSchema } from './job'
import { ManualMediaSearchResultSchema } from './manual-add'

export const LastfmSyncStateSchema = z.enum([
  'never',
  'running',
  'stopped',
  'failed',
  'complete',
])

/** `scrape_job.options.task` of the account-level job that syncs scrobbles. */
export const LASTFM_SCROBBLE_SYNC_TASK = 'lastfm-scrobble-sync'

export const LastfmSyncScheduleSchema = z.enum([
  'off',
  '10m',
  '30m',
  '1h',
  '3h',
  '6h',
  'daily',
  'weekly',
])
export const LastfmSyncSettingsSchema = z
  .object({ schedule: LastfmSyncScheduleSchema })
  .strict()

export const LastfmSyncStatusSchema = z.object({
  configured: z.boolean(),
  /** `running` covers a queued or running sync job, including the gap between chained jobs. */
  state: LastfmSyncStateSchema,
  /** The most recent sync job, whatever its status. */
  job: z
    .object({ id: z.string(), status: JobStatusSchema })
    .nullable()
    .default(null),
  schedule: LastfmSyncScheduleSchema,
  /** When the schedule will next queue a sync; null when off, unconfigured or waiting on a manual sync. */
  nextScheduledAt: z.string().datetime().nullable(),
  pagesFetched: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative().nullable(),
  newScrobbles: z.number().int().nonnegative(),
  storedScrobbles: z.number().int().nonnegative(),
  matchedScrobbles: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
  errorMessage: z.string().nullable(),
})
export const LastfmSyncInputSchema = z.object({}).strict()

export const AlbumListeningQuerySchema = z.object({
  track: z.string().min(1).max(500).optional(),
})

export const ListeningMonthSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  count: z.number().int().positive(),
})

export const ListeningTrackSchema = z.object({
  key: z.string().min(1),
  /** The recording in the album's track list, when the scrobble resolves to one. */
  trackId: z.string().min(1).optional(),
  title: z.string(),
  position: z.number().int().positive().nullable(),
  count: z.number().int().positive(),
  lastListenedAt: z.string().datetime(),
})

export const ListeningSourceSchema = z.object({
  artistName: z.string(),
  albumName: z.string(),
  count: z.number().int().positive(),
  /** Linked by the owner, not by automatic matching. */
  manual: z.boolean().default(false),
})

export const AlbumListeningSchema = z.object({
  total: z.number().int().nonnegative(),
  firstListenedAt: z.string().datetime().nullable(),
  lastListenedAt: z.string().datetime().nullable(),
  /** UTC months with at least one scrobble, oldest first. Filtered by `track` when requested. */
  months: z.array(ListeningMonthSchema),
  /** Every scrobbled track linked to the album, regardless of the `track` filter. */
  tracks: z.array(ListeningTrackSchema),
  /** Scrobbled artist and album names linked to the album, most played first. */
  sources: z.array(ListeningSourceSchema).default([]),
  /** Unlinked scrobbled names that resemble the album, most played first. */
  similarUnlinked: z.array(ListeningSourceSchema).default([]),
})

/** Days in `ListeningSeries.days`: today and the 1,826 UTC days before it. */
export const LISTENING_SERIES_DAYS = 1827

export const ListeningDaySchema = z.object({
  date: z.string().date(),
  count: z.number().int().positive(),
})

/**
 * Stored scrobbles linked to one album, track, artist or playlist, for the
 * trend chart. Days and months are UTC, like `AlbumListening.months`.
 */
export const ListeningSeriesSchema = z.object({
  total: z.number().int().nonnegative(),
  /** UTC date of the first linked scrobble. */
  firstDate: z.string().date().nullable(),
  /** UTC date of the latest linked scrobble. */
  lastDate: z.string().date().nullable(),
  /**
   * UTC date of the earliest stored scrobble of anything, linked or not:
   * where every listening chart and sparkline starts. Null with none stored.
   */
  historyFrom: z.string().date().nullable(),
  /** First day `days` covers. Days before it are only in `months`. */
  daysFrom: z.string().date(),
  /** Last day `days` covers: the UTC date when the series was read. */
  daysTo: z.string().date(),
  /** Days from `daysFrom` to `daysTo` with at least one scrobble, oldest first. */
  days: z.array(ListeningDaySchema).max(LISTENING_SERIES_DAYS),
  /** Months with at least one scrobble, all time, oldest first. */
  months: z.array(ListeningMonthSchema),
})

/**
 * Whether a scrobbled artist and album name is linked to a library album.
 * `manual`: linked by the owner. `excluded`: the owner keeps it unlinked.
 * `ambiguous`: several albums fit equally well. `unmatched`: no album fits.
 */
export const LastfmLinkReasonSchema = z.enum([
  'linked',
  'manual',
  'ambiguous',
  'unmatched',
  'excluded',
  'no-album',
])

/**
 * The rule that linked a name automatically, strictest first.
 * `exact`: same title and credited artist. `normalized`: ignoring accents,
 * punctuation and a leading "The". `edition`: ignoring edition, disc and
 * format qualifiers, or a collaborator credit. `title-tracks`: same title
 * under another artist with shared tracks. `title-prefix`: one title starts
 * with the other and tracks are shared. `tracks`: same artist and mostly
 * shared tracks under another title.
 */
export const LastfmLinkStrategySchema = z.enum([
  'exact',
  'normalized',
  'edition',
  'title-tracks',
  'title-prefix',
  'tracks',
])

export const LASTFM_SPOTIFY_SEARCH_TASK = 'lastfm-spotify-search'

export const LastfmSpotifySearchGroupSchema = z
  .object({
    artistName: z.string().trim().min(1).max(500),
    albumName: z.string().trim().min(1).max(500),
  })
  .strict()

export const LastfmSpotifySearchInputSchema = z
  .object({
    groups: z.array(LastfmSpotifySearchGroupSchema).min(1).max(100),
    batchId: z.string().min(1).max(200).optional(),
    confirmBroadRun: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.groups.length <= 5 || input.confirmBroadRun, {
    message: 'Confirm searching more than five albums',
    path: ['confirmBroadRun'],
  })

export const LastfmSpotifySearchJobSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  resultCount: z.number().int().nonnegative().nullable(),
  errorMessage: z.string().nullable(),
})

export const LastfmSpotifySearchSchema = z.object({
  job: LastfmSpotifySearchJobSchema.nullable(),
  query: z.string(),
  result: ManualMediaSearchResultSchema.nullable(),
})

export const LastfmLinkQuerySchema = z.object({
  sortBy: z
    .enum([
      'artistName',
      'albumName',
      'scrobbles',
      'lastListenedAt',
      'reason',
      'libraryAlbum',
      'spotifySearch',
    ])
    .default('scrobbles'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  reason: z.union([LastfmLinkReasonSchema, z.literal('unlinked')]).optional(),
  reasons: z
    .preprocess(
      (value) => {
        if (value === undefined) return []
        if (typeof value !== 'string') return value
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      },
      z.array(z.union([LastfmLinkReasonSchema, z.literal('unlinked')])).max(7),
    )
    .default([]),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().positive().max(100).default(50),
})

export const LastfmLinkAlbumSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
})

export const LastfmLinkGroupSchema = z.object({
  spotifySearch: LastfmSpotifySearchJobSchema.nullable().default(null),
  artistName: z.string(),
  /** Null for scrobbles Last.fm stored without an album. */
  albumName: z.string().nullable(),
  scrobbles: z.number().int().positive(),
  lastListenedAt: z.string().datetime(),
  reason: LastfmLinkReasonSchema,
  /** The linked album, for `linked` and `manual`. */
  album: LastfmLinkAlbumSchema.nullable(),
  /** The rule that linked it, for `linked`. */
  strategy: LastfmLinkStrategySchema.nullable().default(null),
  /** The equally fitting library albums, for `ambiguous`. */
  candidates: z.array(LastfmLinkAlbumSchema),
})

/**
 * Sets how one scrobbled artist and album name is linked. `link` and `unlink`
 * are kept across syncs; `auto` returns the name to automatic matching.
 */
export const LastfmLinkUpdateSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('link'),
      artistName: z.string().min(1).max(500),
      albumName: z.string().min(1).max(500),
      albumId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.enum(['unlink', 'auto']),
      artistName: z.string().min(1).max(500),
      albumName: z.string().min(1).max(500),
    })
    .strict(),
])

export const LastfmLinkSummarySchema = z.object({
  reason: LastfmLinkReasonSchema,
  groups: z.number().int().nonnegative(),
  scrobbles: z.number().int().nonnegative(),
})

export const LastfmLinkReportSchema = PaginatedDataSchema(
  LastfmLinkGroupSchema,
).extend({
  /** Totals for the whole account, regardless of the filter. */
  summary: z.array(LastfmLinkSummarySchema),
})

/**
 * Scrobbling what the player plays on Sonos rooms. It needs a Last.fm sign-in
 * of its own: the history sync reads public listening with the API key only.
 */
export const LastfmScrobblingStatusSchema = z.object({
  /** The API key and shared secret are saved in Providers. */
  configured: z.boolean(),
  connected: z.boolean(),
  /** The Last.fm account scrobbles go to; null when not connected. */
  account: z.string().nullable(),
})
export const LastfmAuthorizeInputSchema = z.object({}).strict()
export const LastfmAuthorizeResultSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
})
/** The state names the pending sign-in; it is part of the callback's path. */
export const LastfmCallbackStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** Last.fm adds the token when the account allowed the app. */
export const LastfmCallbackQuerySchema = z.object({
  token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/)
    .optional(),
})
export const LastfmDisconnectResultSchema = z.object({
  disconnected: z.literal(true),
})

const SCROBBLE_TEXT_MAX = 500
/** One track played on a Sonos room that this app loaded there. */
export const LastfmPlaySchema = z
  .object({
    trackUri: z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/),
    track: z.string().trim().min(1).max(SCROBBLE_TEXT_MAX),
    /** The first credited artist, as Spotify scrobbles a track. */
    artist: z.string().trim().min(1).max(SCROBBLE_TEXT_MAX),
    /** Empty when the album is not known. */
    album: z.string().trim().max(SCROBBLE_TEXT_MAX),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000)
      .nullable(),
    /** Clock time the track began, in milliseconds. */
    startedAt: z.number().int().nonnegative(),
  })
  .strict()
export const LASTFM_SCROBBLE_BATCH = 50
export const LastfmScrobbleInputSchema = z
  .object({
    plays: z.array(LastfmPlaySchema).min(1).max(LASTFM_SCROBBLE_BATCH),
  })
  .strict()
export const LastfmScrobbleResultSchema = z.object({
  /** False when no Last.fm account is signed in; nothing was kept then. */
  connected: z.boolean(),
  /** Plays kept to send. A play already reported, in the future or too old is not kept. */
  accepted: z.number().int().nonnegative(),
  /** Scrobbles Last.fm took in this request, including ones that had waited. */
  scrobbled: z.number().int().nonnegative(),
  /** Plays kept that Last.fm has not taken yet; they are sent with the next report. */
  waiting: z.number().int().nonnegative(),
})

export type LastfmSyncStatus = z.infer<typeof LastfmSyncStatusSchema>
export type AlbumListening = z.infer<typeof AlbumListeningSchema>
export type ListeningMonth = z.infer<typeof ListeningMonthSchema>
export type ListeningDay = z.infer<typeof ListeningDaySchema>
export type ListeningSeries = z.infer<typeof ListeningSeriesSchema>
export type ListeningTrack = z.infer<typeof ListeningTrackSchema>
export type LastfmSyncSchedule = z.infer<typeof LastfmSyncScheduleSchema>
export type LastfmLinkReason = z.infer<typeof LastfmLinkReasonSchema>
export type LastfmLinkStrategy = z.infer<typeof LastfmLinkStrategySchema>
export type LastfmLinkUpdate = z.infer<typeof LastfmLinkUpdateSchema>
export type LastfmLinkGroup = z.infer<typeof LastfmLinkGroupSchema>
export type LastfmLinkReport = z.infer<typeof LastfmLinkReportSchema>
export type ListeningSource = z.infer<typeof ListeningSourceSchema>

export type LastfmSpotifySearchInput = z.input<
  typeof LastfmSpotifySearchInputSchema
>
export type LastfmSpotifySearch = z.infer<typeof LastfmSpotifySearchSchema>
export type LastfmScrobblingStatus = z.infer<
  typeof LastfmScrobblingStatusSchema
>
export type LastfmPlay = z.infer<typeof LastfmPlaySchema>
export type LastfmScrobbleInput = z.infer<typeof LastfmScrobbleInputSchema>
export type LastfmScrobbleResult = z.infer<typeof LastfmScrobbleResultSchema>
