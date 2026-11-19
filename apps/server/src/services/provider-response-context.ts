import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'
import {
  AlbumReleaseTracksSchema,
  PluginReferenceSchema,
  type PluginReference,
} from '@repo/media-plugin-sdk'
import { ARTIST_ENRICHMENT_TASK } from '@repo/schemas/artist-profiles'
import { JsonValueSchema } from '@repo/schemas/common'
import { getJobTask } from '@repo/schemas/job'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { db } from '@/lib/db'
import { getBuiltinScrapePlugin } from '@/plugins/builtin'
import { spotifyArtistRecordingLimit } from '@/plugins/builtin/artist-providers'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import { scrapeJob, scrapeJobItem } from '@/schemas/db'
import { readAlbumMatchRejections } from './album-match-rejections'
import { getAlbumReleaseHints } from './album-release-hints'
import {
  loadArtistProviderTarget,
  loadCurrentArtistPayloads,
} from './artist-profiles'
import { isProviderReplayTask } from '@/lib/provider-task-scope'
import { getProviderReferenceHints } from './provider-reference-hints'

const id = z.string().min(1).max(200)
export const ProviderReplayScopeSchema = z
  .object({
    jobId: id,
    jobItemId: id.nullable(),
    artistId: id.nullable(),
    attempt: z.number().int().positive(),
    task: z.literal(true).optional(),
  })
  .refine((scope) =>
    scope.task
      ? scope.jobItemId === null &&
        scope.artistId === null &&
        scope.attempt === 1
      : scope.jobItemId !== null || scope.artistId !== null,
  )

const hint = z.object({
  source: z.enum(['spotify', 'musicbrainz', 'discogs']),
  title: z.string(),
  year: z.number().int().optional(),
  releaseDate: z.string().optional(),
  releaseType: z.string().optional(),
  artists: z.array(z.string()).optional(),
  trackEvidence: z
    .object({
      libraryTracks: z.number().int().nonnegative(),
      matchedTracks: z.number().int().nonnegative(),
      exactSequence: z.boolean(),
      tracks: AlbumReleaseTracksSchema.optional(),
      creditedArtists: z
        .array(
          z.object({
            name: z.string(),
            tracks: z.number().int().nonnegative(),
          }),
        )
        .optional(),
    })
    .optional(),
})

const ReplayMediaInputSchema = z.object({
  phase: z.literal('media'),
  context: z.object({
    mediaItemId: id,
    mediaType: z.enum(['album', 'film']),
    options: z.record(z.string(), JsonValueSchema).optional(),
    media: z.object({
      title: z.string(),
      artists: z.array(z.string()),
      releaseDate: z.string().optional(),
      releaseHints: z.array(hint).optional(),
    }),
    artistProfiles: z
      .array(
        z.object({
          artistId: id,
          name: z.string(),
          payload: JsonValueSchema,
        }),
      )
      .optional(),
    existingReferences: z.array(PluginReferenceSchema),
  }),
})

const ReplayArtistInputSchema = z.object({
  phase: z.literal('artist'),
  bootstrap: z.boolean(),
  inferredLastfmMbid: z.literal(true).optional(),
  spotifyRecordings: z
    .array(
      z.object({
        spotifyTrackId: SpotifyIdSchema,
        title: z.string().min(1).max(2_048),
      }),
    )
    .max(spotifyArtistRecordingLimit)
    .optional(),
  context: z.object({
    artist: z.object({ id, name: z.string() }),
    providerArtistId: z.string().nullable(),
  }),
})

export const ProviderReplayContextSchema = z.object({
  version: z.literal(1),
  scope: ProviderReplayScopeSchema,
  provider: id,
  spotifyMarket: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  inputs: z
    .array(
      z.discriminatedUnion('phase', [
        ReplayMediaInputSchema,
        ReplayArtistInputSchema,
      ]),
    )
    .min(1)
    .max(101),
})

type Scope = z.infer<typeof ProviderReplayScopeSchema>
type Context = z.infer<typeof ProviderReplayContextSchema>
type JobScope = {
  provider: string
  mediaItemId: string | null
  options: Record<string, import('@repo/schemas/common').JsonValue>
}

export async function readProviderReplayJobScope(
  scope: Scope,
): Promise<JobScope | null> {
  const [job] = await db
    .select({
      provider: scrapeJob.provider,
      options: scrapeJob.options,
    })
    .from(scrapeJob)
    .where(eq(scrapeJob.id, scope.jobId))

  if (!job) return null
  if (scope.jobItemId !== null) {
    const [item] = await db
      .select({ mediaItemId: scrapeJobItem.mediaItemId })
      .from(scrapeJobItem)
      .where(
        and(
          eq(scrapeJobItem.id, scope.jobItemId),
          eq(scrapeJobItem.jobId, scope.jobId),
          eq(scrapeJobItem.provider, job.provider),
        ),
      )
    return item ? { ...job, mediaItemId: item.mediaItemId } : null
  }

  if (scope.task)
    return isProviderReplayTask(getJobTask(job.options), job.provider)
      ? { ...job, mediaItemId: null }
      : null
  return getJobTask(job.options) === ARTIST_ENRICHMENT_TASK &&
    job.options['artistId'] === scope.artistId
    ? { ...job, mediaItemId: null }
    : null
}

