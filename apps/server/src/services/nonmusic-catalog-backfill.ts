import { and, asc, eq, gt, inArray, like, or } from 'drizzle-orm'
import { PluginNormalizedResultSchema } from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  isJsonRecord,
  normalizeOmdbPayload,
  normalizeTmdbPayload,
} from '@/lib/provider-normalizers'
import {
  LotRadioEpisodePageSchema,
  lotRadioFlightRows,
  normalizeLotRadioItem,
} from '@/lib/lotradio-api'
import {
  mediaItem,
  providerResponse,
  providerSnapshot,
  scrapeJobItem,
  subscriptionItem,
  subscriptionShort,
  subscriptionSource,
} from '@/schemas/db'
import { observeCatalogOccurrences } from './catalog-discoveries'
import { observeFilmRelations } from './film-catalog-observations'
import { projectTmdbResponse } from './provider-response-history'
import {
  observeStationEpisodes,
  observeSubscriptionPage,
  projectSubscriptionResponse,
} from './subscription-catalog-observations'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const NonMusicBackfillInput = z.object({
  family: z.enum([
    'film-snapshots',
    'responses',
    'subscription-sources',
    'subscription-items',
    'shorts',
  ]),
  after: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(25),
})
type BackfillInput = z.input<typeof NonMusicBackfillInput>

async function projectFilmSnapshots(
  tx: Transaction,
  after: string,
  limit: number,
) {
  const rows = await tx
    .select({
      id: providerSnapshot.id,
      filmId: mediaItem.id,
      provider: providerSnapshot.provider,
      payload: providerSnapshot.payload,
      normalizedData: providerSnapshot.normalizedData,
      jobId: providerSnapshot.scrapeJobId,
      createdAt: providerSnapshot.createdAt,
    })
    .from(providerSnapshot)
    .innerJoin(mediaItem, eq(mediaItem.id, providerSnapshot.mediaItemId))
    .where(and(eq(mediaItem.mediaType, 'film'), gt(providerSnapshot.id, after)))
    .orderBy(asc(providerSnapshot.id))
    .limit(limit)
  let projected = 0
  for (const row of rows) {
    const legacy =
      row.normalizedData === null && isJsonRecord(row.payload)
        ? row.provider === 'tmdb'
          ? normalizeTmdbPayload(row.payload).normalized
          : row.provider === 'omdb'
            ? normalizeOmdbPayload(row.payload).normalized
            : row.provider === 'nfo'
              ? {}
              : undefined
        : undefined
    const normalized = PluginNormalizedResultSchema.safeParse(
      row.normalizedData ?? legacy ?? null,
    )
    if (!normalized.success) continue
    await observeFilmRelations(tx, row.filmId, row.payload, normalized.data, {
      provider: row.provider,
      operation: 'film-details',
      occurrenceKey: row.id,
      snapshotId: row.id,
      jobId: row.jobId ?? undefined,
      observedAt: row.createdAt,
    })
    projected++
  }
  return { rows, projected }
}

async function projectResponses(tx: Transaction, after: string, limit: number) {
  const rows = await tx
    .select({
      id: providerResponse.id,
      provider: providerResponse.provider,
      body: providerResponse.body,
      jobId: providerResponse.jobId,
      requestUrl: providerResponse.requestUrl,
      status: providerResponse.status,
      receivedAt: providerResponse.receivedAt,
      subjectId: scrapeJobItem.mediaItemId,
    })
    .from(providerResponse)
    .leftJoin(scrapeJobItem, eq(scrapeJobItem.id, providerResponse.jobItemId))
    .where(
      and(
        gt(providerResponse.id, after),
        or(
          inArray(providerResponse.provider, [
            'tmdb',
            'youtube',
            'rinse',
            'nts',
            'lotradio',
          ]),
          eq(
            providerResponse.requestUrl,
            'https://api.spotify.com/v1/me/shows',
          ),
          like(
            providerResponse.requestUrl,
            'https://api.spotify.com/v1/shows/%/episodes',
          ),
        ),
      ),
    )
    .orderBy(asc(providerResponse.id))
    .limit(limit)
  let projected = 0
  for (const row of rows) {
    if (row.provider === 'tmdb')
      projected += Number(
        (await projectTmdbResponse(tx, row, row.subjectId ?? undefined)) > 0,
      )
    else if (
      row.provider === 'lotradio' &&
      row.body.state === 'captured' &&
      row.body.retainedRepresentation === 'station-episode-data' &&
      row.receivedAt
    ) {
      const page = lotRadioFlightRows(row.body.text).flatMap((value) => {
        const parsed = LotRadioEpisodePageSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })[0]
      if (!page) continue
      const observedAt = row.receivedAt
      const entries = page.items.flatMap((item) => {
        const normalized = normalizeLotRadioItem(item, observedAt)
        return normalized ? [normalized] : []
      })
      const origin = {
        provider: row.provider,
        operation: 'station-feed',
        occurrenceKey: row.id,
        jobId: row.jobId,
        responseId: row.id,
        observedAt,
      }
      await observeSubscriptionPage(
        tx,
        'subscription-source',
        [...new Set(entries.map(({ show }) => show.id))],
        origin,
      )
      await observeStationEpisodes(tx, entries, origin)
      projected += Number(entries.length > 0)
    } else projected += Number((await projectSubscriptionResponse(tx, row)) > 0)
  }
  return { rows, projected }
}

