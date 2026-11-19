import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  JsonValueSchema,
  PluginResultSchema,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { getJobDismissal, getJobTask } from '@repo/schemas/job'
import {
  MAX_LOCAL_PROVIDER_RESPONSE_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseCaptureSchema,
  type ProviderResponseCapture,
} from '@repo/schemas/provider-response'
import {
  archiveSha256,
  ArchivedAlbumReplayError,
  ArchivedAlbumReplayInputSchema,
  type ArchivedAlbumReplayDetail,
  type ArchivedAlbumReplayLocalBody,
  type ArchivedAlbumReplayPlan,
} from '@/lib/archived-album-replay'
import { runIsolatedArchivedReplay } from '@/lib/archived-album-replay-process'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { albumEvidenceTrackNames } from '@/lib/album-release-track-evidence'
import { db } from '@/lib/db'
import { checksumJson } from '@/lib/media-utils'
import { nativeProviderReplayRequestKey } from '@/lib/provider-response-history'
import {
  mediaItem,
  providerCurrentState,
  providerReference,
  providerReferenceOverride,
  providerResponse,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
  scrapeJobLog,
  track,
} from '@/schemas/db'
import { readAlbumMatchRejections } from './album-match-rejections'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  matchesAlbumReleaseReference,
  readAlbumReleaseHint,
} from './album-release-hints'
import { applyProviderResultInTransaction } from './provider-state'
import { lockTagWrites } from './tag-state'

function requireReview(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ArchivedAlbumReplayError(message)
}

type ResponseRow = typeof providerResponse.$inferSelect
type LocalReceiptProvenance = {
  origin: 'paired-worker-local'
  responseId: string
  ordinal: number
  archiveId: string
  retainedBytes: number
  requestKey: string
  appRequestKey: string
  bodySha256: string
  archiveFileSha256: string
}

