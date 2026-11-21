import { z } from 'zod'
import { TrackMatchIdSchema } from './tracks'

/** A scrobbled artist and album name, as Last.fm recorded it. */
export const AlbumNameRefSchema = z
  .object({
    artistName: z.string().min(1).max(500),
    albumName: z.string().min(1).max(500),
  })
  .strict()
export type AlbumNameRef = z.infer<typeof AlbumNameRefSchema>

const AlbumMergeSelectionSchema = z.object({
  albumIds: z.array(TrackMatchIdSchema).min(1).max(50),
  /** The album to keep. Chosen by the server when omitted. */
  targetId: TrackMatchIdSchema.optional(),
  /** Scrobbled album names to bring into the album to keep. */
  names: z.array(AlbumNameRefSchema).max(50).default([]),
  /**
   * The track names scrobbled under a moved album name move to the matching
   * tracks of the album to keep.
   */
  follow: z.boolean().default(true),
})
type AlbumMergeSelection = z.infer<typeof AlbumMergeSelectionSchema>
const selectedOnce = ({ albumIds }: AlbumMergeSelection) =>
  new Set(albumIds).size === albumIds.length
const targetSelected = ({ albumIds, targetId }: AlbumMergeSelection) =>
  targetId === undefined || albumIds.includes(targetId)
const twoParts = ({ albumIds, names }: AlbumMergeSelection) =>
  albumIds.length + names.length > 1
const SELECTED_ONCE = 'Each album can be selected once'
const TARGET_SELECTED = 'The album to keep must be one of the selected albums'
const TWO_PARTS = 'Select two albums, or an album and an album name'

export const AlbumMergePlanRequestSchema = AlbumMergeSelectionSchema.strict()
  .refine(selectedOnce, SELECTED_ONCE)
  .refine(targetSelected, TARGET_SELECTED)
  .refine(twoParts, TWO_PARTS)
export type AlbumMergePlanRequest = z.infer<typeof AlbumMergePlanRequestSchema>

export const AlbumMergeRequestSchema = AlbumMergeSelectionSchema.extend({
  /** The owner has seen the plan. Required when the plan has cautions. */
  reviewed: z.boolean().default(false),
})
  .strict()
  .refine(selectedOnce, SELECTED_ONCE)
  .refine(targetSelected, TARGET_SELECTED)
  .refine(twoParts, TWO_PARTS)
export type AlbumMergeRequest = z.infer<typeof AlbumMergeRequestSchema>

const AlbumNameMoveSelectionSchema = AlbumNameRefSchema.extend({
  /** The album the name moves to. */
  albumId: TrackMatchIdSchema,
  follow: z.boolean().default(true),
})
export const AlbumNameMovePlanRequestSchema =
  AlbumNameMoveSelectionSchema.strict()
export type AlbumNameMovePlanRequest = z.infer<
  typeof AlbumNameMovePlanRequestSchema
>
export const AlbumNameMoveRequestSchema = AlbumNameMoveSelectionSchema.extend({
  reviewed: z.boolean().default(false),
}).strict()
export type AlbumNameMoveRequest = z.infer<typeof AlbumNameMoveRequestSchema>

export const AlbumSeparateRequestSchema = z
  .object({ albumId: TrackMatchIdSchema })
  .strict()
export type AlbumSeparateRequest = z.infer<typeof AlbumSeparateRequestSchema>

export const AlbumMergePlanAlbumSchema = z.object({
  id: z.string(),
  title: z.string(),
  by: z.string(),
  releaseDate: z.string().nullable(),
  trackCount: z.number().int().nonnegative(),
  /** Scrobbles linked to this album itself, without its editions. */
  scrobbles: z.number().int().nonnegative(),
  /** The album has a Spotify album ID. */
  spotify: z.boolean(),
  /** The first album of its record before the merge; null for a first album. */
  editionOfId: z.string().nullable(),
  /** Selected by the owner, rather than brought along as an edition. */
  selected: z.boolean(),
})
export type AlbumMergePlanAlbum = z.infer<typeof AlbumMergePlanAlbumSchema>

