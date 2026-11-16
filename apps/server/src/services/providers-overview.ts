import { and, gte, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ArtistProfileProviderSchema } from '@repo/schemas/artist-profiles'
import {
  ProviderOverviewQuerySchema,
  type ProviderOverview,
  type ProviderOverviewItem,
} from '@repo/schemas/provider'
import { db } from '@/lib/db'
import { isProviderSecretConfigured } from '@/lib/provider-secrets'
import { DAY_MS, HOUR_MS } from '@/lib/request-policy'
import type { ProviderCatalogEntry } from '@/lib/provider-catalog'
import { listProviderCatalog } from '@/plugins/registry'
import { providerRequestEvent, providerSecret, scrapeJob } from '@/schemas/db'
import { jobsNeedingAttention } from '@/services/jobs'
import {
  loadProviderWaitStates,
  providerTurn,
  type ProviderWaitState,
} from '@/services/job-waiting'
import {
  hasAccountSignIn,
  isAccountProvider,
  readAccountConnection,
} from '@/services/provider-connections'

type Library = z.infer<typeof ProviderOverviewQuerySchema>['mediaType']
type SecretRow = typeof providerSecret.$inferSelect

// The same scoping as the Providers page: Subscriptions lists its own
// providers; other account-level providers appear in both media libraries.
function inLibrary(provider: ProviderCatalogEntry, library: Library) {
  if (library === undefined) return true
  if (library === 'subscription') return provider.subscriptions
  if (library === 'artist')
    return ArtistProfileProviderSchema.safeParse(provider.id).success
  return (
    provider.mediaTypes.includes(library) ||
    (provider.mediaTypes.length === 0 && !provider.subscriptions)
  )
}

function roles(provider: ProviderCatalogEntry) {
  const result: ProviderOverviewItem['roles'] = [...provider.mediaTypes]
  if (ArtistProfileProviderSchema.safeParse(provider.id).success)
    result.push('artist')
  if (provider.subscriptions) result.push('subscription')
  if (provider.mediaTypes.length === 0) result.push('account')
  return result
}

function connection(
  provider: ProviderCatalogEntry,
  secrets: SecretRow[],
  state: ProviderWaitState | undefined,
  account: { configured: boolean; connected: boolean } | null,
  userId: string | null,
): ProviderOverviewItem['connection'] {
  const required = provider.secrets.filter((field) => field.required)
  const missing = required.some(
    (field) =>
      !isProviderSecretConfigured(
        provider.id,
        field.key,
        secrets,
        provider.secrets,
      ),
  )
  const halted = state?.halted ?? false
  if (hasAccountSignIn(provider.id)) {
    const method = 'account'
    if (!state?.plugin)
      return {
        state: 'unavailable',
        method,
        detail: 'Provider plugin is not loaded',
      }
    if (missing)
      return {
        state: 'needs-key',
        method,
        detail: 'Add the app credentials to sign in',
      }
    if (halted)
      return {
        state: 'needs-sign-in',
        method,
        detail: 'Access was denied. Sign in again.',
      }
    if (userId === null || account === null)
      return {
        state: 'unavailable',
        method,
        detail: 'Sign-in state needs the owner account',
      }
    if (!account.configured)
      return {
        state: 'needs-key',
        method,
        detail: 'The app credentials are incomplete',
      }
    return account.connected
      ? { state: 'connected', method, detail: 'Signed in' }
      : { state: 'needs-sign-in', method, detail: 'Not signed in' }
  }
  const method = required.length ? 'key' : 'none'
  if (!state?.plugin)
    return {
      state: 'unavailable',
      method,
      detail: 'Provider plugin is not loaded',
    }
  if (!required.length)
    return {
      state: 'not-required',
      method,
      detail: halted ? 'Access was denied' : null,
    }
  if (missing)
    return {
      state: 'needs-key',
      method,
      detail: 'Add the required credentials',
    }
  if (halted)
    return {
      state: 'needs-key',
      method,
      detail: 'Access was denied. Update the credentials.',
    }
  return { state: 'connected', method, detail: 'Key set' }
}

function queue(
  state: ProviderWaitState | undefined,
  queued: number,
): ProviderOverviewItem['queue'] {
  const idle = { reason: null, until: null, detail: null }
  if (!state) return { ...idle, state: queued ? 'waiting' : 'idle' }
  const block = state.block
  if (block)
    return {
      ...block,
      state:
        block.reason === 'access-denied' || block.reason === 'stopped'
          ? 'stopped'
          : block.reason === 'paused'
            ? 'paused'
            : 'waiting',
    }
  if (state.running > 0) return { ...idle, state: 'running' }
  if (queued > 0) return { ...providerTurn(state), state: 'waiting' }
  return { ...idle, state: 'idle' }
}

