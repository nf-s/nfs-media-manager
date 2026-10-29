import { nanoid } from 'nanoid'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  RefreshFilmsSchema,
  RefreshPreviewSchema,
  StartRefreshSchema,
} from '@repo/schemas/job'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { providerCurrentState, scrapeJob } from '@/schemas/db'
import { createJob, retryJob } from './jobs'
import { listProviders } from './providers'

export async function validateFilmProviders(ids: string[]) {
  return validateMediaProviders(ids, 'film')
}

export async function validateMediaProviders(
  ids: string[],
  mediaType: 'album' | 'film',
) {
  const available = (await listProviders()).filter(
    (provider) =>
      provider.supportsScrape && provider.mediaTypes.includes(mediaType),
  )
  if (ids.some((id) => !available.some((provider) => provider.id === id)))
    throw new ServerError({
      statusCode: 422,
      message: `Select loaded ${mediaType} scraping providers`,
    })
  return available.filter((provider) => ids.includes(provider.id))
}

export function requireEnrichmentConfirmation(
  count: number,
  confirmed: boolean,
) {
  if (count > 30000)
    throw new ServerError({
      statusCode: 422,
      message:
        'Selection exceeds 30,000 provider jobs; use a smaller selection',
    })
  if (count > 5 && !confirmed)
    throw new ServerError({
      statusCode: 422,
      message: `Confirm queueing ${count} provider jobs before continuing`,
    })
}

export async function queueFilmEnrichment(
  pairs: Array<{ mediaItemId: string; provider: string }>,
  userId: string | null,
  options: { batchId: string; missingOnly: boolean; confirmBroadRun: boolean },
  progress?: (
    queued: number,
    processed: number,
    total: number,
  ) => Promise<void>,
) {
  return queueMediaEnrichment(
    pairs,
    userId,
    { ...options, mediaType: 'film' },
    progress,
  )
}

export async function queueMediaEnrichment(
  pairs: Array<{ mediaItemId: string; provider: string }>,
  userId: string | null,
  options: {
    batchId: string
    missingOnly: boolean
    confirmBroadRun: boolean
    mediaType: 'album' | 'film'
  },
  progress?: (
    queued: number,
    processed: number,
    total: number,
  ) => Promise<void>,
) {
  const unique = [
    ...new Map(
      pairs.map((pair) => [`${pair.provider}:${pair.mediaItemId}`, pair]),
    ).values(),
  ]
  requireEnrichmentConfirmation(unique.length, options.confirmBroadRun)
  const providers = await validateMediaProviders(
    [...new Set(unique.map((pair) => pair.provider))],
    options.mediaType,
  )
  let queued = 0
  let skipped = 0
  const warnings = new Set<string>()
  for (const [index, pair] of unique.entries()) {
    const provider = providers.find((item) => item.id === pair.provider)
    if (
      !provider ||
      provider.secrets.some((field) => field.required && !field.configured)
    ) {
      skipped++
      warnings.add(
        `${provider?.displayName ?? pair.provider}: credentials are missing; configure them before refreshing metadata.`,
      )
      continue
    }
    const [state] = options.missingOnly
      ? await db
          .select({ checked: providerCurrentState.lastScrapedAt })
          .from(providerCurrentState)
          .where(
            and(
              eq(providerCurrentState.mediaItemId, pair.mediaItemId),
              eq(providerCurrentState.provider, pair.provider),
            ),
          )
      : []
    if (state?.checked) {
      skipped++
      continue
    }
    try {
      await createJob(
        {
          provider: pair.provider,
          scope: {
            mediaType: options.mediaType,
            mediaItemIds: [pair.mediaItemId],
            limit: 1,
          },
          options: { batchId: options.batchId },
          confirmBroadRun: false,
        },
        userId,
        { deferUntilReady: true },
      )
      queued++
    } catch (error) {
      if (!(error instanceof ServerError)) throw error
      skipped++
      if (error.response.statusCode !== 409)
        warnings.add(`${provider.displayName}: ${error.response.message}`)
    }
    if (progress && (index % 10 === 0 || index === unique.length - 1))
      await progress(queued, index + 1, unique.length)
  }
  return { batchId: options.batchId, queued, skipped, warnings: [...warnings] }
}

export async function previewFilmRefresh(
  input: z.infer<typeof RefreshFilmsSchema>,
  selection?: string[],
) {
  return previewMediaRefresh(input, 'film', selection)
}

