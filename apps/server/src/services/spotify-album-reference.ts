import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ProviderRequestError,
  isProviderItemNotFoundError,
} from '@repo/media-plugin-sdk'
import { spotifyIdPattern } from '@repo/schemas/playback'
import { DIRECT_PROVIDER_RESPONSE_SOURCE } from '@repo/schemas/provider-response'
import {
  SPOTIFY_TRACK_ALBUM_LOOKUP_TASK,
  type SpotifyAlbumReferenceInput,
} from '@repo/schemas/spotify-album-reference'
import { SPOTIFY_TRACK_SEARCH_TASK } from '@repo/schemas/spotify-track-search'
import { db, providerLookupDb } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { spotifyReleaseObservation } from '@/lib/music-provider-discoveries'
import { createStableId } from '@/lib/media-utils'
import {
  ProviderResponseStorageError,
  createProviderResponseRecorder,
  providerResponseSecretValues,
} from '@/lib/provider-response-history'
import {
  SpotifyAlbumSchema,
  SpotifyIdSchema,
  normalizeSpotifyAlbum,
  spotifyAlbumId,
  spotifyJson,
} from '@/lib/spotify-api'
import { spotifyClientToken, spotifyMarket } from '@/plugins/builtin/spotify'
import {
  catalogMediaAlias,
  libraryTrack,
  mediaItem,
  providerCurrentState,
  providerSnapshot,
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
  IN_REQUEST_SLOT_WAIT_MS,
  type TaskJobContext,
  type TaskJobResult,
} from './jobs'
import { assertProviderConfigured, providerOperation } from './manual-add'
import { latestCatalogResponseId } from './music-catalog-observations'
import { observeMusicDiscovery } from './music-provider-observations'
import { readMediaProviderWithEvidence } from './interactive-media-provider-response'
import { applyProviderResultInTransaction } from './provider-state'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { lockTagWrites } from './tag-state'
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
  snapshotId: z.string().optional(),
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
        and (r.request_url = 'https://api.spotify.com/v1/search'
          or r.request_url like 'https://api.spotify.com/v1/search?%'
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
    let evidence =
      saved ??
      (lookup?.trackId === track.id &&
      lookup.spotifyTrackId === spotifyTrackId &&
      lookup.evidence.id === releaseId
        ? lookup.evidence
        : undefined)
    // A stale player link can reject navigation after the legacy lookup has
    // already confirmed and saved the actual parent. Keep that source on reopen.
    if (!evidence && spotifyTrackId && storedId) {
      const direct = await storedExactResponse(
        track.id,
        `https://api.spotify.com/v1/tracks/${spotifyTrackId}`,
        spotifyTrackId,
        SpotifyTrackParentSchema,
        tx,
      )
      if (direct?.data.album.id === releaseId)
        evidence = {
          id: releaseId,
          title: direct.data.album.name,
          snapshotId: direct.snapshotId,
          jobId: null,
          responseId: null,
        }
    }
    const mediaItemId = await observeTrackParent(
      tx,
      track.id,
      releaseId,
      evidence?.title || track.albumName?.trim(),
      evidence,
    )
    if (add) await promoteCatalogMediaInTransaction(tx, mediaItemId, userId)
    return add || (await albumIsCached(tx, mediaItemId, releaseId))
      ? { mediaItemId }
      : { mediaItemId, releaseId }
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
      snapshotId: evidence?.snapshotId,
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

/** Serialize competing clicks for one provider identity across API instances. */
async function withLookupLock<T>(
  path: string,
  run: (tx: Transaction) => Promise<T>,
) {
  return providerLookupDb.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`)
    try {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'spotify-open:' + path}, 0))`,
      )
    } catch (error) {
      const timeout = z.object({ code: z.literal('55P03') })
      if (
        !timeout.safeParse(error).success &&
        !(error instanceof Error && timeout.safeParse(error.cause).success)
      )
        throw error
      throw new ServerError({
        statusCode: 429,
        message: 'This Spotify release is already loading. Try again shortly.',
      })
    }
    await tx.execute(sql`set local lock_timeout = default`)
    return run(tx)
  })
}

