import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { SpotifyCodeMatchSchema } from '@repo/schemas/tidal'
import type { db } from '@/lib/db'
import {
  SpotifyAlbumSchema,
  SpotifyIdSchema,
  spotifyArtworkUrl,
} from '@/lib/spotify-api'
import {
  album,
  catalogObservation,
  libraryTrack,
  mediaItem,
  providerReference,
  providerResponse,
  providerSnapshot,
  spotifyCodeLookup,
} from '@/schemas/db'
import { lockLibraryTrackWrites } from './album-library-tracks'
import {
  catalogReferenceValues,
  newCatalogMediaId,
  observeCatalogOccurrences,
  resolveCatalogReferences,
  writeOutsideCatalogMedia,
  type CatalogMedia,
  type CatalogOrigin,
} from './catalog-discoveries'
import { readRetainedMusicResponse } from './music-provider-observations'

const BATCH_SIZE = 500
const AlbumArtworkSchema = SpotifyAlbumSchema.pick({ id: true, images: true })
const ArtworkUrlSchema = z.url({ protocol: /^https$/ })
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type TrackEvidence = {
  nativeAlbumId: string
  albumId?: string
  albumName?: string | null
  artworkUrl?: string | null
  lookup?: { code: string; jobId?: string }
}

function recordEvidence(
  sources: Map<string, TrackEvidence[]>,
  id: string,
  evidence: TrackEvidence,
) {
  const track = sources.get(id) ?? []
  track.push(evidence)
  sources.set(id, track)
}

function trackAlbumOrigin(trackId: string): CatalogOrigin {
  return {
    provider: 'spotify',
    operation: 'stored-track-album',
    occurrenceKey: trackId,
    subjectKind: 'track',
    subjectId: trackId,
    relationshipRole: 'candidate_album',
  }
}