export async function previewMediaRefresh(
  input: z.infer<typeof RefreshFilmsSchema>,
  mediaType: 'album' | 'film',
  selection?: string[],
) {
  const options = RefreshFilmsSchema.parse(input)
  const providers = [...new Set(options.providers)]
  const catalog = await validateMediaProviders(providers, mediaType)
  if (selection?.length === 0) return { total: 0, jobs: 0, items: [] }
  const eligible = sql.join(
    catalog.map((provider) => {
      const identifiers = provider.identifierTypes
      const hasIdentifier = identifiers.length
        ? sql`exists (
      select 1 from provider_reference r where r.media_item_id = m.id and
      ${mediaType === 'album' ? sql`(r.provider = ${provider.id} or (r.reference_type in ('upc', 'ean') and r.external_id ~ '^[0-9]{8,14}$') or (${provider.id} = 'spotify' and r.reference_type = 'spotify' and r.external_id ~ '^[A-Za-z0-9]{22}$')) and` : sql``}
      (${sql.join(
        identifiers.map(
          (type) =>
            sql`(r.reference_type = ${type} and ${type === 'imdb' ? sql`r.external_id ~ '^tt[0-9]+$'` : type === 'tmdb' ? sql`r.external_id ~ '^[0-9]+$'` : sql`length(trim(r.external_id)) > 0`})`,
        ),
        sql` or `,
      )})
    )`
        : sql`true`
      const nameLookup =
        mediaType === 'album' && provider.supportsNameLookup
          ? sql`(length(trim(m.title)) > 0 and exists (select 1 from media_credit c join artist a on a.id = c.artist_id where c.media_item_id = m.id and c.role = 'artist' and length(trim(a.name)) > 0))`
          : sql`false`
      return sql`(p.id = ${provider.id} and (${hasIdentifier} or ${nameLookup}))`
    }),
    sql` or `,
  )
  const providerArray = sql`array[${sql.join(
    providers.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`
  const cutoff = new Date(Date.now() - options.olderThanDays * 86400000)
  const result = await db.execute(sql`
    select m.id, m.title, count(*) over()::int as total,
      jsonb_agg(jsonb_build_object('provider', p.id, 'lastScrapedAt', s.last_scraped_at) order by p.id) as providers
    from media_item m cross join unnest(${providerArray}) as p(id)
    left join provider_current_state s on s.media_item_id = m.id and s.provider = p.id
    where m.media_type = ${mediaType} and coalesce(m.metadata->>'legacyHidden', 'false') <> 'true'
      and (${eligible})
      and (s.last_scraped_at is null or s.last_scraped_at < ${cutoff.toISOString()}::timestamp)
      ${
        selection
          ? sql`and m.id in (${sql.join(
              selection.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }
      and not exists (select 1 from scrape_job_item i join scrape_job j on j.id = i.job_id
        where i.media_item_id = m.id and i.provider = p.id and i.status in ('queued', 'running') and j.status in ('queued', 'running'))
    group by m.id, m.title
    order by case when bool_or(s.last_scraped_at is null) then null else min(s.last_scraped_at) end asc nulls first, m.id
    limit ${options.limit}
  `)
  const rows = z
    .object({
      rows: z.array(
        RefreshPreviewSchema.shape.items.element.extend({ total: z.number() }),
      ),
    })
    .parse(result).rows
  return {
    total: rows[0]?.total ?? 0,
    jobs: rows.reduce((total, row) => total + row.providers.length, 0),
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      providers: row.providers,
    })),
  }
}

export async function startFilmRefresh(
  input: z.infer<typeof StartRefreshSchema>,
  userId: string | null,
) {
  const options = StartRefreshSchema.parse(input)
  const preview = await previewFilmRefresh(options, options.mediaItemIds)
  const pairs = preview.items.flatMap((item) =>
    item.providers.map((provider) => ({
      mediaItemId: item.id,
      provider: provider.provider,
    })),
  )
  if (!pairs.length)
    throw new ServerError({
      statusCode: 409,
      message: 'No stale, unqueued items remain in this selection',
    })
  return queueFilmEnrichment(pairs, userId, {
    batchId: nanoid(),
    missingOnly: false,
    confirmBroadRun: options.confirmBroadRun,
  })
}

export async function retryEnrichmentBatch(
  batchId: string,
  userId: string | null,
  confirmed: boolean,
) {
  const jobs = await db
    .select({ id: scrapeJob.id })
    .from(scrapeJob)
    .where(
      and(
        sql`${scrapeJob.options}->>'batchId' = ${batchId}`,
        sql`${scrapeJob.options}->>'retryJobId' is null`,
        inArray(scrapeJob.status, ['failed', 'cancelled']),
      ),
    )
  requireEnrichmentConfirmation(jobs.length, confirmed)
  let queued = 0
  let skipped = 0
  const warnings = new Set<string>()
  for (const job of jobs) {
    try {
      await retryJob(job.id, userId, confirmed)
      queued++
    } catch (error) {
      if (!(error instanceof ServerError)) throw error
      skipped++
      warnings.add(error.response.message)
    }
  }
  return { batchId, queued, skipped, warnings: [...warnings] }
}