async function readExactSpotifyResource<T extends { id: string }>(
  mediaItemId: string,
  kind: 'tracks' | 'albums',
  id: string,
  schema: z.ZodType<T>,
) {
  const path = `${kind}/${id}`
  const url = `https://api.spotify.com/v1/${path}`
  const saved = await storedExactResponse(mediaItemId, url, id, schema)
  if (saved) return saved
  try {
    return await providerOperation(
      'spotify',
      async ({ secrets }, plugin) => {
        const { result, responses } = await readMediaProviderWithEvidence(
          {
            mediaItemId,
            plugin,
            secrets,
            maxSlotWaitMs: IN_REQUEST_SLOT_WAIT_MS,
          },
          async (request) => {
            const token = await spotifyClientToken(secrets, request)
            return schema.safeParse(
              await spotifyJson(request, token, path, spotifyMarket(secrets), {
                notFoundOn404: true,
              }),
            )
          },
        )
        const evidence = responses.find(
          (response) =>
            response.requestUrl === url &&
            response.status !== null &&
            response.status >= 200 &&
            response.status < 300,
        )
        if (!evidence) throw new ProviderResponseStorageError()
        if (!result.success || result.data.id !== id)
          throw new ServerError({
            statusCode: 502,
            message: 'Spotify returned invalid details for the requested item.',
          })
        return {
          data: result.data,
          snapshotId: evidence.snapshotId,
          observedAt: evidence.observedAt,
        }
      },
      undefined,
      'opening this album',
      IN_REQUEST_SLOT_WAIT_MS,
    )
  } catch (error) {
    if (error instanceof ServerError) {
      if (isProviderItemNotFoundError(error.cause))
        throw new ServerError({
          statusCode: 404,
          message: `Spotify could not find this ${kind === 'tracks' ? 'track' : 'album'}.`,
        })
      if (
        error.cause instanceof ProviderRequestError &&
        ['cooldown', 'rate-limit'].includes(error.cause.code)
      )
        throw new ServerError({ statusCode: 429, message: error.message })
    }
    throw error
  }
}

async function storedExactResponse<T extends { id: string }>(
  mediaItemId: string,
  url: string,
  id: string,
  schema: z.ZodType<T>,
  reader: Pick<Transaction, 'select'> = db,
) {
  const [row] = await reader
    .select({
      snapshotId: providerSnapshot.id,
      observedAt: providerSnapshot.createdAt,
      text: sql<unknown>`${providerSnapshot.payload} #>> '{response,body,text}'`,
    })
    .from(providerSnapshot)
    .where(
      and(
        eq(providerSnapshot.mediaItemId, mediaItemId),
        eq(providerSnapshot.provider, 'spotify'),
        eq(providerSnapshot.source, DIRECT_PROVIDER_RESPONSE_SOURCE),
        sql`${providerSnapshot.payload} #>> '{request,url}' = ${url}
        and (${providerSnapshot.payload} #>> '{response,status}')::integer between 200 and 299
        and ${providerSnapshot.payload} #>> '{response,body,state}' = 'captured'`,
      ),
    )
    .orderBy(desc(providerSnapshot.createdAt), desc(providerSnapshot.id))
    .limit(1)
  if (!row || typeof row.text !== 'string') return
  try {
    const parsed = schema.safeParse(JSON.parse(row.text))
    if (parsed.success && parsed.data.id === id)
      return {
        data: parsed.data,
        snapshotId: row.snapshotId,
        observedAt: row.observedAt,
      }
  } catch {
    // An invalid retained body remains available in Sources for diagnosis.
  }
}