/**
 * Every provider's connection, queue, job counts and request use in one
 * bounded response, cheap enough to poll. Never returns credential values.
 */
export async function getProvidersOverview(
  input: z.input<typeof ProviderOverviewQuerySchema>,
  userId: string | null,
): Promise<ProviderOverview> {
  const query = ProviderOverviewQuerySchema.parse(input)
  const catalog = (await listProviderCatalog()).filter(
    (provider) =>
      provider.surface === 'provider' && inLibrary(provider, query.mediaType),
  )
  const ids = catalog.map((provider) => provider.id)
  const now = Date.now()
  const from = now - DAY_MS
  if (!ids.length)
    return {
      generatedAt: new Date(now).toISOString(),
      requestsFrom: new Date(from).toISOString(),
      providers: [],
    }
  const [jobRows, requestRows, secretRows, accounts] = await Promise.all([
    db
      .select({
        provider: scrapeJob.provider,
        queued: sql<number>`count(*) filter (where ${scrapeJob.status} = 'queued')::integer`,
        running: sql<number>`count(*) filter (where ${scrapeJob.status} = 'running')::integer`,
        failed: sql<number>`count(*) filter (where ${scrapeJob.status} = 'failed')::integer`,
        attention: sql<number>`count(*) filter (where ${jobsNeedingAttention() ?? sql`false`})::integer`,
        lastSuccessAt: sql<
          number | null
        >`(extract(epoch from max(${scrapeJob.finishedAt}) filter (where ${scrapeJob.status} = 'succeeded')) * 1000)::float8`,
      })
      .from(scrapeJob)
      .where(inArray(scrapeJob.provider, ids))
      .groupBy(scrapeJob.provider),
    db
      .select({
        provider: providerRequestEvent.provider,
        bucket: sql<number>`floor((extract(epoch from ${providerRequestEvent.requestedAt}) * 1000 - ${from}) / ${HOUR_MS})::integer`,
        count: sql<number>`count(*)::integer`,
      })
      .from(providerRequestEvent)
      .where(
        and(
          inArray(providerRequestEvent.provider, ids),
          gte(providerRequestEvent.requestedAt, new Date(from)),
          lt(providerRequestEvent.requestedAt, new Date(now)),
        ),
      )
      .groupBy(providerRequestEvent.provider, sql`2`),
    db
      .select()
      .from(providerSecret)
      .where(inArray(providerSecret.provider, ids)),
    Promise.all(
      ids.map((id) =>
        userId !== null && hasAccountSignIn(id)
          ? readAccountConnection(id, userId)
          : null,
      ),
    ),
  ])
  const jobs = new Map(jobRows.map((row) => [row.provider, row]))
  const states = await loadProviderWaitStates(ids, {
    now,
    running: new Map(jobRows.map((row) => [row.provider, row.running])),
  })
  const requests = new Map<string, number[]>()
  for (const row of requestRows) {
    const counts = requests.get(row.provider) ?? Array<number>(24).fill(0)
    if (row.bucket >= 0 && row.bucket < 24) counts[row.bucket] = row.count
    requests.set(row.provider, counts)
  }
  return {
    generatedAt: new Date(now).toISOString(),
    requestsFrom: new Date(from).toISOString(),
    providers: catalog.map((provider, index) => {
      const state = states.get(provider.id)
      const counts = jobs.get(provider.id)
      const worker = state?.dispatch?.worker ?? null
      return {
        id: provider.id,
        name: provider.displayName,
        description: provider.description,
        group: isAccountProvider(provider.id, provider.mediaTypes)
          ? 'account'
          : 'metadata',
        roles: roles(provider),
        connection: connection(
          provider,
          secretRows.filter((row) => row.provider === provider.id),
          state,
          accounts[index] ?? null,
          userId,
        ),
        queue: queue(state, counts?.queued ?? 0),
        jobs: {
          queued: counts?.queued ?? 0,
          running: counts?.running ?? 0,
          failed: counts?.failed ?? 0,
          attention: counts?.attention ?? 0,
        },
        lastSuccessAt:
          counts?.lastSuccessAt === null || counts?.lastSuccessAt === undefined
            ? null
            : new Date(counts.lastSuccessAt).toISOString(),
        requests24h: requests.get(provider.id) ?? Array<number>(24).fill(0),
        budget: state?.budget ?? null,
        runsOn: worker?.mode === 'local' ? 'local-worker' : 'server',
        worker: worker
          ? {
              paired: worker.paired,
              online: worker.online,
              blocked: worker.blocked,
            }
          : null,
        concurrency: state?.concurrency ?? null,
      }
    }),
  }
}
