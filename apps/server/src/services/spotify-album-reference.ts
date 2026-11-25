import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  PluginNormalizedResultSchema,
  isProviderItemNotFoundError,
  type PluginNormalizedResult,
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
  SpotifyAlbumTrackListStartSchema,
  SpotifyIdSchema,
  SpotifyTracksPageSchema,
  completeSpotifyAlbumTracks,
  normalizeSpotifyAlbum,
  spotifyAlbumId,
  spotifyAlbumReadError,
  spotifyAlbumTrackPageFits,
  spotifyAlbumTrackPositionsUnique,
  spotifyJson,
} from '@/lib/spotify-api'
import { spotifyClientToken, spotifyMarket } from '@/plugins/builtin/spotify'
import {
  catalogMediaAlias,
  libraryTrack,
  mediaItem,
  providerCurrentState,
  providerSnapshot,
  track,
} from '@/schemas/db'
import {
  lockLibraryTrackWrites,
  spotifyAlbumReleaseIds,
} from './album-library-tracks'
import { admitAlbumTrackMembers } from './album-track-membership'
import {
  observeCatalogMedia,
  promoteCatalogMedia,
  promoteCatalogMediaInTransaction,
  resolveCatalogMediaId,
  resolveCatalogReferences,
  type CatalogMedia,
} from './catalog-discoveries'
import { IN_REQUEST_SLOT_WAIT_MS } from '@/lib/request-policy'
import type { TaskJobContext, TaskJobResult } from './jobs'
import { assertProviderConfigured, providerOperation } from './manual-add'
import { latestCatalogResponseId } from './music-catalog-observations'
import { observeMusicDiscovery } from './music-provider-observations'
import { readMediaProviderWithEvidence } from './interactive-media-provider-response'
import { applyProviderResultInTransaction } from './provider-state'
import { createProviderRequest } from './provider-requests'
import { saveProviderResponseCapture } from './provider-response-history'
import { recordSpotifyCatalogCodes } from './spotify-catalog-codes'
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
  external_ids: z
    .object({ isrc: z.string().optional() })
    .optional()
    .catch(undefined),
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
    if (add || !(await albumIsCached(tx, mediaItemId, releaseId)))
      return { mediaItemId, releaseId }
    return { mediaItemId }
  })
}

const LinkedAlbumSchema = z.object({
  id: z.string(),
  inLibrary: z.boolean(),
  spotifyIds: SpotifyIdSchema.array(),
})

