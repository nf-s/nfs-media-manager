import { eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { measureCatalogWriteLock } from '@/lib/request-log'
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
  reconcileSpotifyRecordingCredits,
  resolveCatalogReferences,
  spotifyRecordingCredits,
  spotifyTrackCatalogCredits,
  writeOutsideCatalogMedia,
  type CatalogMedia,
  type CatalogOccurrence,
  type CatalogOrigin,
  type SpotifyRecordingCredit,
} from './catalog-discoveries'
import { recordSpotifyCatalogCodes } from './spotify-catalog-codes'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Observation = { media: CatalogMedia; origin: CatalogOrigin }
export type SpotifyCatalogEntry = {
  recording: Observation
  album?: Observation
  isrc?: string | null
}
type ResolvedObservation = Observation & {
  id: string
  outside: boolean
  reconciliationCredits?: CatalogMedia['credits']
  isrc?: string | null
  writeReference?: boolean
}
type BatchSource = 'search' | 'playlist-import'

export async function observeSpotifyCatalogEntriesIndividually(
  tx: Transaction,
  entries: SpotifyCatalogEntry[],
  pendingSpotifyCredits?: SpotifyRecordingCredit[],
) {
  const ids = new Map<string, string>()
  const codes: Parameters<typeof recordSpotifyCatalogCodes>[1][number][] = []
  for (const { album, recording, isrc } of entries) {
    const albumId = album
      ? await observeCatalogMedia(tx, album.media, album.origin)
      : undefined
    const trackId = await observeCatalogMedia(
      tx,
      { ...recording.media, albumId },
      recording.origin,
      pendingSpotifyCredits,
    )
    if (recording.media.externalId) ids.set(recording.media.externalId, trackId)
    codes.push({
      mediaItemId: trackId,
      kind: 'track',
      value: isrc,
      origin: recording.origin,
    })
  }
  await recordSpotifyCatalogCodes(tx, codes)
  return ids
}

async function resolveUnimportedRecordings(
  tx: Transaction,
  recordings: Observation[],
) {
  const matches = await resolveCatalogReferences(
    tx,
    recordings.map(({ media }) => media),
  )
  const targets = recordings.map(({ media, origin }) => {
    const match = media.externalId ? matches.get(media.externalId) : undefined
    const existingId =
      match?.references.size === 1
        ? match.references.values().next().value
        : undefined
    return {
      origin,
      id: existingId ?? newCatalogMediaId(media, origin, match?.blocked),
      existing: Boolean(existingId),
    }
  })
  const targetIds = [...new Set(targets.map(({ id }) => id))]
  const stored = targetIds.length
    ? await tx
        .select({
          id: mediaItem.id,
          inLibrary: mediaItem.inLibrary,
          externalId: libraryTrack.spotifyTrackId,
          artistCredits: sql<unknown>`${mediaItem.metadata}->'spotifyArtistCredits'`,
        })
        .from(mediaItem)
        .leftJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
        .where(inArray(mediaItem.id, targetIds))
    : []
  const byId = new Map(stored.map((row) => [row.id, row]))
  // An occupied deterministic address needs the same fallback as a single observation.
  if (targets.some(({ id, existing }) => !existing && byId.has(id))) return
  return new Map(
    targets.map(({ id, origin }) => [origin, { id, stored: byId.get(id) }]),
  )
}

