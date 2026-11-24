import { and, eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import type { JsonValue } from '@repo/media-plugin-sdk'
import type { parseSpotifyArtistAlbumPage } from '@/lib/spotify-artist-albums'
import { album, mediaCredit, mediaItem, providerReference } from '@/schemas/db'
import { observeNamedArtistIdentities } from './catalog-artist-identities'
import {
  observeCatalogOccurrences,
  type CatalogOrigin,
} from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Release = ReturnType<
  typeof parseSpotifyArtistAlbumPage
>['releases'][number] & { details?: Record<string, JsonValue> }
type PageOrigin = {
  artistId?: string
  operation?: string
  importId?: string
  occurrencePrefix: string
  page: number
  jobId?: string
  responseId?: string
}

const provider = 'spotify'
const referenceType = 'spotify'
const albumReferenceTypes = [referenceType, 'album', 'spotify_album']
const CREDIT_BATCH_SIZE = 500

function uniqueAlbumMatches(rows: { externalId: string | null; id: string }[]) {
  const matches = new Map<string, Set<string>>()
  for (const { externalId, id } of rows) {
    if (!externalId) continue
    const ids = matches.get(externalId) ?? new Set()
    ids.add(id)
    matches.set(externalId, ids)
  }
  return matches
}

/** Save the releases and their independent occurrences under the catalog write lock. */
export async function observeSpotifyArtistAlbumPage(
  tx: Transaction,
  releases: readonly Release[],
  {
    artistId,
    occurrencePrefix,
    operation = 'artist-albums',
    ...page
  }: PageOrigin,
) {
  if (!releases.length) return new Map<string, string>()
  const externalIds = [...new Set(releases.map(({ externalId }) => externalId))]
  const referenceRows = await tx
    .select({
      externalId: providerReference.externalId,
      id: mediaItem.id,
      metadata: providerReference.metadata,
    })
    .from(providerReference)
    .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
    .where(
      and(
        inArray(providerReference.externalId, externalIds),
        eq(providerReference.provider, provider),
        inArray(providerReference.referenceType, albumReferenceTypes),
        eq(mediaItem.mediaType, 'album'),
      ),
    )
  const blocked = new Map<string, Set<string>>()
  for (const { id, externalId, metadata } of referenceRows) {
    if (
      String(metadata?.verified) !== 'false' &&
      String(metadata?.rejected) !== 'true'
    )
      continue
    const ids = blocked.get(externalId) ?? new Set<string>()
    ids.add(id)
    blocked.set(externalId, ids)
  }
  const byReference = uniqueAlbumMatches(
    referenceRows.filter(
      ({ id, externalId }) => !blocked.get(externalId)?.has(id),
    ),
  )
  const withoutReference = externalIds.filter((id) => !byReference.has(id))
  const urlId = sql<
    string | null
  >`substring(${album.spotifyUrl} from '/album/([A-Za-z0-9]{22})')`
  const urlRows = withoutReference.length
    ? await tx
        .select({ externalId: urlId, id: album.mediaItemId })
        .from(album)
        .where(inArray(urlId, withoutReference))
    : []
  const byUrl = uniqueAlbumMatches(
    urlRows.filter(
      ({ id, externalId }) => !externalId || !blocked.get(externalId)?.has(id),
    ),
  )
  const targets = releases.map((release) => {
    const matches =
      byReference.get(release.externalId) ?? byUrl.get(release.externalId)
    const existingId =
      matches?.size === 1 ? matches.values().next().value : undefined
    const key = [provider, referenceType, release.externalId]
    const provisional = createStableId('catalog-album', JSON.stringify(key))
    const id =
      existingId ??
      (blocked.get(release.externalId)?.has(provisional)
        ? createStableId('catalog-album', JSON.stringify([...key, 'separate']))
        : provisional)
    const origin: CatalogOrigin = {
      ...page,
      provider,
      operation,
      subjectKind: artistId ? 'artist' : undefined,
      subjectId: artistId,
      occurrenceKey: `${occurrencePrefix}:${release.position}`,
      relationshipRole: release.relationshipRole,
      position: release.position,
      details: release.details,
    }
    return { id, release, origin }
  })
  const ids = [...new Set(targets.map(({ id }) => id))]
  const members = new Set(
    (
      await tx
        .select({ id: mediaItem.id })
        .from(mediaItem)
        .where(and(inArray(mediaItem.id, ids), eq(mediaItem.inLibrary, true)))
    ).map(({ id }) => id),
  )
  const outside = targets.filter(({ id }) => !members.has(id))
  const summaries = new Map<string, Release>()
  for (const { id, release } of outside) {
    const first = summaries.get(id)
    summaries.set(
      id,
      first
        ? {
            ...first,
            artworkUrl: first.artworkUrl ?? release.artworkUrl,
            releaseDate: first.releaseDate ?? release.releaseDate,
            trackCount: first.trackCount ?? release.trackCount,
          }
        : release,
    )
  }
  if (summaries.size) {
    await tx
      .insert(mediaItem)
      .values(
        [...summaries].map(([id, release]): typeof mediaItem.$inferInsert => ({
          id,
          mediaType: 'album',
          title: release.title,
          slug: slugifyParts(release.title, id),
          artworkUrl: release.artworkUrl,
          releaseDate: release.releaseDate,
          sourceLabel: provider,
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
    await tx
      .insert(album)
      .values(
        [...summaries].map(([id, release]) => ({
          mediaItemId: id,
          spotifyUrl: release.spotifyUrl,
          trackCount: release.trackCount,
        })),
      )
      .onConflictDoUpdate({
        target: album.mediaItemId,
        set: {
          spotifyUrl: sql`coalesce(${album.spotifyUrl}, excluded.spotify_url)`,
          trackCount: sql`coalesce(${album.trackCount}, excluded.track_count)`,
        },
        setWhere: sql`(${album.spotifyUrl} is null and excluded.spotify_url is not null)
          or (${album.trackCount} is null and excluded.track_count is not null)`,
      })
  }
  await tx
    .insert(providerReference)
    .values(
      targets.map(({ id, release: { externalId } }) => ({
        id: createStableId(
          'catalog-ref',
          JSON.stringify([id, provider, referenceType, externalId]),
        ),
        mediaItemId: id,
        provider,
        referenceType,
        externalId,
      })),
    )
    .onConflictDoNothing()

  const credits = targets.flatMap(({ id, release, origin }) =>
    release.credits.map((credit, index) => ({
      ...credit,
      mediaItemId: id,
      billingOrder: index,
      primary: Boolean(artistId && release.primary && index === 0),
      origin,
    })),
  )
  const names = new Map<string, string>()
  for (const { primary, externalId, name } of credits) {
    if (!primary && !names.has(externalId)) names.set(externalId, name)
  }
  const native = new Map<string, string>()
  const identities = [...names]
  for (let index = 0; index < identities.length; index += CREDIT_BATCH_SIZE) {
    const batch = identities.slice(index, index + CREDIT_BATCH_SIZE)
    for (const [externalId, id] of await observeNamedArtistIdentities(
      tx,
      provider,
      new Map(batch),
    ))
      native.set(externalId, id)
  }
  const albumCredits = credits.map((credit) => {
    const id = credit.primary ? artistId : native.get(credit.externalId)
    if (!id) throw new Error('Spotify album credit identity was not resolved.')
    return { ...credit, artistId: id, role: 'artist' }
  })
  const outsideCredits = albumCredits.filter(
    ({ mediaItemId }) => !members.has(mediaItemId),
  )
  for (let index = 0; index < outsideCredits.length; index += CREDIT_BATCH_SIZE)
    await tx
      .insert(mediaCredit)
      .values(
        outsideCredits
          .slice(index, index + CREDIT_BATCH_SIZE)
          .map(({ mediaItemId, artistId, role, billingOrder }) => ({
            mediaItemId,
            artistId,
            role,
            billingOrder,
          })),
      )
      .onConflictDoNothing()
  await observeCatalogOccurrences(tx, [
    ...targets.map(({ id, origin }) => ({
      target: { kind: 'album', id },
      origin,
    })),
    ...albumCredits.map(
      ({ artistId, mediaItemId, role, billingOrder, origin }) => ({
        target: { kind: 'artist', id: artistId },
        origin: {
          ...origin,
          subjectKind: 'album',
          subjectId: mediaItemId,
          relationshipRole: role,
          position: billingOrder + 1,
          occurrenceKey: JSON.stringify([
            origin.occurrenceKey,
            origin.subjectKind,
            origin.subjectId,
            origin.page,
            origin.position,
            'credit',
          ]),
        },
      }),
    ),
  ])
  return new Map(targets.map(({ release, id }) => [release.externalId, id]))
}