function bindArchivedResponses(
  plan: ArchivedAlbumReplayPlan,
  originals: ResponseRow[],
  finishedAt: Date,
  archive: ArchivedAlbumReplayDetail | undefined,
  localOriginals: ReadonlyMap<string, ArchivedAlbumReplayLocalBody>,
) {
  requireReview(
    originals.length === plan.originals.length,
    'The failed attempt no longer has the reviewed response sequence.',
  )
  const localBodies: Array<{
    ordinal: number
    archive: ArchivedAlbumReplayLocalBody
  }> = []
  const localProvenance: LocalReceiptProvenance[] = []
  const captures: ProviderResponseCapture[] = originals.map((row, index) => {
    const pin = plan.originals[index]
    const body = row.body
    requireReview(
      pin &&
        row.id === pin.responseId &&
        row.jobId === plan.jobId &&
        row.jobItemId === plan.jobItemId &&
        row.provider === plan.provider &&
        row.attempt === plan.attempt &&
        row.ordinal === index + 1 &&
        row.method === 'GET' &&
        row.status === 200 &&
        // The worker numbers the first transport attempt as 1.
        (row.retry === null || row.retry === 1) &&
        !row.notFound &&
        row.requestKey,
      'An original response differs from the reviewed archive.',
    )
    if (row.bodyState === 'local') {
      const localPin = pin.localArchive
      const retained = localOriginals.get(row.id)
      requireReview(
        body.state === 'local' &&
          localPin &&
          retained &&
          retained.id === localPin.archiveId &&
          body.reference === retained.id &&
          body.retainedBytes === row.retainedBytes &&
          row.retainedBytes === retained.retainedBytes &&
          retained.retainedBytes === Buffer.byteLength(retained.text) &&
          retained.retainedBytes <= MAX_LOCAL_PROVIDER_RESPONSE_BYTES &&
          retained.status === row.status &&
          retained.requestKey === localPin.requestKey &&
          retained.sha256 === pin.sha256 &&
          archiveSha256(retained.text) === pin.sha256,
        'A local archive differs from its original response receipt.',
      )
      localBodies.push({ ordinal: row.ordinal, archive: retained })
      localProvenance.push({
        origin: 'paired-worker-local',
        responseId: row.id,
        ordinal: row.ordinal,
        archiveId: retained.id,
        retainedBytes: retained.retainedBytes,
        requestKey: retained.requestKey,
        appRequestKey: row.requestKey,
        bodySha256: retained.sha256,
        archiveFileSha256: localPin.file.sha256,
      })
    } else
      requireReview(
        !pin.localArchive &&
          !localOriginals.has(row.id) &&
          row.bodyState === 'captured' &&
          body.state === 'captured' &&
          Buffer.byteLength(body.text) === row.retainedBytes &&
          archiveSha256(body.text) === pin.sha256,
        'An original response differs from the reviewed archive.',
      )
    return ProviderResponseCaptureSchema.parse({
      ordinal: row.ordinal,
      phase: row.phase,
      request: { method: row.method, url: row.requestUrl, key: row.requestKey },
      response: {
        status: row.status,
        contentType: row.contentType,
        receivedAt: row.receivedAt?.toISOString() ?? null,
        retry: row.retry ?? undefined,
        body,
      },
    })
  })
  requireReview(
    localBodies.length === localOriginals.size,
    'The reviewed local archives are outside the response sequence.',
  )
  const firstMedia = captures.findIndex(({ phase }) => phase === 'media')
  requireReview(
    firstMedia >= 0 &&
      captures.slice(firstMedia).every(({ phase }) => phase === 'media'),
    'The reviewed artist lookups must precede the album lookups.',
  )
  const detail = plan.version === 1 ? plan.supplement : plan.detail
  const destination = new URL(detail.requestUrl)
  requireReview(
    destination.protocol === 'https:' &&
      !destination.username &&
      !destination.password &&
      !destination.hash &&
      archiveSha256(destination.href) === detail.archiveRequestKey,
    'The exact detail request differs from the reviewed archive.',
  )
  const detailKey = nativeProviderReplayRequestKey(
    destination.href,
    detail.notFoundOn404,
  )
  if (plan.version === 2) {
    const rowIndex = originals.findIndex(
      ({ id }) => id === plan.detail.responseId,
    )
    const row = originals[rowIndex]
    const pin = plan.originals[rowIndex]
    const detailRows = originals.flatMap(({ requestKey }, index) =>
      requestKey === detailKey ? [index] : [],
    )
    requireReview(
      !archive &&
        row &&
        pin &&
        row.phase === 'media' &&
        row.requestKey === detailKey &&
        row.receivedAt &&
        row.receivedAt <= finishedAt &&
        rowIndex === detailRows.at(-1) &&
        detailRows.every(
          (index) => plan.originals[index]?.sha256 === pin.sha256,
        ),
      'The reviewed group detail is not the final consistent response from the failed attempt.',
    )
    return {
      captures,
      localBodies,
      localProvenance,
      boundDetail: {
        ordinal: row.ordinal,
        requestKey: detail.archiveRequestKey,
      },
      provenance: {
        detail: {
          origin: 'original-failed-attempt',
          responseId: row.id,
          ordinal: row.ordinal,
          requestKey: detail.archiveRequestKey,
          bodySha256: pin.sha256,
        },
      },
    }
  }
  const supplement = plan.supplement
  requireReview(
    archive &&
      Date.parse(supplement.capturedAt) > finishedAt.getTime() &&
      Date.parse(supplement.capturedAt) <= Date.now() &&
      archive.capturedAt === Date.parse(supplement.capturedAt) &&
      archive.id === supplement.archiveId &&
      archive.requestKey === supplement.archiveRequestKey &&
      archive.sha256 === supplement.sha256 &&
      archiveSha256(archive.text) === supplement.sha256 &&
      Buffer.byteLength(archive.text) === archive.retainedBytes &&
      archive.retainedBytes <= MAX_PROVIDER_RESPONSE_BYTES,
    'The independent detail response does not match its reviewed provenance.',
  )
  requireReview(
    captures.every(({ request }) => request.key !== detailKey),
    'The independent detail must be separate from the original attempt.',
  )
  captures.push(
    ProviderResponseCaptureSchema.parse({
      ordinal: captures.length + 1,
      phase: 'media',
      request: {
        method: 'GET',
        url: destination.origin + destination.pathname,
        key: detailKey,
      },
      response: {
        status: 200,
        contentType: 'application/json',
        receivedAt: supplement.capturedAt,
        body: {
          state: 'captured',
          text: archive.text,
          redacted: archive.redacted,
        },
      },
    }),
  )
  return {
    captures,
    localBodies,
    localProvenance,
    boundDetail: {
      ordinal: captures.length,
      requestKey: supplement.archiveRequestKey,
    },
    provenance: {
      supplement: {
        origin: 'independent-reviewed-detail',
        archiveId: supplement.archiveId,
        capturedAt: supplement.capturedAt,
        requestKey: supplement.archiveRequestKey,
        bodySha256: supplement.sha256,
        archiveFileSha256: supplement.archiveFile.sha256,
        receiptSha256: supplement.receiptSha256,
      },
    },
  }
}

