import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import type { CatalogNativeKind, CatalogObservationQuerySchema } from '@repo/schemas/catalog'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import { album, artist, catalogAddition, catalogObservation, film, libraryTrack, mediaCredit, mediaItem, playlist, providerReference, subscriptionItem, subscriptionSource } from '@/schemas/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type CatalogCredit = { name: string; externalId?: string; role?: string }

type CatalogMedia = {
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

async function existingMedia(tx: Transaction, media: CatalogMedia, aliases: string[]) {
  if (!media.externalId) return
  const spotifyTrack = media.provider === 'spotify' && media.kind === 'track'
  if (spotifyTrack) {
    const [match] = await tx.select({ id: libraryTrack.mediaItemId }).from(libraryTrack)
      .where(eq(libraryTrack.spotifyTrackId, media.externalId))
    if (match) return match.id
  }
  const references = await tx.selectDistinct({ id: mediaItem.id })
    .from(providerReference).innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
    .where(and(eq(providerReference.externalId, media.externalId),
      media.kind === 'film' && ['imdb', 'tmdb'].includes(media.referenceType) ? undefined : eq(providerReference.provider, media.provider), inArray(providerReference.referenceType, aliases),
      sql`${providerReference.metadata}->>'verified' is distinct from 'false'`,
      sql`${providerReference.metadata}->>'rejected' is distinct from 'true'`,
      eq(mediaItem.mediaType, media.kind))).limit(2)
  if (references.length === 1) return references[0]?.id
  if (references.length === 0 && media.provider === 'spotify' && media.kind === 'album') {
    const byUrl = await tx.select({ id: album.mediaItemId }).from(album)
      .where(sql`substring(${album.spotifyUrl} from '/album/([A-Za-z0-9]{22})') = ${media.externalId}`).limit(2)
    if (byUrl.length === 1) return byUrl[0]?.id
  }
}

function originKey(origin: CatalogOrigin) {
  return [origin.provider, origin.operation, origin.subjectKind, origin.subjectId, origin.occurrenceKey, origin.page, origin.position]
}

type CatalogTarget = { kind: string; id: string }
type Occurrence = { target: CatalogTarget; origin: CatalogOrigin }

export async function observeCatalogOccurrences(tx: Transaction, occurrences: Occurrence[]) {
  for (let start = 0; start < occurrences.length; start += 500) {
    const rows = occurrences.slice(start, start + 500).map(({ target, origin }) => ({
      id: createStableId('discovery', JSON.stringify([target.kind, target.id, ...originKey(origin), origin.relationshipRole,
        origin.responseId, origin.jobId, origin.snapshotId, origin.importId])),
      targetKind: target.kind, targetId: target.id,
      mediaItemId: ['film', 'track', 'album'].includes(target.kind) ? target.id : null,
      provider: origin.provider, operation: origin.operation,
      subjectKind: origin.subjectKind, subjectId: origin.subjectId, relationshipRole: origin.relationshipRole,
      page: origin.page, position: origin.position, jobId: origin.jobId, responseId: origin.responseId,
      snapshotId: origin.snapshotId, importId: origin.importId, details: origin.details, observedAt: origin.observedAt,
    }))
    await tx.insert(catalogObservation).values(rows).onConflictDoNothing()
  }
}

export function observeCatalogOccurrence(tx: Transaction, target: CatalogTarget, origin: CatalogOrigin) {
  return observeCatalogOccurrences(tx, [{ target, origin }])
}

async function observeCredits(tx: Transaction, id: string, media: CatalogMedia, origin: CatalogOrigin) {
  const credits = media.credits ?? []
  for (const [position, credit] of credits.entries()) {
    const role = credit.role ?? 'artist'
    const key = credit.externalId
      ? [media.provider, credit.externalId]
      : [media.provider, id, role, position, credit.name]
    const creatorId = createStableId('catalog-artist', JSON.stringify(key))
    let creditedId = media.artistId && position === 0 ? media.artistId : creatorId
    if (creditedId === creatorId) {
      await tx.insert(artist).values({
        id: creatorId, name: credit.name, sortName: credit.name,
        catalogProvider: media.provider, catalogExternalId: credit.externalId,
      }).onConflictDoNothing()
      if (credit.externalId) {
        const [native] = await tx.select({ id: artist.id, merged: artist.mergedIntoId }).from(artist).where(and(
          eq(artist.catalogProvider, media.provider), eq(artist.catalogExternalId, credit.externalId)))
        if (native) creditedId = native.merged ?? native.id
      }
    }
    await tx.insert(mediaCredit).values({
      mediaItemId: id, artistId: creditedId, role, billingOrder: position,
    }).onConflictDoNothing()
    await observeCatalogOccurrence(tx, { kind: media.kind === 'film' ? 'person' : 'artist', id: creditedId }, {
      ...origin, subjectKind: media.kind, subjectId: id, relationshipRole: role, position: position + 1,
      occurrenceKey: JSON.stringify([origin.occurrenceKey, origin.subjectKind, origin.subjectId, origin.page, origin.position, 'credit']),
    })
  }
  if (media.artistId && !credits.length && origin.relationshipRole !== 'appears_on')
    await tx.insert(mediaCredit).values({ mediaItemId: id, artistId: media.artistId, role: 'artist' }).onConflictDoNothing()
}

/** Resolve exact provider representations and retain each independent occurrence. */
export async function observeCatalogMedia(tx: Transaction, media: CatalogMedia, origin: CatalogOrigin): Promise<string> {
  // Share the lock used by existing Spotify recording, merge and track writers.
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const { type, aliases } = nativeReference(media)
  const existingId = await existingMedia(tx, media, aliases)
  const spotifyTrack = media.provider === 'spotify' && media.kind === 'track'
  const key = media.externalId
    ? [media.provider, type, media.externalId]
    : [media.provider, type, media.provisionalKey ?? [...originKey(origin), media.title]]
  const id = existingId ?? (spotifyTrack && media.externalId
    ? createStableId('library-track', `spotify:${media.externalId}`)
    : createStableId(`catalog-${media.kind}`, JSON.stringify(key)))

  const outside = !existingId || Boolean(await tx.$count(mediaItem, and(eq(mediaItem.id, id), eq(mediaItem.inLibrary, false))))
  if (outside) {
    await tx.insert(mediaItem).values({
      id, mediaType: media.kind, title: media.title, slug: slugifyParts(media.title, id),
      artworkUrl: media.artworkUrl, releaseDate: media.releaseDate,
      sourceLabel: media.provider, inLibrary: false,
    }).onConflictDoUpdate({ target: mediaItem.id, set: {
      artworkUrl: sql`coalesce(${mediaItem.artworkUrl}, excluded.artwork_url)`,
      releaseDate: sql`coalesce(${mediaItem.releaseDate}, excluded.release_date)`,
    }, setWhere: sql`not ${mediaItem.inLibrary} and (
      (${mediaItem.artworkUrl} is null and excluded.artwork_url is not null) or
      (${mediaItem.releaseDate} is null and excluded.release_date is not null))` })
    if (media.kind === 'album')
      await tx.insert(album).values({ mediaItemId: id, spotifyUrl: media.spotifyUrl, trackCount: media.trackCount }).onConflictDoUpdate({
        target: album.mediaItemId, set: {
          spotifyUrl: sql`coalesce(${album.spotifyUrl}, excluded.spotify_url)`,
          trackCount: sql`coalesce(${album.trackCount}, excluded.track_count)`,
        }, setWhere: sql`(${album.spotifyUrl} is null and excluded.spotify_url is not null) or (${album.trackCount} is null and excluded.track_count is not null)`,
      })
    if (media.kind === 'film')
      await tx.insert(film).values({ mediaItemId: id }).onConflictDoNothing()
    if (media.kind === 'track')
      await tx.insert(libraryTrack).values({
        mediaItemId: id, spotifyTrackId: spotifyTrack && media.playable !== false ? media.externalId : undefined,
        spotifyUrl: media.spotifyUrl, durationSec: media.durationSec, albumMediaItemId: media.albumId,
        albumName: media.albumName, spotifyAlbumId: media.spotifyAlbumId,
        albumLinkStrategy: media.albumId && media.spotifyAlbumId ? 'spotify-album' : undefined,
      }).onConflictDoUpdate({target: libraryTrack.mediaItemId, set: {
        spotifyTrackId: sql`coalesce(${libraryTrack.spotifyTrackId}, excluded.spotify_track_id)`,
        durationSec: sql`coalesce(${libraryTrack.durationSec}, excluded.duration_sec)`,
        albumMediaItemId: sql`coalesce(${libraryTrack.albumMediaItemId}, excluded.album_media_item_id)`,
        albumName: sql`coalesce(${libraryTrack.albumName}, excluded.album_name)`,
        spotifyAlbumId: sql`coalesce(${libraryTrack.spotifyAlbumId}, excluded.spotify_album_id)`,
      }, setWhere: sql`(${libraryTrack.spotifyTrackId} is null and excluded.spotify_track_id is not null) or (${libraryTrack.durationSec} is null and excluded.duration_sec is not null)
        or (${libraryTrack.albumMediaItemId} is null and excluded.album_media_item_id is not null)
        or (${libraryTrack.albumName} is null and excluded.album_name is not null)
        or (${libraryTrack.spotifyAlbumId} is null and excluded.spotify_album_id is not null)` })
    await observeCredits(tx, id, media, origin)
  }

  if (media.externalId)
    await tx.insert(providerReference).values({
      id: createStableId('catalog-ref', JSON.stringify([id, media.provider, type, media.externalId])),
      mediaItemId: id, provider: media.provider, referenceType: type, externalId: media.externalId, metadata: media.referenceMetadata,
    }).onConflictDoNothing()

  await observeCatalogOccurrence(tx, { kind: media.kind, id }, origin)
  return id
}

export async function promoteCatalogMediaInTransaction(tx: Transaction, id: string, ownerId?: string) {
  const addedAt = new Date()
  const [row] = await tx.update(mediaItem).set({ inLibrary: true })
    .where(and(eq(mediaItem.id, id), eq(mediaItem.inLibrary, false), sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`))
    .returning({ kind: mediaItem.mediaType })
  if (!row) {
    const [existing] = await tx.select({ id: mediaItem.id }).from(mediaItem)
      .where(and(eq(mediaItem.id, id), eq(mediaItem.inLibrary, true), sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`))
    if (!existing) throw new ServerError({ statusCode: 404, message: 'Media not found' })
    return { mediaItemId: id, created: false }
  }
  await tx.insert(catalogAddition).values({ mediaItemId: id, ownerId, addedAt }).onConflictDoNothing()
  if (row.kind === 'track') await tx.update(libraryTrack).set({ dateAdded: addedAt }).where(eq(libraryTrack.mediaItemId, id))
  if (row.kind === 'album') await tx.update(album).set({ dateAdded: addedAt }).where(eq(album.mediaItemId, id))
  if (row.kind === 'film') await tx.update(film).set({ dateAdded: addedAt, dateAddedSource: 'Added to library' }).where(eq(film.mediaItemId, id))
  return { mediaItemId: id, created: true }
}

