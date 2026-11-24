import { z } from 'zod'
import { PaginatedDataSchema, PaginationQuerySchema } from './common'
import { TrackMatchIdSchema } from './tracks'

/** The library a change belongs to. */
export const LibraryChangeKindSchema = z.enum(['track', 'album', 'artist'])
export type LibraryChangeKind = z.infer<typeof LibraryChangeKindSchema>

/**
 * `merge` joins whole records, `move` gives one scrobbled name to another
 * record, `separate` gives a name or a version its own record again,
 * `rematch` returns a name to the automatic rules, `show` picks the version a
 * record's row is shown as and `keep-separate` stores that records are
 * different.
 */
export const LibraryChangeActionSchema = z.enum([
  'merge',
  'move',
  'separate',
  'rematch',
  'show',
  'keep-separate',
  'remove',
])
export type LibraryChangeAction = z.infer<typeof LibraryChangeActionSchema>

/** What a change can move besides scrobbled track names. */
export const LibraryChangePartSchema = z.enum([
  'version',
  'edition',
  'position',
  'playlist-entry',
  'album-name',
  'artist-name',
  'title',
  'credit',
])
export type LibraryChangePart = z.infer<typeof LibraryChangePartSchema>

/** What a change moved besides scrobbled track names, for the list of changes. */
export const LibraryChangeDetailsSchema = z.object({
  /** How many parts of each kind the change moved. */
  counts: z
    .partialRecord(LibraryChangePartSchema, z.number().int().nonnegative())
    .optional(),
  /** Names of moved parts that are not track names, most played first. */
  labels: z.array(z.string()).max(5).optional(),
})
export type LibraryChangeDetails = z.infer<typeof LibraryChangeDetailsSchema>

export const LibraryChangeActorSchema = z.enum(['owner', 'automatic'])
export type LibraryChangeActor = z.infer<typeof LibraryChangeActorSchema>

/** A record as it was named when the change was made. */
export const LibraryChangeRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  by: z.string(),
  /** The record is in the library now. A merged track returns when undone. */
  exists: z.boolean(),
})
export type LibraryChangeRecord = z.infer<typeof LibraryChangeRecordSchema>

/** A scrobbled artist and track name that a change moved. */
export const LibraryChangeNameSchema = z.object({
  artistName: z.string(),
  trackName: z.string(),
  scrobbles: z.number().int().nonnegative(),
})
export type LibraryChangeName = z.infer<typeof LibraryChangeNameSchema>

export const LibraryChangeSchema = z.object({
  id: z.string(),
  kind: LibraryChangeKindSchema,
  action: LibraryChangeActionSchema,
  actor: LibraryChangeActorSchema,
  /** The automatic rule that made the change. */
  rule: z.string().nullable(),
  /** The run that made an automatic change. */
  batchId: z.string().nullable(),
  /** The record the names belong to after the change, when it is one record. */
  target: LibraryChangeRecordSchema.nullable(),
  /** Records the names left. A merged track is removed with its names. */
  sources: z.array(LibraryChangeRecordSchema),
  /** Scrobbled names the change moved, most played first, up to five. */
  names: z.array(LibraryChangeNameSchema),
  nameCount: z.number().int().nonnegative(),
  /** Scrobbles recorded under the moved names. */
  scrobbles: z.number().int().nonnegative(),
  /** What the change moved besides scrobbled track names. */
  details: LibraryChangeDetailsSchema.nullable(),
  createdAt: z.string(),
  undoneAt: z.string().nullable(),
  /** False for a change made before its other effects were recorded. */
  reversible: z.boolean(),
  /** Everything is still where the change put it. */
  canUndo: z.boolean(),
  /** Everything is still where the undo left it. */
  canRedo: z.boolean(),
  /** Why the change cannot be undone, or made again, right now. */
  blocked: z.string().nullable(),
})
export type LibraryChange = z.infer<typeof LibraryChangeSchema>

