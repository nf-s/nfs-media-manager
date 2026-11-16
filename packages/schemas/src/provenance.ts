import { z } from 'zod'
import { JsonValueSchema } from './common'

/** One provider whose current normalized result supplies a field. */
export const FieldSourceSchema = z.object({
  provider: z.string(),
  /** When the provider's current snapshot was stored. */
  scrapedAt: z.string().datetime().nullable(),
  /** Null when the snapshot has since been removed. */
  snapshotId: z.string().nullable(),
  /** How the snapshot was obtained, such as `scrape-job` or `file-import`. */
  snapshotSource: z.string().nullable(),
  jobId: z.string().nullable(),
  /** The value this provider supplied, as it supplied it. */
  value: JsonValueSchema,
  /** The supplied value equals the stored value. */
  matchesCurrent: z.boolean(),
})

/** The latest manual override of a field; it wins over every provider. */
export const FieldOverrideSchema = z.object({
  at: z.string().datetime(),
  /** User ID of the editor, when known. */
  by: z.string().nullable(),
  note: z.string().nullable(),
})

export const MediaFieldProvenanceSchema = z.object({
  /**
   * A stored column (`title`, `releaseDate`, `durationSec`), a browse value
   * (`browse.ratingRymValue`) or a credit role (`credits.artist`).
   */
  key: z.string(),
  label: z.string(),
  /** The stored value; null when nothing is stored. */
  value: JsonValueSchema,
  override: FieldOverrideSchema.nullable(),
  /**
   * Every provider whose current result supplies the field, newest first.
   * Several can supply one field and the app does not record which write
   * was applied last, so `matchesCurrent` is the only link to the value.
   */
  sources: z.array(FieldSourceSchema),
})

export const MediaProvenanceSchema = z.object({
  mediaItemId: z.string(),
  mediaType: z.enum(['album', 'film']),
  fields: z.array(MediaFieldProvenanceSchema),
})

export type FieldSource = z.infer<typeof FieldSourceSchema>
export type FieldOverride = z.infer<typeof FieldOverrideSchema>
export type MediaFieldProvenance = z.infer<typeof MediaFieldProvenanceSchema>
export type MediaProvenance = z.infer<typeof MediaProvenanceSchema>
