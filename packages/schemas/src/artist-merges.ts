import { z } from 'zod'
import { CreatorIdSchema } from './common'
import { MergeFollowedTitleSchema } from './library-changes'

const CountSchema = z.number().int().nonnegative()

const ArtistMergeSelectionSchema = z.object({
  artistIds: z.array(CreatorIdSchema).min(2).max(50),
  /** The artist to keep. Chosen by the server when omitted. */
  targetId: CreatorIdSchema.optional(),
  /**
   * Also merge the titles scrobbled under the merged names that match a
   * track of the artist to keep.
   */
  follow: z.boolean().default(true),
})
type ArtistMergeSelection = z.infer<typeof ArtistMergeSelectionSchema>
const selectedOnce = ({ artistIds }: ArtistMergeSelection) =>
  new Set(artistIds).size === artistIds.length
const targetSelected = ({ artistIds, targetId }: ArtistMergeSelection) =>
  targetId === undefined || artistIds.includes(targetId)
const SELECTED_ONCE = 'Each artist can be selected once'
const TARGET_SELECTED = 'The artist to keep must be one of the selected artists'

export const ArtistMergePlanRequestSchema = ArtistMergeSelectionSchema.strict()
  .refine(selectedOnce, SELECTED_ONCE)
  .refine(targetSelected, TARGET_SELECTED)
export type ArtistMergePlanRequest = z.infer<
  typeof ArtistMergePlanRequestSchema
>

export const ArtistMergeRequestSchema = ArtistMergeSelectionSchema.extend({
  /** The owner has seen the plan. Required when the plan has cautions. */
  reviewed: z.boolean().default(false),
})
  .strict()
  .refine(selectedOnce, SELECTED_ONCE)
  .refine(targetSelected, TARGET_SELECTED)
export type ArtistMergeRequest = z.infer<typeof ArtistMergeRequestSchema>

/**
 * Why a selected artist cannot be merged. Film directors and actors share the
 * artist records, so an artist with film credits is a person as well.
 */
export const ArtistMergeBlockSchema = z.enum(['film'])
export type ArtistMergeBlock = z.infer<typeof ArtistMergeBlockSchema>

export const ArtistMergePlanArtistSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Scrobbles linked to the artist's albums and tracks. */
  scrobbles: CountSchema,
  albumCount: CountSchema,
  trackCount: CountSchema,
  /** Every credit of the artist, in any role. */
  creditCount: CountSchema,
  /** The artist has a Spotify artist profile. */
  spotify: z.boolean(),
  /** Providers with a stored profile of this artist. */
  providers: z.array(z.string()),
  profiles: z
    .array(
      z.object({ provider: z.string(), externalId: z.string().nullable() }),
    )
    .optional(),
  inLibrary: z.boolean().optional(),
  /** Other names merged into this artist before. */
  names: z.array(z.string()),
  blocked: ArtistMergeBlockSchema.nullable(),
})
export type ArtistMergePlanArtist = z.infer<typeof ArtistMergePlanArtistSchema>

/** Evidence against a merge. Any caution opens the review before merging. */
export const ArtistMergeCautionSchema = z.discriminatedUnion('code', [
  /** Two of the artists have different profiles with one provider. */
  z.object({
    code: z.literal('profiles'),
    providers: z.array(z.string()).min(1),
  }),
  /** The artists are credited together on tracks or albums. */
  z.object({ code: z.literal('together'), items: CountSchema.min(1) }),
  /** The names are not spellings of one name. */
  z.object({ code: z.literal('names'), names: z.array(z.string()).min(2) }),
  /** The owner kept some of these artists separate. */
  z.object({ code: z.literal('separate'), names: z.array(z.string()).min(2) }),
])
export type ArtistMergeCaution = z.infer<typeof ArtistMergeCautionSchema>

export const ArtistMergePlanSchema = z.object({
  targetId: z.string(),
  /** The artist to keep first, then the artists merged into it. */
  artists: z.array(ArtistMergePlanArtistSchema),
  /** What moves to the artist to keep. */
  moves: z.object({
    credits: CountSchema,
    albums: CountSchema,
    tracks: CountSchema,
    /** Credits on items the artist to keep is already credited on. */
    shared: CountSchema,
    /** Names the artist to keep keeps after the merge. */
    names: z.array(z.string()),
  }),
  scrobbles: z.object({
    target: CountSchema,
    /** Scrobbles of every selected artist, counted once. */
    total: CountSchema,
  }),
  /**
   * The titles scrobbled under the merged names that follow onto a matching
   * track of the artist to keep, when the request says `follow`.
   */
  also: z.array(MergeFollowedTitleSchema),
  cautions: z.array(ArtistMergeCautionSchema),
  blocked: z.boolean(),
})
export type ArtistMergePlan = z.infer<typeof ArtistMergePlanSchema>

/** A name merged into an artist, which the artist keeps. */
export const ArtistKeptNameSchema = z.object({
  id: z.string(),
  name: z.string(),
})
export type ArtistKeptName = z.infer<typeof ArtistKeptNameSchema>
