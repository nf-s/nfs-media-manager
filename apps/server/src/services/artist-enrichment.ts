import {
  ARTIST_ENRICHMENT_TASK,
  ArtistEnrichmentInputSchema,
  type ArtistEnrichmentInput,
  type ArtistProfileProvider,
} from '@repo/schemas/artist-profiles'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createJobDiagnostics } from '@/lib/job-diagnostics'
import { jobLogSecrets } from '@/lib/job-errors'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  ArtistSearchAmbiguousError,
  lookupArtistProvider,
  normalizeArtistProviderId,
} from '@/plugins/builtin/artist-providers'
import { getScrapePlugin } from '@/plugins/registry'
import {
  loadArtistProviderTarget,
  saveArtistProviderResult,
} from './artist-profiles'
import { listStoredArtistProviderCandidates } from './artist-provider-evidence'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'

const ArtistEnrichmentOptionsSchema = ArtistEnrichmentInputSchema.extend({
  artistId: z.string().min(1),
}).strip()

async function artistProvider(provider: ArtistProfileProvider) {
  const plugin = await getScrapePlugin(provider)
  if (!plugin)
    throw new ServerError({
      statusCode: 422,
      message: 'Provider is unavailable.',
    })
  const rows = await db.query.providerSecret.findMany({
    where: (table, operators) => operators.eq(table.provider, provider),
  })
  const secrets = resolveProviderSecrets(
    provider,
    rows,
    plugin.manifest.secrets,
  )
  // Discogs credentials can belong to the configured local request worker.
  if (
    provider !== 'discogs' &&
    plugin.manifest.secrets.some(
      (field) => field.required && !secrets[field.key]?.trim(),
    )
  )
    throw new ServerError({
      statusCode: 422,
      message:
        'Configure ' +
        plugin.manifest.displayName +
        ' credentials in Providers before refreshing artist metadata.',
    })
  return { plugin, secrets }
}

export async function prepareArtistEnrichment(
  _userId: string | null,
  input: Record<string, unknown>,
) {
  const { artistId, provider, providerArtistId } =
    ArtistEnrichmentOptionsSchema.parse(input)
  const target = await loadArtistProviderTarget(artistId, provider)
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
  const requested = providerArtistId
    ? normalizeArtistProviderId(provider, providerArtistId)
    : null
  if (providerArtistId && !requested)
    throw new ServerError({
      statusCode: 422,
      message: 'Invalid provider artist identifier.',
    })
  await artistProvider(provider)
  return {
    artistId,
    artistName: target.name,
    provider,
    groupKey: artistId,
    ...(requested ? { providerArtistId: requested } : {}),
  }
}

export async function runArtistEnrichment(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  let diagnostics: ReturnType<typeof createJobDiagnostics> | undefined
  try {
    const { artistId, provider, providerArtistId } =
      ArtistEnrichmentOptionsSchema.parse(input)
    await context.assertActive()
    const target = await loadArtistProviderTarget(artistId, provider)
    if (!target)
      throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
    const { plugin, secrets } = await artistProvider(provider)
    diagnostics = createJobDiagnostics(jobLogSecrets(secrets))
    let id = providerArtistId ?? target.providerArtistId
    if (!id) {
      const candidates = await listStoredArtistProviderCandidates(
        artistId,
        target.name,
        provider,
      )
      if (candidates.length > 1) {
        diagnostics.recordDiagnostic({
          stage: 'artist.stored-candidates',
          evidence: {
            total: candidates.length,
            candidates: candidates.slice(0, 5),
          },
        })
        throw new ArtistSearchAmbiguousError()
      }
      const [candidate] = candidates
      if (candidate?.exact) id = candidate.id
    }
    const totalPages = id ? 1 : 2
    await context.progress({ pagesRead: 0, totalPages })
    const result = await lookupArtistProvider(provider, target.name, id, {
      secrets,
      request: createProviderRequest(plugin, context.assertActive),
      recordDiagnostic: diagnostics.recordDiagnostic,
      searched: () => context.progress({ pagesRead: 1, totalPages }),
    }).catch(async (error: unknown) => {
      if (await context.isActive()) {
        if (
          error instanceof ArtistSearchAmbiguousError ||
          isProviderItemNotFoundError(error)
        )
          await recordProviderSuccess(provider)
        else await recordProviderFailure(plugin, error)
      }
      throw error
    })
    await context.assertActive()
    await recordProviderSuccess(provider)
    return {
      outcome: 'complete',
      message: 'Artist profile saved.',
      options: { progress: { pagesRead: totalPages, totalPages } },
      persist: (tx) =>
        saveArtistProviderResult(
          artistId,
          provider,
          { ...result, scrapeJobId: context.jobId },
          tx,
        ),
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    const classification =
      error instanceof ArtistSearchAmbiguousError
        ? 'ambiguous'
        : isProviderItemNotFoundError(error)
          ? 'not-found'
          : undefined
    return {
      outcome: 'failed',
      failureClassification: classification,
      error:
        error instanceof SyntaxError
          ? new Error('Provider returned invalid JSON.')
          : error,
      metadata: { diagnostics: diagnostics?.snapshot() ?? [] },
    }
  }
}

export function enqueueArtistEnrichment(
  input: ArtistEnrichmentInput & { artistId: string },
  userId: string | null,
) {
  return createTaskJob(ARTIST_ENRICHMENT_TASK, userId, { taskOptions: input })
}
