import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { SPOTIFY_PLAYLIST_IMPORT_TASK } from '@repo/schemas/tracks'
import {
  SonovaultResolveResultSchema,
  SonovaultStoredRecordSchema,
} from '@/lib/sonovault-api'
import { SpotifyTrackEntriesPageSchema } from '@/lib/spotify-api'
import { db } from '@/lib/db'
import {
  playlist,
  providerResponse,
  scrapeJob,
  sonovaultTrackCandidate,
  sonovaultTrackLookup,
  spotifyPlaylistListing,
} from '@/schemas/db'
import { observeCatalogOccurrence } from './catalog-discoveries'
import { observeSonovaultTrack } from './sonovault-catalog-observations'
import {
  observeSpotifyPlaylistPage,
  spotifyPlaylistOccurrences,
} from './spotify-playlists'
import { observeSpotifyPlaylists } from './spotify-playlist-listing'
import { ListedPlaylistSchema } from './spotify-playlist-state'
import { backfillSpotifyTrackDiscoveries } from './spotify-track-search'
import { backfillTidalSimilarDiscoveries } from './tidal-similar'

type Batch = { apply: boolean; limit: number; after?: string }

async function backfillSpotifyPlaylists({ apply, limit, after }: Batch) {
  const rows = await db
    .select()
    .from(spotifyPlaylistListing)
    .where(after ? gt(spotifyPlaylistListing.userId, after) : undefined)
    .orderBy(asc(spotifyPlaylistListing.userId))
    .limit(limit)
  let candidates = 0
  let skipped = 0
  for (const row of rows) {
    const summaries = row.playlists.flatMap((item, index) => {
      const summary = ListedPlaylistSchema.safeParse(item)
      if (!summary.success) {
        skipped += 1
        return []
      }
      return [{ summary: summary.data, position: index + 1 }]
    })
    candidates += summaries.length
    if (apply)
      for (let start = 0; start < summaries.length; start += 100)
        await observeSpotifyPlaylists(summaries.slice(start, start + 100), {
          observedAt: row.listedAt,
        })
  }
  return { next: rows.at(-1)?.userId ?? null, candidates, skipped }
}

function capturedJson(body: { state: string; text?: string }): unknown {
  if (body.state !== 'captured' || !body.text) return null
  try {
    return JSON.parse(body.text)
  } catch {
    return null
  }
}

/** Recovery from retained playlist pages. Private account endpoints have no eligible body. */
async function backfillSpotifyPlaylistPages({ apply, limit, after }: Batch) {
  const jobs = await db
    .select({ id: scrapeJob.id, finishedAt: scrapeJob.finishedAt })
    .from(scrapeJob)
    .where(
      and(
        eq(scrapeJob.provider, 'spotify'),
        sql`(${scrapeJob.options}->>'task') = ${SPOTIFY_PLAYLIST_IMPORT_TASK}`,
        after ? gt(scrapeJob.id, after) : undefined,
      ),
    )
    .orderBy(asc(scrapeJob.id))
    .limit(limit)
  let candidates = 0
  let skipped = 0
  for (const job of jobs) {
    const responses = await db
      .select()
      .from(providerResponse)
      .where(
        and(
          eq(providerResponse.jobId, job.id),
          eq(providerResponse.provider, 'spotify'),
          eq(providerResponse.method, 'GET'),
          eq(providerResponse.status, 200),
          eq(providerResponse.bodyState, 'captured'),
        ),
      )
      .orderBy(asc(providerResponse.attempt), asc(providerResponse.ordinal))
    const attempts = new Map<number, typeof responses>()
    for (const response of responses) {
      const attempt = attempts.get(response.attempt) ?? []
      attempt.push(response)
      attempts.set(response.attempt, attempt)
    }
    for (const [attempt, responses] of attempts) {
      const metadata = responses.find(({ requestUrl }) =>
        Boolean(
          requestUrl?.match(
            /^https:\/\/api\.spotify\.com\/v1\/playlists\/[A-Za-z0-9]{22}$/,
          ),
        ),
      )
      const spotifyId = metadata?.requestUrl?.split('/').at(-1)
      if (!spotifyId || !metadata) continue
      const [stored] = await db
        .select({ id: playlist.id, snapshot: playlist.snapshotId })
        .from(playlist)
        .where(eq(playlist.spotifyId, spotifyId))
      if (!stored) {
        skipped += 1
        continue
      }
      const detail = PlaylistSnapshotSchema.safeParse(
        capturedJson(metadata.body),
      )
      const snapshot = detail.data?.snapshot_id ?? null
      const pages = responses.flatMap((response) => {
        if (response.requestUrl !== `${metadata.requestUrl}/items`) return []
        const page = SpotifyTrackEntriesPageSchema.safeParse(
          capturedJson(response.body),
        )
        return page.success ? [{ id: response.id, ...page.data }] : []
      })
      let offset = 0
      const total = pages[0]?.total
      const complete = Boolean(
        snapshot &&
        snapshot === stored.snapshot &&
        total !== undefined &&
        pages.every((page) => {
          if (offset !== page.offset || total !== page.total) return false
          offset += page.items.length
          return true
        }) &&
        offset === total &&
        pages.at(-1)?.next === null,
      )
      for (const [index, page] of pages.entries()) {
        const entries = spotifyPlaylistOccurrences(page.items, page.offset)
        candidates += entries.length
        if (apply)
          await db.transaction((tx) =>
            observeSpotifyPlaylistPage(
              tx,
              stored.id,
              {
                entries,
                page: index + 1,
                total: page.total,
                responseId: page.id,
              },
              {
                jobId: job.id,
                snapshot,
                observedAt: job.finishedAt ?? undefined,
                complete,
              },
            ),
          )
      }
      if (apply && complete)
        await db.transaction((tx) =>
          observeCatalogOccurrence(
            tx,
            { kind: 'playlist', id: stored.id },
            {
              provider: 'spotify',
              operation: 'playlist-contents',
              occurrenceKey: `${job.id}:${attempt}`,
              jobId: job.id,
              observedAt: job.finishedAt ?? undefined,
              details: {
                snapshot,
                version: job.id,
                complete: true,
                total: total ?? 0,
              },
            },
          ),
        )
    }
  }
  return { next: jobs.at(-1)?.id ?? null, candidates, skipped }
}

