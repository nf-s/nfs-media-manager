import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import type {
  CatalogNativeKind,
  CatalogObservationQuerySchema,
} from '@repo/schemas/catalog'
import { DIRECT_PROVIDER_RESPONSE_SOURCE } from '@repo/schemas/provider-response'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { catalogNativeAddition } from '@/schemas/db'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import { createAlbumMatchRejectionPredicate } from '@/lib/album-match-identities'
import { readAlbumMatchRejectionsForItems } from './album-match-rejections'
import { currentArtistId } from './artist-names'
import { observeNamedArtistIdentities } from './catalog-artist-identities'
import {
  album,
  artist,
  catalogAddition,
  catalogMediaAlias,
  catalogObservation,
  film,
  libraryTrack,
  mediaCredit,
  mediaItem,
  playlist,
  providerReference,
  providerSnapshot,
  subscriptionItem,
  subscriptionSource,
} from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function resolveCatalogMediaId(
  reader: Pick<Transaction, 'select'>,
  id: string,
) {
  const [alias] = await reader
    .select({ id: catalogMediaAlias.mediaItemId })
    .from(catalogMediaAlias)
    .where(eq(catalogMediaAlias.aliasId, id))
  return alias?.id ?? id
}

/** Keep observations at the original address while resolving membership and counts on the survivor. */
export async function setCatalogMediaAlias(
  tx: Transaction,
  aliasId: string,
  targetId: string,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const id = await resolveCatalogMediaId(tx, targetId)
  if (aliasId === id) return
  await tx
    .update(catalogMediaAlias)
    .set({ mediaItemId: id })
    .where(eq(catalogMediaAlias.mediaItemId, aliasId))
  await tx
    .insert(catalogMediaAlias)
    .values({ aliasId, mediaItemId: id })
    .onConflictDoUpdate({
      target: catalogMediaAlias.aliasId,
      set: { mediaItemId: id },
    })
  await tx
    .update(catalogObservation)
    .set({ mediaItemId: id })
    .where(eq(catalogObservation.mediaItemId, aliasId))
}

export async function clearCatalogMediaAlias(tx: Transaction, aliasId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  await tx
    .delete(catalogMediaAlias)
    .where(eq(catalogMediaAlias.aliasId, aliasId))
  await tx
    .update(catalogObservation)
    .set({ mediaItemId: aliasId })
    .where(
      and(
        inArray(catalogObservation.targetKind, ['track', 'album', 'film']),
        eq(catalogObservation.targetId, aliasId),
      ),
    )
}

export type CatalogCredit = { name: string; externalId?: string; role?: string }

export type CatalogMedia = {
  kind: 'album' | 'track' | 'film'
  title: string
  provider: string
  referenceType: string
  provisionalKey?: string
  referenceMetadata?: Record<string, JsonValue>
  externalId?: string | null
  artworkUrl?: string | null
  releaseDate?: Date | null
  spotifyUrl?: string | null
  playable?: boolean
  artistId?: string
  albumId?: string | null
  albumName?: string | null
  spotifyAlbumId?: string | null
  credits?: CatalogCredit[]
  trackCount?: number
  durationSec?: number | null
}

export type CatalogOrigin = {
  provider: string
  operation: string
  occurrenceKey: string
  subjectKind?: string
  subjectId?: string
  relationshipRole?: string
  page?: number
  position?: number
  jobId?: string
  responseId?: string
  snapshotId?: string
  importId?: string
  details?: Record<string, JsonValue>
  observedAt?: Date
}

function nativeReference(media: CatalogMedia) {
  if (media.provider === 'spotify' && media.kind === 'album')
    return { type: 'spotify', aliases: ['spotify', 'album', 'spotify_album'] }
  if (media.provider === 'spotify' && media.kind === 'track')
    return { type: 'track', aliases: ['track', 'spotify_track', 'spotify'] }
  return { type: media.referenceType, aliases: [media.referenceType] }
}

async function existingMedia(tx: Transaction, media: CatalogMedia) {
  if (!media.externalId) return
  const externalId = media.externalId
  const spotifyTrack = media.provider === 'spotify' && media.kind === 'track'
  if (spotifyTrack) {
    const [match] = await tx
      .select({ id: libraryTrack.mediaItemId })
      .from(libraryTrack)
      .where(eq(libraryTrack.spotifyTrackId, media.externalId))
    if (match) return match.id
  }
  const match = (await resolveCatalogReferences(tx, [media])).get(externalId)
  return (
    match && {
      id:
        match.references.size === 1
          ? match.references.values().next().value
          : undefined,
      blocked: match.blocked,
    }
  )
}