type Phase =
  | { phase: 'media'; artistId: null }
  | {
      phase: 'artist'
      artistId: string
      lookupByName?: boolean
      inferredLastfmMbid?: string
    }

/** Resolve the same inputs as a live scrape, with no credential or network access. */
export async function reconstructProviderReplayContext(
  scope: Scope,
  job: JobScope,
  phases: readonly Phase[],
): Promise<Context | null> {
  const plugin = getBuiltinScrapePlugin(job.provider)
  const inputs: Context['inputs'] = []
  for (const phase of phases) {
    if (phase.phase === 'artist') {
      const target = await loadArtistProviderTarget(
        phase.artistId,
        job.provider,
      )
      if (!target) return null
      const explicitId = job.options['providerArtistId']
      const bootstrap = scope.jobItemId !== null
      inputs.push({
        phase: 'artist',
        bootstrap,
        ...(!bootstrap &&
        typeof explicitId !== 'string' &&
        phase.inferredLastfmMbid
          ? { inferredLastfmMbid: true }
          : {}),
        context: {
          artist: { id: phase.artistId, name: target.name },
          providerArtistId: bootstrap
            ? null
            : typeof explicitId === 'string'
              ? explicitId
              : (phase.inferredLastfmMbid ??
                (phase.lookupByName ? null : target.providerArtistId)),
        },
      })
      continue
    }

    if (!job.mediaItemId) return null
    const mediaItemId = job.mediaItemId
    const [record, references, overrides] = await Promise.all([
      db.query.mediaItem.findFirst({
        where: (table, operators) => operators.eq(table.id, mediaItemId),
        with: { credits: { with: { artist: true } } },
      }),
      db.query.providerReference.findMany({
        where: (table, operators) =>
          operators.eq(table.mediaItemId, mediaItemId),
      }),
      db.query.providerReferenceOverride.findMany({
        where: (table) =>
          and(
            eq(table.mediaItemId, mediaItemId),
            or(
              eq(table.provider, job.provider),
              inArray(table.provider, ['imdb', 'tmdb']),
            ),
          ),
        orderBy: (table) => [asc(table.createdAt), asc(table.id)],
      }),
    ])
    if (!record || record.mediaType === 'track') return null
    const rejections =
      record.mediaType === 'album'
        ? await readAlbumMatchRejections(db, mediaItemId)
        : []
    const rejected = createAlbumMatchRejectionPredicate(
      job.provider,
      rejections,
    )
    const existingReferences: PluginReference[] = []
    const effective = new Map(
      [...new Map(overrides.map((row) => [row.referenceType, row])).values()]
        .filter((row) => !rejected(row))
        .map((row) => [row.referenceType, row.externalId]),
    )
    for (const [referenceType, externalId] of effective)
      existingReferences.push({
        referenceType,
        externalId,
        isPrimary: true,
        metadata: { sourceProvider: job.provider, manualOverride: true },
      })
    for (const row of references.sort(
      (left, right) =>
        Number(right.provider === job.provider) -
        Number(left.provider === job.provider),
    )) {
      if (effective.has(row.referenceType) || rejected(row)) continue
      const metadata = { ...row.metadata }
      delete metadata['manualOverride']
      existingReferences.push({
        referenceType: row.referenceType,
        externalId: row.externalId,
        isPrimary: row.isPrimary,
        metadata: { ...metadata, sourceProvider: row.provider },
      })
    }
    const credits = record.credits
      .filter(({ role }) => role === 'artist')
      .sort((left, right) => left.billingOrder - right.billingOrder)
    const [referenceHints, releaseHints, artistProfiles] = await Promise.all([
      getProviderReferenceHints({
        provider: job.provider,
        mediaItemId,
        mediaType: record.mediaType,
        existingReferences,
      }),
      record.mediaType === 'album' && plugin?.manifest.albumReleaseHints
        ? getAlbumReleaseHints(
            mediaItemId,
            rejections,
            job.provider === 'discogs',
          )
        : undefined,
      record.mediaType === 'album' && plugin?.manifest.bootstrapAlbumArtists
        ? loadCurrentArtistPayloads(
            job.provider,
            credits.map(({ artist }) => artist.id),
          )
        : undefined,
    ])
    inputs.push({
      phase: 'media',
      context: {
        mediaItemId,
        mediaType: record.mediaType,
        options: job.options,
        media: {
          title: record.title,
          artists: credits.map(({ artist }) => artist.name),
          releaseDate: record.releaseDate?.toISOString(),
          releaseHints: releaseHints?.map((value) => hint.parse(value)),
        },
        artistProfiles,
        existingReferences: [
          ...existingReferences,
          ...referenceHints.filter((reference) => !rejected(reference)),
        ],
      },
    })
  }
  return ProviderReplayContextSchema.parse({
    version: 1,
    scope,
    provider: job.provider,
    inputs,
  })
}