async function materializeStoredAlbums(
  tx: Transaction,
  missing: Map<string, string>,
  lookupAlbums: Map<string, TrackEvidence[]>,
) {
  if (!missing.size) return []
  const metadata = await tx
    .select({
      externalId: libraryTrack.spotifyAlbumId,
      name: libraryTrack.albumName,
      artworkUrl: mediaItem.artworkUrl,
    })
    .from(libraryTrack)
    .innerJoin(mediaItem, eq(mediaItem.id, libraryTrack.mediaItemId))
    .where(
      and(
        inArray(libraryTrack.spotifyAlbumId, [...missing.keys()]),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
  const byRelease = new Map<
    string,
    { titles: Set<string>; covers: Set<string> }
  >()
  for (const { externalId, name, artworkUrl } of metadata) {
    if (!externalId) continue
    const release = byRelease.get(externalId) ?? {
      titles: new Set<string>(),
      covers: new Set<string>(),
    }
    if (name?.trim()) release.titles.add(name.trim())
    const cover = ArtworkUrlSchema.safeParse(artworkUrl).data
    if (cover) release.covers.add(cover)
    byRelease.set(externalId, release)
  }
  for (const externalId of missing.keys()) {
    for (const { albumName, artworkUrl } of lookupAlbums.get(externalId) ??
      []) {
      const release = byRelease.get(externalId) ?? {
        titles: new Set<string>(),
        covers: new Set<string>(),
      }
      if (albumName?.trim()) release.titles.add(albumName.trim())
      if (artworkUrl) release.covers.add(artworkUrl)
      byRelease.set(externalId, release)
    }
  }
  const candidates = [...missing].flatMap(([externalId, trackId]) => {
    const release = byRelease.get(externalId)
    if (release?.titles.size !== 1) return []
    const [title] = release.titles
    if (!title) return []
    const media = {
      kind: 'album',
      provider: 'spotify',
      referenceType: 'spotify',
      externalId,
      title,
      spotifyUrl: `https://open.spotify.com/album/${externalId}`,
      artworkUrl:
        release.covers.size === 1 ? [...release.covers][0] : undefined,
    } satisfies CatalogMedia
    return [{ id: newCatalogMediaId(media, trackAlbumOrigin(trackId)), media }]
  })
  const occupied = new Set(
    (
      await tx
        .select({ id: mediaItem.id })
        .from(mediaItem)
        .where(
          inArray(
            mediaItem.id,
            candidates.map(({ id }) => id),
          ),
        )
    ).map(({ id }) => id),
  )
  const created = candidates.filter(({ id }) => !occupied.has(id))
  await writeOutsideCatalogMedia(tx, created)
  const references = created.flatMap(({ id, media }) => {
    const reference = catalogReferenceValues(id, media)
    return reference ? [reference] : []
  })
  if (references.length)
    await tx.insert(providerReference).values(references).onConflictDoNothing()
  return created
}

async function loadSpotifyLookupEvidence(tx: Transaction, trackIds: string[]) {
  const rows = await tx
    .select({
      spotifyId: spotifyCodeLookup.spotifyId,
      result: spotifyCodeLookup.result,
      code: spotifyCodeLookup.code,
      jobId: spotifyCodeLookup.scrapeJobId,
    })
    .from(spotifyCodeLookup)
    .where(
      and(
        eq(spotifyCodeLookup.source, 'spotify'),
        eq(spotifyCodeLookup.codeType, 'isrc'),
        inArray(spotifyCodeLookup.spotifyId, trackIds),
      ),
    )
  const byTrack = new Map<string, TrackEvidence[]>()
  for (const row of rows) {
    const match = SpotifyCodeMatchSchema.safeParse(row.result).data
    if (!match?.spotifyAlbumId || match.spotifyId !== row.spotifyId) continue
    recordEvidence(byTrack, match.spotifyId, {
      nativeAlbumId: match.spotifyAlbumId,
      albumName: match.albumName,
      artworkUrl: match.artworkUrl,
      lookup: { code: row.code, jobId: row.jobId ?? undefined },
    })
  }
  return byTrack
}

function exactAlbumIdentity(stored: string | null, evidence: TrackEvidence[]) {
  const [nativeAlbumId, conflict] = new Set([
    ...(stored ? [stored] : []),
    ...evidence.map((source) => source.nativeAlbumId),
  ])
  return conflict ? undefined : SpotifyIdSchema.safeParse(nativeAlbumId).data
}

/** Fill missing details for outside tracks with an exact retained Spotify album identity. */
export async function repairShadowTrackDetails(
  apply: boolean,
  database: typeof db,
) {
  const dryRun = Symbol('shadow track repair dry run')
  const counts = {
    albumLinks: 0,
    artwork: 0,
    inheritedArtwork: 0,
    albumsCreated: 0,
  }
  try {
    await database.transaction(async (tx) => {
      await lockLibraryTrackWrites(tx)
      const tracks = await tx
        .select({
          id: libraryTrack.mediaItemId,
          trackId: libraryTrack.spotifyTrackId,
          nativeAlbumId: libraryTrack.spotifyAlbumId,
          albumId: libraryTrack.albumMediaItemId,
          artworkUrl: mediaItem.artworkUrl,
        })
        .from(libraryTrack)
        .innerJoin(mediaItem, eq(mediaItem.id, libraryTrack.mediaItemId))
        .where(sql`
        not ${mediaItem.inLibrary}
        and ${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'
        and (${libraryTrack.albumMediaItemId} is null or (
          ${mediaItem.artworkUrl} is null and not exists (
            select 1 from media_item parent
            where parent.id = ${libraryTrack.albumMediaItemId}
              and parent.artwork_url is not null
          )
        ))
        and (${libraryTrack.spotifyAlbumId} is not null or (
          ${libraryTrack.spotifyTrackId} is not null and (exists (
            select 1 from catalog_observation observation
            where observation.target_kind = 'track'
              and observation.target_id = ${libraryTrack.mediaItemId}
              and observation.provider = 'spotify'
              and observation.subject_kind = 'album'
              and observation.relationship_role in ('track_on_edition', 'recording_on_release', 'track-on-album')
              and (observation.response_id is not null or observation.snapshot_id is not null)
          ) or exists (
            select 1 from spotify_code_lookup lookup
            where lookup.spotify_id = ${libraryTrack.spotifyTrackId}
              and lookup.source = 'spotify' and lookup.code_type = 'isrc'
          ))
        ))
      `)

      const createdAlbums = new Set<string>()
      const lookupByTrack = new Map<string, TrackEvidence[]>()
      for (let start = 0; start < tracks.length; start += BATCH_SIZE) {
        const lookupBatch = await loadSpotifyLookupEvidence(
          tx,
          tracks
            .slice(start, start + BATCH_SIZE)
            .flatMap(({ trackId }) => (trackId ? [trackId] : [])),
        )
        for (const [id, sources] of lookupBatch) lookupByTrack.set(id, sources)
      }
      const lookupAlbums = new Map<string, TrackEvidence[]>()
      for (const { trackId, nativeAlbumId } of tracks) {
        const sources = (trackId && lookupByTrack.get(trackId)) || []
        const exactId = exactAlbumIdentity(nativeAlbumId, sources)
        if (exactId)
          for (const source of sources)
            recordEvidence(lookupAlbums, exactId, source)
      }
      for (let start = 0; start < tracks.length; start += BATCH_SIZE) {
        const batch = tracks.slice(start, start + BATCH_SIZE)
        const trackByItem = new Map(batch.map((track) => [track.id, track]))
        const evidence = new Map<string, TrackEvidence[]>()
        for (const { id, trackId } of batch) {
          const sources = trackId && lookupByTrack.get(trackId)
          if (sources) evidence.set(id, [...sources])
        }
        const decodedResponses = new Map<
          string,
          ReturnType<typeof readRetainedMusicResponse>
        >()
        const observations = await tx
          .select({
            id: catalogObservation.targetId,
            albumId: catalogObservation.subjectId,
            response: providerResponse,
            snapshot: providerSnapshot.payload,
          })
          .from(catalogObservation)
          .leftJoin(
            providerResponse,
            and(
              eq(providerResponse.id, catalogObservation.responseId),
              eq(providerResponse.provider, 'spotify'),
              eq(providerResponse.bodyState, 'captured'),
            ),
          )
          .leftJoin(
            providerSnapshot,
            and(
              eq(providerSnapshot.id, catalogObservation.snapshotId),
              eq(providerSnapshot.mediaItemId, catalogObservation.subjectId),
              eq(providerSnapshot.provider, 'spotify'),
            ),
          )
          .where(
            and(
              eq(catalogObservation.targetKind, 'track'),
              eq(catalogObservation.provider, 'spotify'),
              eq(catalogObservation.subjectKind, 'album'),
              inArray(catalogObservation.relationshipRole, [
                'track_on_edition',
                'recording_on_release',
                'track-on-album',
              ]),
              inArray(
                catalogObservation.targetId,
                batch.map(({ id }) => id),
              ),
              or(
                sql`${providerResponse.id} is not null`,
                sql`${providerSnapshot.id} is not null`,
              ),
            ),
          )
        for (const { id, albumId, response, snapshot } of observations) {
          const nativeTrackId = SpotifyIdSchema.safeParse(
            trackByItem.get(id)?.trackId,
          ).data
          if (!albumId || !nativeTrackId) continue
          if (response) {
            const discoveries =
              decodedResponses.get(response.id) ??
              readRetainedMusicResponse(response)
            decodedResponses.set(response.id, discoveries)
            for (const node of discoveries) {
              if (
                node.kind === 'album' &&
                node.externalId &&
                node.children?.some(
                  (track) =>
                    track.kind === 'track' &&
                    track.externalId === nativeTrackId,
                )
              )
                recordEvidence(evidence, id, {
                  nativeAlbumId: node.externalId,
                  albumId,
                  artworkUrl: node.artworkUrl,
                })
            }
          }
          const retained = SpotifyAlbumSchema.safeParse(snapshot).data
          if (retained?.tracks?.items.some(({ id }) => id === nativeTrackId))
            recordEvidence(evidence, id, {
              nativeAlbumId: retained.id,
              albumId,
              artworkUrl: spotifyArtworkUrl(retained.images),
            })
        }

        const albumIds = new Set(
          batch.flatMap(({ id, nativeAlbumId }) => [
            ...(SpotifyIdSchema.safeParse(nativeAlbumId).success &&
            nativeAlbumId
              ? [nativeAlbumId]
              : []),
            ...(evidence.get(id) ?? []).map((source) => source.nativeAlbumId),
          ]),
        )
        const resolved = await resolveCatalogReferences(
          tx,
          [...albumIds].map((externalId) => ({
            kind: 'album',
            provider: 'spotify',
            title: '',
            referenceType: 'spotify',
            externalId,
            spotifyUrl: `https://open.spotify.com/album/${externalId}`,
          })),
        )
        const missing = new Map<string, string>()
        for (const track of batch) {
          const sources = evidence.get(track.id) ?? []
          const nativeAlbumId = exactAlbumIdentity(track.nativeAlbumId, sources)
          if (!nativeAlbumId || track.albumId) continue
          const match = resolved.get(nativeAlbumId)
          if (
            match &&
            !match.references.size &&
            !match.blocked.size &&
            !sources.some((source) => source.albumId)
          )
            missing.set(nativeAlbumId, track.id)
        }
        for (const { id, media } of await materializeStoredAlbums(
          tx,
          missing,
          lookupAlbums,
        )) {
          createdAlbums.add(id)
          counts.albumsCreated++
          resolved.get(media.externalId)?.references.add(id)
        }
        const parents = await tx
          .select({ id: mediaItem.id, artworkUrl: mediaItem.artworkUrl })
          .from(album)
          .innerJoin(mediaItem, eq(mediaItem.id, album.mediaItemId))
          .where(
            and(
              inArray(album.mediaItemId, [
                ...new Set(
                  [...resolved.values()].flatMap(({ references }) => [
                    ...references,
                  ]),
                ),
              ]),
              sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
            ),
          )
        const parentArtwork = new Map(
          parents.map(({ id, artworkUrl }) => [id, artworkUrl]),
        )
        const parentsWithoutArtwork = parents
          .filter(({ artworkUrl }) => !artworkUrl)
          .map(({ id }) => id)
        const albumSnapshots = await tx
          .select({
            albumId: providerSnapshot.mediaItemId,
            payload: providerSnapshot.payload,
          })
          .from(providerSnapshot)
          .where(
            and(
              eq(providerSnapshot.provider, 'spotify'),
              inArray(providerSnapshot.mediaItemId, parentsWithoutArtwork),
              inArray(sql<string>`${providerSnapshot.payload}->>'id'`, [
                ...albumIds,
              ]),
            ),
          )
        const snapshotArtwork = new Map<string, Set<string>>()
        for (const { albumId, payload } of albumSnapshots) {
          const release = AlbumArtworkSchema.safeParse(payload).data
          if (!release) continue
          const cover = spotifyArtworkUrl(release.images)
          if (!cover) continue
          const key = JSON.stringify([albumId, release.id])
          const urls = snapshotArtwork.get(key) ?? new Set<string>()
          urls.add(cover)
          snapshotArtwork.set(key, urls)
        }
        const repairs = batch.flatMap((track) => {
          const sources = evidence.get(track.id) ?? []
          const nativeAlbumId = exactAlbumIdentity(track.nativeAlbumId, sources)
          if (!nativeAlbumId) return []
          const match = resolved.get(nativeAlbumId)
          if (match?.references.size !== 1) return []
          const [albumId] = match.references
          if (
            !albumId ||
            !parentArtwork.has(albumId) ||
            (track.albumId && track.albumId !== albumId) ||
            sources.some(
              (source) => source.albumId && source.albumId !== albumId,
            )
          )
            return []
          const cover = parentArtwork.get(albumId)
          const [retainedCover, conflictingCover] = new Set([
            ...sources.flatMap(({ artworkUrl }) =>
              artworkUrl ? [artworkUrl] : [],
            ),
            ...(snapshotArtwork.get(JSON.stringify([albumId, nativeAlbumId])) ??
              []),
          ])
          const artworkUrl =
            track.artworkUrl || cover || conflictingCover
              ? null
              : (retainedCover ?? null)
          if (track.albumId && !artworkUrl) return []
          return [
            {
              id: track.id,
              albumId,
              nativeAlbumId,
              link: track.albumId === null,
              artworkUrl,
              lookup: sources.flatMap((source) =>
                source.lookup ? [source.lookup] : [],
              ),
              inheritedArtwork:
                track.albumId === null && !track.artworkUrl && Boolean(cover),
            },
          ]
        })

        for (const repair of repairs) {
          if (repair.link) counts.albumLinks++
          if (repair.artworkUrl) counts.artwork++
          if (repair.inheritedArtwork) counts.inheritedArtwork++
        }
        if (!repairs.length) continue
        await observeCatalogOccurrences(
          tx,
          repairs.flatMap(({ id, albumId, lookup }) =>
            lookup.map(({ code, jobId }) => ({
              target: { kind: 'track', id },
              origin: {
                provider: 'spotify',
                operation: 'stored-spotify-code-lookup',
                occurrenceKey: JSON.stringify([id, code]),
                subjectKind: 'album',
                subjectId: albumId,
                relationshipRole: 'recording_on_release',
                details: { isrc: code },
                jobId,
              },
            })),
          ),
        )
        await observeCatalogOccurrences(
          tx,
          repairs.flatMap(({ id, albumId }) =>
            createdAlbums.has(albumId)
              ? [
                  {
                    target: { kind: 'album', id: albumId },
                    origin: trackAlbumOrigin(id),
                  },
                ]
              : [],
          ),
        )
        const records = sql`jsonb_to_recordset(${JSON.stringify(repairs)}::jsonb)`
        await tx.execute(sql`
        update library_track t set album_media_item_id = r."albumId",
          spotify_album_id = coalesce(t.spotify_album_id, r."nativeAlbumId"),
          album_link_strategy = 'spotify-album'
        from ${records} as r(id text, "albumId" text, "nativeAlbumId" text, link boolean)
        join media_item m on m.id = r.id
        where t.media_item_id = r.id and r.link and t.album_media_item_id is null
          and not m.in_library and m.metadata->>'legacyHidden' is distinct from 'true'`)
        await tx.execute(sql`
        update media_item m set artwork_url = r."artworkUrl"
        from ${records} as r(id text, "artworkUrl" text)
        where m.id = r.id and r."artworkUrl" is not null and m.artwork_url is null
          and not m.in_library and m.metadata->>'legacyHidden' is distinct from 'true'`)
      }
      if (!apply) throw dryRun
    })
  } catch (error) {
    if (error !== dryRun) throw error
  }
  return counts
}
