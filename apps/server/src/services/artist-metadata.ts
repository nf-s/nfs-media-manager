import { or, sql, type SQLWrapper } from 'drizzle-orm'
import { z } from 'zod'
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import { ArtistProviderMetadataSchema } from '@repo/schemas/creators'
import type { ProviderFreshnessFilter } from '@repo/schemas/film-selection'
import { db } from '@/lib/db'
import { listArtistEnrichmentProviderIds } from '@/plugins/registry'

// The literal matches the predicate on the artist job indexes.
const artistJob = sql`job.options->>'task' = ${sql.raw(`'${ARTIST_ENRICHMENT_TASK}'`)}
  and job.options->>'verifySnapshotId' is null`
const attempted = sql`job.started_at is not null and job.status <> 'queued'`
const jobArtist = sql`job.options->>'artistId'`
const latestAttemptOrder = sql`order by job.started_at desc nulls last, job.created_at desc nulls last, job.id desc nulls last`

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
    const successful = sql`select state.artist_id from artist_provider_current_state state
      where state.provider = ${provider}`
    const attemptedByProvider = sql`from scrape_job job
      where ${artistJob} and ${attempted} and job.provider = ${provider}`
    const condition = or(
      ...modes.flatMap((filter) => {
        if (filter.mode === 'all') return []
        if (filter.mode === 'failed')
          return [
            sql`(select job.status ${attemptedByProvider} and ${jobArtist} = ${id}
              ${latestAttemptOrder} limit 1) = 'failed'`,
          ]
        if (filter.mode === 'never')
          return [
            // An index probe avoids joining or rescanning a provider's full history.
            sql`(${id} not in (${successful}) and (
              select 1 ${attemptedByProvider} and ${jobArtist} = ${id} limit 1
            ) is null)`,
          ]
        if (filter.mode === 'unscraped')
          return [sql`${id} not in (${successful})`]
        return [
          sql`${id} not in (
            select state.artist_id from artist_provider_current_state state
            join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
            where state.provider = ${provider}
              and snapshot.created_at >= ${new Date(now - filter.olderThanDays * 86400000).toISOString()}::timestamp
          )`,
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
    select requested.artist_id as "artistId", requested_provider.provider,
      snapshot.created_at at time zone 'UTC' as "lastScrapedAt",
      attempt.started_at at time zone 'UTC' as "lastAttemptAt",
      latest.status as "lastJobStatus"
    from unnest(${sql.param(ids)}::text[]) requested(artist_id)
    cross join unnest(${sql.param(await listArtistEnrichmentProviderIds())}::text[]) requested_provider(provider)
    left join artist_provider_current_state state on state.artist_id = ${id} and state.provider = ${provider}
    left join artist_provider_snapshot snapshot on snapshot.id = state.latest_snapshot_id
    left join lateral (
      select job.status from scrape_job job
      where ${artistJob} and job.provider = ${provider} and ${jobArtist} = ${id}
      order by job.created_at desc nulls last, job.id desc nulls last
      limit 1
    ) latest on true
    left join lateral (
      select job.started_at from scrape_job job
      where ${artistJob} and job.provider = ${provider} and ${jobArtist} = ${id} and ${attempted}
      ${latestAttemptOrder}
      limit 1
    ) attempt on true
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
