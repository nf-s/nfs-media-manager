import { sql } from 'drizzle-orm'
import { z } from 'zod'
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
import { recordSpotifyCatalogCodes } from './spotify-catalog-codes'

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

const AlbumIdentityRowsSchema = z.array(
  z.object({
    id: z.string(),
    external_id: z.string().nullable(),
    in_library: z.boolean(),
    blocked: z.boolean(),
  }),
)

function uniqueAlbumMatches(rows: z.infer<typeof AlbumIdentityRowsSchema>) {
  const matches = new Map<string, Set<string>>()
  for (const { external_id, id, blocked } of rows) {
    if (!external_id || blocked) continue
    const ids = matches.get(external_id) ?? new Set()
    ids.add(id)
    matches.set(external_id, ids)
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
  const candidates = releases.map((release) => {
    const key = [provider, referenceType, release.externalId]
    return {
      release,
      provisional: createStableId('catalog-album', JSON.stringify(key)),
      separate: createStableId(
        'catalog-album',
        JSON.stringify([...key, 'separate']),
      ),
    }
  })
  const provisionalIds = [
    ...new Set(
      candidates.flatMap(({ provisional, separate }) => [
        provisional,
        separate,
      ]),
    ),
  ]
  const { rows } = await tx.execute(sql`
    with refs as (
      select m.id, r.external_id, m.in_library,
        coalesce(bool_or(
          r.metadata->>'verified' = 'false' or r.metadata->>'rejected' = 'true'
        ), false) as blocked
      from provider_reference r join media_item m on m.id = r.media_item_id
      where r.external_id = any(${sql.param(externalIds)}::text[])
        and r.provider = ${provider}
        and r.reference_type = any(${sql.param(albumReferenceTypes)}::text[])
        and m.media_type = 'album'
      group by m.id, r.external_id, m.in_library
    ), unmatched as (
      select id from unnest(${sql.param(externalIds)}::text[]) as wanted(id)
      where not exists (select 1 from refs where external_id = wanted.id and not blocked)
    )
    select id, external_id, in_library, blocked from refs
    union all
    select m.id, unmatched.id, m.in_library, false
    from unmatched
    join album a on substring(a.spotify_url from '/album/([A-Za-z0-9]{22})') = unmatched.id
    join media_item m on m.id = a.media_item_id
    where not exists (
      select 1 from refs where id = m.id and external_id = unmatched.id and blocked
    )
    union all
    select id, null, in_library, false from media_item
    where id = any(${sql.param(provisionalIds)}::text[]) and in_library
  `)
  const albumIdentities = AlbumIdentityRowsSchema.parse(rows)
  const blocked = new Map<string, Set<string>>()
  for (const { id, external_id, blocked: isBlocked } of albumIdentities) {
    if (!isBlocked || !external_id) continue
    const ids = blocked.get(external_id) ?? new Set<string>()
    ids.add(id)
    blocked.set(external_id, ids)
  }
  const matchedAlbums = uniqueAlbumMatches(albumIdentities)
  const targets = candidates.map(({ release, provisional, separate }) => {
    const matches = matchedAlbums.get(release.externalId)
    const existingId =
      matches?.size === 1 ? matches.values().next().value : undefined
    const id =
      existingId ??
      (blocked.get(release.externalId)?.has(provisional)
        ? separate
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
  const members = new Set(
    albumIdentities.flatMap(({ id, in_library }) => (in_library ? [id] : [])),
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

  await recordSpotifyCatalogCodes(
    tx,
    targets.map(({ id, release, origin }) => ({
      mediaItemId: id,
      kind: 'album',
      value: release.upc,
      origin,
    })),
  )

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