/** Resolve references of the same kind and provider. Spotify release URLs use their native IDs. */
export async function resolveCatalogReferences(
  tx: Transaction,
  entries: readonly CatalogMedia[],
) {
  const [media] = entries
  const identities = new Map(
    entries.flatMap((entry) =>
      entry.externalId ? [[entry.externalId, entry]] : [],
    ),
  )
  const externalIds = [...identities.keys()]
  const matches = new Map<
    string,
    { references: Set<string>; blocked: Set<string>; usedAlbumUrl: boolean }
  >(
    externalIds.map((id) => [
      id,
      { references: new Set(), blocked: new Set(), usedAlbumUrl: false },
    ]),
  )
  if (!media || !matches.size) return matches
  const { aliases } = nativeReference(media)
  const nativeReferences = await tx
    .selectDistinct({
      id: mediaItem.id,
      externalId: providerReference.externalId,
      metadata: providerReference.metadata,
    })
    .from(providerReference)
    .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
    .where(
      and(
        inArray(providerReference.externalId, externalIds),
        media.kind === 'film' && ['imdb', 'tmdb'].includes(media.referenceType)
          ? undefined
          : eq(providerReference.provider, media.provider),
        inArray(providerReference.referenceType, aliases),
        eq(mediaItem.mediaType, media.kind),
      ),
    )
  for (const { id, externalId, metadata } of nativeReferences) {
    const match = matches.get(externalId)
    if (
      String(metadata?.verified) === 'false' ||
      String(metadata?.rejected) === 'true'
    )
      match?.blocked.add(id)
    else match?.references.add(id)
  }
  for (const { references, blocked } of matches.values())
    for (const id of blocked) references.delete(id)

  const spotifyAlbum = media.provider === 'spotify' && media.kind === 'album'
  if (spotifyAlbum) {
    const withoutReferences = [...matches]
      .filter(([, match]) => !match.references.size)
      .map(([id]) => id)
    if (withoutReferences.length) {
      const externalId = sql<string>`substring(${album.spotifyUrl} from '/album/([A-Za-z0-9]{22})')`
      const byUrl = await tx
        .select({ id: album.mediaItemId, externalId })
        .from(album)
        .where(
          and(
            sql`${album.spotifyUrl} is not null`,
            inArray(externalId, withoutReferences),
          ),
        )
      for (const { id, externalId } of byUrl) {
        const match = matches.get(externalId)
        if (match && !match.blocked.has(id)) {
          match.references.add(id)
          match.usedAlbumUrl = true
        }
      }
    }
  }
  if (media.kind === 'album') {
    const rejections = await readAlbumMatchRejectionsForItems(tx, [
      ...new Set(
        [...matches.values()].flatMap(({ references }) => [...references]),
      ),
    ])
    for (const [externalId, { references, blocked }] of matches) {
      const identity = identities.get(externalId)
      const spotifyUrl = identity?.spotifyUrl
      const referenceUrl = identity?.referenceMetadata?.url
      for (const id of references) {
        const rejected = rejections.get(id)
        if (!rejected) continue
        const isRejected = createAlbumMatchRejectionPredicate(
          media.provider,
          rejected,
        )
        if (
          aliases.some((referenceType) =>
            isRejected({ referenceType, externalId }),
          ) ||
          (spotifyUrl &&
            isRejected({ referenceType: 'url', externalId: spotifyUrl })) ||
          (typeof referenceUrl === 'string' &&
            isRejected({
              referenceType: 'url',
              externalId: referenceUrl,
            }))
        ) {
          references.delete(id)
          blocked.add(id)
        }
      }
    }
  }
  return matches
}

function originKey(origin: CatalogOrigin) {
  return [
    origin.provider,
    origin.operation,
    origin.subjectKind,
    origin.subjectId,
    origin.occurrenceKey,
    origin.page,
    origin.position,
  ]
}

type CatalogTarget = { kind: string; id: string }
export type CatalogOccurrence = { target: CatalogTarget; origin: CatalogOrigin }