async function readLinkedAlbum(
  tx: Pick<Transaction, 'execute'>,
  albumId: string,
) {
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
  {
    action = 'opening this album',
    getToken = spotifyClientToken,
    refresh = false,
  }: {
    action?: string
    getToken?: typeof spotifyClientToken
    refresh?: boolean
  } = {},
) {
  const path = `${kind}/${id}`
  const url = `https://api.spotify.com/v1/${path}`
  const saved = refresh
    ? undefined
    : await storedExactResponse(mediaItemId, url, id, schema)
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
            const token = await getToken(secrets, request)
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
      action,
      IN_REQUEST_SLOT_WAIT_MS,
    )
  } catch (error) {
    if (error instanceof ServerError) {
      if (isProviderItemNotFoundError(error.cause))
        throw new ServerError({
          statusCode: 404,
          message: `Spotify could not find this ${kind === 'tracks' ? 'track' : 'album'}.`,
        })
    }
    throw spotifyAlbumReadError(error)
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
    if (latest?.spotifyTrackId === spotifyTrackId) {
      await recordSpotifyCatalogCodes(tx, [
        {
          mediaItemId: latest.id,
          kind: 'track',
          value: data.external_ids?.isrc,
          origin: { operation: SPOTIFY_TRACK_ALBUM_LOOKUP_TASK, snapshotId },
        },
      ])
      if (!(latest.spotifyAlbumId && spotifyAlbumId(latest.spotifyAlbumId)))
        await cacheTrackAlbum(tx, latest.id, evidence)
    }
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

type SpotifyAlbumDetails = {
  data: z.infer<typeof SpotifyAlbumSchema>
  snapshotId: string
  observedAt: Date
}

async function confirmObservedAlbumRecordings(
  tx: Transaction,
  albumId: string,
  tracks: PluginNormalizedResult['tracks'],
) {
  const entries: CatalogMedia[] = tracks.flatMap(({ externalId, title }) =>
    externalId
      ? [
          {
            kind: 'track',
            provider: 'spotify',
            referenceType: 'track',
            externalId,
            title,
          },
        ]
      : [],
  )
  if (!entries.length) return
  const matches = await resolveCatalogReferences(tx, entries)
  const candidates = new Map<string, string[]>()
  for (const [externalId, match] of matches) {
    if (match.references.size !== 1) continue
    const [id] = match.references
    if (id) candidates.set(id, [...(candidates.get(id) ?? []), externalId])
  }
  const exact = [...candidates].flatMap(([id, [spotifyId, alternate]]) =>
    spotifyId && !alternate ? [{ id, spotify_id: spotifyId }] : [],
  )
  if (!exact.length) return
  // An observed track can already have an address before a complete list
  // confirms its Spotify ID. Keep an existing native recording when present.
  await tx.execute(sql`
    update library_track recording set spotify_track_id = exact.spotify_id
    from jsonb_to_recordset(${JSON.stringify(exact)}::jsonb) exact(id text, spotify_id text)
    join media_item observed on observed.id = exact.id
    where recording.media_item_id = exact.id and recording.album_media_item_id = ${albumId}
      and recording.spotify_track_id is null and not observed.in_library
      and observed.metadata->>'legacyHidden' is distinct from 'true'
      and not exists (select 1 from library_track native where native.spotify_track_id = exact.spotify_id)
  `)
}

async function storeExactAlbum(
  tx: Transaction,
  mediaItemId: string,
  { data, snapshotId, observedAt }: SpotifyAlbumDetails,
  { payload, normalized }: ReturnType<typeof normalizeSpotifyAlbum>,
) {
  await confirmObservedAlbumRecordings(tx, mediaItemId, normalized.tracks)
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
}

async function loadAlbum(mediaItemId: string, releaseId: string) {
  return withLookupLock(`albums/${releaseId}`, async (tx) => {
    if (await albumIsCached(tx, mediaItemId, releaseId)) return
    const details = await readExactSpotifyResource(
      mediaItemId,
      'albums',
      releaseId,
      SpotifyAlbumSchema,
    )
    const result = normalizeSpotifyAlbum(details.data)
    // Follow the normal provider write lock order. A full refresh or identity
    // correction may have finished while the interactive read was in flight.
    if (result.normalized.tags.length) await lockTagWrites(tx)
    await lockLibraryTrackWrites(tx)
    const current = await readLinkedAlbum(tx, mediaItemId)
    if (!current?.spotifyIds.includes(releaseId)) throw releaseUnavailable()
    if (await albumIsCached(tx, mediaItemId, releaseId)) return
    await storeExactAlbum(tx, mediaItemId, details, result)
  })
}

async function storedAlbumTrackPages(
  mediaItemId: string,
  path: string,
  observedAt: Date,
) {
  const rows = await db
    .select({
      text: sql<unknown>`${providerSnapshot.payload} #>> '{response,body,text}'`,
    })
    .from(providerSnapshot)
    .where(
      and(
        eq(providerSnapshot.mediaItemId, mediaItemId),
        eq(providerSnapshot.provider, 'spotify'),
        eq(providerSnapshot.source, DIRECT_PROVIDER_RESPONSE_SOURCE),
        gte(providerSnapshot.createdAt, observedAt),
        sql`${providerSnapshot.payload} #>> '{request,url}' = ${'https://api.spotify.com/v1/' + path}
          and (${providerSnapshot.payload} #>> '{response,status}')::integer between 200 and 299
          and ${providerSnapshot.payload} #>> '{response,body,state}' = 'captured'`,
      ),
    )
    .orderBy(desc(providerSnapshot.createdAt), desc(providerSnapshot.id))
    .limit(15)
  const pages = new Map<number, z.infer<typeof SpotifyTracksPageSchema>>()
  for (const { text } of rows) {
    if (typeof text !== 'string') continue
    try {
      const result = SpotifyTracksPageSchema.safeParse(JSON.parse(text))
      if (result.success && !pages.has(result.data.offset))
        pages.set(result.data.offset, result.data)
    } catch {
      // This response remains available in Sources.
    }
  }
  return [...pages.values()].sort((left, right) => left.offset - right.offset)
}

function continuationsMatchAlbum(
  head: z.infer<typeof SpotifyTracksPageSchema>,
  continuations: z.infer<typeof SpotifyTracksPageSchema>[],
) {
  const tracks = [...head.items]
  for (const page of continuations) {
    if (!spotifyAlbumTrackPageFits(page, tracks.length, head.total))
      return false
    tracks.push(...page.items)
  }
  return spotifyAlbumTrackPositionsUnique(tracks)
}

async function readCompleteSpotifyAlbum(
  mediaItemId: string,
  releaseId: string,
) {
  const action = 'adding this album'
  let token: string | undefined
  const getToken: typeof spotifyClientToken = async (secrets, request) =>
    (token ??= await spotifyClientToken(secrets, request))
  const readHead = (refresh = false) =>
    readExactSpotifyResource(
      mediaItemId,
      'albums',
      releaseId,
      SpotifyAlbumTrackListStartSchema,
      { action, getToken, refresh },
    )
  let details = await readHead()
  const path = `albums/${releaseId}/tracks`
  let pages = details.data.tracks.next
    ? await storedAlbumTrackPages(mediaItemId, path, details.observedAt)
    : []
  // A successful page that no longer fits proves the retained head is stale.
  // A failed request during a cooldown is excluded and preserves progress.
  if (!continuationsMatchAlbum(details.data.tracks, pages)) {
    details = await readHead(true)
    pages = []
  }
  try {
    const data = await completeSpotifyAlbumTracks(
      details.data,
      async (offset, total) => {
        const cached = pages.find((page) =>
          spotifyAlbumTrackPageFits(page, offset, total),
        )
        if (cached) return cached
        return providerOperation(
          'spotify',
          async ({ secrets }, plugin) => {
            const { result } = await readMediaProviderWithEvidence(
              {
                mediaItemId,
                plugin,
                secrets,
                maxSlotWaitMs: IN_REQUEST_SLOT_WAIT_MS,
              },
              async (request) =>
                spotifyJson(request, await getToken(secrets, request), path, {
                  ...spotifyMarket(secrets),
                  offset: String(offset),
                  limit: '50',
                }),
            )
            return result
          },
          undefined,
          action,
          IN_REQUEST_SLOT_WAIT_MS,
        )
      },
    )
    return { details, data }
  } catch (error) {
    if (
      error instanceof ServerError ||
      error instanceof ProviderResponseStorageError
    )
      throw spotifyAlbumReadError(error)
    throw new ServerError({
      statusCode: 502,
      message: 'Spotify returned an incomplete album track list. Try again.',
      cause: error,
    })
  }
}

async function hasCompleteStoredSpotifyTrackList(
  tx: Transaction,
  mediaItemId: string,
  releaseId: string,
) {
  const [current] = await tx
    .select({ normalized: providerCurrentState.normalizedData })
    .from(providerCurrentState)
    .where(
      and(
        eq(providerCurrentState.mediaItemId, mediaItemId),
        eq(providerCurrentState.provider, 'spotify'),
      ),
    )
  const normalized = PluginNormalizedResultSchema.safeParse(
    current?.normalized,
  ).data
  if (
    !normalized?.tracks.length ||
    !normalized.references.some(
      (ref) => ref.referenceType === 'album' && ref.externalId === releaseId,
    )
  )
    return false
  const positions = await tx
    .select({
      position: track.position,
      externalId: track.externalId,
      title: track.title,
    })
    .from(track)
    .where(eq(track.albumMediaItemId, mediaItemId))
    .orderBy(track.position)
    .limit(normalized.tracks.length + 1)
  return (
    positions.length === normalized.tracks.length &&
    normalized.tracks.every((entry, index) => {
      const position = positions[index]
      return (
        position?.position === entry.position &&
        position.externalId === (entry.externalId ?? null) &&
        position.title === entry.title
      )
    })
  )
}

/** Add the chosen release and its complete track list in one library transaction. */
export async function addStoredSpotifyAlbum(
  mediaItemId: string,
  releaseId: string,
  ownerId?: string,
) {
  return withLookupLock(`albums/${releaseId}`, async (tx) => {
    // Check under the write lock, then release it before any provider request.
    const cached = await db.transaction(async (writer) => {
      await lockLibraryTrackWrites(writer)
      const album = await readLinkedAlbum(writer, mediaItemId)
      if (!album?.spotifyIds.includes(releaseId)) throw releaseUnavailable()
      const complete = await hasCompleteStoredSpotifyTrackList(
        writer,
        mediaItemId,
        releaseId,
      )
      if (album.inLibrary) {
        if (complete) await admitAlbumTrackMembers(writer, mediaItemId)
        return { mediaItemId, created: false }
      }
      if (complete)
        return promoteCatalogMediaInTransaction(writer, mediaItemId, ownerId)
    })
    if (cached) return cached
    const { details, data } = await readCompleteSpotifyAlbum(
      mediaItemId,
      releaseId,
    )
    const albumResult = normalizeSpotifyAlbum(data)
    if (albumResult.normalized.tags.length) await lockTagWrites(tx)
    await lockLibraryTrackWrites(tx)
    const current = await readLinkedAlbum(tx, mediaItemId)
    if (!current?.spotifyIds.includes(releaseId)) throw releaseUnavailable()
    const result = await promoteCatalogMediaInTransaction(
      tx,
      mediaItemId,
      ownerId,
    )
    if (await hasCompleteStoredSpotifyTrackList(tx, mediaItemId, releaseId)) {
      if (!result.created) await admitAlbumTrackMembers(tx, mediaItemId)
      return result
    }
    await storeExactAlbum(tx, mediaItemId, details, albumResult)
    return result
  })
}

export async function addCatalogItem(mediaItemId: string, ownerId: string) {
  const canonicalId = await resolveCatalogMediaId(db, mediaItemId)
  const album = await readLinkedAlbum(db, canonicalId)
  if (
    !album ||
    !album.spotifyIds.length ||
    (album.inLibrary && album.spotifyIds.length > 1)
  )
    return promoteCatalogMedia(canonicalId, ownerId)
  const [releaseId, alternate] = album.spotifyIds
  if (!releaseId || alternate)
    throw new ServerError({
      statusCode: 409,
      message:
        'This album has multiple Spotify releases. Choose the release to add.',
    })
  return addStoredSpotifyAlbum(canonicalId, releaseId, ownerId)
}

/** Resolve an exact parent recorded on a track. Opening it never adds membership. */
export async function openSpotifyAlbumReference(
  input: SpotifyAlbumReferenceInput,
  userId: string,
) {
  let parent = await resolveStoredParent(input)
  if ('spotifyTrackId' in parent) {
    const lookup = await loadTrackParent(parent.trackId, parent.spotifyTrackId)
    parent = await resolveStoredParent(input, lookup)
  }
  if (!('mediaItemId' in parent)) throw releaseUnavailable()
  if (parent.releaseId) {
    if (input.add)
      await addStoredSpotifyAlbum(parent.mediaItemId, parent.releaseId, userId)
    else await loadAlbum(parent.mediaItemId, parent.releaseId)
  }
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
    await context.activity('Checking the track’s saved release')
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
    await context.activity('Reading the track’s Spotify release')
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
    const isrc = parent.data.external_ids?.isrc
    return {
      outcome: 'complete',
      message: 'Confirmed the track’s Spotify release by ID.',
      options: { releaseEvidence: evidence },
      async persist(tx) {
        await lockLibraryTrackWrites(tx)
        const current = await trackReference(tx, trackId)
        if (current?.spotifyTrackId !== spotifyTrackId) return
        await recordSpotifyCatalogCodes(tx, [
          {
            mediaItemId: current.id,
            kind: 'track',
            value: isrc,
            origin: {
              operation: SPOTIFY_TRACK_ALBUM_LOOKUP_TASK,
              jobId: context.jobId,
              responseId: evidence.responseId ?? undefined,
            },
          },
        ])
        if (!(current.spotifyAlbumId && spotifyAlbumId(current.spotifyAlbumId)))
          await cacheTrackAlbum(tx, current.id, evidence)
      },
    }
  } catch (error) {
    if (!(await context.isActive())) return { outcome: 'stopped' }
    return { outcome: 'failed', error }
  }
}
