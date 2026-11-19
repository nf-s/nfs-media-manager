import { isDeepStrictEqual } from 'node:util'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import {
  PluginResultSchema,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { getJobDismissal, getJobTask } from '@repo/schemas/job'
import {
  MAX_PROVIDER_RESPONSE_BYTES,
  ProviderResponseCaptureSchema,
  type ProviderResponseCapture,
} from '@repo/schemas/provider-response'
import {
  archiveSha256,
  ArchivedAlbumReplayError,
  ArchivedAlbumReplayInputSchema,
  type ArchivedAlbumReplayDetail,
  type ArchivedAlbumReplayPlan,
} from '@/lib/archived-album-replay'
import { runIsolatedArchivedReplay } from '@/lib/archived-album-replay-process'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { albumEvidenceTrackNames } from '@/lib/album-release-track-evidence'
import { db } from '@/lib/db'
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

function bindArchivedResponses(
  plan: ArchivedAlbumReplayPlan,
  originals: ResponseRow[],
  finishedAt: Date,
  archive: ArchivedAlbumReplayDetail,
): ProviderResponseCapture[] {
  requireReview(
    originals.length === plan.originals.length,
    'The failed attempt no longer has the reviewed response sequence.',
  )
  const captures = originals.map((row, index) => {
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
        row.retry === null &&
        !row.notFound &&
        row.requestKey &&
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
        body,
      },
    })
  })
  requireReview(
    captures.some(({ phase }) => phase === 'media') &&
      captures.filter(({ phase }) => phase === 'artist').length <= 1 &&
      captures.slice(1).every(({ phase }) => phase === 'media'),
    'The reviewed attempt must contain one album lookup and at most one artist lookup.',
  )
  const detail = plan.supplement
  const destination = new URL(detail.requestUrl)
  requireReview(
    destination.protocol === 'https:' &&
      !destination.username &&
      !destination.password &&
      !destination.hash &&
      Date.parse(detail.capturedAt) > finishedAt.getTime() &&
      Date.parse(detail.capturedAt) <= Date.now() &&
      archive.capturedAt === Date.parse(detail.capturedAt) &&
      archive.id === detail.archiveId &&
      archiveSha256(destination.href) === detail.archiveRequestKey &&
      archive.requestKey === detail.archiveRequestKey &&
      archive.sha256 === detail.sha256 &&
      archiveSha256(archive.text) === detail.sha256 &&
      Buffer.byteLength(archive.text) === archive.retainedBytes &&
      archive.retainedBytes <= MAX_PROVIDER_RESPONSE_BYTES,
    'The independent detail response does not match its reviewed provenance.',
  )
  const detailKey = nativeProviderReplayRequestKey(
    destination.href,
    detail.notFoundOn404,
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
        receivedAt: detail.capturedAt,
        body: {
          state: 'captured',
          text: archive.text,
          redacted: archive.redacted,
        },
      },
    }),
  )
  return captures
}

export async function commitArchivedAlbumReplay(
  plan: ArchivedAlbumReplayPlan,
  planSha256: string,
  archive: ArchivedAlbumReplayDetail,
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
    const captures = bindArchivedResponses(
      plan,
      originals,
      original.finishedAt,
      archive,
    )
    const artistRow = originals.find(({ phase }) => phase === 'artist')
    const artist = credits.find(
      (credit) => credit.artistId === artistRow?.artistId,
    )?.artist
    requireReview(
      !artistRow || artist,
      'The archived artist is outside the album credit.',
    )
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
    const spotify = releaseHints.find(({ source }) => source === 'spotify')
    requireReview(
      spotify?.title === plan.library.title &&
        spotify.releaseDate === plan.library.date &&
        isDeepStrictEqual(spotify.artists, plan.library.artists) &&
        spotify.trackEvidence?.exactSequence &&
        spotify.trackEvidence.libraryTracks === plan.library.tracks.length,
      'The stored Spotify edition no longer proves the reviewed ordered tracks.',
    )
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
      artist: artist ? { id: artist.id, name: artist.name } : undefined,
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
      supplementRequestKey: plan.supplement.archiveRequestKey,
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

    const id = nanoid()
    const now = new Date()
    const detail = plan.supplement
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
        archivedReplay: {
          sourceJobItemId: item.id,
          sourceAttempt: plan.attempt,
          originals: plan.originals,
          supplement: {
            origin: 'independent-reviewed-detail',
            archiveId: detail.archiveId,
            capturedAt: detail.capturedAt,
            requestKey: detail.archiveRequestKey,
            bodySha256: detail.sha256,
            archiveFileSha256: detail.archiveFile.sha256,
            receiptSha256: detail.receiptSha256,
          },
          anchors: plan.anchors,
          adapterSha256: plan.adapter.sha256,
          projectorSha256: plan.projector.sha256,
          dependencySha256: plan.dependencies.map(({ sha256 }) => sha256),
          groupId: plan.groupId,
        },
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