/** An album that becomes, or moves to be, an edition of the album to keep. */
export const AlbumMergePlanEditionSchema = z.object({
  albumId: z.string(),
  /** Its first album before the merge; null when it was one. */
  fromId: z.string().nullable(),
})

export const AlbumMergePlanNameSchema = z.object({
  artistName: z.string(),
  albumName: z.string(),
  scrobbles: z.number().int().nonnegative(),
  /** The album the name is linked to now. */
  albumId: z.string().nullable(),
})
export type AlbumMergePlanName = z.infer<typeof AlbumMergePlanNameSchema>

/** A track name that follows its album name to a track of the album to keep. */
export const AlbumMergeFollowSchema = z.object({
  artistName: z.string(),
  trackName: z.string(),
  /** Every scrobble of the name, under any album name. */
  scrobbles: z.number().int().nonnegative(),
  fromTrackId: z.string(),
  toTrackId: z.string(),
  toTitle: z.string(),
})
export type AlbumMergeFollow = z.infer<typeof AlbumMergeFollowSchema>

/** A track name scrobbled under a moved album name that stays on its track. */
export const AlbumMergeUnmatchedSchema = z.object({
  artistName: z.string(),
  trackName: z.string(),
  scrobbles: z.number().int().nonnegative(),
  trackId: z.string(),
})
export type AlbumMergeUnmatched = z.infer<typeof AlbumMergeUnmatchedSchema>

/** Evidence against a merge. Any caution opens the review before merging. */
export const AlbumMergeCautionSchema = z.discriminatedUnion('code', [
  /** A version word, such as Deluxe or Live, is in some titles only. */
  z.object({ code: z.literal('version'), words: z.array(z.string()).min(1) }),
  /** The albums, or a scrobbled name, are credited to different artists. */
  z.object({ code: z.literal('artists'), names: z.array(z.string()).min(2) }),
  /**
   * Fewer than half the titles of the shorter track list are on the other.
   * `shared` of `listed` titles of the shorter list match.
   */
  z.object({
    code: z.literal('tracks'),
    albums: z
      .array(
        z.object({
          albumId: z.string(),
          shared: z.number().int().nonnegative(),
          listed: z.number().int().positive(),
        }),
      )
      .min(1),
  }),
  /** Track names that would follow are now on a track of another album. */
  z.object({
    code: z.literal('elsewhere'),
    count: z.number().int().positive(),
    names: z
      .array(
        z.object({
          artistName: z.string(),
          trackName: z.string(),
          albumTitle: z.string(),
        }),
      )
      .max(5),
  }),
  /** The owner chose to keep some of these albums separate. */
  z.object({
    code: z.literal('separate'),
    albumIds: z.array(z.string()).min(2),
  }),
])
export type AlbumMergeCaution = z.infer<typeof AlbumMergeCautionSchema>

/**
 * Why the selection cannot be merged: an album was removed from the library
 * by a legacy import, or the albums are one record already and no name moves.
 */
export const AlbumMergeBlockSchema = z.enum(['hidden', 'same-record'])
export type AlbumMergeBlock = z.infer<typeof AlbumMergeBlockSchema>

export const AlbumMergePlanSchema = z.object({
  targetId: z.string(),
  /** The album to keep first, then the other selected albums, then editions. */
  albums: z.array(AlbumMergePlanAlbumSchema),
  editions: z.array(AlbumMergePlanEditionSchema),
  /** Scrobbled album names that move to the album to keep. */
  names: z.array(AlbumMergePlanNameSchema),
  /** Track names that follow the album names: the Also merged rows. */
  also: z.array(AlbumMergeFollowSchema),
  /** Track names under the album names that match no track and stay. */
  unmatched: z.array(AlbumMergeUnmatchedSchema),
  scrobbles: z.object({
    /** Scrobbles of the record of the album to keep. */
    target: z.number().int().nonnegative(),
    /** Scrobbles the record does not count yet. */
    added: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  cautions: z.array(AlbumMergeCautionSchema),
  blocked: AlbumMergeBlockSchema.nullable(),
})
export type AlbumMergePlan = z.infer<typeof AlbumMergePlanSchema>
