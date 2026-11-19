import {
  ARTIST_ENRICHMENT_TASK,
  ArtistEnrichmentInputSchema,
  ArtistProfileProviderSchema,
  type ArtistEnrichmentInput,
  type ArtistProviderId,
} from '@repo/schemas/artist-profiles'
import {
  isProviderArtistSearchAmbiguousError,
  isProviderItemNotFoundError,
  PluginArtistResultSchema,
  type MediaPluginArtistContext,
  type MediaProviderPlugin,
} from '@repo/media-plugin-sdk'
import { z } from 'zod'
import { db } from '@/lib/db'
import { env } from '@/env'
import { ServerError } from '@/lib/error'
import { createJobDiagnostics } from '@/lib/job-diagnostics'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
  ProviderResponseStorageError,
} from '@/lib/provider-response-history'
import { jobLogSecrets } from '@/lib/job-errors'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  ArtistSearchAmbiguousError,
  lookupArtistProvider,
  normalizeArtistProviderId,
} from '@/plugins/builtin/artist-providers'
import { getScrapePlugin } from '@/plugins/registry'
import {
  loadCurrentArtistPayloads,
  loadArtistProviderTarget,
  resolveLegacyArtistRelationships,
  saveArtistProviderResult,
} from './artist-profiles'
import {
  listSpotifyArtistRecordings,
  listStoredArtistProviderCandidates,
} from './artist-provider-evidence'
import { listArtistScrobbledRecordings } from './artist-listening'
import { createTaskJob, type TaskJobContext, type TaskJobResult } from './jobs'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'

const ArtistEnrichmentOptionsSchema = ArtistEnrichmentInputSchema.extend({
  artistId: z.string().min(1),
}).strip()

