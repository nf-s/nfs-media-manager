import { and, eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { createStableId, slugifyParts } from '@/lib/media-utils'
import { AlbumMbidSchema } from '@/plugins/builtin/album-provider-helpers'
import {
  album,
  artist,
  catalogObservation,
  lastfmScrobble,
  libraryTrack,
  mediaCredit,
  mediaItem,
  providerReference,
} from '@/schemas/db'
import {
  observeCatalogOccurrences,
  type CatalogOrigin,
} from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Scrobble = Pick<
  typeof lastfmScrobble.$inferSelect,
  | 'id'
  | 'artistName'
  | 'artistMbid'
  | 'albumName'
  | 'albumMbid'
  | 'trackName'
  | 'trackMbid'
>
type Mention = {
  kind: 'track' | 'album'
  title: string
  referenceType: string
  externalId?: string
  key: string
}

function name(value: string | null) {
  return value?.replaceAll('\u0000', '').trim().slice(0, 500)
}

function mbid(value: string | null) {
  return AlbumMbidSchema.safeParse(value).data
}

function mention(
  kind: Mention['kind'],
  title: string,
  id: string | undefined,
  context: unknown[],
): Mention {
  const referenceType = kind === 'album' ? 'mbid' : 'recording-mbid'
  return {
    kind,
    title,
    referenceType,
    externalId: id,
    key: JSON.stringify([kind, referenceType, id ?? context]),
  }
}

/** Account identity and listened-at values stay on the existing scrobble record. */
export async function observeLastfmScrobbles(
  tx: Transaction,
  rows: Scrobble[],
  evidence: { jobId?: string; responseId?: string } = {},
) {
  if (!rows.length) return
  await tx.execute(sql`select pg_advisory_xact_lock(614106)`)
  const previous = new Set(
    (
      await tx
        .selectDistinct({ id: catalogObservation.subjectId })
        .from(catalogObservation)
        .where(
          and(
            eq(catalogObservation.operation, 'scrobble'),
            eq(catalogObservation.subjectKind, 'scrobble'),
            inArray(
              catalogObservation.subjectId,
              rows.map(({ id }) => id),
            ),
          ),
        )
    ).map(({ id }) => id),
  )
  const events = rows.flatMap((row) => {
    const artistName = name(row.artistName)
    const albumName = name(row.albumName)
    const title = name(row.trackName)
    if (!title || !artistName || previous.has(row.id)) return []
    const performerId = mbid(row.artistMbid)
    const scope = [performerId ?? artistName, albumName ?? title]
    return [
      {
        id: row.id,
        performerId,
        artistName,
        artistKey: JSON.stringify(
          performerId
            ? ['lastfm', performerId]
            : ['lastfm', 'scrobble', ...scope],
        ),
        album: albumName
          ? mention('album', albumName, mbid(row.albumMbid), scope)
          : undefined,
        track: mention('track', title, mbid(row.trackMbid), [...scope, title]),
      },
    ]
  })
  if (!events.length) return
  const mentions = new Map(
    events
      .flatMap(({ album, track }) => [...(album ? [album] : []), track])
      .map((item) => [item.key, item]),
  )
  const nativeIds = [
    ...new Set(
      [...mentions.values()].flatMap(({ externalId }) =>
        externalId ? [externalId] : [],
      ),
    ),
  ]
  const matches = new Map<string, Set<string>>()
  if (nativeIds.length) {
    const stored = await tx
      .select({
        id: mediaItem.id,
        kind: mediaItem.mediaType,
        externalId: providerReference.externalId,
        referenceType: providerReference.referenceType,
      })
      .from(providerReference)
      .innerJoin(mediaItem, eq(mediaItem.id, providerReference.mediaItemId))
      .where(
        and(
          eq(providerReference.provider, 'lastfm'),
          inArray(providerReference.referenceType, ['mbid', 'recording-mbid']),
          inArray(providerReference.externalId, nativeIds),
          sql`${providerReference.metadata}->>'rejected' is distinct from 'true'`,
          sql`${providerReference.metadata}->>'verified' is distinct from 'false'`,
        ),
      )
    for (const row of stored) {
      const key = JSON.stringify([row.kind, row.referenceType, row.externalId])
      const ids = matches.get(key) ?? new Set<string>()
      ids.add(row.id)
      matches.set(key, ids)
    }
  }
  const ids = new Map(
    [...mentions].map(([key, item]) => {
      const found = matches.get(key)
      const existing =
        found?.size === 1 ? found.values().next().value : undefined
      return [
        key,
        existing ??
          createStableId(
            `catalog-${item.kind}`,
            JSON.stringify([
              'lastfm',
              item.referenceType,
              item.externalId ?? key,
            ]),
          ),
      ]
    }),
  )
  const targets = new Map(
    [...mentions].flatMap(([key, item]) => {
      const id = ids.get(key)
      return id ? [[id, item] satisfies [string, Mention]] : []
    }),
  )
  await tx
    .insert(mediaItem)
    .values(
      [...targets].map(([id, item]) => ({
        id,
        mediaType: item.kind,
        title: item.title,
        slug: slugifyParts(item.title, id),
        sourceLabel: 'lastfm',
        inLibrary: false,
      })),
    )
    .onConflictDoNothing()
  const releases = [...targets].flatMap(([id, item]) =>
    item.kind === 'album' ? [{ mediaItemId: id }] : [],
  )
  if (releases.length)
    await tx.insert(album).values(releases).onConflictDoNothing()
  const recordings = new Map(
    events.flatMap(({ track, album }) => {
      const id = ids.get(track.key)
      return id
        ? [
            [
              id,
              {
                mediaItemId: id,
                albumMediaItemId: album ? ids.get(album.key) : undefined,
                albumName: album?.title,
              },
            ] satisfies [string, typeof libraryTrack.$inferInsert],
          ]
        : []
    }),
  )
  if (recordings.size)
    await tx
      .insert(libraryTrack)
      .values([...recordings.values()])
      .onConflictDoNothing()
  const references = [...mentions].flatMap(([key, item]) => {
    const id = ids.get(key)
    return id && item.externalId
      ? [
          {
            id: createStableId(
              'catalog-ref',
              JSON.stringify([
                id,
                'lastfm',
                item.referenceType,
                item.externalId,
              ]),
            ),
            mediaItemId: id,
            provider: 'lastfm',
            referenceType: item.referenceType,
            externalId: item.externalId,
          },
        ]
      : []
  })
  if (references.length)
    await tx.insert(providerReference).values(references).onConflictDoNothing()

  const artists = new Map(
    events.map(({ artistKey, artistName, performerId }) => [
      artistKey,
      {
        id: createStableId('catalog-artist', artistKey),
        name: artistName,
        sortName: artistName,
        catalogProvider: 'lastfm',
        catalogExternalId: performerId,
      },
    ]),
  )
  await tx
    .insert(artist)
    .values([...artists.values()])
    .onConflictDoNothing()
  const performerIds = [
    ...new Set(
      events.flatMap(({ performerId }) => (performerId ? [performerId] : [])),
    ),
  ]
  const storedArtists = new Map(
    performerIds.length
      ? (
          await tx
            .select({
              externalId: artist.catalogExternalId,
              id: artist.id,
              merged: artist.mergedIntoId,
            })
            .from(artist)
            .where(
              and(
                eq(artist.catalogProvider, 'lastfm'),
                inArray(artist.catalogExternalId, performerIds),
              ),
            )
        ).map(({ externalId, id, merged }) => [externalId, merged ?? id])
      : [],
  )

  const members = new Set(
    (
      await tx
        .select({ id: mediaItem.id })
        .from(mediaItem)
        .where(
          and(
            inArray(mediaItem.id, [...targets.keys()]),
            eq(mediaItem.inLibrary, true),
          ),
        )
    ).map(({ id }) => id),
  )
  const credits: (typeof mediaCredit.$inferInsert)[] = []
  const occurrences: Parameters<typeof observeCatalogOccurrences>[1] = []
  for (const event of events) {
    const observedArtist =
      storedArtists.get(event.performerId ?? null) ??
      artists.get(event.artistKey)?.id
    const origin: CatalogOrigin = {
      ...evidence,
      provider: 'lastfm',
      operation: 'scrobble',
      occurrenceKey: event.id,
      subjectKind: 'scrobble',
      subjectId: event.id,
    }
    if (observedArtist)
      occurrences.push({
        target: { kind: 'artist', id: observedArtist },
        origin: { ...origin, relationshipRole: 'reported_artist' },
      })
    for (const item of [event.album, event.track]) {
      if (!item) continue
      const id = ids.get(item.key)
      if (!id) continue
      if (observedArtist && !members.has(id))
        credits.push({
          mediaItemId: id,
          artistId: observedArtist,
          role: 'artist',
        })
      occurrences.push({
        target: { kind: item.kind, id },
        origin: {
          ...origin,
          relationshipRole:
            item.kind === 'album' ? 'reported_album' : 'played_track',
        },
      })
    }
  }
  if (credits.length)
    await tx.insert(mediaCredit).values(credits).onConflictDoNothing()
  await observeCatalogOccurrences(tx, occurrences)
}
