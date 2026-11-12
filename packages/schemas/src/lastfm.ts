import { z } from 'zod'

export const LastfmSyncStateSchema = z.enum([
  'never',
  'running',
  'stopped',
  'failed',
  'complete',
])

export const LastfmSyncStatusSchema = z.object({
  configured: z.boolean(),
  state: LastfmSyncStateSchema,
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

export const AlbumListeningSchema = z.object({
  total: z.number().int().nonnegative(),
  firstListenedAt: z.string().datetime().nullable(),
  lastListenedAt: z.string().datetime().nullable(),
  /** UTC months with at least one scrobble, oldest first. Filtered by `track` when requested. */
  months: z.array(ListeningMonthSchema),
  /** Every scrobbled track linked to the album, regardless of the `track` filter. */
  tracks: z.array(ListeningTrackSchema),
})

export type LastfmSyncStatus = z.infer<typeof LastfmSyncStatusSchema>
export type AlbumListening = z.infer<typeof AlbumListeningSchema>
export type ListeningMonth = z.infer<typeof ListeningMonthSchema>
export type ListeningTrack = z.infer<typeof ListeningTrackSchema>