async function projectStoredSubscriptions(
  tx: Transaction,
  family: 'subscription-sources' | 'subscription-items' | 'shorts',
  after: string,
  limit: number,
) {
  if (family === 'subscription-sources') {
    const rows = await tx
      .select({
        id: subscriptionSource.id,
        type: subscriptionSource.type,
        createdAt: subscriptionSource.createdAt,
      })
      .from(subscriptionSource)
      .where(gt(subscriptionSource.id, after))
      .orderBy(asc(subscriptionSource.id))
      .limit(limit)
    await observeCatalogOccurrences(
      tx,
      rows.map((row) => ({
        target: { kind: 'subscription-source', id: row.id },
        origin: {
          provider: row.type,
          operation: 'stored-subscription-source',
          occurrenceKey: row.id,
          observedAt: row.createdAt,
        },
      })),
    )
    return { rows, projected: rows.length }
  }
  if (family === 'shorts') {
    const rows = await tx
      .select({
        id: subscriptionShort.id,
        sourceId: subscriptionShort.sourceId,
      })
      .from(subscriptionShort)
      .where(gt(subscriptionShort.id, after))
      .orderBy(asc(subscriptionShort.id))
      .limit(limit)
    await observeCatalogOccurrences(
      tx,
      rows.map((row) => ({
        target: { kind: 'subscription-item', id: row.id },
        origin: {
          provider: 'youtube',
          operation: 'stored-short',
          occurrenceKey: row.id,
          subjectKind: 'subscription-source',
          subjectId: row.sourceId,
          relationshipRole: 'short',
        },
      })),
    )
    return { rows, projected: rows.length }
  }
  const rows = await tx
    .select({
      id: subscriptionItem.id,
      sourceId: subscriptionItem.sourceId,
      type: subscriptionItem.type,
      createdAt: subscriptionItem.createdAt,
      publishedAt: subscriptionItem.publishedAt,
      publishedPrecision: subscriptionItem.publishedPrecision,
    })
    .from(subscriptionItem)
    .where(gt(subscriptionItem.id, after))
    .orderBy(asc(subscriptionItem.id))
    .limit(limit)
  await observeCatalogOccurrences(
    tx,
    rows.map((row) => ({
      target: { kind: 'subscription-item', id: row.id },
      origin: {
        provider: row.type,
        operation: 'stored-subscription-item',
        occurrenceKey: row.id,
        subjectKind: 'subscription-source',
        subjectId: row.sourceId,
        relationshipRole: 'episode-of',
        observedAt: row.createdAt,
        details: {
          publishedAt: row.publishedAt.toISOString(),
          publishedPrecision: row.publishedPrecision,
        },
      },
    })),
  )
  return { rows, projected: rows.length }
}

/** Replays one bounded batch through the live projectors using stored evidence only. */
export async function backfillNonMusicCatalog(
  tx: Transaction,
  input: BackfillInput,
) {
  const { family, after = '', limit } = NonMusicBackfillInput.parse(input)
  const { rows, projected } =
    family === 'film-snapshots'
      ? await projectFilmSnapshots(tx, after, limit)
      : family === 'responses'
        ? await projectResponses(tx, after, limit)
        : await projectStoredSubscriptions(tx, family, after, limit)
  return {
    family,
    scanned: rows.length,
    projected,
    skipped: rows.length - projected,
    next: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
  }
}

/** A dry run uses the same writes in a transaction and rolls them back. */
export async function runNonMusicCatalogBackfill(
  input: BackfillInput,
  apply = false,
) {
  let report: Awaited<ReturnType<typeof backfillNonMusicCatalog>> | undefined
  const dryRun = new Error('Catalog backfill dry run completed')
  try {
    await db.transaction(async (tx) => {
      report = await backfillNonMusicCatalog(tx, input)
      if (!apply) throw dryRun
    })
  } catch (error) {
    if (error !== dryRun) throw error
  }
  return report
}
