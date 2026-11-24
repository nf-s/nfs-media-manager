import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { JsonValue } from '@repo/media-plugin-sdk'
import type {
  CatalogNativeKind,
  CatalogObservationQuerySchema,
} from '@repo/schemas/catalog'
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

async function existingMedia(
  tx: Transaction,
  media: CatalogMedia,
  aliases: string[],
) {
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
  const nativeReferences = await tx
    .selectDistinct({ id: mediaItem.id, metadata: providerReference.metadata })
    .from(providerReference)
    .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
    .where(
      and(
        eq(providerReference.externalId, externalId),
        media.kind === 'film' && ['imdb', 'tmdb'].includes(media.referenceType)
          ? undefined
          : eq(providerReference.provider, media.provider),
        inArray(providerReference.referenceType, aliases),
        eq(mediaItem.mediaType, media.kind),
      ),
    )
  const blocked = new Set(
    nativeReferences
      .filter(
        ({ metadata }) =>
          String(metadata?.verified) === 'false' ||
          String(metadata?.rejected) === 'true',
      )
      .map(({ id }) => id),
  )
  const references = new Set(
    nativeReferences.filter(({ id }) => !blocked.has(id)).map(({ id }) => id),
  )
  if (
    !references.size &&
    media.provider === 'spotify' &&
    media.kind === 'album'
  ) {
    const byUrl = await tx
      .select({ id: album.mediaItemId })
      .from(album)
      .where(
        sql`${album.spotifyUrl} is not null and substring(${album.spotifyUrl} from '/album/([A-Za-z0-9]{22})') = ${externalId}`,
      )
    for (const { id } of byUrl) if (!blocked.has(id)) references.add(id)
  }
  if (media.kind === 'album' && references.size) {
    const rejections = await readAlbumMatchRejectionsForItems(tx, [
      ...references,
    ])
    for (const [id, rejected] of rejections) {
      const isRejected = createAlbumMatchRejectionPredicate(
        media.provider,
        rejected,
      )
      if (
        aliases.some((referenceType) =>
          isRejected({ referenceType, externalId }),
        ) ||
        (media.spotifyUrl &&
          isRejected({ referenceType: 'url', externalId: media.spotifyUrl })) ||
        (typeof media.referenceMetadata?.url === 'string' &&
          isRejected({
            referenceType: 'url',
            externalId: media.referenceMetadata.url,
          }))
      ) {
        references.delete(id)
        blocked.add(id)
      }
    }
  }
  return {
    id: references.size === 1 ? references.values().next().value : undefined,
    blocked,
  }
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
type Occurrence = { target: CatalogTarget; origin: CatalogOrigin }

export async function observeCatalogOccurrences(
  tx: Transaction,
  occurrences: Occurrence[],
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
    const billing = z
      .tuple([
        z.object({
          id: z.string().regex(/^[A-Za-z0-9]{22}$/),
          name: z.string(),
        }),
      ])
      .safeParse(recording?.metadata?.spotifyArtistCredits)
    if (billing.success && billing.data[0].name === sole.name)
      credits = [{ ...sole, externalId: billing.data[0].id }]
  }
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
  )
  for (const [position, credit] of credits.entries()) {
    const role = credit.role ?? 'artist'
    const key = [media.provider, id, role, position, credit.name]
    const creatorId = createStableId('catalog-artist', JSON.stringify(key))
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
    await observeCatalogOccurrence(
      tx,
      { kind: media.kind === 'film' ? 'person' : 'artist', id: observedId },
      {
        ...origin,
        subjectKind: media.kind,
        subjectId: id,
        relationshipRole: role,
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
    )
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

/** Resolve exact provider representations and retain each independent occurrence. */
export async function observeCatalogMedia(
  tx: Transaction,
  media: CatalogMedia,
  origin: CatalogOrigin,
): Promise<string> {
  // Share the lock used by existing Spotify recording, merge and track writers.
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const { type, aliases } = nativeReference(media)
  const resolved = await existingMedia(tx, media, aliases)
  const existingId = typeof resolved === 'string' ? resolved : resolved?.id
  const spotifyTrack = media.provider === 'spotify' && media.kind === 'track'
  const key = media.externalId
    ? [media.provider, type, media.externalId]
    : [
        media.provider,
        type,
        media.provisionalKey ?? [...originKey(origin), media.title],
      ]
  let id =
    existingId ??
    (spotifyTrack && media.externalId
      ? createStableId('library-track', `spotify:${media.externalId}`)
      : createStableId(`catalog-${media.kind}`, JSON.stringify(key)))
  if (typeof resolved !== 'string' && resolved?.blocked.has(id))
    id = createStableId(
      `catalog-${media.kind}`,
      JSON.stringify([...key, 'separate']),
    )

  const outside =
    !existingId ||
    Boolean(
      await tx.$count(
        mediaItem,
        and(eq(mediaItem.id, id), eq(mediaItem.inLibrary, false)),
      ),
    )
  if (outside) {
    await tx
      .insert(mediaItem)
      .values({
        id,
        mediaType: media.kind,
        title: media.title,
        slug: slugifyParts(media.title, id),
        artworkUrl: media.artworkUrl,
        releaseDate: media.releaseDate,
        sourceLabel: media.provider,
        inLibrary: false,
      })
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
    if (media.kind === 'album')
      await tx
        .insert(album)
        .values({
          mediaItemId: id,
          spotifyUrl: media.spotifyUrl,
          trackCount: media.trackCount,
        })
        .onConflictDoUpdate({
          target: album.mediaItemId,
          set: {
            spotifyUrl: sql`coalesce(${album.spotifyUrl}, excluded.spotify_url)`,
            trackCount: sql`case when ${album.trackCount} = 0 then excluded.track_count else ${album.trackCount} end`,
          },
          setWhere: sql`(${album.spotifyUrl} is null and excluded.spotify_url is not null) or (${album.trackCount} = 0 and excluded.track_count > 0)`,
        })
    if (media.kind === 'film')
      await tx.insert(film).values({ mediaItemId: id }).onConflictDoNothing()
    if (media.kind === 'track')
      await tx
        .insert(libraryTrack)
        .values({
          mediaItemId: id,
          spotifyTrackId:
            spotifyTrack && media.playable !== false
              ? media.externalId
              : undefined,
          spotifyUrl: media.spotifyUrl,
          durationSec: media.durationSec,
          albumMediaItemId: media.albumId,
          albumName: media.albumName,
          spotifyAlbumId: media.spotifyAlbumId,
          albumLinkStrategy:
            media.albumId && media.spotifyAlbumId ? 'spotify-album' : undefined,
        })
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
  if (media.externalId && !existingNativeTrack)
    await tx
      .insert(providerReference)
      .values({
        id: createStableId(
          'catalog-ref',
          JSON.stringify([id, media.provider, type, media.externalId]),
        ),
        mediaItemId: id,
        provider: media.provider,
        referenceType: type,
        externalId: media.externalId,
        metadata: media.referenceMetadata,
      })
      .onConflictDoNothing()

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
      .select()
      .from(catalogObservation)
      .where(where)
      .orderBy(desc(catalogObservation.observedAt), desc(catalogObservation.id))
      .limit(size)
      .offset((page - 1) * size),
    db.$count(catalogObservation, where),
  ])
  return {
    items: items.map(({ observedAt, details, ...item }) => ({
      ...item,
      observedAt: observedAt.toISOString(),
      details: Object.entries(details ?? {}).flatMap(([label, value]) =>
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
          ? [{ label, value: String(value) }]
          : [],
      ),
    })),
    page,
    size,
    totalCount,
    pageCount: Math.ceil(totalCount / size),
  }
}