async function resolveObservations(
  tx: Transaction,
  entries: SpotifyCatalogEntry[],
  source: BatchSource,
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
  if (source === 'playlist-import' && tracks.length !== trackIds.length) return
  const tracksById = new Map(tracks.map((track) => [track.externalId, track]))
  const unimported = await resolveUnimportedRecordings(
    tx,
    entries.flatMap(({ recording }) =>
      recording.media.externalId && !tracksById.has(recording.media.externalId)
        ? [recording]
        : [],
    ),
  )
  if (!unimported) return

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
  const seenTracks = new Set<string>()
  for (const { album, recording, isrc } of entries) {
    const release = album && byOrigin.get(album.origin)
    if (release)
      observations.push({
        ...release,
        outside: !release.existing || !stored.get(release.id),
      })
    const { media, origin } = recording
    const track = media.externalId && tracksById.get(media.externalId)
    const extra = unimported.get(origin)
    const id =
      (track && track.id) || extra?.id || newCatalogMediaId(media, origin)
    // A first occurrence can change the reference or playback identity used by a later one.
    if (source === 'search' && seenTracks.has(id)) return
    seenTracks.add(id)
    const storedTrack = track || extra?.stored
    const outside = !storedTrack?.inLibrary
    const credits = media.credits ?? []
    const writableNative =
      outside && media.playable !== false && storedTrack?.externalId === null
    const billing =
      storedTrack &&
      (storedTrack.externalId === media.externalId || writableNative)
        ? spotifyTrackCatalogCredits(credits, storedTrack.artistCredits)
        : credits
    observations.push({
      ...recording,
      id,
      outside,
      isrc,
      media: { ...media, albumId: release?.id, credits: billing },
      reconciliationCredits: source === 'search' ? billing : media.credits,
      writeReference: !track,
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
  const matches = observations.flatMap(
    ({ id, media, origin, reconciliationCredits }) =>
      spotifyRecordingCredits(
        id,
        { ...media, credits: reconciliationCredits },
        origin,
        native,
      ),
  )
  return { credits, matches }
}

export async function observeSpotifyCatalogEntries(
  tx: Transaction,
  entries: SpotifyCatalogEntry[],
  source: BatchSource,
) {
  const ids = new Map<string, string>()
  if (entries.length) {
    await measureCatalogWriteLock(() =>
      tx.execute(sql`select pg_advisory_xact_lock(614106)`),
    )
    const pendingSpotifyCredits: SpotifyRecordingCredit[] | undefined =
      source === 'playlist-import' ? [] : undefined
    await observeEntries(tx, entries, source, ids, pendingSpotifyCredits)
    if (pendingSpotifyCredits)
      await reconcileSpotifyRecordingCredits(tx, pendingSpotifyCredits)
  }
  return ids
}

async function observeEntries(
  tx: Transaction,
  entries: SpotifyCatalogEntry[],
  source: BatchSource,
  ids: Map<string, string>,
  pendingSpotifyCredits?: SpotifyRecordingCredit[],
): Promise<void> {
  if (await tryObserveBatch(tx, entries, source, ids, pendingSpotifyCredits))
    return
  if (entries.length === 1) {
    const result = await observeSpotifyCatalogEntriesIndividually(
      tx,
      entries,
      pendingSpotifyCredits,
    )
    for (const [externalId, id] of result) ids.set(externalId, id)
    return
  }
  // Keep nearby clean entries batched. Earlier entries may change how a later
  // release or artist resolves, so each half reads after the previous writes.
  const middle = Math.floor(entries.length / 2)
  await observeEntries(
    tx,
    entries.slice(0, middle),
    source,
    ids,
    pendingSpotifyCredits,
  )
  await observeEntries(
    tx,
    entries.slice(middle),
    source,
    ids,
    pendingSpotifyCredits,
  )
}

async function tryObserveBatch(
  tx: Transaction,
  entries: SpotifyCatalogEntry[],
  source: BatchSource,
  ids: Map<string, string>,
  pendingSpotifyCredits?: SpotifyRecordingCredit[],
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
  const observations = await resolveObservations(tx, entries, source)
  if (!observations) return false
  const resolvedCredits = await resolveCredits(tx, observations)
  if (!resolvedCredits) return false
  const { credits, matches } = resolvedCredits

  const outside = new Map<string, CatalogMedia>()
  const references: (typeof providerReference.$inferInsert)[] = []
  const occurrences: CatalogOccurrence[] = []
  const codes: Parameters<typeof recordSpotifyCatalogCodes>[1][number][] = []
  for (const {
    id,
    media,
    outside: isOutside,
    origin,
    writeReference,
    isrc,
  } of observations) {
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
    if (isOutside || media.kind === 'album' || writeReference) {
      const reference = catalogReferenceValues(id, media)
      if (reference) references.push(reference)
    }
    occurrences.push({ target: { id, kind: media.kind }, origin })
    if (media.kind === 'track' && media.externalId)
      ids.set(media.externalId, id)
    if (source === 'search' && isrc)
      codes.push({ mediaItemId: id, kind: 'track', value: isrc, origin })
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
  if (pendingSpotifyCredits) pendingSpotifyCredits.push(...matches)
  else await reconcileSpotifyRecordingCredits(tx, matches)
  if (codes.length) await recordSpotifyCatalogCodes(tx, codes)
  return true
}