export const LibraryChangeParamsSchema = z.object({
  id: z.string().trim().min(1).max(100),
})

export const LibraryChangeListQuerySchema = PaginationQuerySchema.extend({
  kind: LibraryChangeKindSchema.default('track'),
  actor: LibraryChangeActorSchema.optional(),
  /** Only changes that moved something into or out of this record. */
  recordId: TrackMatchIdSchema.optional(),
  /** Only the changes of one automatic run. */
  batchId: z.string().trim().min(1).max(100).optional(),
})
export type LibraryChangeListQuery = z.infer<
  typeof LibraryChangeListQuerySchema
>
export const LibraryChangePageSchema = PaginatedDataSchema(LibraryChangeSchema)
export type LibraryChangePage = z.infer<typeof LibraryChangePageSchema>

/**
 * A scrobbled track name that follows the album name or artist name it was
 * scrobbled under onto a matching track.
 */
export const MergeFollowedTitleSchema = z.object({
  artistName: z.string(),
  trackName: z.string(),
  scrobbles: z.number().int().nonnegative(),
  /** The track the name belongs to now. */
  fromTrackId: z.string(),
  /** The track the name moves to. */
  toTrackId: z.string(),
  toTitle: z.string(),
})
export type MergeFollowedTitle = z.infer<typeof MergeFollowedTitleSchema>

/** A scrobbled album name that is merged with a title scrobbled under it. */
export const MergeFollowedAlbumNameSchema = z.object({
  artistName: z.string(),
  albumName: z.string(),
  scrobbles: z.number().int().nonnegative(),
  /** The album the name moves to: the album of the track to keep. */
  toAlbumId: z.string(),
  toAlbumTitle: z.string(),
})
export type MergeFollowedAlbumName = z.infer<
  typeof MergeFollowedAlbumNameSchema
>

const TrackMergeSelectionSchema = z.object({
  trackIds: z.array(TrackMatchIdSchema).min(2).max(50),
  /** The track to keep. Chosen by the server when omitted. */
  targetId: TrackMatchIdSchema.optional(),
  /**
   * Also merge the album names the merged titles were scrobbled under, and
   * the other titles under those album names that match a track on the album.
   */
  follow: z.boolean().default(true),
})
type TrackMergeSelection = z.infer<typeof TrackMergeSelectionSchema>
const selectedOnce = ({ trackIds }: TrackMergeSelection) =>
  new Set(trackIds).size === trackIds.length
const targetSelected = ({ trackIds, targetId }: TrackMergeSelection) =>
  targetId === undefined || trackIds.includes(targetId)
const SELECTED_ONCE = 'Each track can be selected once'
const TARGET_SELECTED = 'The track to keep must be one of the selected tracks'

export const TrackMergePlanRequestSchema = TrackMergeSelectionSchema.strict()
  .refine(selectedOnce, SELECTED_ONCE)
  .refine(targetSelected, TARGET_SELECTED)
export type TrackMergePlanRequest = z.infer<typeof TrackMergePlanRequestSchema>

export const TrackMergeRequestSchema = TrackMergeSelectionSchema.extend({
  /** The owner has seen the plan. Required when the plan has cautions. */
  reviewed: z.boolean().default(false),
})
  .strict()
  .refine(selectedOnce, SELECTED_ONCE)
  .refine(targetSelected, TARGET_SELECTED)
export type TrackMergeRequest = z.infer<typeof TrackMergeRequestSchema>

export const TrackMergeApplyQuerySchema = z.object({
  interactive: z.literal('true').optional(),
})

export const TrackMergeBusySchema = z.object({
  reason: z.literal('library-busy'),
})

/** What a selected track has besides scrobbled names. */
export const TrackMergeBlockSchema = z.enum(['spotify', 'album', 'playlist'])
export type TrackMergeBlock = z.infer<typeof TrackMergeBlockSchema>

