import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { isProviderItemNotFoundError } from '@repo/media-plugin-sdk'
import {
  SPOTIFY_ARTIST_ALBUMS_TASK,
  SpotifyArtistAlbumListingSchema,
  type SpotifyArtistAlbumListing,
} from '@repo/schemas/spotify-artist-albums'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createJobDiagnostics } from '@/lib/job-diagnostics'
import { jobLogSecrets } from '@/lib/job-errors'
import { createStableId } from '@/lib/media-utils'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
  ProviderResponseStorageError,
} from '@/lib/provider-response-history'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import {
  SpotifyIdSchema,
  spotifyJson,
  type SpotifyRequest,
} from '@/lib/spotify-api'
import {
  parseSpotifyArtistAlbumPage,
  spotifyArtistAlbumGroups,
  spotifyArtistAlbumsPageSize,
  spotifyArtistAlbumsPath,
} from '@/lib/spotify-artist-albums'
import {
  ArtistSearchAmbiguousError,
  lookupArtistProvider,
} from '@/plugins/builtin/artist-providers'
import { spotifyClientToken, spotifyPlugin } from '@/plugins/builtin/spotify'
import { getScrapePlugin } from '@/plugins/registry'
import {
  providerResponse,
  providerSecret,
  scrapeJob,
  spotifyArtistAlbumListing,
} from '@/schemas/db'
import { listArtistScrobbledRecordings } from './artist-listening'
import {
  listSpotifyArtistRecordings,
  listStoredArtistProviderCandidates,
} from './artist-provider-evidence'
import {
  loadArtistProviderTarget,
  saveArtistProviderResult,
} from './artist-profiles'
import {
  createTaskJob,
  withRunningJob,
  type TaskJobContext,
  type TaskJobResult,
} from './jobs'
import {
  createProviderRequest,
  getProviderSafety,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { latestSpotifyJobs } from './spotify-playlist-state'
import { observeSpotifyArtistAlbumPage } from './spotify-artist-album-discoveries'

const MarketSchema = z.string().regex(/^[A-Z]{2}$/)
const ListingInputSchema = z.object({ artistId: z.string().min(1).max(200) })
const ListingOptionsSchema = ListingInputSchema.extend({
  market: MarketSchema,
  artistName: z.string().min(1),
  groupKey: z.string().min(1),
})
type ListingOptions = z.infer<typeof ListingOptionsSchema>
type Listing = typeof spotifyArtistAlbumListing.$inferSelect
type ListingScope = Pick<Listing, 'artistId' | 'spotifyArtistId' | 'market'>
type ListingPage = ReturnType<typeof parseSpotifyArtistAlbumPage>
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Longer listings continue in a fresh job, keeping the response archive bounded.
const PAGES_PER_JOB = 100

const groupKey = (artistId: string, market: string) =>
  createStableId(SPOTIFY_ARTIST_ALBUMS_TASK, JSON.stringify([artistId, market]))

async function loadTarget(artistId: string, tx?: Transaction) {
  const target = await loadArtistProviderTarget(artistId, 'spotify', tx, {
    includeCatalog: true,
  })
  if (!target)
    throw new ServerError({ statusCode: 404, message: 'Artist not found.' })
  const nativeId =
    target.catalogProvider === 'spotify' ? target.catalogExternalId : null
  const result = SpotifyIdSchema.safeParse(target.providerArtistId ?? nativeId)
  return {
    name: target.name,
    spotifyArtistId: result.success ? result.data : null,
  }
}

async function listingAccess() {
  const plugin = await getScrapePlugin('spotify')
  const rows = await db.query.providerSecret.findMany({
    where: eq(providerSecret.provider, 'spotify'),
  })
  const secrets = resolveProviderSecrets(
    'spotify',
    rows,
    spotifyPlugin.manifest.secrets,
  )
  const market = MarketSchema.safeParse(secrets.market)
  const unavailableReason =
    !plugin || !secrets.clientId?.trim() || !secrets.clientSecret?.trim()
      ? 'Configure Spotify credentials in Providers to fetch albums.'
      : !market.success
        ? 'Set a two-letter Spotify market in Providers to fetch albums.'
        : null
  return {
    market: market.success ? market.data : null,
    secrets,
    unavailableReason,
  }
}

function scopeFilter(scope: ListingScope) {
  return and(
    eq(spotifyArtistAlbumListing.artistId, scope.artistId),
    eq(spotifyArtistAlbumListing.spotifyArtistId, scope.spotifyArtistId),
    eq(spotifyArtistAlbumListing.market, scope.market),
  )
}

async function readCheckpoint(scope: ListingScope) {
  const [row] = await db
    .select()
    .from(spotifyArtistAlbumListing)
    .where(scopeFilter(scope))
  return row
}

export async function getSpotifyArtistAlbumListing(
  artistId: string,
): Promise<SpotifyArtistAlbumListing> {
  const [target, access, safety] = await Promise.all([
    loadTarget(artistId),
    listingAccess(),
    getProviderSafety('spotify'),
  ])
  const { market } = access
  const { spotifyArtistId } = target
  const key = market ? groupKey(artistId, market) : null
  const [listing, jobs] = await Promise.all([
    market && spotifyArtistId
      ? readCheckpoint({ artistId, market, spotifyArtistId })
      : null,
    key ? latestSpotifyJobs(SPOTIFY_ARTIST_ALBUMS_TASK, [key]) : null,
  ])
  return SpotifyArtistAlbumListingSchema.parse({
    market,
    artistUrl: spotifyArtistId
      ? `https://open.spotify.com/artist/${spotifyArtistId}`
      : null,
    unavailableReason:
      access.unavailableReason ??
      (safety.halted ? 'Review the Spotify request halt in Providers.' : null),
    retryAt: safety.cooldownUntil,
    pagesSaved: listing?.pagesSaved ?? 0,
    releasesSeen: listing?.releasesSeen ?? 0,
    expectedTotal: listing?.expectedTotal ?? null,
    completedAt: listing?.completedAt?.toISOString() ?? null,
    job: key ? (jobs?.get(key)?.job ?? null) : null,
  })
}

export async function prepareSpotifyArtistAlbums(
  userId: string | null,
  input: Record<string, unknown>,
): Promise<ListingOptions> {
  if (!userId)
    throw new ServerError({
      statusCode: 422,
      message: 'Sign in to fetch artist albums.',
    })
  const { artistId } = ListingInputSchema.parse(input)
  const [target, access] = await Promise.all([
    loadTarget(artistId),
    listingAccess(),
  ])
  if (!access.market || access.unavailableReason)
    throw new ServerError({
      statusCode: 422,
      message: access.unavailableReason ?? 'Spotify is unavailable.',
    })
  return {
    artistId,
    artistName: target.name,
    market: access.market,
    groupKey: groupKey(artistId, access.market),
  }
}

export async function queueSpotifyArtistAlbums(
  artistId: string,
  userId: string,
) {
  const current = await getSpotifyArtistAlbumListing(artistId)
  const job = current.job
  if (
    current.completedAt ||
    job?.status === 'queued' ||
    job?.status === 'running'
  )
    return current
  await createTaskJob(SPOTIFY_ARTIST_ALBUMS_TASK, userId, {
    taskOptions: { artistId },
    ...(job?.status === 'failed' || job?.status === 'cancelled'
      ? { retryOf: job.jobId }
      : {}),
  })
  return getSpotifyArtistAlbumListing(artistId)
}

async function resolveTarget(
  context: TaskJobContext,
  options: ListingOptions,
  request: SpotifyRequest,
  secrets: Record<string, string>,
  getToken: () => Promise<string>,
  assertStored: () => void,
  recordDiagnostic: (diagnostic: unknown) => void,
) {
  const { artistId } = options
  const target = await loadTarget(artistId)
  if (target.spotifyArtistId) return target.spotifyArtistId
  const candidates = await listStoredArtistProviderCandidates(
    artistId,
    target.name,
    'spotify',
  )
  if (candidates.length > 1) throw new ArtistSearchAmbiguousError()
  const [candidate] = candidates
  const inferred = candidate?.exact ? candidate.id : null
  const result = await lookupArtistProvider('spotify', target.name, inferred, {
    secrets,
    request,
    getSpotifyToken: getToken,
    recordDiagnostic,
    searched: async () => undefined,
    ...(inferred
      ? {}
      : {
          spotifyRecordings: await listSpotifyArtistRecordings(artistId),
          loadSpotifyCatalogRecordings: () =>
            listArtistScrobbledRecordings(db, artistId, target.name, {
              requireRelease: true,
            }),
        }),
  })
  assertStored()
  const resolvedId = SpotifyIdSchema.parse(result.profile.externalId)
  await context.assertActive()
  const saved = await withRunningJob(context.jobId, (tx) =>
    saveArtistProviderResult(
      artistId,
      'spotify',
      {
        profile: {
          name: result.profile.name,
          externalId: resolvedId,
          url: result.profile.url,
          tags: [],
        },
        payload: result.payload,
        scrapeJobId: context.jobId,
      },
      tx,
      { onlyIfMissing: true },
    ),
  )
  if (!saved) return null
  const resolved = (await loadTarget(artistId)).spotifyArtistId
  if (!resolved)
    throw new Error('The Spotify artist match changed during the lookup.')
  return resolved
}

async function savePage(
  context: TaskJobContext,
  scope: ListingScope,
  offset: number,
  page: ListingPage,
) {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select({ status: scrapeJob.status })
      .from(scrapeJob)
      .where(eq(scrapeJob.id, context.jobId))
      .for('update')
    if (job?.status !== 'running') return null
    await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
    const target = await loadTarget(scope.artistId, tx)
    if (target.spotifyArtistId !== scope.spotifyArtistId)
      throw new ServerError({
        statusCode: 409,
        message: 'The Spotify artist match changed during the fetch.',
      })
    const [saved] = await tx
      .select()
      .from(spotifyArtistAlbumListing)
      .where(scopeFilter(scope))
      .for('update')
    if ((saved?.nextOffset ?? 0) !== offset || saved?.completedAt)
      return saved ?? null
    const [response] = await tx
      .select({ id: providerResponse.id })
      .from(providerResponse)
      .where(eq(providerResponse.jobId, context.jobId))
      .orderBy(desc(providerResponse.ordinal))
      .limit(1)
    const pagesSaved = (saved?.pagesSaved ?? 0) + 1
    await observeSpotifyArtistAlbumPage(tx, page.releases, {
      artistId: scope.artistId,
      occurrencePrefix: `${scope.spotifyArtistId}:${scope.market}`,
      page: pagesSaved,
      jobId: context.jobId,
      responseId: response?.id,
    })
    const progress = {
      pagesSaved,
      nextOffset: page.nextOffset ?? offset + page.releases.length,
      releasesSeen: (saved?.releasesSeen ?? 0) + page.releases.length,
      expectedTotal: page.total,
      completedAt: page.nextOffset === null ? new Date() : null,
      updatedAt: new Date(),
    }
    const [row] = await tx
      .insert(spotifyArtistAlbumListing)
      .values({ ...scope, ...progress })
      .onConflictDoUpdate({
        target: [
          spotifyArtistAlbumListing.artistId,
          spotifyArtistAlbumListing.spotifyArtistId,
          spotifyArtistAlbumListing.market,
        ],
        set: progress,
      })
      .returning()
    return row ?? null
  })
}

