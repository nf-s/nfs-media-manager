import { and, eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import type { parseSpotifyArtistAlbumPage } from '@/lib/spotify-artist-albums'
import {
  album,
  artist,
  mediaCredit,
  mediaItem,
  providerReference,
} from '@/schemas/db'
import {
  observeCatalogOccurrences,
  type CatalogOrigin,
} from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Release = ReturnType<
  typeof parseSpotifyArtistAlbumPage
>['releases'][number]
type PageOrigin = {
  artistId: string
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
  { artistId, occurrencePrefix, ...page }: PageOrigin,
) {
  if (!releases.length) return
  const externalIds = [...new Set(releases.map(({ externalId }) => externalId))]
  const byReference = uniqueAlbumMatches(
    await tx
      .select({ externalId: providerReference.externalId, id: mediaItem.id })
      .from(providerReference)
      .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
      .where(
        and(
          inArray(providerReference.externalId, externalIds),
          eq(providerReference.provider, provider),
          inArray(providerReference.referenceType, albumReferenceTypes),
          eq(mediaItem.mediaType, 'album'),
          sql`${providerReference.metadata}->>'verified' is distinct from 'false'`,
          sql`${providerReference.metadata}->>'rejected' is distinct from 'true'`,
        ),
      ),
  )
  const withoutReference = externalIds.filter((id) => !byReference.has(id))
  const urlId = sql<
    string | null
  >`substring(${album.spotifyUrl} from '/album/([A-Za-z0-9]{22})')`
  const byUrl = uniqueAlbumMatches(
    withoutReference.length
      ? await tx
          .select({ externalId: urlId, id: album.mediaItemId })
          .from(album)
          .where(inArray(urlId, withoutReference))
      : [],
  )
  const targets = releases.map((release) => {
    const matches =
      byReference.get(release.externalId) ?? byUrl.get(release.externalId)
    const existingId =
      matches?.size === 1 ? matches.values().next().value : undefined
    const id =
      existingId ??
      createStableId(
        'catalog-album',
        JSON.stringify([provider, referenceType, release.externalId]),
      )
    const origin: CatalogOrigin = {
      ...page,
      provider,
      operation: 'artist-albums',
      subjectKind: 'artist',
      subjectId: artistId,
      occurrenceKey: `${occurrencePrefix}:${release.position}`,
      relationshipRole: release.relationshipRole,
      position: release.position,
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

  const credits = outside.flatMap(({ id, release, origin }) =>
    release.credits.map((credit, index) => ({
      ...credit,
      mediaItemId: id,
      billingOrder: index,
      primary: release.primary && index === 0,
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
    await tx
      .insert(artist)
      .values(
        batch.map(([externalId, name]) => ({
          id: createStableId(
            'catalog-artist',
            JSON.stringify([provider, externalId]),
          ),
          name,
          sortName: name,
          catalogProvider: provider,
          catalogExternalId: externalId,
        })),
      )
      .onConflictDoNothing()
    const rows = await tx
      .select({
        externalId: artist.catalogExternalId,
        id: artist.id,
        merged: artist.mergedIntoId,
      })
      .from(artist)
      .where(
        and(
          eq(artist.catalogProvider, provider),
          inArray(
            artist.catalogExternalId,
            batch.map(([externalId]) => externalId),
          ),
        ),
      )
    for (const row of rows) {
      if (row.externalId) native.set(row.externalId, row.merged ?? row.id)
    }
  }
  const albumCredits = credits.map((credit) => {
    const id = credit.primary ? artistId : native.get(credit.externalId)
    if (!id) throw new Error('Spotify album credit identity was not resolved.')
    return { ...credit, artistId: id, role: 'artist' }
  })
  for (let index = 0; index < albumCredits.length; index += CREDIT_BATCH_SIZE)
    await tx
      .insert(mediaCredit)
      .values(
        albumCredits
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
}
