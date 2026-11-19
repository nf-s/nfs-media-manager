import { createHash } from 'node:crypto'
import { z } from 'zod'
import { JsonValueSchema, PluginReferenceSchema } from '@repo/media-plugin-sdk'
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseCaptureSchema,
} from '@repo/schemas/provider-response'

const id = z.string().min(1).max(200)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const pin = z
  .object({ path: z.string().min(1).max(4096), sha256: digest })
  .strict()

export class ArchivedAlbumReplayError extends Error {}

export const ArchivedAlbumReplayPlanSchema = z
  .object({
    version: z.literal(1),
    jobId: id,
    jobItemId: id,
    attempt: z.number().int().positive(),
    provider: id,
    albumId: id,
    adapter: pin,
    projector: pin,
    dependencies: z.array(pin).max(32),
    groupId: id,
    library: z
      .object({
        title: z.string().min(1),
        artists: z.array(z.string().min(1)).min(1).max(32),
        date: z.string().date(),
        tracks: z.array(z.string().min(1)).min(1).max(100),
      })
      .strict(),
    anchors: z
      .array(
        z
          .object({
            provider: z.enum(['spotify', 'musicbrainz', 'discogs']),
            referenceType: id,
            recordId: id,
            snapshotId: id,
            snapshotProvider: z.enum([
              'spotify',
              'musicbrainz',
              'discogs',
              'legacy-record',
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    originals: z
      .array(z.object({ responseId: id, sha256: digest }).strict())
      .min(1)
      .max(8),
    supplement: z
      .object({
        receiptSha256: digest,
        archiveId: z.string().uuid(),
        archiveFile: pin,
        capturedAt: z.string().datetime(),
        requestUrl: z.string().url().max(2048),
        archiveRequestKey: digest,
        notFoundOn404: z.boolean(),
        sha256: digest,
      })
      .strict(),
  })
  .strict()
  .refine(
    ({ anchors, originals }) =>
      new Set(originals.map(({ responseId }) => responseId)).size ===
        originals.length &&
      new Set(anchors.map(({ provider }) => provider)).size ===
        anchors.length &&
      anchors.some(({ provider }) => provider === 'spotify') &&
      anchors.every(
        ({ provider, snapshotProvider }) =>
          snapshotProvider === provider || snapshotProvider === 'legacy-record',
      ),
    'The reviewed originals and active source records must be unambiguous',
  )

export type ArchivedAlbumReplayPlan = z.infer<
  typeof ArchivedAlbumReplayPlanSchema
>

export const ArchivedAlbumReplayDetailSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    action: z.string().min(1),
    status: z.literal(200),
    capturedAt: z.number().int().positive(),
    requestKey: digest,
    retainedBytes: z.number().int().positive().max(MAX_PROVIDER_RESPONSE_BYTES),
    sha256: digest,
    redacted: z.boolean(),
    text: z.string().min(1).max(MAX_PROVIDER_RESPONSE_BYTES),
  })
  .strict()

export type ArchivedAlbumReplayDetail = z.infer<
  typeof ArchivedAlbumReplayDetailSchema
>

export const ArchivedAlbumReplayInputSchema = z.object({
  adapter: pin,
  projector: pin,
  dependencies: z.array(pin).max(32),
  provider: id,
  albumId: id,
  groupId: id,
  artist: z.object({ id, name: z.string() }).optional(),
  media: z.object({
    title: z.string(),
    artists: z.array(z.string()),
    releaseDate: z.string(),
    releaseHints: z.array(
      z.object({
        source: z.enum(['spotify', 'musicbrainz', 'discogs']),
        title: z.string(),
        year: z.number().int().optional(),
        releaseDate: z.string().optional(),
        releaseType: z.string().optional(),
        artists: z.array(z.string()).optional(),
        trackEvidence: z
          .object({
            libraryTracks: z.number().int(),
            matchedTracks: z.number().int(),
            exactSequence: z.boolean(),
            creditedArtists: z
              .array(z.object({ name: z.string(), tracks: z.number().int() }))
              .optional(),
          })
          .optional(),
      }),
    ),
  }),
  existingReferences: z.array(PluginReferenceSchema),
  rejections: z.array(
    z.object({
      provider: id,
      sourceProvider: id,
      referenceType: id,
      identifier: id,
      aliases: z.array(z.object({ referenceType: id, externalId: id })),
    }),
  ),
  options: z.record(z.string(), JsonValueSchema),
  captures: z.array(ProviderResponseCaptureSchema).min(2).max(9),
  supplementRequestKey: digest,
})

export type ArchivedAlbumReplayInput = z.infer<
  typeof ArchivedAlbumReplayInputSchema
>

export function archiveSha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
