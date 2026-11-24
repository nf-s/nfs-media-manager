import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import {
  musicObservationProviders,
  musicResponseEndpoint,
  readMusicDiscoveries,
  type MusicDiscovery,
} from '@/lib/music-provider-discoveries'
import {
  artistProviderSnapshot,
  lastfmScrobble,
  mediaItem,
  providerResponse,
  providerSnapshot,
  scrapeJob,
  scrapeJobItem,
} from '@/schemas/db'
import { observeCatalogOccurrence } from './catalog-discoveries'
import { observeLastfmScrobbles } from './lastfm-catalog-observations'
import {
  observeMusicDiscovery,
  observeMusicProviderResponse,
  readRetainedMusicResponse,
} from './music-provider-observations'

type Batch = { apply: boolean; limit: number; after?: string }
const ObjectSchema = z.record(z.string(), z.unknown())

function count(nodes: MusicDiscovery[]): number {
  return nodes.reduce((sum, node) => sum + 1 + count(node.children ?? []), 0)
}

/** Only the retained public catalog bodies are selected, regardless of job outcome. */
export async function backfillPublicMusicResponses({
  apply,
  limit,
  after,
}: Batch) {
  const rows = await db
    .select({
      response: providerResponse,
      albumId: scrapeJobItem.mediaItemId,
      jobOptions: scrapeJob.options,
    })
    .from(providerResponse)
    .innerJoin(scrapeJob, eq(scrapeJob.id, providerResponse.jobId))
    .leftJoin(scrapeJobItem, eq(scrapeJobItem.id, providerResponse.jobItemId))
    .where(
      and(
        after ? gt(providerResponse.id, after) : undefined,
        inArray(providerResponse.provider, musicObservationProviders),
        eq(providerResponse.method, 'GET'),
        eq(providerResponse.bodyState, 'captured'),
        gte(providerResponse.status, 200),
        lt(providerResponse.status, 300),
        sql`(${providerResponse.provider} <> 'lastfm' or
        ${providerResponse.requestUrl} ~* '[?&]method=(album|artist|track)[.]')`,
        sql`(${providerResponse.provider} <> 'spotify' or
        ${providerResponse.requestUrl} ~ '^https://api[.]spotify[.]com/v1/(search|artists/|albums/)')`,
      ),
    )
    .orderBy(asc(providerResponse.id))
    .limit(Math.min(limit, 12))
  let candidates = 0
  let skipped = 0
  for (const { response, albumId, jobOptions } of rows) {
    const observations = readRetainedMusicResponse(response)
    if (!observations.length) {
      skipped++
      continue
    }
    candidates += count(observations)
    if (apply) {
      const artistId =
        response.artistId ??
        (typeof jobOptions.artistId === 'string'
          ? jobOptions.artistId
          : undefined)
      await db.transaction((tx) =>
        observeMusicProviderResponse(
          tx,
          response,
          { artistId, albumId },
          observations,
        ),
      )
    }
  }
  return { next: rows.at(-1)?.response.id ?? null, candidates, skipped }
}

function fromSnapshot(
  provider: string,
  payload: unknown,
  artistSource: boolean,
) {
  const outer = ObjectSchema.safeParse(payload).data
  const row = ObjectSchema.safeParse(outer?.data).data ?? outer
  if (!row) return []
  const decode = (requestUrl: string, value: unknown) => {
    const endpoint = musicResponseEndpoint({
      provider,
      method: 'GET',
      status: 200,
      requestUrl,
      phase: artistSource ? 'artist' : 'media',
    })
    return endpoint ? readMusicDiscoveries(endpoint, value) : []
  }
  if (artistSource) {
    if (provider === 'musicbrainz')
      return [
        ...decode('https://musicbrainz.org/ws/2/artist/saved', row.artist),
        ...decode('https://musicbrainz.org/ws/2/artist', row.search),
      ]
    if (provider === 'discogs')
      return [
        ...decode('https://api.discogs.com/artists/1', row.artist),
        ...decode('https://api.discogs.com/database/search', row.search),
      ]
    if (provider === 'lastfm')
      return [
        ...decode(
          'https://ws.audioscrobbler.com/2.0/?method=artist.getInfo',
          row.artist,
        ),
        ...decode(
          'https://ws.audioscrobbler.com/2.0/?method=artist.search',
          row.search,
        ),
      ]
    if (provider === 'spotify')
      return [
        ...decode(
          'https://api.spotify.com/v1/artists/fixtureartist000000000',
          row.artist,
        ),
        ...decode('https://api.spotify.com/v1/search?type=artist', row.search),
      ]
    return []
  }
  if (provider === 'musicbrainz')
    return decode(
      'https://musicbrainz.org/ws/2/release-group/saved',
      row.releaseGroup,
    )
  if (provider === 'discogs')
    return [
      ...decode('https://api.discogs.com/masters/1', row.master),
      ...decode(
        'https://api.discogs.com/releases/1',
        row.release ?? row.mainRelease,
      ),
    ]
  if (provider === 'lastfm')
    return decode(
      'https://ws.audioscrobbler.com/2.0/?method=album.getInfo',
      row,
    )
  if (provider === 'spotify')
    return decode(
      'https://api.spotify.com/v1/albums/fixturealbum0000000000',
      row,
    )
  return []
}

