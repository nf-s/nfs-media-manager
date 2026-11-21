import { z } from 'zod'
import { CreatorIdSchema } from './common'
import { TrackMergeCautionSchema } from './library-changes'
import { TrackMatchIdSchema } from './tracks'

/**
 * Why tracks were found as possible duplicates. `link`: a scrobbled name one
 * track owns already counts towards another. `key`: the same first artist and
 * the same title once credits and remaster notes are left out.
 */
export const TrackDuplicateRuleSchema = z.enum(['link', 'key'])
export type TrackDuplicateRule = z.infer<typeof TrackDuplicateRuleSchema>

/** Tracks that look like the same track twice. */
export const TrackDuplicateGroupSchema = z.object({
  id: z.string(),
  rule: TrackDuplicateRuleSchema,
  /** What matched, worded for the group row, strongest first. */
  evidence: z.array(z.string()),
  /** What the merge plan would raise. Any caution opens the review. */
  cautions: z.array(TrackMergeCautionSchema),
  memberCount: z.number().int().min(2),
  /** Scrobbles of the most played member. */
  scrobbles: z.number().int().nonnegative(),
  /** Every member, the track a merge keeps first. */
  memberIds: z.array(z.string()),
})
export type TrackDuplicateGroup = z.infer<typeof TrackDuplicateGroupSchema>

/** A group in the rows of the Possible duplicates view. */
export const TrackDuplicateLayoutGroupSchema = TrackDuplicateGroupSchema.extend(
  {
    /** Zero-based row of the group's first member in the browse order. */
    offset: z.number().int().nonnegative(),
    /** Members the current search and filters show. */
    rowCount: z.number().int().positive(),
  },
)
export type TrackDuplicateLayoutGroup = z.infer<
  typeof TrackDuplicateLayoutGroupSchema
>

export const TrackDuplicateLayoutSchema = z.object({
  /** Rows of the view, the same as the browse count. */
  totalRows: z.number().int().nonnegative(),
  groups: z.array(TrackDuplicateLayoutGroupSchema),
})
export type TrackDuplicateLayout = z.infer<typeof TrackDuplicateLayoutSchema>

export const TrackDuplicateCountQuerySchema = z.object({
  /** Only groups with a track credited to this artist. */
  creatorId: CreatorIdSchema.optional(),
})
export type TrackDuplicateCountQuery = z.infer<
  typeof TrackDuplicateCountQuerySchema
>

export const TrackDuplicateCountSchema = z.object({
  count: z.number().int().nonnegative(),
  /** False until the groups have been worked out once. */
  ready: z.boolean(),
})
export type TrackDuplicateCount = z.infer<typeof TrackDuplicateCountSchema>

export const TrackDuplicateMemberSchema = z.object({
  id: z.string(),
  title: z.string(),
  by: z.string(),
})

/** The groups a track is in, for the notice on its page. */
export const TrackDuplicatesSchema = z.object({
  items: z.array(
    TrackDuplicateGroupSchema.extend({
      /** The other members, in group order. */
      others: z.array(TrackDuplicateMemberSchema),
    }),
  ),
})
export type TrackDuplicates = z.infer<typeof TrackDuplicatesSchema>

export const TrackSeparationRequestSchema = z
  .object({ trackIds: z.array(TrackMatchIdSchema).min(2).max(50) })
  .strict()
  .refine(
    ({ trackIds }) => new Set(trackIds).size === trackIds.length,
    'Each track can be selected once',
  )
export type TrackSeparationRequest = z.infer<
  typeof TrackSeparationRequestSchema
>
