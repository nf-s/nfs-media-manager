import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, asc, eq, exists, gt, inArray, sql, type SQL } from 'drizzle-orm'
import type { PluginReference } from '@repo/media-plugin-sdk'
import { db } from '@/lib/db'
import { normalizeMdblistPayload } from '@/lib/mdblist-normalizer'
import { checksumJson } from '@/lib/media-utils'
import {
  mediaItem,
  providerCurrentState,
  providerReference,
  providerReferenceOverride,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
} from '@/schemas/db'
import {
  insertMdblistFilmReferences,
  isBlockedFilmReference,
  lockFilmReferenceWrites,
} from '@/services/film-reference-state'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const batchSize = 100
const referenceTypes = ['imdb', 'tmdb', 'trakt']

function currentSnapshots(tx: Transaction, scope?: SQL) {
  const successfulItem = tx
    .select({ id: scrapeJobItem.id })
    .from(scrapeJobItem)
    .where(
      and(
        eq(scrapeJobItem.jobId, scrapeJob.id),
        eq(scrapeJobItem.mediaItemId, mediaItem.id),
        eq(scrapeJobItem.provider, 'mdblist'),
        eq(scrapeJobItem.status, 'succeeded'),
        eq(scrapeJobItem.payload, providerSnapshot.payload),
      ),
    )
  return tx
    .select({
      mediaItemId: mediaItem.id,
      snapshotId: providerSnapshot.id,
      payload: providerSnapshot.payload,
    })
    .from(providerCurrentState)
    .innerJoin(mediaItem, eq(mediaItem.id, providerCurrentState.mediaItemId))
    .innerJoin(
      providerSnapshot,
      and(
        eq(providerSnapshot.id, providerCurrentState.latestSnapshotId),
        eq(providerSnapshot.mediaItemId, mediaItem.id),
        eq(providerSnapshot.checksum, providerCurrentState.checksum),
      ),
    )
    .innerJoin(scrapeJob, eq(scrapeJob.id, providerSnapshot.scrapeJobId))
    .where(
      and(
        eq(mediaItem.mediaType, 'film'),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
        eq(providerCurrentState.provider, 'mdblist'),
        eq(providerCurrentState.status, 'ready'),
        eq(providerSnapshot.provider, 'mdblist'),
        eq(providerSnapshot.source, 'scrape-job'),
        eq(scrapeJob.provider, 'mdblist'),
        exists(successfulItem),
        scope,
      ),
    )
    .orderBy(asc(mediaItem.id))
    .limit(batchSize)
}

type Snapshot = Awaited<ReturnType<typeof currentSnapshots>>[number]

type Reference = Pick<PluginReference, 'referenceType' | 'externalId'>
type CurrentReference = Reference & {
  provider: string
  metadata: PluginReference['metadata'] | null
}

function matchingSnapshotReferences(
  row: Snapshot,
  current: CurrentReference[],
  historical: Reference[],
) {
  const independent = current.filter(({ provider }) => provider !== 'mdblist')
  const imdb = independent.find(({ referenceType }) => referenceType === 'imdb')
  const tmdb = independent.find(({ referenceType }) => referenceType === 'tmdb')
  if (!imdb && !tmdb) return null
  if (current.some(isBlockedFilmReference)) return null
  const known = [...current, ...historical]
  let references: PluginReference[]
  try {
    references = normalizeMdblistPayload(
      row.payload,
      { imdb: imdb?.externalId, tmdb: tmdb?.externalId },
      known,
    ).normalized.references
  } catch {
    return null
  }
  if (
    known.some(
      (knownReference) =>
        !references.some(
          ({ referenceType, externalId }) =>
            referenceType === knownReference.referenceType &&
            externalId === knownReference.externalId,
        ),
    )
  )
    return null
  return references.map((reference) => ({
    ...reference,
    metadata: { snapshotId: row.snapshotId },
  }))
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const id = key(row)
    const group = groups.get(id)
    if (group) group.push(row)
    else groups.set(id, [row])
  }
  return groups
}

function referenceKey(reference: Reference) {
  return `${reference.referenceType}:${reference.externalId}`
}