export async function observeCatalogOccurrences(
  tx: Transaction,
  occurrences: CatalogOccurrence[],
) {
  for (let start = 0; start < occurrences.length; start += 500) {
    const rows = occurrences
      .slice(start, start + 500)
      .map(({ target, origin }) => ({
        id: createStableId(
          'discovery',
          JSON.stringify([
            target.kind,
            target.id,
            ...originKey(origin),
            origin.relationshipRole,
            origin.responseId,
            origin.jobId,
            origin.snapshotId,
            origin.importId,
          ]),
        ),
        targetKind: target.kind,
        targetId: target.id,
        mediaItemId: ['film', 'track', 'album'].includes(target.kind)
          ? sql`coalesce((select ${catalogMediaAlias.mediaItemId} from ${catalogMediaAlias}
            where ${catalogMediaAlias.aliasId} = ${target.id}), ${target.id})`
          : null,
        provider: origin.provider,
        operation: origin.operation,
        subjectKind: origin.subjectKind,
        subjectId: origin.subjectId,
        relationshipRole: origin.relationshipRole,
        page: origin.page,
        position: origin.position,
        jobId: origin.jobId,
        responseId: origin.responseId,
        snapshotId: origin.snapshotId,
        importId: origin.importId,
        details: origin.details,
        observedAt: origin.observedAt,
      }))
    await tx.insert(catalogObservation).values(rows).onConflictDoNothing()
  }
}

export function observeCatalogOccurrence(
  tx: Transaction,
  target: CatalogTarget,
  origin: CatalogOrigin,
) {
  return observeCatalogOccurrences(tx, [{ target, origin }])
}

export function spotifyTrackCatalogCredits(
  credits: CatalogCredit[],
  metadata: unknown,
) {
  const [sole] = credits
  const billing = z
    .tuple([
      z.object({
        id: z.string().regex(/^[A-Za-z0-9]{22}$/),
        name: z.string(),
      }),
    ])
    .safeParse(metadata)
  return sole && billing.success && billing.data[0].name === sole.name
    ? [{ ...sole, externalId: billing.data[0].id }]
    : credits
}

export function catalogCreditOccurrence(
  target: CatalogTarget,
  origin: CatalogOrigin,
  subjectKind: CatalogMedia['kind'],
  subjectId: string,
  relationshipRole: string,
  position: number,
): CatalogOccurrence {
  return {
    target,
    origin: {
      ...origin,
      subjectKind,
      subjectId,
      relationshipRole,
      position: position + 1,
      occurrenceKey: JSON.stringify([
        origin.occurrenceKey,
        origin.subjectKind,
        origin.subjectId,
        origin.page,
        origin.position,
        'credit',
      ]),
    },
  }
}

export function provisionalCatalogArtistId(
  provider: string,
  id: string,
  role: string,
  position: number,
  name: string,
) {
  return createStableId(
    'catalog-artist',
    JSON.stringify([provider, id, role, position, name]),
  )
}

async function observeCredits(
  tx: Transaction,
  id: string,
  media: CatalogMedia,
  origin: CatalogOrigin,
  outside: boolean,
) {
  let credits = media.credits ?? []
  const [sole] = credits
  if (
    media.kind === 'track' &&
    media.provider === 'spotify' &&
    media.externalId &&
    sole &&
    !sole.externalId &&
    credits.length === 1
  ) {
    const [recording] = await tx
      .select({ metadata: mediaItem.metadata })
      .from(mediaItem)
      .innerJoin(libraryTrack, eq(libraryTrack.mediaItemId, mediaItem.id))
      .where(
        and(
          eq(mediaItem.id, id),
          eq(libraryTrack.spotifyTrackId, media.externalId),
        ),
      )
    credits = spotifyTrackCatalogCredits(
      credits,
      recording?.metadata?.spotifyArtistCredits,
    )
  }
  const observedNativeIds = new Map<string, string>()
  const native = await observeNamedArtistIdentities(
    tx,
    media.provider,
    new Map(
      credits.flatMap((credit, index) =>
        credit.externalId && !(media.artistId && index === 0)
          ? [[credit.externalId, credit.name]]
          : [],
      ),
    ),
    observedNativeIds,
  )
  for (const [position, credit] of credits.entries()) {
    const role = credit.role ?? 'artist'
    const creatorId = provisionalCatalogArtistId(
      media.provider,
      id,
      role,
      position,
      credit.name,
    )
    const observedId =
      (position === 0 ? media.artistId : undefined) ??
      (credit.externalId ? native.get(credit.externalId) : undefined) ??
      creatorId
    let creditedId = observedId
    if (creditedId === creatorId) {
      const inserted = await tx
        .insert(artist)
        .values({
          id: creatorId,
          name: credit.name,
          sortName: credit.name,
          catalogProvider: media.provider,
        })
        .onConflictDoNothing()
        .returning({ id: artist.id })
      if (!inserted.length) creditedId = await currentArtistId(tx, creatorId)
    }
    if (outside)
      await tx
        .insert(mediaCredit)
        .values({
          mediaItemId: id,
          artistId: creditedId,
          role,
          billingOrder: position,
        })
        .onConflictDoNothing()
    const occurrence = catalogCreditOccurrence(
      {
        kind: media.kind === 'film' ? 'person' : 'artist',
        id:
          (credit.externalId
            ? observedNativeIds.get(credit.externalId)
            : undefined) ?? observedId,
      },
      origin,
      media.kind,
      id,
      role,
      position,
    )
    await observeCatalogOccurrence(tx, occurrence.target, occurrence.origin)
  }
  if (
    outside &&
    media.artistId &&
    !credits.length &&
    origin.relationshipRole !== 'appears_on'
  )
    await tx
      .insert(mediaCredit)
      .values({ mediaItemId: id, artistId: media.artistId, role: 'artist' })
      .onConflictDoNothing()
}

