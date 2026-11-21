import { z } from 'zod'
import { TrackMatchIdSchema } from './tracks'

/** The version to separate from its record, or to show the record's row as. */
export const TrackVersionRequestSchema = z
  .object({ trackId: TrackMatchIdSchema })
  .strict()
export type TrackVersionRequest = z.infer<typeof TrackVersionRequestSchema>

export const TrackPartsParamsSchema = z.object({ id: TrackMatchIdSchema })

/**
 * What a version of a record is. `spotify`: it has its own Spotify track.
 * `album`: it is on an album track list. `lastfm`: it is made of scrobbled
 * names only.
 */
export const TrackPartTypeSchema = z.enum(['spotify', 'album', 'lastfm'])
export type TrackPartType = z.infer<typeof TrackPartTypeSchema>

/** One track of a record. */
export const TrackPartVersionSchema = z.object({
  id: z.string(),
  title: z.string(),
  by: z.string(),
  type: TrackPartTypeSchema,
  album: z.object({ id: z.string(), title: z.string() }).nullable(),
  /** The album name Spotify or Last.fm gave, when no library album is linked. */
  albumName: z.string().nullable(),
  durationSec: z.number().int().positive().nullable(),
  /** Scrobbles of the names this version owns. */
  scrobbles: z.number().int().nonnegative(),
  /** The record's row is shown as this version. */
  shown: z.boolean(),
})
export type TrackPartVersion = z.infer<typeof TrackPartVersionSchema>

/** A scrobbled name owned by one version of the record. */
export const TrackPartNameSchema = z.object({
  /** The version that owns the name. */
  trackId: z.string(),
  artistKey: z.string(),
  trackKey: z.string(),
  artistName: z.string(),
  trackName: z.string(),
  scrobbles: z.number().int().nonnegative(),
  /** The owner chose this version for the name. */
  manuallyMatched: z.boolean(),
})
export type TrackPartName = z.infer<typeof TrackPartNameSchema>

/** What the record of a track is made of: its versions and their names. */
export const TrackPartsSchema = z.object({
  /** The version the record's row is shown as. */
  shownId: z.string(),
  /**
   * The versions were joined by hand, or a version kept apart. False when
   * they are worked out from shared recording codes.
   */
  stored: z.boolean(),
  /** Scrobbles of the record, each counted once. */
  scrobbles: z.number().int().nonnegative(),
  versions: z.array(TrackPartVersionSchema),
  /** Most played first. */
  names: z.array(TrackPartNameSchema),
})
export type TrackParts = z.infer<typeof TrackPartsSchema>

export const AlbumUnlistedNamesParamsSchema = z.object({
  id: z.string().trim().min(1).max(200),
})

/** A name scrobbled under an album whose track is not on its track list. */
export const AlbumUnlistedNameSchema = z.object({
  /** The track that owns the name; selecting the row selects it. */
  trackId: z.string(),
  artistKey: z.string(),
  trackKey: z.string(),
  artistName: z.string(),
  trackName: z.string(),
  /** Scrobbles of the name under this album. */
  scrobbles: z.number().int().nonnegative(),
})
export type AlbumUnlistedName = z.infer<typeof AlbumUnlistedNameSchema>

/** At most 100, most played first. */
export const AlbumUnlistedNamesSchema = z.object({
  names: z.array(AlbumUnlistedNameSchema).max(100),
})
export type AlbumUnlistedNames = z.infer<typeof AlbumUnlistedNamesSchema>
