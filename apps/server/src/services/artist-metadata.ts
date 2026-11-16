import { or, sql, type SQLWrapper } from 'drizzle-orm'
import { z } from 'zod'
import {
  ARTIST_ENRICHMENT_TASK,
  ArtistProfileProviderSchema,
} from '@repo/schemas/artist-profiles'
import { ArtistProviderMetadataSchema } from '@repo/schemas/creators'
import type { ProviderFreshnessFilter } from '@repo/schemas/film-selection'
import { db } from '@/lib/db'

export function artistLastScrapedAt(id: SQLWrapper, provider: string) {
  return sql`(
    select snapshot.created_at
    from artist_provider_current_state state
    join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
    where state.artist_id = ${id} and state.provider = ${provider}
  )`
}

export function artistFreshnessConditions(
  id: SQLWrapper,
  filters: ProviderFreshnessFilter[],
) {
  const providers = [...new Set(filters.map((filter) => filter.provider))]
  const now = Date.now()
  return providers.flatMap((provider) => {
    const modes = filters.filter((filter) => filter.provider === provider)
    if (modes.some((filter) => filter.mode === 'all')) return []
    const lastScrapedAt = artistLastScrapedAt(id, provider)
    const condition = or(
      ...modes.flatMap((filter) => {
        if (filter.mode === 'all') return []
        if (filter.mode === 'failed')
          return [
            sql`${id} in (
            select latest.artist_id from (
              select distinct on (job.options->>'artistId') job.options->>'artistId' as artist_id, job.status
              from scrape_job job
              where job.options->>'task' = ${ARTIST_ENRICHMENT_TASK} and job.provider = ${provider}
                and job.started_at is not null and job.status <> 'queued'
              order by job.options->>'artistId', job.started_at desc, job.created_at desc, job.id desc
            ) latest where latest.status = 'failed'
          )`,
          ]
        if (filter.mode === 'never')
          return [
            sql`${lastScrapedAt} is null and not exists (
            select 1 from scrape_job job
            where job.options->>'task' = ${ARTIST_ENRICHMENT_TASK}
              and job.options->>'artistId' = ${id} and job.provider = ${provider}
              and job.started_at is not null and job.status <> 'queued'
          )`,
          ]
        if (filter.mode === 'unscraped') return [sql`${lastScrapedAt} is null`]
        return [
          sql`(${lastScrapedAt} is null or ${lastScrapedAt} < ${new Date(now - filter.olderThanDays * 86400000).toISOString()}::timestamp)`,
        ]
      }),
    )
    return condition ? [condition] : []
  })
}

const MetadataRowSchema = ArtistProviderMetadataSchema.extend({
  artistId: z.string(),
  lastScrapedAt: z.coerce.date().nullable(),
  lastAttemptAt: z.coerce.date().nullable(),
})

/** Read current dates and latest jobs only for the returned directory page. */
export async function loadArtistMetadata(ids: string[]) {
  if (!ids.length) return []
  const id = sql`requested.artist_id`
  const provider = sql`requested_provider.provider`
  const result = await db.execute(sql`
    with latest_jobs as (
      select distinct on (job.options->>'artistId', job.provider)
        job.options->>'artistId' as artist_id, job.provider, job.status,
        max(job.started_at) filter (where job.status <> 'queued')
          over (partition by job.options->>'artistId', job.provider) as last_attempt_at
      from scrape_job job
      where job.options->>'task' = ${ARTIST_ENRICHMENT_TASK}
        and job.options->>'artistId' = any(${sql.param(ids)}::text[])
        and job.provider = any(${sql.param(ArtistProfileProviderSchema.options)}::text[])
      order by job.options->>'artistId', job.provider, job.created_at desc, job.id desc
    )
    select requested.artist_id as "artistId", requested_provider.provider,
      snapshot.created_at at time zone 'UTC' as "lastScrapedAt",
      latest.last_attempt_at at time zone 'UTC' as "lastAttemptAt",
      latest.status as "lastJobStatus"
    from unnest(${sql.param(ids)}::text[]) requested(artist_id)
    cross join unnest(${sql.param(ArtistProfileProviderSchema.options)}::text[]) requested_provider(provider)
    left join artist_provider_current_state state on state.artist_id = ${id} and state.provider = ${provider}
    left join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
    left join latest_jobs latest on latest.artist_id = ${id} and latest.provider = ${provider}
  `)
  return z
    .array(MetadataRowSchema)
    .parse(result.rows)
    .map((row) => ({
      ...row,
      lastScrapedAt: row.lastScrapedAt?.toISOString() ?? null,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    }))
}
