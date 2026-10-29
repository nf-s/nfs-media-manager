import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  QueueFilmSelectionSchema,
  ProviderScrapeAttemptSchema,
  lastScrapedField,
  type ProviderFreshnessFilter,
} from '@repo/schemas/film-selection'
import type { AlbumListItem, FilmListItem } from '@repo/schemas/media'
import type { ProviderSummary } from '@repo/schemas/provider'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { canIdentifyMedia } from '@/lib/provider-identification'
import { mediaItem, providerCurrentState, scrapeJobItem } from '@/schemas/db'
import { listProviders } from './providers'
import {
  previewMediaRefresh,
  queueMediaEnrichment,
  requireEnrichmentConfirmation,
  validateMediaProviders,
} from './film-enrichment'

type SelectionFreshnessQuery = {
  provider?: string
  olderThanDays?: number
  freshness: ProviderFreshnessFilter[]
}

export async function listSelectionProviders(
  query: SelectionFreshnessQuery,
  mediaType: 'album' | 'film',
) {
  const providers = (await listProviders()).filter(
    (provider) =>
      provider.supportsScrape && provider.mediaTypes.includes(mediaType),
  )
  const requested = [
    ...(query.provider ? [query.provider] : []),
    ...query.freshness.map((filter) => filter.provider),
  ]
  if (requested.some((id) => !providers.some((provider) => provider.id === id)))
    throw new ServerError({
      statusCode: 422,
      message: `Select loaded ${mediaType} scraping providers`,
    })
  return providers
}

function freshnessExpression(provider: string) {
  // Imports and overrides never advance last_scraped_at.
  return sql`(select s.last_scraped_at from provider_current_state s where s.media_item_id = ${mediaItem.id} and s.provider = ${provider})`
}

async function latestAttempts(
  ids: string[],
  providers: string[],
): Promise<Map<string, z.infer<typeof ProviderScrapeAttemptSchema>>> {
  if (!ids.length || !providers.length) return new Map()
  const attempts = await db
    .selectDistinctOn([scrapeJobItem.mediaItemId, scrapeJobItem.provider], {
      id: scrapeJobItem.mediaItemId,
      provider: scrapeJobItem.provider,
      status: scrapeJobItem.status,
      startedAt: scrapeJobItem.startedAt,
      finishedAt: scrapeJobItem.finishedAt,
      message: scrapeJobItem.message,
      jobId: scrapeJobItem.jobId,
    })
    .from(scrapeJobItem)
    .where(
      and(
        inArray(scrapeJobItem.mediaItemId, ids),
        inArray(scrapeJobItem.provider, providers),
        isNotNull(scrapeJobItem.startedAt),
        ne(scrapeJobItem.status, 'queued'),
      ),
    )
    .orderBy(
      scrapeJobItem.mediaItemId,
      scrapeJobItem.provider,
      desc(scrapeJobItem.startedAt),
      desc(scrapeJobItem.createdAt),
      desc(scrapeJobItem.id),
    )
  return new Map(
    attempts.map((attempt) => [
      JSON.stringify([attempt.id, attempt.provider]),
      ProviderScrapeAttemptSchema.parse({
        ...attempt,
        startedAt: attempt.startedAt?.toISOString(),
        finishedAt: attempt.finishedAt?.toISOString() ?? null,
        error:
          attempt.status === 'failed' || attempt.status === 'cancelled'
            ? attempt.message
            : null,
      }),
    ]),
  )
}

export function selectionBrowseOptions(
  query: SelectionFreshnessQuery & {
    direction: 'asc' | 'desc'
  },
) {
  const filters: ProviderFreshnessFilter[] = [...query.freshness]
  if (query.provider && query.olderThanDays !== undefined)
    filters.push({
      provider: query.provider,
      mode: 'older',
      olderThanDays: query.olderThanDays,
    })
  return {
    sort: query.provider
      ? {
          field: lastScrapedField,
          expression: freshnessExpression(query.provider),
          missingFirst: query.direction === 'asc',
        }
      : undefined,
    conditions: filters.flatMap((filter) => {
      if (filter.mode === 'all') return []
      const freshness = freshnessExpression(filter.provider)
      if (filter.mode === 'failed')
        return [
          sql`${mediaItem.id} in (
          select latest.media_item_id from (
            select distinct on (i.media_item_id) i.media_item_id, i.status
            from scrape_job_item i
            where i.provider = ${filter.provider} and i.started_at is not null and i.status <> 'queued'
            order by i.media_item_id, i.started_at desc, i.created_at desc, i.id desc
          ) latest where latest.status = 'failed'
        )`,
        ]
      if (filter.mode === 'never')
        return [
          sql`${freshness} is null and not exists (
          select 1 from scrape_job_item i
          where i.media_item_id = ${mediaItem.id} and i.provider = ${filter.provider}
            and i.started_at is not null and i.status <> 'queued'
        )`,
        ]
      return [
        filter.mode === 'unscraped'
          ? sql`${freshness} is null`
          : sql`(${freshness} is null or ${freshness} < ${new Date(Date.now() - filter.olderThanDays * 86400000).toISOString()}::timestamp)`,
      ]
    }),
  }
}