export async function commitArchivedAlbumReplay(
  plan: ArchivedAlbumReplayPlan,
  planSha256: string,
  archive: ArchivedAlbumReplayDetail | undefined,
  localOriginals: ReadonlyMap<string, ArchivedAlbumReplayLocalBody>,
) {
  return db.transaction(async (tx) => {
    // Use the ordinary queue/retry lock and acquire provider writer locks
    // before locking the album, just as normal persistence does.
    await tx.execute(sql`select pg_advisory_xact_lock(614104)`)
    const [original] = await tx
      .select()
      .from(scrapeJob)
      .where(eq(scrapeJob.id, plan.jobId))
      .for('update')
    requireReview(
      original?.status === 'failed' &&
        original.provider === plan.provider &&
        original.finishedAt &&
        !getJobTask(original.options) &&
        original.scope.mediaType === 'album' &&
        original.scope.limit === 1 &&
        isDeepStrictEqual(original.scope.mediaItemIds, [plan.albumId]),
      'The original failed job does not match the reviewed album.',
    )
    const items = await tx
      .select()
      .from(scrapeJobItem)
      .where(eq(scrapeJobItem.jobId, original.id))
      .for('update')
    const [item] = items
    requireReview(
      items.length === 1 &&
        item?.id === plan.jobItemId &&
        item.mediaItemId === plan.albumId &&
        item.provider === plan.provider &&
        item.status === 'failed' &&
        item.attemptCount === plan.attempt,
      'The original item or attempt changed after review.',
    )
    if (typeof original.options.retryJobId === 'string') {
      const prior = await tx.query.scrapeJob.findFirst({
        where: eq(scrapeJob.id, original.options.retryJobId),
      })
      requireReview(
        prior?.status === 'succeeded' &&
          prior.provider === plan.provider &&
          isDeepStrictEqual(prior.scope, original.scope) &&
          prior.options.retryOf === original.id &&
          prior.options.archivedReplayPlanSha256 === planSha256,
        'The original job already has a different replacement.',
      )
      const snapshot = await tx.query.providerSnapshot.findFirst({
        where: and(
          eq(providerSnapshot.scrapeJobId, prior.id),
          eq(providerSnapshot.mediaItemId, plan.albumId),
          eq(providerSnapshot.provider, plan.provider),
          eq(providerSnapshot.source, 'archived-replay'),
        ),
      })
      requireReview(snapshot, 'The prior archived replay snapshot is missing.')
      return { jobId: prior.id, outcome: 'already-committed' }
    }

    await lockTagWrites(tx)
    await lockLibraryTrackWrites(tx)
    const [lockedAlbum] = await tx
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(
        and(eq(mediaItem.id, plan.albumId), eq(mediaItem.mediaType, 'album')),
      )
      .for('update')
    requireReview(lockedAlbum, 'The reviewed album is unavailable.')
    const active = await tx
      .select({ id: scrapeJobItem.id })
      .from(scrapeJobItem)
      .innerJoin(scrapeJob, eq(scrapeJob.id, scrapeJobItem.jobId))
      .where(
        and(
          eq(scrapeJobItem.mediaItemId, plan.albumId),
          eq(scrapeJobItem.provider, plan.provider),
          inArray(scrapeJob.status, ['queued', 'running']),
        ),
      )
      .limit(1)
    requireReview(!active.length, 'The album already has active provider work.')

    const record = await tx.query.mediaItem.findFirst({
      where: eq(mediaItem.id, plan.albumId),
      with: { credits: { with: { artist: true } } },
    })
    requireReview(record, 'The reviewed album is unavailable.')
    const credits = record.credits
      .filter(({ role }) => role === 'artist')
      .sort((left, right) => left.billingOrder - right.billingOrder)
    const tracks = await tx.query.track.findMany({
      columns: { title: true },
      where: eq(track.albumMediaItemId, plan.albumId),
      orderBy: [asc(track.position)],
      limit: plan.library.tracks.length + 1,
    })
    requireReview(
      record.title === plan.library.title &&
        record.releaseDate?.toISOString().slice(0, 10) === plan.library.date &&
        isDeepStrictEqual(
          credits.map(({ artist }) => artist.name),
          plan.library.artists,
        ) &&
        isDeepStrictEqual(
          tracks.map(({ title }) => title),
          plan.library.tracks,
        ),
      'The album title, date, artists or ordered tracks changed after review.',
    )
    const references = await tx.query.providerReference.findMany({
      where: eq(providerReference.mediaItemId, plan.albumId),
    })
    const overrides = await tx.query.providerReferenceOverride.findMany({
      where: eq(providerReferenceOverride.mediaItemId, plan.albumId),
    })
    const current = await tx.query.providerCurrentState.findMany({
      where: eq(providerCurrentState.mediaItemId, plan.albumId),
    })
    requireReview(
      !references.some(({ provider }) => provider === plan.provider) &&
        !overrides.some(({ provider }) => provider === plan.provider) &&
        !current.some(({ provider }) => provider === plan.provider),
      'The target provider reference or snapshot changed after review.',
    )
    const rejections = await readAlbumMatchRejections(tx, plan.albumId)
    const libraryTracks = albumEvidenceTrackNames(
      tracks.map(({ title }) => title),
    )
    const releaseHints = []
    for (const anchor of plan.anchors) {
      const isRejected = createAlbumMatchRejectionPredicate(
        anchor.provider,
        rejections,
      )
      const candidates = references.filter(
        (reference) =>
          matchesAlbumReleaseReference(anchor.provider, reference) &&
          !isRejected(reference),
      )
      const primaries = candidates.filter(({ isPrimary }) => isPrimary)
      const activeIds = new Set(
        (primaries.length ? primaries : candidates).map(
          ({ externalId }) => externalId,
        ),
      )
      requireReview(
        candidates.some(
          ({ referenceType, externalId }) =>
            referenceType === anchor.referenceType &&
            externalId === anchor.recordId,
        ) &&
          activeIds.size === 1 &&
          activeIds.has(anchor.recordId) &&
          !overrides.some(
            (reference) =>
              matchesAlbumReleaseReference(anchor.provider, reference) &&
              (reference.referenceType !== anchor.referenceType ||
                reference.externalId !== anchor.recordId),
          ) &&
          current.some(
            ({ provider, latestSnapshotId }) =>
              provider === anchor.snapshotProvider &&
              latestSnapshotId === anchor.snapshotId,
          ),
        'An active linked edition or its snapshot changed after review.',
      )
      const snapshot = await tx.query.providerSnapshot.findFirst({
        columns: { payload: true },
        where: and(
          eq(providerSnapshot.id, anchor.snapshotId),
          eq(providerSnapshot.mediaItemId, plan.albumId),
          eq(providerSnapshot.provider, anchor.snapshotProvider),
        ),
      })
      const hint =
        snapshot &&
        readAlbumReleaseHint(
          anchor.provider,
          anchor.recordId,
          anchor.snapshotProvider,
          snapshot.payload,
          libraryTracks,
        )
      requireReview(
        hint,
        'A pinned snapshot does not contain the active linked edition.',
      )
      if ('evidence' in anchor) {
        const { evidence } = anchor
        requireReview(
          evidence.title === hint.title &&
            isDeepStrictEqual(evidence.artists, hint.artists) &&
            (evidence.year === undefined || evidence.year === hint.year) &&
            (evidence.releaseDate === undefined ||
              evidence.releaseDate === hint.releaseDate) &&
            (evidence.completeTracks === undefined ||
              (hint.trackEvidence?.exactSequence &&
                evidence.completeTracks === hint.trackEvidence.libraryTracks)),
          'The pinned source no longer proves its reviewed release evidence.',
        )
      }
      releaseHints.push(hint)
    }

    const originals = await tx
      .select()
      .from(providerResponse)
      .where(
        and(
          eq(providerResponse.jobId, original.id),
          eq(providerResponse.jobItemId, item.id),
          eq(providerResponse.attempt, plan.attempt),
        ),
      )
      .orderBy(asc(providerResponse.ordinal))
    const { captures, boundDetail, localBodies, localProvenance, provenance } =
      bindArchivedResponses(
        plan,
        originals,
        original.finishedAt,
        archive,
        localOriginals,
      )
    const artistRows = originals.filter(({ phase }) => phase === 'artist')
    requireReview(
      plan.version === 1
        ? artistRows.length <= 1
        : isDeepStrictEqual(
            artistRows.map(({ artistId }) => artistId),
            plan.artistLookups.map(({ artistId }) => artistId),
          ),
      'The archived artist lookups changed after review.',
    )
    const artistLookups = artistRows.map(({ artistId }, index) => {
      const artist = credits.find(
        (credit) => credit.artistId === artistId,
      )?.artist
      requireReview(artist, 'The archived artist is outside the album credit.')
      return {
        id: artist.id,
        name: artist.name,
        providerArtistId:
          plan.version === 2
            ? (plan.artistLookups[index]?.providerArtistId ?? null)
            : null,
      }
    })
    requireReview(
      !createAlbumMatchRejectionPredicate(
        plan.provider,
        rejections,
      )({
        referenceType: 'group',
        externalId: plan.groupId,
      }),
      'The reviewed release group was rejected.',
    )
    if (plan.version === 1) {
      const spotify = releaseHints.find(({ source }) => source === 'spotify')
      requireReview(
        spotify?.title === plan.library.title &&
          spotify.releaseDate === plan.library.date &&
          isDeepStrictEqual(spotify.artists, plan.library.artists) &&
          spotify.trackEvidence?.exactSequence &&
          spotify.trackEvidence.libraryTracks === plan.library.tracks.length,
        'The stored Spotify edition no longer proves the reviewed ordered tracks.',
      )
    }
    const existingReferences: PluginReference[] = references.map(
      (reference) => ({
        referenceType: reference.referenceType,
        externalId: reference.externalId,
        isPrimary: reference.isPrimary,
        metadata: { ...reference.metadata, sourceProvider: reference.provider },
      }),
    )
    const limit = original.options.matchEvidenceLimit
    const input = ArchivedAlbumReplayInputSchema.parse({
      adapter: plan.adapter,
      projector: plan.projector,
      dependencies: plan.dependencies,
      provider: plan.provider,
      albumId: plan.albumId,
      groupId: plan.groupId,
      artistLookups,
      media: {
        title: plan.library.title,
        artists: plan.library.artists,
        releaseDate: plan.library.date,
        releaseHints,
      },
      existingReferences,
      rejections,
      options: typeof limit === 'number' ? { matchEvidenceLimit: limit } : {},
      captures,
      localBodies,
      boundDetail,
    })
    const output = PluginResultSchema.parse(
      await runIsolatedArchivedReplay(input),
    )
    const [reference] = output.normalized.references
    requireReview(
      output.normalized.references.length === 1 &&
        reference?.referenceType === 'group' &&
        reference.externalId === plan.groupId &&
        reference.isPrimary,
      'The archived adapter did not reproduce the reviewed release group.',
    )
    if (plan.version === 2)
      requireReview(
        checksumJson(output) === plan.reviewedResultSha256,
        'The archived adapter output differs from the reviewed release metadata.',
      )

    const id = nanoid()
    const now = new Date()
    const archivedReplay = JsonValueSchema.parse(
      JSON.parse(
        JSON.stringify({
          sourceJobItemId: item.id,
          sourceAttempt: plan.attempt,
          originals: plan.originals.map(({ responseId, sha256 }) => ({
            responseId,
            sha256,
          })),
          ...(localProvenance.length
            ? { localOriginals: localProvenance }
            : {}),
          ...provenance,
          ...(plan.version === 2
            ? { reviewedResultSha256: plan.reviewedResultSha256 }
            : {}),
          anchors: plan.anchors,
          adapterSha256: plan.adapter.sha256,
          projectorSha256: plan.projector.sha256,
          dependencySha256: plan.dependencies.map(({ sha256 }) => sha256),
          groupId: plan.groupId,
        }),
      ),
    )
    await tx.insert(scrapeJob).values({
      id,
      provider: plan.provider,
      status: 'succeeded',
      scope: original.scope,
      startedAt: now,
      finishedAt: now,
      requestedByUserId: original.requestedByUserId,
      options: {
        ...(typeof original.options.batchId === 'string'
          ? { batchId: original.options.batchId }
          : {}),
        retryOf: original.id,
        archivedReplayPlanSha256: planSha256,
        archivedReplay,
      },
    })
    await applyProviderResultInTransaction(
      {
        mediaItemId: plan.albumId,
        mediaType: 'album',
        provider: plan.provider,
        source: 'archived-replay',
        payload: output.payload,
        normalized: output.normalized,
        scrapeJobId: id,
      },
      tx,
    )
    await tx.insert(scrapeJobItem).values({
      id: nanoid(),
      jobId: id,
      mediaItemId: plan.albumId,
      provider: plan.provider,
      status: 'succeeded',
      attemptCount: 1,
      startedAt: now,
      finishedAt: now,
      message: 'Metadata applied from archived provider responses.',
    })
    await tx
      .update(scrapeJob)
      .set({
        options: {
          ...original.options,
          retryJobId: id,
          ...(getJobDismissal(original.options)
            ? {}
            : {
                dismissal: { dismissedAt: now.toISOString(), userId: null },
              }),
        },
      })
      .where(eq(scrapeJob.id, original.id))
    await tx.insert(scrapeJobLog).values([
      {
        id: nanoid(),
        jobId: original.id,
        level: 'info',
        message: 'A replacement used archived provider responses.',
        metadata: { retryJobId: id },
      },
      {
        id: nanoid(),
        jobId: id,
        level: 'info',
        message: 'Replayed archived provider responses without a live lookup.',
        metadata: { sourceJobId: original.id },
      },
    ])
    return { jobId: id, outcome: 'committed' }
  })
}