export async function promoteCatalogMedia(id: string, ownerId: string) {
  return db.transaction((tx) => promoteCatalogMediaInTransaction(tx, id, ownerId))
}

export async function promoteNativeResource(kind: CatalogNativeKind, id: string) {
  const table = { artist, person: artist, playlist, collection: playlist, 'subscription-source': subscriptionSource, 'subscription-item': subscriptionItem }[kind]
  return db.transaction(async (tx) => {
    const where = and(eq(table.id, id), table === playlist ? eq(playlist.kind, kind === 'collection' ? 'collection' : 'playlist') : undefined)
    const [row] = await tx.update(table).set({ addedToLibrary: true })
      .where(and(where, eq(table.addedToLibrary, false))).returning({ id: table.id })
    if (!row && !await tx.$count(table, where)) throw new ServerError({ statusCode: 404, message: 'Resource not found' })
    return { mediaItemId: id, created: Boolean(row) }
  })
}

export async function listCatalogObservations(id: string, { page, size }: z.infer<typeof CatalogObservationQuerySchema>, kind?: CatalogNativeKind) {
  const where = kind ? and(eq(catalogObservation.targetId, id), eq(catalogObservation.targetKind, kind)) : eq(catalogObservation.mediaItemId, id)
  const [items, totalCount] = await Promise.all([
    db.select().from(catalogObservation).where(where)
      .orderBy(desc(catalogObservation.observedAt), desc(catalogObservation.id)).limit(size).offset((page - 1) * size),
    db.$count(catalogObservation, where),
  ])
  return { items: items.map(({ observedAt, details, ...item }) => ({
    ...item, observedAt: observedAt.toISOString(),
    details: Object.entries(details ?? {}).flatMap(([label, value]) =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [{label,value:String(value)}] : []),
  })), page, size, totalCount, pageCount: Math.ceil(totalCount / size) }
}
