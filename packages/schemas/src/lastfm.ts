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

export type LastfmSyncStatus = z.infer<typeof LastfmSyncStatusSchema>
export type AlbumListening = z.infer<typeof AlbumListeningSchema>
export type ListeningMonth = z.infer<typeof ListeningMonthSchema>
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