export function newCatalogMediaId(
  media: CatalogMedia,
  origin: CatalogOrigin,
  blocked?: ReadonlySet<string>,
) {
  const { type } = nativeReference(media)
  const key = media.externalId
    ? [media.provider, type, media.externalId]
    : [
        media.provider,
        type,
        media.provisionalKey ?? [...originKey(origin), media.title],
      ]
  const id =
    media.provider === 'spotify' && media.kind === 'track' && media.externalId
      ? createStableId('library-track', `spotify:${media.externalId}`)
      : createStableId(`catalog-${media.kind}`, JSON.stringify(key))
  return blocked?.has(id)
    ? createStableId(
        `catalog-${media.kind}`,
        JSON.stringify([...key, 'separate']),
      )
    : id
}

export function catalogReferenceValues(id: string, media: CatalogMedia) {
  const { externalId } = media
  if (!externalId) return
  const { type } = nativeReference(media)
  return {
    id: createStableId(
      'catalog-ref',
      JSON.stringify([id, media.provider, type, externalId]),
    ),
    mediaItemId: id,
    provider: media.provider,
    referenceType: type,
    externalId,
    metadata: media.referenceMetadata,
  }
}

export async function writeOutsideCatalogMedia(
  tx: Transaction,
  entries: { id: string; media: CatalogMedia }[],
) {
  if (!entries.length) return
  await tx
    .insert(mediaItem)
    .values(
      entries.map(({ id, media }) => ({
        id,
        mediaType: media.kind,
        title: media.title,
        slug: slugifyParts(media.title, id),
        artworkUrl: media.artworkUrl,
        releaseDate: media.releaseDate,
        sourceLabel: media.provider,
        inLibrary: false,
      })),
    )
    .onConflictDoUpdate({
      target: mediaItem.id,
      set: {
        artworkUrl: sql`coalesce(${mediaItem.artworkUrl}, excluded.artwork_url)`,
        releaseDate: sql`coalesce(${mediaItem.releaseDate}, excluded.release_date)`,
      },
      setWhere: sql`not ${mediaItem.inLibrary} and (
      (${mediaItem.artworkUrl} is null and excluded.artwork_url is not null) or
      (${mediaItem.releaseDate} is null and excluded.release_date is not null))`,
    })
  const releases = entries.filter(({ media }) => media.kind === 'album')
  if (releases.length)
    await tx
      .insert(album)
      .values(
        releases.map(({ id, media }) => ({
          mediaItemId: id,
          spotifyUrl: media.spotifyUrl,
          trackCount: media.trackCount,
        })),
      )
      .onConflictDoUpdate({
        target: album.mediaItemId,
        set: {
          spotifyUrl: sql`coalesce(${album.spotifyUrl}, excluded.spotify_url)`,
          trackCount: sql`case when ${album.trackCount} = 0 then excluded.track_count else ${album.trackCount} end`,
        },
        setWhere: sql`(${album.spotifyUrl} is null and excluded.spotify_url is not null) or (${album.trackCount} = 0 and excluded.track_count > 0)`,
      })
  const films = entries.filter(({ media }) => media.kind === 'film')
  if (films.length)
    await tx
      .insert(film)
      .values(films.map(({ id }) => ({ mediaItemId: id })))
      .onConflictDoNothing()
  const recordings = entries.filter(({ media }) => media.kind === 'track')
  if (recordings.length)
    await tx
      .insert(libraryTrack)
      .values(
        recordings.map(({ id, media }) => ({
          mediaItemId: id,
          spotifyTrackId:
            media.provider === 'spotify' && media.playable !== false
              ? media.externalId
              : undefined,
          spotifyUrl: media.spotifyUrl,
          durationSec: media.durationSec,
          albumMediaItemId: media.albumId,
          albumName: media.albumName,
          spotifyAlbumId: media.spotifyAlbumId,
          albumLinkStrategy:
            media.albumId && media.spotifyAlbumId ? 'spotify-album' : undefined,
        })),
      )
      .onConflictDoUpdate({
        target: libraryTrack.mediaItemId,
        set: {
          spotifyTrackId: sql`coalesce(${libraryTrack.spotifyTrackId}, excluded.spotify_track_id)`,
          durationSec: sql`coalesce(${libraryTrack.durationSec}, excluded.duration_sec)`,
          albumMediaItemId: sql`coalesce(${libraryTrack.albumMediaItemId}, excluded.album_media_item_id)`,
          albumName: sql`coalesce(${libraryTrack.albumName}, excluded.album_name)`,
          spotifyAlbumId: sql`coalesce(${libraryTrack.spotifyAlbumId}, excluded.spotify_album_id)`,
        },
        setWhere: sql`(${libraryTrack.spotifyTrackId} is null and excluded.spotify_track_id is not null) or (${libraryTrack.durationSec} is null and excluded.duration_sec is not null)
        or (${libraryTrack.albumMediaItemId} is null and excluded.album_media_item_id is not null)
        or (${libraryTrack.albumName} is null and excluded.album_name is not null)
        or (${libraryTrack.spotifyAlbumId} is null and excluded.spotify_album_id is not null)`,
      })
}