export async function backfillMusicAlbumSnapshots({
  apply,
  limit,
  after,
}: Batch) {
  const rows = await db
    .select({
      id: providerSnapshot.id,
      mediaItemId: mediaItem.id,
      payload: providerSnapshot.payload,
      provider: providerSnapshot.provider,
      source: providerSnapshot.source,
      jobId: providerSnapshot.scrapeJobId,
      createdAt: providerSnapshot.createdAt,
    })
    .from(providerSnapshot)
    .innerJoin(mediaItem, eq(mediaItem.id, providerSnapshot.mediaItemId))
    .where(
      and(
        eq(mediaItem.mediaType, 'album'),
        inArray(providerSnapshot.provider, [
          ...musicObservationProviders,
          'album-csv',
          'upc-csv',
        ]),
        after ? gt(providerSnapshot.id, after) : undefined,
      ),
    )
    .orderBy(asc(providerSnapshot.id))
    .limit(Math.min(limit, 12))
  let candidates = 0
  let skipped = 0
  for (const row of rows) {
    const imported = row.source === 'file-import' || row.source === 'manual-add'
    const nodes = fromSnapshot(row.provider, row.payload, false)
    if (!nodes.length && !imported) {
      skipped++
      continue
    }
    candidates += count(nodes) + Number(imported)
    if (apply)
      await db.transaction(async (tx) => {
        const origin = {
          provider: row.provider,
          operation: imported ? 'import' : 'provider-result',
          occurrenceKey: row.id,
          snapshotId: row.id,
          jobId: row.jobId ?? undefined,
          observedAt: row.createdAt,
        }
        if (imported)
          await observeCatalogOccurrence(
            tx,
            { kind: 'album', id: row.mediaItemId },
            origin,
          )
        for (const node of nodes)
          await observeMusicDiscovery(tx, node, {
            ...origin,
            subjectKind: 'album',
            subjectId: row.mediaItemId,
          })
      })
  }
  return { next: rows.at(-1)?.id ?? null, candidates, skipped }
}

export async function backfillMusicArtistSnapshots({
  apply,
  limit,
  after,
}: Batch) {
  const rows = await db
    .select({
      id: artistProviderSnapshot.id,
      artistId: artistProviderSnapshot.artistId,
      payload: artistProviderSnapshot.payload,
      provider: artistProviderSnapshot.provider,
      jobId: artistProviderSnapshot.scrapeJobId,
      createdAt: artistProviderSnapshot.createdAt,
    })
    .from(artistProviderSnapshot)
    .where(
      and(
        inArray(artistProviderSnapshot.provider, musicObservationProviders),
        after ? gt(artistProviderSnapshot.id, after) : undefined,
      ),
    )
    .orderBy(asc(artistProviderSnapshot.id))
    .limit(Math.min(limit, 12))
  let candidates = 0
  let skipped = 0
  for (const row of rows) {
    const nodes = fromSnapshot(row.provider, row.payload, true)
    if (!nodes.length) {
      skipped++
      continue
    }
    candidates += count(nodes)
    if (apply)
      await db.transaction(async (tx) => {
        for (const node of nodes)
          await observeMusicDiscovery(tx, node, {
            provider: row.provider,
            operation: 'provider-result',
            occurrenceKey: row.id,
            subjectKind: 'artist',
            subjectId: row.artistId,
            snapshotId: row.id,
            jobId: row.jobId ?? undefined,
            observedAt: row.createdAt,
          })
      })
  }
  return { next: rows.at(-1)?.id ?? null, candidates, skipped }
}

export async function backfillLastfmScrobbles({ apply, limit, after }: Batch) {
  const rows = await db
    .select({
      id: lastfmScrobble.id,
      artistName: lastfmScrobble.artistName,
      artistMbid: lastfmScrobble.artistMbid,
      trackName: lastfmScrobble.trackName,
      trackMbid: lastfmScrobble.trackMbid,
      albumName: lastfmScrobble.albumName,
      albumMbid: lastfmScrobble.albumMbid,
    })
    .from(lastfmScrobble)
    .where(after ? gt(lastfmScrobble.id, after) : undefined)
    .orderBy(asc(lastfmScrobble.id))
    .limit(limit)
  if (apply && rows.length)
    await db.transaction((tx) => observeLastfmScrobbles(tx, rows))
  return {
    next: rows.at(-1)?.id ?? null,
    candidates: rows.reduce((sum, row) => sum + (row.albumName ? 3 : 2), 0),
    skipped: 0,
  }
}