export async function annotateSelection<T extends AlbumListItem | FilmListItem>(
  result: { items: T[]; totalCount: number; pageCount: number },
  query: { provider?: string; page: number; size: number },
  providers: ProviderSummary[],
) {
  const states =
    result.items.length && providers.length
      ? await db
          .select({
            id: providerCurrentState.mediaItemId,
            provider: providerCurrentState.provider,
            date: providerCurrentState.lastScrapedAt,
          })
          .from(providerCurrentState)
          .where(
            and(
              inArray(
                providerCurrentState.provider,
                providers.map((provider) => provider.id),
              ),
              inArray(
                providerCurrentState.mediaItemId,
                result.items.map((item) => item.id),
              ),
            ),
          )
      : []
  const byId = new Map(
    states.map((state) => [
      JSON.stringify([state.id, state.provider]),
      state.date?.toISOString() ?? null,
    ]),
  )
  const attempts = await latestAttempts(
    result.items.map((item) => item.id),
    providers.map((provider) => provider.id),
  )
  return {
    ...result,
    page: query.page,
    size: query.size,
    items: result.items.map((item) => {
      const identity = {
        ...item,
        artists: item.credits
          .filter((credit) => credit.role === 'artist')
          .map((credit) => credit.name),
      }
      const providerFreshness = Object.fromEntries(
        providers.map((provider) => [
          provider.id,
          {
            lastScrapedAt:
              byId.get(JSON.stringify([item.id, provider.id])) ?? null,
            hasProviderIdentifier: canIdentifyMedia(provider, identity),
            lastAttempt:
              attempts.get(JSON.stringify([item.id, provider.id])) ?? null,
          },
        ]),
      )
      const legacy = query.provider
        ? providerFreshness[query.provider]
        : undefined
      return {
        ...item,
        lastScrapedAt: legacy?.lastScrapedAt ?? null,
        hasProviderIdentifier: legacy?.hasProviderIdentifier ?? false,
        providerFreshness,
      }
    }),
  }
}

export async function queueMediaSelection(
  input: z.infer<typeof QueueFilmSelectionSchema>,
  mediaType: 'album' | 'film',
  userId: string | null,
) {
  const options = QueueFilmSelectionSchema.parse(input)
  const ids = [...new Set(options.mediaItemIds)]
  const providers = [...new Set(options.providers)]
  requireEnrichmentConfirmation(
    ids.length * providers.length,
    options.confirmBroadRun,
  )
  await validateMediaProviders(providers, mediaType)
  const items = await db
    .select({ id: mediaItem.id })
    .from(mediaItem)
    .where(
      and(
        inArray(mediaItem.id, ids),
        eq(mediaItem.mediaType, mediaType),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  if (items.length !== ids.length)
    throw new ServerError({
      statusCode: 422,
      message: `Selection includes missing or archived ${mediaType}s. Reload and select again.`,
    })
  let pairs =
    options.olderThanDays === undefined
      ? ids.flatMap((mediaItemId) =>
          providers.map((provider) => ({ mediaItemId, provider })),
        )
      : (
          await previewMediaRefresh(
            {
              providers,
              olderThanDays: options.olderThanDays,
              limit: ids.length,
            },
            mediaType,
            ids,
          )
        ).items.flatMap((item) =>
          item.providers.map((provider) => ({
            mediaItemId: item.id,
            provider: provider.provider,
          })),
        )
  const freshness = (options.freshness ?? []).filter(
    (filter) => filter.mode !== 'all',
  )
  if (freshness.length) {
    if (freshness.some((filter) => !providers.includes(filter.provider)))
      throw new ServerError({
        statusCode: 422,
        message: 'Queue freshness filters must match selected providers',
      })
    const states = await db
      .select({
        id: providerCurrentState.mediaItemId,
        provider: providerCurrentState.provider,
        date: providerCurrentState.lastScrapedAt,
      })
      .from(providerCurrentState)
      .where(
        and(
          inArray(providerCurrentState.mediaItemId, ids),
          inArray(
            providerCurrentState.provider,
            freshness.map((filter) => filter.provider),
          ),
        ),
      )
    const dates = new Map(
      states.map((state) => [
        JSON.stringify([state.id, state.provider]),
        state.date,
      ]),
    )
    const byProvider = new Map(
      freshness.map((filter) => [filter.provider, filter]),
    )
    const attempts = await latestAttempts(
      ids,
      freshness.map((filter) => filter.provider),
    )
    const now = Date.now()
    pairs = pairs.filter((pair) => {
      const filter = byProvider.get(pair.provider)
      const date = dates.get(JSON.stringify([pair.mediaItemId, pair.provider]))
      const attempt = attempts.get(
        JSON.stringify([pair.mediaItemId, pair.provider]),
      )
      if (!filter) return true
      if (filter.mode === 'failed') return attempt?.status === 'failed'
      if (filter.mode === 'never') return !date && !attempt
      if (filter.mode === 'unscraped') return !date
      if (!date) return true
      return (
        filter.mode === 'older' &&
        date.getTime() < now - filter.olderThanDays * 86400000
      )
    })
  }
  if (!pairs.length)
    return {
      batchId: options.batchId,
      queued: 0,
      skipped: ids.length * providers.length,
      warnings: [
        'No matching, identified, unqueued provider work remains in this selection.',
      ],
    }
  const result = await queueMediaEnrichment(pairs, userId, {
    batchId: options.batchId,
    missingOnly: false,
    confirmBroadRun: options.confirmBroadRun,
    mediaType,
  })
  return {
    ...result,
    skipped: result.skipped + ids.length * providers.length - pairs.length,
  }
}