const PlaylistSnapshotSchema = z.object({ snapshot_id: z.string().optional() })

async function backfillSonovaultLookups({ apply, limit, after }: Batch) {
  const rows = await db
    .select()
    .from(sonovaultTrackLookup)
    .where(after ? gt(sonovaultTrackLookup.mediaItemId, after) : undefined)
    .orderBy(asc(sonovaultTrackLookup.mediaItemId))
    .limit(limit)
  let candidates = 0
  let skipped = 0
  for (const row of rows) {
    const record = SonovaultStoredRecordSchema.safeParse(row.record)
    if (!record.success) {
      skipped += 1
      continue
    }
    candidates += 1
    if (apply)
      await db.transaction((tx) =>
        observeSonovaultTrack(
          tx,
          record.data.track,
          record.data.kind === 'resolve' ? record.data.links : [],
          {
            operation: 'sonovault-track-lookup',
            occurrenceKey: row.scrapeJobId ?? row.mediaItemId,
            subjectKind: 'track',
            subjectId: row.mediaItemId,
            jobId: row.scrapeJobId ?? undefined,
            responseId: row.responseId ?? undefined,
            observedAt: row.lookedUpAt,
          },
        ),
      )
  }
  return { next: rows.at(-1)?.mediaItemId ?? null, candidates, skipped }
}

async function backfillSonovaultCandidates({ apply, limit, after }: Batch) {
  const key = sql<string>`concat(${sonovaultTrackCandidate.mediaItemId}, '/', ${sonovaultTrackCandidate.sonovaultTrackId})`
  const rows = await db
    .select({ key, candidate: sonovaultTrackCandidate })
    .from(sonovaultTrackCandidate)
    .where(after ? sql`${key} > ${after}` : undefined)
    .orderBy(asc(key))
    .limit(limit)
  let candidates = 0
  let skipped = 0
  for (const { candidate: row } of rows) {
    const parsed = SonovaultResolveResultSchema.safeParse(row.result)
    const record = parsed.data?.track
    if (!parsed.success || !record) {
      skipped += 1
      continue
    }
    candidates += 1
    if (apply)
      await db.transaction((tx) =>
        observeSonovaultTrack(tx, record, parsed.data.links, {
          operation: 'sonovault-track-match',
          occurrenceKey: row.scrapeJobId ?? row.sonovaultTrackId,
          subjectKind: 'track',
          subjectId: row.mediaItemId,
          jobId: row.scrapeJobId ?? undefined,
          responseId: row.responseId ?? undefined,
          observedAt: row.foundAt,
        }),
      )
  }
  return { next: rows.at(-1)?.key ?? null, candidates, skipped }
}

export async function backfillMusicCatalog(apply = false) {
  const result: Record<string, { candidates: number; skipped: number }> = {}
  const families = {
    spotifyTrackMatches: backfillSpotifyTrackDiscoveries,
    tidalSimilar: backfillTidalSimilarDiscoveries,
    spotifyPlaylistListings: backfillSpotifyPlaylists,
    spotifyPlaylistPages: backfillSpotifyPlaylistPages,
    sonovaultLookups: backfillSonovaultLookups,
    sonovaultCandidates: backfillSonovaultCandidates,
  }
  for (const [family, backfill] of Object.entries(families)) {
    const counts = { candidates: 0, skipped: 0 }
    let after: string | undefined
    for (;;) {
      const page = await backfill({ apply, limit: 100, after })
      counts.candidates += page.candidates
      counts.skipped += page.skipped
      if (!page.next) break
      after = page.next
    }
    result[family] = counts
  }
  return { apply, ...result }
}