async function planSnapshots(tx: Transaction, snapshots: Snapshot[]) {
  if (!snapshots.length) return []
  const filmIds = snapshots.map(({ mediaItemId }) => mediaItemId)
  const current = groupBy(
    await tx.query.providerReference.findMany({
      columns: {
        mediaItemId: true,
        provider: true,
        referenceType: true,
        externalId: true,
        metadata: true,
      },
      where: and(
        inArray(providerReference.mediaItemId, filmIds),
        inArray(providerReference.referenceType, referenceTypes),
      ),
    }),
    (row) => row.mediaItemId,
  )
  const historical = groupBy(
    await tx.query.providerReferenceOverride.findMany({
      columns: { mediaItemId: true, referenceType: true, externalId: true },
      where: and(
        inArray(providerReferenceOverride.mediaItemId, filmIds),
        inArray(providerReferenceOverride.referenceType, referenceTypes),
      ),
    }),
    (row) => row.mediaItemId,
  )
  const verified = snapshots.map((row) => {
    const references = matchingSnapshotReferences(
      row,
      current.get(row.mediaItemId) ?? [],
      historical.get(row.mediaItemId) ?? [],
    )
    return {
      mediaItemId: row.mediaItemId,
      snapshotId: row.snapshotId,
      references,
    }
  })
  const externalIds = [
    ...new Set(
      verified.flatMap(({ references }) =>
        (references ?? []).map(({ externalId }) => externalId),
      ),
    ),
  ]
  const owners = groupBy(
    externalIds.length
      ? await tx
          .select({
            mediaItemId: mediaItem.id,
            referenceType: providerReference.referenceType,
            externalId: providerReference.externalId,
          })
          .from(providerReference)
          .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
          .where(
            and(
              eq(mediaItem.mediaType, 'film'),
              sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
              inArray(providerReference.referenceType, referenceTypes),
              inArray(providerReference.externalId, externalIds),
            ),
          )
      : [],
    referenceKey,
  )
  return verified.map(({ mediaItemId, snapshotId, references }) => {
    if (
      !references ||
      references.some((reference) =>
        owners
          .get(referenceKey(reference))
          ?.some((owner) => owner.mediaItemId !== mediaItemId),
      )
    )
      return null
    const stored = new Set(
      (current.get(mediaItemId) ?? [])
        .filter(({ provider }) => provider === 'mdblist')
        .map(referenceKey),
    )
    return {
      mediaItemId,
      snapshotId,
      references,
      missing: references.filter(
        (reference) => !stored.has(referenceKey(reference)),
      ),
    }
  })
}

type Plan = NonNullable<Awaited<ReturnType<typeof planSnapshots>>[number]>

export async function backfillMdblistReferences(review?: string) {
  let after: string | undefined
  let scanned = 0
  let conflicts = 0
  const plans: Plan[] = []
  for (;;) {
    const batch = await db.transaction(
      async (tx) => {
        const rows = await currentSnapshots(
          tx,
          after ? gt(mediaItem.id, after) : undefined,
        )
        return { rows, candidates: await planSnapshots(tx, rows) }
      },
      { accessMode: 'read only', isolationLevel: 'repeatable read' },
    )
    if (!batch.rows.length) break
    scanned += batch.rows.length
    for (const candidate of batch.candidates) {
      if (!candidate) conflicts++
      else if (candidate.missing.length) plans.push(candidate)
    }
    after = batch.rows.at(-1)?.mediaItemId
  }
  const claims = new Map<string, number>()
  for (const plan of plans)
    for (const reference of plan.missing) {
      const key = referenceKey(reference)
      claims.set(key, (claims.get(key) ?? 0) + 1)
    }
  const eligible = plans.filter((plan) =>
    plan.missing.every(
      (reference) => claims.get(referenceKey(reference)) === 1,
    ),
  )
  const checksum = checksumJson(eligible)
  if (review !== undefined && review !== checksum)
    throw new Error('The MDBList recovery plan changed. Run a new dry run.')

  let added = 0
  let changed = 0
  if (review !== undefined)
    for (let offset = 0; offset < eligible.length; offset += batchSize) {
      const batch = eligible.slice(offset, offset + batchSize)
      const result = await db.transaction(async (tx) => {
        await lockFilmReferenceWrites(tx)
        const rows = await currentSnapshots(
          tx,
          inArray(
            mediaItem.id,
            batch.map(({ mediaItemId }) => mediaItemId),
          ),
        )
        const planned = new Map(batch.map((plan) => [plan.mediaItemId, plan]))
        const verified = (await planSnapshots(tx, rows))
          .filter((current) => current !== null)
          .filter(
            (current) =>
              checksumJson(current) ===
              checksumJson(planned.get(current.mediaItemId)),
          )
        const inserted = await insertMdblistFilmReferences(tx, verified)
        return {
          added: inserted.length,
          changed: batch.length - verified.length,
        }
      })
      added += result.added
      changed += result.changed
    }

  return {
    applied: review !== undefined,
    scanned,
    conflicts,
    competingFilms: plans.length - eligible.length,
    eligibleFilms: eligible.length,
    eligibleReferences: eligible.reduce(
      (sum, plan) => sum + plan.missing.length,
      0,
    ),
    added,
    changedSinceReview: changed,
    review: checksum,
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2)
  const review = args[0]?.match(/^--apply=([a-f0-9]{64})$/)?.[1]
  if (args.length && (args.length !== 1 || !review)) {
    process.stderr.write(
      'Use no arguments for a dry run, or --apply=<review hash>.\n',
    )
    process.exitCode = 1
  } else {
    void backfillMdblistReferences(review)
      .then((result) =>
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
      )
      .catch((error: unknown) => {
        const reviewChanged =
          error instanceof Error &&
          error.message ===
            'The MDBList recovery plan changed. Run a new dry run.'
        process.stderr.write(
          reviewChanged ? `${error.message}\n` : 'MDBList recovery failed.\n',
        )
        process.exitCode = 1
      })
      .finally(() => db.$client.end())
  }
}
