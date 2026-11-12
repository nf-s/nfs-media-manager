import { z } from 'zod'
import { PaginatedDataSchema } from './common'
import { JobStatusSchema } from './job'

export const LastfmSyncStateSchema = z.enum([
  'never',
  'running',
  'stopped',
  'failed',
  'complete',
])

/** `scrape_job.options.task` of the account-level job that syncs scrobbles. */
export const LASTFM_SCROBBLE_SYNC_TASK = 'lastfm-scrobble-sync'

export const LastfmSyncScheduleSchema = z.enum(['off', '6h', 'daily', 'weekly'])
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
 * Why a scrobbled artist and album name is or is not linked to a library album.
 * `pending`: exactly one album matches and it links at the next sync or relink.
 * `ambiguous`: several albums share the title and artist.
 * `artist-mismatch`: an album has the title but does not credit the artist.
 */
export const LastfmLinkReasonSchema = z.enum([
  'linked',
  'pending',
  'ambiguous',
  'artist-mismatch',
  'no-title-match',
  'no-album',
])

export const LastfmLinkQuerySchema = z.object({
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
  artistName: z.string(),
  /** Null for scrobbles Last.fm stored without an album. */
  albumName: z.string().nullable(),
  scrobbles: z.number().int().positive(),
  lastListenedAt: z.string().datetime(),
  reason: LastfmLinkReasonSchema,
  /** The linked album, or the one a `pending` group will link to. */
  album: LastfmLinkAlbumSchema.nullable(),
  /** Library albums with the same title, for `ambiguous` and `artist-mismatch`. */
  candidates: z.array(LastfmLinkAlbumSchema),
})

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
export type LastfmLinkGroup = z.infer<typeof LastfmLinkGroupSchema>
export type LastfmLinkReport = z.infer<typeof LastfmLinkReportSchema>
export type ListeningSource = z.infer<typeof ListeningSourceSchema>