export async function runSpotifyArtistAlbums(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  let storageError: (() => ProviderResponseStorageError | undefined) | undefined
  let diagnostics: ReturnType<typeof createJobDiagnostics> | undefined
  try {
    const options = ListingOptionsSchema.parse(input)
    const { artistId, market } = options
    await context.assertActive()
    await context.activity('Checking access to Spotify artist releases')
    const access = await listingAccess()
    if (access.unavailableReason || access.market !== market)
      return {
        outcome: 'failed',
        error: new ServerError({
          statusCode: 422,
          message:
            access.unavailableReason ??
            'The Spotify market changed. Start a fetch for the new market.',
        }),
      }
    const { secrets } = access
    diagnostics = createJobDiagnostics(jobLogSecrets(secrets), {
      protectProviderResponses: true,
    })
    const capture = createProviderResponseRecorder(
      (response) =>
        saveProviderResponseCapture({
          jobId: context.jobId,
          provider: 'spotify',
          attempt: 1,
          capture: response,
        }),
      providerResponseSecretValues(secrets),
    )
    storageError = capture.storageError
    const request = createProviderRequest(spotifyPlugin, context.assertActive, {
      beginResponseCapture: capture('task'),
    })
    let tokenRequest: Promise<string> | undefined
    const getToken = () =>
      (tokenRequest ??= spotifyClientToken(secrets, request))
    await context.activity('Resolving the Spotify artist match')
    const spotifyArtistId = await resolveTarget(
      context,
      options,
      request,
      secrets,
      getToken,
      capture.assertStored,
      diagnostics.recordDiagnostic,
    )
    if (!spotifyArtistId) return { outcome: 'stopped' }
    capture.assertStored()
    const scope = { artistId, spotifyArtistId, market }
    let saved = await readCheckpoint(scope)
    if (saved?.completedAt)
      return {
        outcome: 'complete',
        message: 'Using saved Spotify artist albums.',
        noProviderRequests: true,
      }
    await context.activity('Reading and saving artist release pages', {
      done: saved?.pagesSaved ?? 0,
      unit: 'pages',
    })
    const token = await getToken()
    for (let index = 0; index < PAGES_PER_JOB; index += 1) {
      const offset = saved?.nextOffset ?? 0
      const page = parseSpotifyArtistAlbumPage(
        await spotifyJson(
          request,
          token,
          spotifyArtistAlbumsPath(spotifyArtistId),
          {
            include_groups: spotifyArtistAlbumGroups,
            market,
            limit: String(spotifyArtistAlbumsPageSize),
            offset: String(offset),
          },
          { notFoundOn404: true },
        ),
        spotifyArtistId,
        offset,
      )
      capture.assertStored()
      await context.assertActive()
      const checkpoint = await savePage(context, scope, offset, page)
      if (!checkpoint) return { outcome: 'stopped' }
      saved = checkpoint
      await recordProviderSuccess('spotify')
      const totalPages = saved.completedAt
        ? saved.pagesSaved
        : Math.max(
            saved.pagesSaved + 1,
            Math.ceil(page.total / spotifyArtistAlbumsPageSize),
          )
      await context.progress({ pagesRead: saved.pagesSaved, totalPages })
      await context.activity('Reading and saving artist release pages', {
        done: saved.pagesSaved,
        total: totalPages,
        unit: 'pages',
      })
      if (saved.completedAt)
        return {
          outcome: 'complete',
          message: `Saved ${saved.pagesSaved} Spotify album pages.`,
        }
    }
    return {
      outcome: 'continue',
      message: 'The next job continues reading Spotify artist albums.',
      nextOptions: options,
    }
  } catch (caught) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    const error = storageError?.() ?? caught
    const classification =
      error instanceof ArtistSearchAmbiguousError
        ? 'ambiguous'
        : isProviderItemNotFoundError(error)
          ? 'not-found'
          : undefined
    if (
      !(
        error instanceof ProviderResponseStorageError ||
        error instanceof ServerError
      )
    ) {
      if (classification) await recordProviderSuccess('spotify')
      else await recordProviderFailure(spotifyPlugin, error)
    }
    return {
      outcome: 'failed',
      failureClassification: classification,
      error:
        error instanceof z.ZodError || error instanceof SyntaxError
          ? new Error('Spotify returned invalid artist or album data.')
          : error,
      metadata: { diagnostics: diagnostics?.snapshot() ?? [] },
    }
  }
}