/** Resolve exact provider representations and retain each independent occurrence. */
export async function observeCatalogMedia(
  tx: Transaction,
  media: CatalogMedia,
  origin: CatalogOrigin,
): Promise<string> {
  // Share the lock used by existing Spotify recording, merge and track writers.
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const resolved = await existingMedia(tx, media)
  const existingId = typeof resolved === 'string' ? resolved : resolved?.id
  const spotifyTrack = media.provider === 'spotify' && media.kind === 'track'
  const id =
    existingId ??
    newCatalogMediaId(
      media,
      origin,
      typeof resolved === 'string' ? undefined : resolved?.blocked,
    )

  const outside =
    !existingId ||
    Boolean(
      await tx.$count(
        mediaItem,
        and(eq(mediaItem.id, id), eq(mediaItem.inLibrary, false)),
      ),
    )
  if (outside) await writeOutsideCatalogMedia(tx, [{ id, media }])
  await observeCredits(tx, id, media, origin, outside)

  const existingNativeTrack =
    spotifyTrack &&
    !outside &&
    media.externalId &&
    (await tx.$count(
      libraryTrack,
      and(
        eq(libraryTrack.mediaItemId, id),
        eq(libraryTrack.spotifyTrackId, media.externalId),
      ),
    ))
  const reference = catalogReferenceValues(id, media)
  if (reference && !existingNativeTrack)
    await tx.insert(providerReference).values(reference).onConflictDoNothing()

  await observeCatalogOccurrence(tx, { kind: media.kind, id }, origin)
  return id
}

export async function promoteCatalogMediaInTransaction(
  tx: Transaction,
  id: string,
  ownerId?: string,
) {
  const addedAt = new Date()
  const [row] = await tx
    .update(mediaItem)
    .set({ inLibrary: true })
    .where(
      and(
        eq(mediaItem.id, id),
        eq(mediaItem.inLibrary, false),
        sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
      ),
    )
    .returning({ kind: mediaItem.mediaType })
  if (!row) {
    const [existing] = await tx
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(
        and(
          eq(mediaItem.id, id),
          eq(mediaItem.inLibrary, true),
          sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
        ),
      )
    if (!existing)
      throw new ServerError({ statusCode: 404, message: 'Media not found' })
    return { mediaItemId: id, created: false }
  }
  await tx
    .insert(catalogAddition)
    .values({ mediaItemId: id, ownerId, addedAt })
    .onConflictDoNothing()
  if (row.kind === 'track')
    await tx
      .update(libraryTrack)
      .set({ dateAdded: addedAt })
      .where(eq(libraryTrack.mediaItemId, id))
  if (row.kind === 'album')
    await tx
      .update(album)
      .set({ dateAdded: addedAt })
      .where(eq(album.mediaItemId, id))
  if (row.kind === 'film')
    await tx
      .update(film)
      .set({ dateAdded: addedAt, dateAddedSource: 'Added to library' })
      .where(eq(film.mediaItemId, id))
  return { mediaItemId: id, created: true }
}