async function loadTrackParent(trackId: string, spotifyTrackId: string) {
  return withLookupLock(`tracks/${spotifyTrackId}`, async (tx) => {
    const current = await trackReference(tx, trackId)
    if (
      !current ||
      current.spotifyTrackId !== spotifyTrackId ||
      (current.spotifyAlbumId && spotifyAlbumId(current.spotifyAlbumId))
    )
      return
    const { data, snapshotId } = await readExactSpotifyResource(
      trackId,
      'tracks',
      spotifyTrackId,
      SpotifyTrackParentSchema,
    )
    const evidence = {
      id: data.album.id,
      title: data.album.name,
      jobId: null,
      responseId: null,
      snapshotId,
    }
    await lockLibraryTrackWrites(tx)
    const latest = await trackReference(tx, trackId)
    if (
      latest?.spotifyTrackId === spotifyTrackId &&
      !(latest.spotifyAlbumId && spotifyAlbumId(latest.spotifyAlbumId))
    )
      await cacheTrackAlbum(tx, latest.id, evidence)
    return { trackId, spotifyTrackId, evidence }
  })
}

async function albumIsCached(
  tx: Transaction,
  mediaItemId: string,
  releaseId: string,
) {
  const [cached] = await tx
    .select({
      inLibrary: mediaItem.inLibrary,
      snapshot: providerCurrentState.latestSnapshotId,
      // A prior enrichment can retain and project the album page before
      // failing on a later track page, without producing a current snapshot.
      observed: sql<boolean>`exists (
        select 1 from catalog_observation o join provider_response r on r.id = o.response_id
        where o.media_item_id = ${mediaItemId} and o.provider = 'spotify'
          and o.relationship_role = 'release_detail' and r.provider = 'spotify'
          and r.status between 200 and 299 and r.body_state = 'captured'
          and split_part(r.request_url, '?', 1) = ${'https://api.spotify.com/v1/albums/' + releaseId}
      )`,
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
  if (!cached) throw releaseUnavailable()
  return Boolean(cached.inLibrary || cached.snapshot || cached.observed)
}

async function loadAlbum(mediaItemId: string, releaseId: string) {
  return withLookupLock(`albums/${releaseId}`, async (tx) => {
    if (await albumIsCached(tx, mediaItemId, releaseId)) return
    const { data, snapshotId, observedAt } = await readExactSpotifyResource(
      mediaItemId,
      'albums',
      releaseId,
      SpotifyAlbumSchema,
    )
    const { payload, normalized } = normalizeSpotifyAlbum(data)
    // Follow the normal provider write lock order. A full refresh or identity
    // correction may have finished while the interactive read was in flight.
    if (normalized.tags.length) await lockTagWrites(tx)
    await lockLibraryTrackWrites(tx)
    const current = await readLinkedAlbum(tx, mediaItemId)
    if (!current?.spotifyIds.includes(releaseId)) throw releaseUnavailable()
    if (await albumIsCached(tx, mediaItemId, releaseId)) return
    await applyProviderResultInTransaction(
      {
        mediaItemId,
        mediaType: 'album',
        provider: 'spotify',
        source: 'album-open',
        payload,
        normalized,
      },
      tx,
    )
    await observeMusicDiscovery(
      tx,
      spotifyReleaseObservation(data, 1, 'release_detail'),
      {
        provider: 'spotify',
        operation: 'provider-result',
        subjectKind: 'album',
        subjectId: mediaItemId,
        occurrenceKey: snapshotId,
        snapshotId,
        observedAt,
      },
    )
  })
}

/** Resolve an exact parent recorded on a track. Opening it never adds membership. */
export async function openSpotifyAlbumReference(
  input: SpotifyAlbumReferenceInput,
  userId: string,
) {
  let parent = await resolveStoredParent(input, userId)
  if ('spotifyTrackId' in parent) {
    const lookup = await loadTrackParent(parent.trackId, parent.spotifyTrackId)
    parent = await resolveStoredParent(input, userId, lookup)
  }
  if (!('mediaItemId' in parent)) throw releaseUnavailable()
  if (!input.add && parent.releaseId)
    await loadAlbum(parent.mediaItemId, parent.releaseId)
  return { mediaItemId: parent.mediaItemId }
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
