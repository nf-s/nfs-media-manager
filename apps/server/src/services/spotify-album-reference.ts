import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { spotifyIdPattern } from '@repo/schemas/playback'
import {
  SPOTIFY_TRACK_ALBUM_LOOKUP_TASK,
  type SpotifyAlbumReferenceInput,
} from '@repo/schemas/spotify-album-reference'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId } from '@/lib/media-utils'
import {
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import { resolveProviderSecrets } from '@/lib/provider-secrets'
import { SpotifyIdSchema, spotifyAlbumId, spotifyJson } from '@/lib/spotify-api'
import {
  spotifyClientToken,
  spotifyMarket,
  spotifyPlugin,
} from '@/plugins/builtin/spotify'
import {
  catalogMediaAlias,
  libraryTrack,
  mediaItem,
  providerCurrentState,
  providerSecret,
} from '@/schemas/db'
import {
  lockLibraryTrackWrites,
  spotifyAlbumReleaseIds,
} from './album-library-tracks'
import {
  observeCatalogMedia,
  promoteCatalogMediaInTransaction,
} from './catalog-discoveries'
import {
  createJob,
  createTaskJob,
  type TaskJobContext,
  type TaskJobResult,
} from './jobs'
import { assertProviderConfigured, providerOperation } from './manual-add'
import { latestCatalogResponseId } from './music-catalog-observations'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { spotifySearchRecordingId } from './track-match-diagnostics'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

const TrackAlbumLookupInputSchema = z.object({
  trackId: z.string().min(1).max(500),
  spotifyTrackId: SpotifyIdSchema,
})
const SpotifyTrackParentSchema = z.object({
  id: SpotifyIdSchema,
  album: z.object({ id: SpotifyIdSchema, name: z.string().min(1) }),
})
const ReleaseEvidenceSchema = z.object({
  id: SpotifyIdSchema,
  title: z.string().nullable(),
  jobId: z.string().nullable(),
  responseId: z.string().nullable(),
})
type ReleaseEvidence = z.infer<typeof ReleaseEvidenceSchema>
type StoredParent =
  | { mediaItemId: string; releaseId?: string }
  | { trackId: string; spotifyTrackId: string }

async function trackReference(database: Pick<typeof db, 'select'>, id: string) {
  const [track] = await database
    .select({
      id: libraryTrack.mediaItemId,
      albumId: libraryTrack.albumMediaItemId,
      albumName: libraryTrack.albumName,
      albumLinkStrategy: libraryTrack.albumLinkStrategy,
      spotifyTrackId: libraryTrack.spotifyTrackId,
      spotifyAlbumId: libraryTrack.spotifyAlbumId,
    })
    .from(libraryTrack)
    .innerJoin(mediaItem, eq(mediaItem.id, libraryTrack.mediaItemId))
    .where(
      and(
        eq(
          libraryTrack.mediaItemId,
          sql`coalesce(
          (select ${catalogMediaAlias.mediaItemId} from ${catalogMediaAlias} where ${catalogMediaAlias.aliasId} = ${id}), ${id}
        )`,
        ),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  return track
}

/** Read only search jobs for this track and only evidence for its chosen Spotify identity. */
async function storedReleaseEvidence(
  tx: Transaction,
  trackId: string,
  spotifyTrackId: string,
) {
  const task = sql.raw(`'${SPOTIFY_TRACK_SEARCH_TASK}'`)
  const { rows } = await tx.execute(sql`
    with related_jobs as materialized (
      select id from scrape_job where provider = 'spotify' and status = 'succeeded'
        and options->>'task' = ${task}
        and (options->>'trackId' = ${trackId} or ${spotifySearchRecordingId(sql`options`)} = ${trackId})
    ), raw_responses as (
      select r.id, r.job_id, case when pg_input_is_valid(r.body->>'text', 'jsonb')
        then (r.body->>'text')::jsonb end as data
      from related_jobs j join provider_response r on r.job_id = j.id
      where r.provider = 'spotify' and r.body_state = 'captured' and r.status between 200 and 299
        and (r.request_url like 'https://api.spotify.com/v1/search?%'
          or r.request_url like 'https://api.spotify.com/v1/tracks/%')
    ), raw_items as (
      select r.id, r.job_id, item from raw_responses r
      cross join lateral jsonb_path_query(r.data, '$.tracks.items[*]') item
      union all select id, job_id, data from raw_responses where data ? 'id'
    )
    select distinct * from (
      select item #>> '{album,id}' as id, item #>> '{album,name}' as title,
        job_id as "jobId", id as "responseId"
      from raw_items where item->>'id' = ${spotifyTrackId}
      union all
      select item->>'spotifyAlbumId', item->>'albumName', j.id, null::text
      from related_jobs j join scrape_job_log l on l.job_id = j.id
      cross join lateral jsonb_path_query(l.metadata, '$.diagnostics[*].candidates[*]') item
      where item->>'spotifyTrackId' = ${spotifyTrackId}
    ) evidence where id collate "C" ~ ${spotifyIdPattern.source}
    order by "responseId" nulls last, "jobId", title`)
  return ReleaseEvidenceSchema.array().parse(rows)
}

const releaseUnavailable = () =>
  new ServerError({
    statusCode: 409,
    message: 'The track does not identify one Spotify release.',
  })

async function resolveStoredParent(
  { trackId, spotifyAlbumId: expectedId, add }: SpotifyAlbumReferenceInput,
  userId: string,
  lookup?: {
    trackId: string
    spotifyTrackId: string
    evidence: ReleaseEvidence
  },
): Promise<StoredParent> {
  return db.transaction(async (tx) => {
    await lockLibraryTrackWrites(tx)
    const track = await trackReference(tx, trackId)
    if (!track)
      throw new ServerError({ statusCode: 404, message: 'Track not found.' })
    const spotifyTrackId = SpotifyIdSchema.safeParse(track.spotifyTrackId).data
    const storedId = track.spotifyAlbumId
      ? spotifyAlbumId(track.spotifyAlbumId)
      : null
    const stored =
      !storedId && spotifyTrackId
        ? await storedReleaseEvidence(tx, track.id, spotifyTrackId)
        : []
    const releaseIds = new Set(stored.map(({ id }) => id))
    if (releaseIds.size > 1) throw releaseUnavailable()
    const trustedLink =
      track.albumLinkStrategy === 'album-track-list' ||
      track.albumLinkStrategy === 'spotify-track' ||
      track.albumLinkStrategy === 'spotify-album'
    const linkedAlbum =
      !storedId &&
      !stored.length &&
      track.albumId &&
      (trustedLink || !spotifyTrackId)
        ? await readLinkedAlbum(tx, track.albumId)
        : undefined
    if (
      trustedLink &&
      linkedAlbum &&
      linkedAlbum.spotifyIds.length > 1 &&
      !linkedAlbum.inLibrary
    )
      throw releaseUnavailable()
    const linkedReleaseId =
      trustedLink && linkedAlbum?.spotifyIds.length === 1
        ? linkedAlbum.spotifyIds[0]
        : undefined
    const releaseId = storedId ?? stored[0]?.id ?? linkedReleaseId
    // The player can supply an expected release before the track has one saved.
    const needsTrackLookup = !releaseId && Boolean(spotifyTrackId)
    if (expectedId && expectedId !== releaseId && !needsTrackLookup)
      throw new ServerError({
        statusCode: 404,
        message: 'This Spotify album reference is no longer on the track.',
      })
    if (!releaseId) {
      if (!expectedId && linkedAlbum?.inLibrary && !add)
        return { mediaItemId: linkedAlbum.id }
      if (!spotifyTrackId) throw releaseUnavailable()
      return { trackId: track.id, spotifyTrackId }
    }

    const [saved] = stored
    if (saved) await cacheTrackAlbum(tx, track.id, saved)
    const evidence =
      saved ??
      (lookup?.trackId === track.id &&
      lookup.spotifyTrackId === spotifyTrackId &&
      lookup.evidence.id === releaseId
        ? lookup.evidence
        : undefined)
    const mediaItemId = await observeTrackParent(
      tx,
      track.id,
      releaseId,
      evidence?.title || track.albumName?.trim(),
      evidence,
    )
    if (add) await promoteCatalogMediaInTransaction(tx, mediaItemId, userId)
    return { mediaItemId, releaseId }
  })
}

const LinkedAlbumSchema = z.object({
  id: z.string(),
  inLibrary: z.boolean(),
  spotifyIds: SpotifyIdSchema.array(),
})

async function readLinkedAlbum(tx: Transaction, albumId: string) {
  const { rows } = await tx.execute(sql`
    select id, in_library as "inLibrary", array(
      select distinct spotify_id from (${spotifyAlbumReleaseIds(albumId)}) release where spotify_id is not null
    ) as "spotifyIds"
    from media_item where id = ${albumId} and media_type = 'album'
      and metadata->>'legacyHidden' is distinct from 'true'`)
  return LinkedAlbumSchema.array().parse(rows)[0]
}

async function observeTrackParent(
  tx: Transaction,
  trackId: string,
  releaseId: string,
  title?: string | null,
  evidence?: ReleaseEvidence,
) {
  const { rows } = await tx.execute(sql`
    select distinct coalesce(alias.media_item_id, item.id) as id
    from (${spotifyAlbumReleaseIds()}) release join media_item item on item.id = release.album_id
    left join catalog_media_alias alias on alias.alias_id = release.album_id
    join media_item canonical on canonical.id = coalesce(alias.media_item_id, item.id)
    where release.spotify_id = ${releaseId} and canonical.metadata->>'legacyHidden' is distinct from 'true'
    limit 2`)
  if (rows.length > 1)
    throw new ServerError({
      statusCode: 409,
      message: 'This Spotify release matches more than one saved album.',
    })
  const id = await observeCatalogMedia(
    tx,
    {
      kind: 'album',
      provider: 'spotify',
      referenceType: 'spotify',
      externalId: releaseId,
      title: title || 'Spotify release',
      spotifyUrl: `https://open.spotify.com/album/${releaseId}`,
    },
    {
      provider: 'spotify',
      operation: 'parent-reference',
      subjectKind: 'track',
      subjectId: trackId,
      relationshipRole: 'album',
      occurrenceKey: releaseId,
      jobId: evidence?.jobId ?? undefined,
      responseId: evidence?.responseId ?? undefined,
    },
  )
  const [visible] = await tx
    .select({ id: mediaItem.id })
    .from(mediaItem)
    .where(
      and(
        eq(mediaItem.id, id),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  if (!visible) throw releaseUnavailable()
  return id
}

async function cacheTrackAlbum(
  tx: Transaction,
  trackId: string,
  evidence: ReleaseEvidence,
) {
  await tx
    .update(libraryTrack)
    .set({
      spotifyAlbumId: evidence.id,
      albumName: sql`coalesce(${libraryTrack.albumName}, ${evidence.title})`,
      updatedAt: new Date(),
    })
    .where(eq(libraryTrack.mediaItemId, trackId))
}

/** Resolve an exact parent recorded on a track. Opening it never adds membership. */
export async function openSpotifyAlbumReference(
  input: SpotifyAlbumReferenceInput,
  userId: string,
) {
  let parent = await resolveStoredParent(input, userId)
  if ('spotifyTrackId' in parent) {
    const { trackId, spotifyTrackId } = parent
    const job = await createTaskJob(SPOTIFY_TRACK_ALBUM_LOOKUP_TASK, userId, {
      taskOptions: { trackId, spotifyTrackId },
    })
    if (job.status === 'running' || job.status === 'queued')
      throw new ServerError({
        statusCode: 409,
        message:
          'The Spotify track is already being read. Try opening the release again.',
      })
    if (job.status !== 'succeeded')
      throw new ServerError({
        statusCode: 502,
        message:
          'Could not confirm this track’s release on Spotify. Try opening the release again.',
      })
    const { data: evidence } = ReleaseEvidenceSchema.safeParse(
      job.options.releaseEvidence,
    )
    parent = await resolveStoredParent(
      input,
      userId,
      evidence ? { trackId, spotifyTrackId, evidence } : undefined,
    )
  }
  if (!('mediaItemId' in parent)) throw releaseUnavailable()
  const { mediaItemId, releaseId } = parent
  if (input.add || !releaseId) return { mediaItemId }
  const [stored] = await db
    .select({
      inLibrary: mediaItem.inLibrary,
      snapshot: providerCurrentState.latestSnapshotId,
    })
    .from(mediaItem)
    .leftJoin(
      providerCurrentState,
      and(
        eq(providerCurrentState.mediaItemId, mediaItem.id),
        eq(providerCurrentState.provider, 'spotify'),
      ),
    )
    .where(eq(mediaItem.id, mediaItemId))
  if (stored?.inLibrary || stored?.snapshot) return { mediaItemId }

  const rows = await db.query.providerSecret.findMany({
    where: eq(providerSecret.provider, 'spotify'),
  })
  const secrets = resolveProviderSecrets(
    'spotify',
    rows,
    spotifyPlugin.manifest.secrets,
  )
  if (!secrets.clientId?.trim() || !secrets.clientSecret?.trim())
    return { mediaItemId }
  try {
    const job = await createJob(
      {
        provider: 'spotify',
        scope: { mediaItemIds: [mediaItemId], mediaType: 'album', limit: 1 },
        options: { spotifyAlbumReference: releaseId },
        confirmBroadRun: true,
      },
      userId,
      { reuseSpotifyAlbumReferenceAttempt: true, deferUntilReady: true },
    )
    return { mediaItemId, jobId: job.id }
  } catch (error) {
    // The saved parent can be opened while its provider is unavailable.
    if (
      error instanceof ServerError &&
      [422, 429].includes(error.response.statusCode)
    )
      return { mediaItemId }
    throw error
  }
}

export async function prepareSpotifyTrackAlbumLookup(
  _userId: string | null,
  input: Record<string, unknown>,
) {
  const identity = TrackAlbumLookupInputSchema.parse(input)
  await assertProviderConfigured('spotify', 'reading this track’s release')
  return {
    ...identity,
    groupKey: createStableId(
      SPOTIFY_TRACK_ALBUM_LOOKUP_TASK,
      JSON.stringify([identity.trackId, identity.spotifyTrackId]),
    ),
  }
}

export async function runSpotifyTrackAlbumLookup(
  context: TaskJobContext,
  input: Record<string, unknown>,
): Promise<TaskJobResult> {
  try {
    const { trackId, spotifyTrackId } = TrackAlbumLookupInputSchema.parse(input)
    const target = await trackReference(db, trackId)
    if (
      !target ||
      target.spotifyTrackId !== spotifyTrackId ||
      (target.spotifyAlbumId && spotifyAlbumId(target.spotifyAlbumId))
    )
      return {
        outcome: 'complete',
        message: 'The track no longer needs a Spotify release lookup.',
        noProviderRequests: true,
      }
    const parent = await providerOperation(
      'spotify',
      async ({ secrets, request }, plugin) => {
        const token = await spotifyClientToken(secrets, request)
        const recorder = createProviderResponseRecorder(
          (capture) =>
            saveProviderResponseCapture({
              jobId: context.jobId,
              provider: 'spotify',
              attempt: 1,
              capture,
            }),
          providerResponseSecretValues(secrets),
        )
        const read = createProviderRequest(plugin, context.assertActive, {
          maxSlotWaitMs: context.maxSlotWaitMs,
          beginResponseCapture: recorder('task'),
        })
        try {
          return SpotifyTrackParentSchema.safeParse(
            await spotifyJson(
              read,
              token,
              `tracks/${spotifyTrackId}`,
              spotifyMarket(secrets),
              { notFoundOn404: true },
            ),
          )
        } finally {
          recorder.assertStored()
        }
      },
      context.assertActive,
      'reading this track’s release',
      context.maxSlotWaitMs,
    )
    if (!parent.success || parent.data.id !== spotifyTrackId)
      return {
        outcome: 'failed',
        failureClassification: 'ambiguous',
        error: releaseUnavailable(),
      }
    const evidence: ReleaseEvidence = {
      id: parent.data.album.id,
      title: parent.data.album.name,
      jobId: context.jobId,
      responseId:
        (await latestCatalogResponseId(db, context.jobId, 'spotify')) ?? null,
    }
    return {
      outcome: 'complete',
      message: 'Confirmed the track’s Spotify release by ID.',
      options: { releaseEvidence: evidence },
      async persist(tx) {
        await lockLibraryTrackWrites(tx)
        const current = await trackReference(tx, trackId)
        if (
          !current ||
          current.spotifyTrackId !== spotifyTrackId ||
          (current.spotifyAlbumId && spotifyAlbumId(current.spotifyAlbumId))
        )
          return
        await cacheTrackAlbum(tx, current.id, evidence)
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}