/**
 * What a merge does with a selected track. `keep`: the track to keep.
 * `merge`: its scrobbled names, album positions and playlist entries move to
 * the track to keep and it is removed. `version`: it stays, as a version of
 * the kept record, with its own names.
 */
export const TrackMergeOutcomeSchema = z.enum(['keep', 'merge', 'version'])
export type TrackMergeOutcome = z.infer<typeof TrackMergeOutcomeSchema>

export const TrackMergePlanTrackSchema = z.object({
  id: z.string(),
  title: z.string(),
  by: z.string(),
  albumTitle: z.string().nullable(),
  durationSec: z.number().int().positive().nullable(),
  scrobbles: z.number().int().nonnegative(),
  /** The track has its own Spotify track ID. */
  spotify: z.boolean(),
  nameCount: z.number().int().nonnegative(),
  /** What the track has besides scrobbled names. */
  identity: TrackMergeBlockSchema.nullable(),
  outcome: TrackMergeOutcomeSchema,
  /**
   * Set on a track that cannot be merged. Every track can now be merged or
   * joined as a version, so this is always null.
   */
  blocked: TrackMergeBlockSchema.nullable(),
})
export type TrackMergePlanTrack = z.infer<typeof TrackMergePlanTrackSchema>

export const TrackMergePlanNameSchema = z.object({
  trackId: z.string(),
  artistName: z.string(),
  trackName: z.string(),
  count: z.number().int().nonnegative(),
  /** The track to keep already counts these scrobbles. */
  counted: z.boolean(),
})

/** Evidence against a merge. Any caution opens the review before merging. */
export const TrackMergeCautionSchema = z.discriminatedUnion('code', [
  /** A version word, such as Live or Demo, is in some titles only. */
  z.object({ code: z.literal('version'), words: z.array(z.string()).min(1) }),
  /** Known lengths differ by more than ten seconds. */
  z.object({
    code: z.literal('duration'),
    seconds: z.number().int().positive(),
  }),
  /** The tracks are credited to different artists. */
  z.object({ code: z.literal('artists'), names: z.array(z.string()).min(2) }),
  /** Two of the tracks are different positions on the same album. */
  z.object({
    code: z.literal('same-album'),
    albums: z.array(z.string()).min(1),
  }),
  /** The owner kept some of the tracks separate. Merging forgets that. */
  z.object({
    code: z.literal('separate'),
    trackIds: z.array(z.string()).min(2),
  }),
  /** Titles that would follow are now on a track of another album. */
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
  /**
   * Titles scrobbled under the album name that match more than one track of
   * the album. They stay where they are.
   */
  z.object({
    code: z.literal('ambiguous'),
    count: z.number().int().positive(),
    names: z
      .array(z.object({ artistName: z.string(), trackName: z.string() }))
      .max(5),
  }),
])
export type TrackMergeCaution = z.infer<typeof TrackMergeCautionSchema>

export const TrackMergePlanSchema = z.object({
  targetId: z.string(),
  tracks: z.array(TrackMergePlanTrackSchema),
  /** Scrobbled names that move to the track to keep. */
  names: z.array(TrackMergePlanNameSchema),
  scrobbles: z.object({
    target: z.number().int().nonnegative(),
    /**
     * Scrobbles the track to keep does not count yet: those of the names that
     * move and of the names its new versions keep.
     */
    added: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  /**
   * What follows the merged titles when the request says `follow`: the album
   * names they were scrobbled under, and the other titles under those album
   * names that match a track on the album of the track to keep.
   */
  also: z.object({
    albumNames: z.array(MergeFollowedAlbumNameSchema),
    titles: z.array(MergeFollowedTitleSchema),
  }),
  cautions: z.array(TrackMergeCautionSchema),
  /** Always false: no selected track is refused. */
  blocked: z.boolean(),
})
export type TrackMergePlan = z.infer<typeof TrackMergePlanSchema>