async function artistProvider(provider: ArtistProviderId) {
  const plugin = await getScrapePlugin(provider)
  const builtin = ArtistProfileProviderSchema.safeParse(provider)
  if (!plugin || (!builtin.success && !plugin.scrapeArtist))
    throw new ServerError({
      statusCode: 422,
      message: 'Provider is unavailable.',
    })
  if (plugin.manifest.localWorkerRequired && env.RUNTIME_KIND !== 'cloudflare')
    throw new ServerError({
      statusCode: 422,
      message: 'Provider requires a paired local worker on the hosted runtime',
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
  return { plugin, secrets, builtin: builtin.success ? builtin.data : null }
}

function artistLookupMiss(error: unknown) {
  return isProviderItemNotFoundError(error) || artistLookupAmbiguous(error)
}

function artistLookupAmbiguous(error: unknown) {
  return (
    error instanceof ArtistSearchAmbiguousError ||
    isProviderArtistSearchAmbiguousError(error)
  )
}

async function lookupPluginArtist(
  scrapeArtist: NonNullable<MediaProviderPlugin['scrapeArtist']>,
  provider: ArtistProviderId,
  context: MediaPluginArtistContext,
) {
  const result = PluginArtistResultSchema.parse(await scrapeArtist(context))
  return resolveLegacyArtistRelationships(context.artist.id, provider, result)
}

/** Save missing provider profiles before the album adapter resolves the release. */
export async function collectAlbumArtistProfiles(
  plugin: MediaProviderPlugin,
  artists: MediaPluginArtistContext['artist'][],
  context: Pick<MediaPluginArtistContext, 'secrets' | 'recordDiagnostic'> & {
    requestFor: (artistId: string) => MediaPluginArtistContext['request']
  },
  assertActive: () => Promise<void>,
  persist: (
    artistId: string,
    result: Awaited<ReturnType<typeof lookupPluginArtist>>,
  ) => Promise<void>,
) {
  const scrapeArtist = plugin.scrapeArtist
  if (!scrapeArtist || !artists.length) return []
  const provider = plugin.manifest.id
  const ids = artists.map(({ id }) => id)
  const saved = await loadCurrentArtistPayloads(provider, ids)
  const existing = new Set(saved.map(({ artistId }) => artistId))
  let fetched = false
  for (const artist of artists) {
    if (existing.has(artist.id)) continue
    await assertActive()
    try {
      const result = await lookupPluginArtist(scrapeArtist, provider, {
        secrets: context.secrets,
        recordDiagnostic: context.recordDiagnostic,
        request: context.requestFor(artist.id),
        artist,
        providerArtistId: null,
      })
      await assertActive()
      await persist(artist.id, result)
      fetched = true
      existing.add(artist.id)
    } catch (error) {
      if (!artistLookupMiss(error)) throw error
    }
  }
  const profiles = fetched
    ? await loadCurrentArtistPayloads(provider, ids)
    : saved
  const byArtist = new Map(
    profiles.map((profile) => [profile.artistId, profile]),
  )
  return ids.flatMap((id) => {
    const profile = byArtist.get(id)
    return profile ? [profile] : []
  })
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
  const builtin = ArtistProfileProviderSchema.safeParse(provider)
  const requested =
    providerArtistId && builtin.success
      ? normalizeArtistProviderId(builtin.data, providerArtistId)
      : providerArtistId
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
  let storageError: (() => ProviderResponseStorageError | undefined) | undefined
  try {
    const { artistId, provider, providerArtistId } =
      ArtistEnrichmentOptionsSchema.parse(input)
    await context.assertActive()
    const target = await loadArtistProviderTarget(artistId, provider)
    if (!target)
      throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
    const { plugin, secrets, builtin } = await artistProvider(provider)
    diagnostics = createJobDiagnostics(jobLogSecrets(secrets), {
      protectProviderResponses: plugin.sanitizeResponseCapture !== undefined,
    })
    const savedOrExplicitId = providerArtistId ?? target.providerArtistId
    let id = savedOrExplicitId
    if (!id && builtin) {
      const candidates = await listStoredArtistProviderCandidates(
        artistId,
        target.name,
        builtin,
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
    const inferredLastfmMbid =
      builtin === 'lastfm' &&
      !savedOrExplicitId &&
      Boolean(id && normalizeArtistProviderId('musicbrainz', id))
    let totalPages = !builtin || id ? 1 : 2
    await context.progress({ pagesRead: 0, totalPages })
    const capture = createProviderResponseRecorder(
      (capture) =>
        saveProviderResponseCapture({
          jobId: context.jobId,
          artistId,
          provider,
          attempt: 1,
          capture,
        }),
      providerResponseSecretValues(secrets),
      plugin.sanitizeResponseCapture,
    )
    storageError = capture.storageError
    const requestContext = {
      secrets,
      request: createProviderRequest(plugin, context.assertActive, {
        beginResponseCapture: capture('artist', artistId),
      }),
      recordDiagnostic: diagnostics.recordDiagnostic,
      searched: () => {
        totalPages = 2
        return context.progress({ pagesRead: 1, totalPages })
      },
      ...(builtin === 'lastfm' && !savedOrExplicitId
        ? {
            inferredLastfmMbid,
            loadLastfmRecordings: () =>
              listArtistScrobbledRecordings(db, artistId, target.name),
          }
        : {}),
      ...(builtin === 'spotify' && !id
        ? {
            spotifyRecordings: await listSpotifyArtistRecordings(artistId),
            loadSpotifyCatalogRecordings: () =>
              listArtistScrobbledRecordings(db, artistId, target.name, {
                requireRelease: true,
              }),
          }
        : {}),
    }
    const lookup = builtin
      ? lookupArtistProvider(builtin, target.name, id, requestContext)
      : plugin.scrapeArtist
        ? lookupPluginArtist(plugin.scrapeArtist, provider, {
            ...requestContext,
            artist: { id: artistId, name: target.name },
            providerArtistId: id,
          })
        : Promise.reject(new Error('Artist provider is unavailable.'))
    const result = await lookup.catch(async (error: unknown) => {
      if (
        !(storageError?.() || error instanceof ProviderResponseStorageError) &&
        (await context.isActive())
      ) {
        if (artistLookupMiss(error)) await recordProviderSuccess(provider)
        else await recordProviderFailure(plugin, error)
      }
      throw error
    })
    capture.assertStored()
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
  } catch (caught) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    const error = storageError?.() ?? caught
    const classification = artistLookupAmbiguous(error)
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
