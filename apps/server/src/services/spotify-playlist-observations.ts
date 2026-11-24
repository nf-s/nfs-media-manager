import { eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { SpotifyIdSchema } from '@/lib/spotify-api'
import {
  artist,
  libraryTrack,
  mediaCredit,
  mediaItem,
  providerReference,
} from '@/schemas/db'
import { observeNamedArtistIdentitiesWithoutMerging } from './catalog-artist-identities'
import {
  catalogCreditOccurrence,
  catalogReferenceValues,
  newCatalogMediaId,
  observeCatalogMedia,
  observeCatalogOccurrences,
  provisionalCatalogArtistId,
  resolveCatalogReferences,
  spotifyTrackCatalogCredits,
  writeOutsideCatalogMedia,
  type CatalogMedia,
  type CatalogOccurrence,
  type CatalogOrigin,
} from './catalog-discoveries'
import { spotifyTrackAndAlbumObservations } from './music-catalog-observations'
import type { PlaylistPage } from './spotify-playlists'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Evidence = {
  jobId?: string
  snapshot?: string | null
  observedAt?: Date
  complete?: boolean
}
type Observation = { media: CatalogMedia; origin: CatalogOrigin }
type ResolvedObservation = Observation & {
  id: string
  outside: boolean
}

function playlistObservations(
  playlistId: string,
  page: PlaylistPage,
  evidence: Evidence,
) {
  return page.entries.map(
    ({
      position,
      track,
      mention,
    }): {
      recording: Observation
      album?: Observation
    } => {
      const key = JSON.stringify([
        evidence.snapshot ?? evidence.jobId ?? 'stored',
        position,
      ])
      const origin = {
        operation: 'playlist-contents',
        key,
        subjectKind: 'playlist',
        subjectId: playlistId,
        jobId: evidence.jobId,
        observedAt: evidence.observedAt,
        responseId: page.responseId,
        page: page.page,
        position,
        details: {
          snapshot: evidence.snapshot ?? null,
          version: evidence.jobId ?? evidence.snapshot ?? null,
          total: page.total,
          complete: evidence.complete ?? false,
          addedAt: track?.addedAt ?? null,
        },
        relationshipRole: 'playlist_entry',
      }
      if (track)
        return spotifyTrackAndAlbumObservations(
          {
            ...track,
            spotifyUrl: `https://open.spotify.com/track/${track.spotifyTrackId}`,
          },
          origin,
        )
      return {
        recording: {
          media: {
            kind: 'track',
            title: mention.name,
            provider: 'spotify',
            referenceType: 'track',
            credits: mention.artists.map(({ id, name }) => ({
              name,
              externalId: SpotifyIdSchema.safeParse(id).data,
            })),
          },
          origin: { ...origin, provider: 'spotify', occurrenceKey: key },
        },
      }
    },
  )
}

async function observeIndividually(
  tx: Transaction,
  entries: ReturnType<typeof playlistObservations>,
) {
  for (const { album, recording } of entries) {
    const albumId = album
      ? await observeCatalogMedia(tx, album.media, album.origin)
      : undefined
    await observeCatalogMedia(
      tx,
      { ...recording.media, albumId },
      recording.origin,
    )
  }
}

/** Retain observations when the input has no previously imported tracks. */
export function observeSpotifyPlaylistPage(
  tx: Transaction,
  playlistId: string,
  page: PlaylistPage,
  evidence: Evidence,
) {
  return observeIndividually(
    tx,
    playlistObservations(playlistId, page, evidence),
  )
}

async function resolveObservations(
  tx: Transaction,
  entries: ReturnType<typeof playlistObservations>,
) {
  const trackIds = [
    ...new Set(
      entries.flatMap(({ recording }) =>
        recording.media.externalId ? [recording.media.externalId] : [],
      ),
    ),
  ]
  const tracks = trackIds.length
    ? await tx
        .select({
          id: mediaItem.id,
          inLibrary: mediaItem.inLibrary,
          artistCredits: sql<unknown>`${mediaItem.metadata}->'spotifyArtistCredits'`,
          externalId: libraryTrack.spotifyTrackId,
        })
        .from(libraryTrack)
        .innerJoin(mediaItem, eq(mediaItem.id, libraryTrack.mediaItemId))
        .where(inArray(libraryTrack.spotifyTrackId, trackIds))
    : []
  if (tracks.length !== trackIds.length) return
  const tracksById = new Map(tracks.map((track) => [track.externalId, track]))

  const releases = entries.flatMap(({ album }) => (album ? [album] : []))
  const matches = await resolveCatalogReferences(
    tx,
    releases.map(({ media }) => media),
  )
  // Writing a native reference can supersede ambiguous URL matches. Two or
  // more native matches stay ambiguous when another native reference is added.
  if (
    [...matches.values()].some(
      ({ references, usedAlbumUrl }) => usedAlbumUrl && references.size > 1,
    )
  )
    return

  const releaseTargets = releases.map(({ media, origin }) => {
    const match = media.externalId ? matches.get(media.externalId) : undefined
    const existingId =
      match?.references.size === 1
        ? match.references.values().next().value
        : undefined
    return {
      media,
      origin,
      existing: Boolean(existingId),
      id: existingId ?? newCatalogMediaId(media, origin, match?.blocked),
      match,
    }
  })
  const releaseItemIds = [...new Set(releaseTargets.map(({ id }) => id))]
  const stored = new Map(
    releaseItemIds.length
      ? (
          await tx
            .select({ id: mediaItem.id, inLibrary: mediaItem.inLibrary })
            .from(mediaItem)
            .where(inArray(mediaItem.id, releaseItemIds))
        ).map(({ id, inLibrary }) => [id, inLibrary])
      : [],
  )
  // Existing rows at unclaimed deterministic addresses can change how a
  // duplicate occurrence resolves once the first reference is written.
  if (
    releaseTargets.some(
      ({ id, media, existing, match }) =>
        media.externalId &&
        !existing &&
        stored.has(id) &&
        !match?.references.has(id),
    )
  )
    return

  const byOrigin = new Map(
    releaseTargets.map((target) => [target.origin, target]),
  )
  const observations: ResolvedObservation[] = []
  for (const { album, recording } of entries) {
    const release = album && byOrigin.get(album.origin)
    if (release)
      observations.push({
        ...release,
        outside: !release.existing || !stored.get(release.id),
      })
    const track =
      recording.media.externalId && tracksById.get(recording.media.externalId)
    let credits = recording.media.credits ?? []
    if (track && credits.length === 1 && !credits[0]?.externalId)
      credits = spotifyTrackCatalogCredits(credits, track.artistCredits)
    observations.push({
      ...recording,
      id: track
        ? track.id
        : newCatalogMediaId(recording.media, recording.origin),
      outside: !track || !track.inLibrary,
      media: { ...recording.media, albumId: release?.id, credits },
    })
  }
  return observations
}

async function resolveCredits(
  tx: Transaction,
  observations: ResolvedObservation[],
) {
  const names = new Map<string, string>()
  for (const { media } of observations) {
    // The first occurrence supplying a native identity names a new artist.
    // Within that occurrence the last spelling of the same ID wins.
    const entryNames = new Map(
      media.credits?.flatMap(({ externalId, name }) =>
        externalId ? [[externalId, name]] : [],
      ),
    )
    for (const [id, name] of entryNames) if (!names.has(id)) names.set(id, name)
  }
  const observed = new Map<string, string>()
  const native = await observeNamedArtistIdentitiesWithoutMerging(
    tx,
    'spotify',
    names,
    observed,
  )
  if (!native) return

  const provisional = new Map<string, typeof artist.$inferInsert>()
  const credits = observations.flatMap(({ id, media, origin, outside }) =>
    (media.credits ?? []).map(
      ({ name, externalId, role = 'artist' }, position) => {
        const knownId = externalId && native.get(externalId)
        const artistId =
          knownId ||
          provisionalCatalogArtistId('spotify', id, role, position, name)
        if (!knownId)
          provisional.set(artistId, {
            id: artistId,
            name,
            sortName: name,
            catalogProvider: 'spotify',
          })
        return {
          outside,
          values: { mediaItemId: id, artistId, role, billingOrder: position },
          occurrence: catalogCreditOccurrence(
            {
              kind: 'artist',
              id: (externalId && observed.get(externalId)) || artistId,
            },
            origin,
            media.kind,
            id,
            role,
            position,
          ),
        }
      },
    ),
  )
  if (provisional.size) {
    const inserted = await tx
      .insert(artist)
      .values([...provisional.values()])
      .onConflictDoNothing()
      .returning({ id: artist.id })
    if (inserted.length < provisional.size) {
      const aliases = new Map(
        (
          await tx
            .select({ id: artist.id, survivor: artist.mergedIntoId })
            .from(artist)
            .where(inArray(artist.id, [...provisional.keys()]))
        ).map(({ id, survivor }) => [id, survivor]),
      )
      for (const { values } of credits)
        values.artistId = aliases.get(values.artistId) ?? values.artistId
    }
  }
  return credits
}

/** Store every playlist position after the import has resolved and written its native tracks. */
export async function observeSpotifyPlaylistPageBatch(
  tx: Transaction,
  playlistId: string,
  page: PlaylistPage,
  evidence: Evidence,
) {
  const entries = playlistObservations(playlistId, page, evidence)
  if (!entries.length) return
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  await observeEntries(tx, entries)
}

async function observeEntries(
  tx: Transaction,
  entries: ReturnType<typeof playlistObservations>,
): Promise<void> {
  if (await tryObserveBatch(tx, entries)) return
  if (entries.length === 1) return observeIndividually(tx, entries)
  // Keep nearby clean entries batched. Earlier entries may change how a later
  // release or artist resolves, so each half reads after the previous writes.
  const middle = Math.floor(entries.length / 2)
  await observeEntries(tx, entries.slice(0, middle))
  await observeEntries(tx, entries.slice(middle))
}

async function tryObserveBatch(
  tx: Transaction,
  entries: ReturnType<typeof playlistObservations>,
) {
  const creditCount = entries.reduce(
    (count, { album, recording }) =>
      count +
      (album?.media.credits?.length ?? 0) +
      (recording.media.credits?.length ?? 0),
    0,
  )
  // Keep bulk artist writes below PostgreSQL's parameter limit for unusual credit lists.
  if (creditCount > 4_000) return false
  const observations = await resolveObservations(tx, entries)
  if (!observations) return false
  const credits = await resolveCredits(tx, observations)
  if (!credits) return false

  const outside = new Map<string, CatalogMedia>()
  const references: (typeof providerReference.$inferInsert)[] = []
  const occurrences: CatalogOccurrence[] = []
  for (const { id, media, outside: isOutside, origin } of observations) {
    if (isOutside) {
      const first = outside.get(id)
      outside.set(
        id,
        first
          ? {
              ...first,
              artworkUrl: first.artworkUrl ?? media.artworkUrl,
              releaseDate: first.releaseDate ?? media.releaseDate,
              durationSec: first.durationSec ?? media.durationSec,
              albumId: first.albumId ?? media.albumId,
              albumName: first.albumName ?? media.albumName,
              spotifyAlbumId: first.spotifyAlbumId ?? media.spotifyAlbumId,
              spotifyUrl:
                first.kind === 'album'
                  ? (first.spotifyUrl ?? media.spotifyUrl)
                  : first.spotifyUrl,
            }
          : media,
      )
    }
    if (isOutside || media.kind === 'album') {
      const reference = catalogReferenceValues(id, media)
      if (reference) references.push(reference)
    }
    occurrences.push({ target: { id, kind: media.kind }, origin })
  }
  await writeOutsideCatalogMedia(
    tx,
    [...outside].map(([id, media]) => ({ id, media })),
  )
  const outsideCredits = credits.filter(({ outside }) => outside)
  for (let start = 0; start < outsideCredits.length; start += 500)
    await tx
      .insert(mediaCredit)
      .values(
        outsideCredits.slice(start, start + 500).map(({ values }) => values),
      )
      .onConflictDoNothing()
  if (references.length)
    await tx.insert(providerReference).values(references).onConflictDoNothing()
  await observeCatalogOccurrences(tx, [
    ...credits.map(({ occurrence }) => occurrence),
    ...occurrences,
  ])
  return true
}
