import { and, eq, inArray, sql } from 'drizzle-orm'
import type { db } from '@/lib/db'
import { createStableId, parseOptionalDate } from '@/lib/media-utils'
import {
  musicResponseEndpoint,
  readMusicDiscoveries,
  type MusicDiscovery,
} from '@/lib/music-provider-discoveries'
import { artist, mediaItem, providerResponse } from '@/schemas/db'
import {
  observeCatalogMedia,
  observeCatalogOccurrence,
  type CatalogOrigin,
} from './catalog-discoveries'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type MusicResponse = Pick<
  typeof providerResponse.$inferSelect,
  | 'id'
  | 'provider'
  | 'phase'
  | 'method'
  | 'requestUrl'
  | 'status'
  | 'body'
  | 'jobId'
  | 'receivedAt'
>
type MusicResponseSubjects = {
  artistId?: string | null
  albumId?: string | null
}
type Parent = { kind: MusicDiscovery['kind']; id: string; title: string }

const unresolvedTitles = [
  'Spotify release',
  'Discogs release',
  'Discogs main release',
  'Discogs master',
  'MusicBrainz release',
  'MusicBrainz release group',
  'Last.fm album',
  'Rate Your Music release',
]

async function observeArtist(
  tx: Transaction,
  node: MusicDiscovery,
  origin: CatalogOrigin,
) {
  const key = node.externalId
    ? [node.provider, node.externalId]
    : [
        node.provider,
        origin.subjectKind,
        origin.subjectId,
        origin.occurrenceKey,
        origin.position,
        node.title,
      ]
  const id = createStableId('catalog-artist', JSON.stringify(key))
  await tx
    .insert(artist)
    .values({
      id,
      name: node.title,
      sortName: node.title,
      catalogProvider: node.provider,
      catalogExternalId: node.externalId,
    })
    .onConflictDoNothing()
  if (!node.externalId) return id
  const [stored] = await tx
    .select({ id: artist.id, merged: artist.mergedIntoId })
    .from(artist)
    .where(
      and(
        eq(artist.catalogProvider, node.provider),
        eq(artist.catalogExternalId, node.externalId),
      ),
    )
  return stored?.merged ?? stored?.id ?? id
}

/** Observations are addressable through the same album, track and artist pages as members. */
export async function observeMusicDiscovery(
  tx: Transaction,
  node: MusicDiscovery,
  source: CatalogOrigin,
  parent?: Parent,
): Promise<string> {
  const origin: CatalogOrigin = {
    ...source,
    occurrenceKey: JSON.stringify([
      source.occurrenceKey,
      source.position,
      node.provider,
      node.referenceType,
      node.externalId,
      node.details?.disc,
    ]),
    subjectKind: parent?.kind ?? source.subjectKind,
    subjectId: parent?.id ?? source.subjectId,
    relationshipRole: node.relationship,
    position: node.ordinal,
    details: {
      ...source.details,
      ...node.details,
      ...(node.url ? { url: node.url } : {}),
    },
  }
  let id: string
  if (node.kind === 'artist') {
    id = await observeArtist(tx, node, origin)
    await observeCatalogOccurrence(tx, { kind: 'artist', id }, origin)
  } else {
    const spotifyUrl = node.provider === 'spotify' ? node.url : undefined
    id = await observeCatalogMedia(
      tx,
      {
        kind: node.kind,
        title: node.title,
        provider: node.provider,
        referenceType: node.referenceType,
        externalId: node.externalId,
        provisionalKey:
          node.provisionalKey ??
          (parent
            ? JSON.stringify([
                parent.id,
                node.details?.disc ?? null,
                node.ordinal,
                node.title,
              ])
            : undefined),
        referenceMetadata: node.url ? { url: node.url } : undefined,
        releaseDate: parseOptionalDate(node.date),
        artworkUrl: node.artworkUrl,
        durationSec: node.durationSec,
        trackCount: node.trackCount,
        credits: node.credits,
        spotifyUrl,
        albumId:
          node.kind === 'track' && parent?.kind === 'album'
            ? parent.id
            : undefined,
        albumName:
          node.kind === 'track' && parent?.kind === 'album'
            ? parent.title
            : undefined,
        // Release listings alone do not verify that a particular track is playable.
        playable: false,
      },
      origin,
    )
    if (
      node.kind === 'album' &&
      node.externalId &&
      !unresolvedTitles.includes(node.title)
    )
      await tx
        .update(mediaItem)
        .set({
          title: node.title,
        })
        .where(
          and(
            eq(mediaItem.id, id),
            eq(mediaItem.inLibrary, false),
            eq(mediaItem.sourceLabel, node.provider),
            inArray(mediaItem.title, unresolvedTitles),
            sql`${mediaItem.metadata}->>'legacyHidden' is distinct from 'true'`,
          ),
        )
  }
  for (const child of node.children ?? [])
    await observeMusicDiscovery(tx, child, origin, {
      kind: node.kind,
      id,
      title: node.title,
    })
  return id
}

export function readRetainedMusicResponse(row: MusicResponse) {
  const endpoint = musicResponseEndpoint(row)
  if (!endpoint || row.body.state !== 'captured') return []
  try {
    const value: unknown = JSON.parse(row.body.text)
    return readMusicDiscoveries(endpoint, value)
  } catch {
    return []
  }
}

export async function observeMusicProviderResponse(
  tx: Transaction,
  row: MusicResponse,
  subjects: MusicResponseSubjects,
  discoveries = readRetainedMusicResponse(row),
) {
  const { artistId, albumId } = subjects
  for (const node of discoveries)
    await observeMusicDiscovery(tx, node, {
      provider: row.provider,
      operation:
        node.relationship === 'candidate' ? 'match-search' : 'provider-result',
      occurrenceKey: row.id,
      subjectKind: artistId ? 'artist' : albumId ? 'album' : undefined,
      subjectId: artistId ?? albumId ?? undefined,
      jobId: row.jobId,
      responseId: row.id,
      observedAt: row.receivedAt ?? undefined,
    })
}