export async function promoteCatalogMedia(id: string, ownerId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
    return promoteCatalogMediaInTransaction(
      tx,
      await resolveCatalogMediaId(tx, id),
      ownerId,
    )
  })
}

export async function promoteNativeResource(
  kind: CatalogNativeKind,
  requestedId: string,
  ownerId?: string,
) {
  const table = {
    artist,
    person: artist,
    playlist,
    collection: playlist,
    'subscription-source': subscriptionSource,
    'subscription-item': subscriptionItem,
  }[kind]
  return db.transaction(async (tx) => {
    let id = requestedId
    if (table === artist) {
      await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
      id = await currentArtistId(tx, requestedId)
    }
    const where = and(
      eq(table.id, id),
      table === playlist
        ? eq(playlist.kind, kind === 'collection' ? 'collection' : 'playlist')
        : undefined,
    )
    const [resource] = await tx
      .select({ id: table.id })
      .from(table)
      .where(where)
      .for('update')
    if (!resource)
      throw new ServerError({ statusCode: 404, message: 'Resource not found' })
    if (table === artist) {
      const aliases = tx
        .select({ id: artist.id })
        .from(artist)
        .where(eq(artist.mergedIntoId, id))
      const [prior] = await tx
        .select({ id: catalogNativeAddition.targetId })
        .from(catalogNativeAddition)
        .where(
          and(
            eq(catalogNativeAddition.targetKind, kind),
            inArray(catalogNativeAddition.targetId, aliases),
          ),
        )
        .limit(1)
      if (prior) return { mediaItemId: id, created: false }
    }
    const [row] = await tx
      .insert(catalogNativeAddition)
      .values({ targetKind: kind, targetId: id, ownerId })
      .onConflictDoNothing()
      .returning({ id: catalogNativeAddition.targetId })
    // Film people and music artists share an identity, but have separate directories.
    if (kind !== 'person' && row)
      await tx.update(table).set({ addedToLibrary: true }).where(where)
    return { mediaItemId: id, created: Boolean(row) }
  })
}

export async function listCatalogObservations(
  id: string,
  { page, size }: z.infer<typeof CatalogObservationQuerySchema>,
  kind?: CatalogNativeKind,
) {
  let where
  if (kind === 'artist' || kind === 'person') {
    const currentId = await currentArtistId(db, id)
    const mergedNames = db
      .select({ id: artist.id })
      .from(artist)
      .where(eq(artist.mergedIntoId, currentId))
    where = and(
      eq(catalogObservation.targetKind, kind),
      or(
        eq(catalogObservation.targetId, currentId),
        inArray(catalogObservation.targetId, mergedNames),
      ),
    )
  } else {
    where = kind
      ? and(
          eq(catalogObservation.targetId, id),
          eq(catalogObservation.targetKind, kind),
        )
      : eq(catalogObservation.mediaItemId, await resolveCatalogMediaId(db, id))
  }
  const [items, totalCount] = await Promise.all([
    db
      .select({
        observation: catalogObservation,
        snapshotMediaId: providerSnapshot.mediaItemId,
        snapshotMediaType: mediaItem.mediaType,
      })
      .from(catalogObservation)
      .leftJoin(
        providerSnapshot,
        and(
          eq(providerSnapshot.id, catalogObservation.snapshotId),
          eq(providerSnapshot.provider, catalogObservation.provider),
          eq(providerSnapshot.source, DIRECT_PROVIDER_RESPONSE_SOURCE),
        ),
      )
      .leftJoin(mediaItem, eq(mediaItem.id, providerSnapshot.mediaItemId))
      .where(where)
      .orderBy(desc(catalogObservation.observedAt), desc(catalogObservation.id))
      .limit(size)
      .offset((page - 1) * size),
    db.$count(catalogObservation, where),
  ])
  return {
    items: items.map(
      ({
        observation: { observedAt, details, ...item },
        snapshotMediaId,
        snapshotMediaType,
      }) => ({
        ...item,
        ...(snapshotMediaId && snapshotMediaType
          ? {
              directResponse: {
                mediaItemId: snapshotMediaId,
                mediaType: snapshotMediaType,
              },
            }
          : {}),
        observedAt: observedAt.toISOString(),
        details: Object.entries(details ?? {}).flatMap(([label, value]) =>
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
            ? [{ label, value: String(value) }]
            : [],
        ),
      }),
    ),
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
  }
}
