import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { JsonValueSchema, PluginReferenceSchema } from '@repo/media-plugin-sdk'
import {
  MAX_LOCAL_PROVIDER_RESPONSE_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseCaptureSchema,
} from '@repo/schemas/provider-response'

const id = z.string().min(1).max(200)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const pin = z
  .object({ path: z.string().min(1).max(4096), sha256: digest })
  .strict()

export class ArchivedAlbumReplayError extends Error {}

const planFields = {
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
  originals: z
    .array(
      z
        .object({
          responseId: id,
          sha256: digest,
          localArchive: z
            .object({
              archiveId: z.string().uuid(),
              file: pin,
              requestKey: digest,
            })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .min(1)
    .max(8),
}

const anchor = z
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
  .strict()

const detailRequest = {
  requestUrl: z.string().url().max(2048),
  archiveRequestKey: digest,
  notFoundOn404: z.boolean(),
}

const independentPlan = z
  .object({
    ...planFields,
    version: z.literal(1),
    anchors: z.array(anchor).min(1).max(3),
    supplement: z
      .object({
        ...detailRequest,
        receiptSha256: digest,
        archiveId: z.string().uuid(),
        archiveFile: pin,
        capturedAt: z.string().datetime(),
        sha256: digest,
      })
      .strict(),
  })
  .strict()

const originalPlan = z
  .object({
    ...planFields,
    version: z.literal(2),
    anchors: z
      .array(
        anchor.extend({
          evidence: z
            .object({
              title: z.string().min(1),
              artists: z.array(z.string().min(1)).min(1).max(32),
              year: z.number().int().positive().optional(),
              releaseDate: z.string().min(4).max(10).optional(),
              completeTracks: z.number().int().positive().optional(),
            })
            .strict(),
        }),
      )
      .min(1)
      .max(3),
    detail: z.object({ ...detailRequest, responseId: id }).strict(),
    artistLookups: z
      .array(
        z
          .object({
            artistId: id,
            providerArtistId: id.nullable(),
          })
          .strict(),
      )
      .max(7),
    reviewedResultSha256: digest,
  })
  .strict()

const reviewedGroupPlan = originalPlan.omit({ artistLookups: true }).extend({
  version: z.literal(3),
  detail: originalPlan.shape.detail.extend({
    ordinal: z.number().int().positive(),
  }),
  review: z.object({ decisionSha256: digest, evidenceFile: pin }).strict(),
})

export const ArchivedGroupReviewEvidenceSchema = z
  .object({
    version: z.literal(1),
    jobId: id,
    jobItemId: id,
    attempt: z.number().int().positive(),
    provider: id,
    albumId: id,
    groupId: id,
    decisionSha256: digest,
    anchors: reviewedGroupPlan.shape.anchors,
    reviewedResultSha256: digest,
    detail: z
      .object({
        responseId: id,
        ordinal: z.number().int().positive(),
        requestKey: digest,
        bodySha256: digest,
      })
      .strict(),
  })
  .strict()

export function verifyArchivedGroupReview(
  plan: z.infer<typeof reviewedGroupPlan>,
  bytes: Buffer | undefined,
) {
  if (bytes && archiveSha256(bytes) === plan.review.evidenceFile.sha256) {
    const evidence = ArchivedGroupReviewEvidenceSchema.parse(
      JSON.parse(bytes.toString('utf8')),
    )
    const { jobId, jobItemId, attempt, provider, albumId, groupId, detail } =
      plan
    const original = plan.originals[detail.ordinal - 1]
    if (
      evidence.jobId === jobId &&
      evidence.jobItemId === jobItemId &&
      evidence.attempt === attempt &&
      evidence.provider === provider &&
      evidence.albumId === albumId &&
      evidence.groupId === groupId &&
      evidence.decisionSha256 === plan.review.decisionSha256 &&
      evidence.reviewedResultSha256 === plan.reviewedResultSha256 &&
      isDeepStrictEqual(evidence.anchors, plan.anchors) &&
      evidence.detail.responseId === detail.responseId &&
      evidence.detail.ordinal === detail.ordinal &&
      evidence.detail.requestKey === detail.archiveRequestKey &&
      original?.responseId === detail.responseId &&
      evidence.detail.bodySha256 === original.sha256
    )
      return
  }
  throw new ArchivedAlbumReplayError(
    'The reviewed group evidence does not match the plan.',
  )
}

export const ArchivedAlbumReplayPlanSchema = z
  .discriminatedUnion('version', [
    independentPlan,
    originalPlan,
    reviewedGroupPlan,
  ])
  .refine((plan) => {
    const { anchors, originals } = plan
    return (
      new Set(originals.map(({ responseId }) => responseId)).size ===
        originals.length &&
      new Set(anchors.map(({ provider }) => provider)).size ===
        anchors.length &&
      anchors.every(
        ({ provider, snapshotProvider }) =>
          snapshotProvider === provider || snapshotProvider === 'legacy-record',
      ) &&
      (plan.version === 1
        ? plan.anchors.some(({ provider }) => provider === 'spotify')
        : plan.originals.some(
            ({ responseId }) => responseId === plan.detail.responseId,
          ) &&
          plan.anchors.some(
            ({ evidence }) =>
              evidence.completeTracks === plan.library.tracks.length,
          ) &&
          (plan.version === 2
            ? new Set(plan.artistLookups.map(({ artistId }) => artistId))
                .size === plan.artistLookups.length
            : plan.anchors.some(
                ({ provider, evidence }) =>
                  provider === 'spotify' &&
                  evidence.completeTracks === plan.library.tracks.length,
              )))
    )
  }, 'The reviewed originals and active source records must be unambiguous')

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

export const ArchivedAlbumReplayLocalBodySchema =
  ArchivedAlbumReplayDetailSchema.extend({
    retainedBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_LOCAL_PROVIDER_RESPONSE_BYTES),
    text: z.string().min(1).max(MAX_LOCAL_PROVIDER_RESPONSE_BYTES),
  })

export type ArchivedAlbumReplayLocalBody = z.infer<
  typeof ArchivedAlbumReplayLocalBodySchema
>

export const ArchivedAlbumReplayInputSchema = z.object({
  adapter: pin,
  projector: pin,
  dependencies: z.array(pin).max(32),
  provider: id,
  albumId: id,
  groupId: id,
  artistLookups: z
    .array(z.object({ id, name: z.string(), providerArtistId: id.nullable() }))
    .max(7),
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
  captures: z.array(ProviderResponseCaptureSchema).min(1).max(9),
  localBodies: z
    .array(
      z.object({
        ordinal: z.number().int().positive(),
        archive: ArchivedAlbumReplayLocalBodySchema,
      }),
    )
    .max(8)
    .default([]),
  reviewedGroup: z.literal(true).optional(),
  boundDetail: z.object({
    ordinal: z.number().int().positive(),
    requestKey: digest,
    bodySha256: digest.optional(),
  }),
})

export type ArchivedAlbumReplayInput = z.infer<
  typeof ArchivedAlbumReplayInputSchema
>

export function archiveSha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}
