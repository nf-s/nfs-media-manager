import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { ProviderRequestError } from '@repo/media-plugin-sdk'
import {
  MixIdSchema,
  MixShowIdSchema,
  type MixStation,
  type SubscriptionSyncSchedule,
  type SubscriptionSyncStatus,
} from '@repo/schemas/subscriptions'
import { db } from '@/lib/db'
import { ServerError } from '@/lib/error'
import type {
  MixStationAdapter,
  StationEpisode,
  StationRequest,
  StationShow,
} from '@/lib/mix-station'
import { mixStationAdapters } from '@/lib/mix-stations'
import { mixStationPlugins } from '@/plugins/builtin/mix-stations'
import {
  subscriptionItem,
  subscriptionSource,
  subscriptionSync,
} from '@/schemas/db'
import type {
  LastfmSyncJobContext,
  LastfmSyncJobResult,
} from './lastfm-scrobbles'
import {
  createProviderRequest,
  recordProviderFailure,
  recordProviderSuccess,
} from './provider-requests'
import { subscriptionSearchVector } from './subscription-library'
import {
  dueSubscriptionSyncUsers,
  readSubscriptionSyncStatus,
  saveSubscriptionSyncSchedule,
  subscriptionSyncRun,
} from './subscription-sync-state'

// The same limits as the YouTube and Spotify podcast syncs: one job stays well
// inside a Cloudflare Queue invocation; a longer sync continues in a follow-on job.
const CHUNK_STEPS = 300
const CHUNK_BUDGET_MS = 8 * 60 * 1000
const LOG_EVERY_SHOWS = 25
const LOG_EVERY_PAGES = 25
// When a rate limit carries no retry time.
const DEFAULT_PAUSE_MS = 60 * 60 * 1000

type SyncRow = typeof subscriptionSync.$inferSelect
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Catalogue = NonNullable<MixStationAdapter['catalogue']>

// Sources, items and checkpoints of one station; every other type shares the
// tables and is never read or changed here.
const stationRun = (station: MixStation, userId: string) =>
  subscriptionSyncRun(userId, station)

const stationName = (station: MixStation) =>
  mixStationPlugins[station].manifest.displayName

// A station's identifiers carry its own prefix; anything else is invalid data.
const stationId = (schema: z.ZodString, station: MixStation) =>
  schema.refine((id) => id.startsWith(`${station}.`))

/** The adapter's shows, one per ID, after checking each belongs to the station. */
function distinctShows(station: MixStation, shows: StationShow[]) {
  const ShowId = stationId(MixShowIdSchema, station)
  const byId = new Map<string, StationShow>()
  for (const show of shows)
    if (!byId.has(ShowId.parse(show.id))) byId.set(show.id, show)
  return byId
}

/** The text a mix is found by besides its title, show and description. */
const namesText = (episode: StationEpisode) =>
  [...episode.tags, ...episode.artists].join(' ')

/** The mix sync state in the shape every subscription provider shares. */
export function getMixStationSyncStatus(
  station: MixStation,
  userId: string,
): Promise<SubscriptionSyncStatus> {
  // A station needs no account or credentials.
  return readSubscriptionSyncStatus(station, userId, {
    configured: true,
    connected: true,
    redirectUri: null,
  })
}

export async function setMixStationSyncSchedule(
  station: MixStation,
  userId: string,
  schedule: SubscriptionSyncSchedule,
) {
  await saveSubscriptionSyncSchedule(station, userId, schedule)
  return getMixStationSyncStatus(station, userId)
}

/**
 * Opens a run for a sync job to work on. A completed station gets a new run;
 * an unfinished or paused run keeps its checkpoint so it resumes in place. The
 * last completion time is kept: a feed run reads back to it.
 */
export async function prepareMixStationSyncRun(
  station: MixStation,
  userId: string | null,
) {
  if (userId === null)
    throw new ServerError({
      statusCode: 422,
      message: 'Sign in as the owner before syncing mixes.',
    })
  const fresh = {
    status: 'running',
    runId: nanoid(),
    phase: 'sources',
    feedTruncated: false,
    pageToken: null,
    sourceCursor: null,
    sourcesDone: 0,
    sourcesTotal: 0,
    newItems: 0,
    resumeAfter: null,
    errorMessage: null,
    startedAt: new Date(),
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(subscriptionSync)
      .values({ userId, provider: station, ...fresh })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(subscriptionSync)
      .where(stationRun(station, userId))
      .for('update')
    if (!row || row.status === 'running') return
    await tx
      .update(subscriptionSync)
      .set(
        row.status === 'complete' || row.status === 'idle'
          ? fresh
          : { status: 'running', resumeAfter: null, errorMessage: null },
      )
      .where(stationRun(station, userId))
  })
}

// Only one sync job per station is active at a time, so the newest job takes
// the run. The token fences a cancelled job that is still finishing a request.
async function claim(station: MixStation, token: string) {
  const [open] = await db
    .select({ userId: subscriptionSync.userId })
    .from(subscriptionSync)
    .where(
      and(
        eq(subscriptionSync.provider, station),
        eq(subscriptionSync.status, 'running'),
      ),
    )
    .orderBy(asc(subscriptionSync.startedAt), asc(subscriptionSync.userId))
    .limit(1)
  if (!open) return null
  const [row] = await db
    .update(subscriptionSync)
    .set({ leaseToken: token })
    .where(
      and(
        stationRun(station, open.userId),
        eq(subscriptionSync.status, 'running'),
      ),
    )
    .returning()
  return row ?? null
}

/** Locks the run and confirms this job still owns the step it fetched. */
async function ownedRun(
  tx: Transaction,
  station: MixStation,
  token: string,
  run: SyncRow,
) {
  const [current] = await tx
    .select()
    .from(subscriptionSync)
    .where(stationRun(station, run.userId))
    .for('update')
  return current &&
    current.status === 'running' &&
    current.leaseToken === token &&
    current.runId === run.runId &&
    current.historyComplete === run.historyComplete &&
    current.phase === run.phase &&
    current.pageToken === run.pageToken &&
    current.sourceCursor === run.sourceCursor
    ? current
    : null
}

/** Marks the run complete in the step's transaction. */
async function completeRun(
  tx: Transaction,
  station: MixStation,
  run: SyncRow,
  changes: Partial<typeof subscriptionSync.$inferInsert>,
) {
  await tx
    .update(subscriptionSync)
    .set({
      ...changes,
      status: 'complete',
      completedAt: new Date(),
      pageToken: null,
      leaseToken: null,
    })
    .where(stationRun(station, run.userId))
}

/**
 * Stores shows with every detail the station gave. A renamed show's mixes get
 * new search text, since the show name is part of it.
 */
async function upsertShows(
  tx: Transaction,
  station: MixStation,
  run: SyncRow,
  shows: StationShow[],
) {
  if (!shows.length) return
  const byId = new Map(shows.map((show) => [show.id, show]))
  const renamed = (
    await tx
      .select({ id: subscriptionSource.id, title: subscriptionSource.title })
      .from(subscriptionSource)
      .where(
        and(
          eq(subscriptionSource.type, station),
          inArray(subscriptionSource.id, [...byId.keys()]),
        ),
      )
  ).flatMap((existing) => {
    const show = byId.get(existing.id)
    return show && show.title !== existing.title ? [show] : []
  })
  await tx
    .insert(subscriptionSource)
    .values(
      shows.map((show) => ({
        id: show.id,
        type: station,
        title: show.title,
        handle: show.handle,
        description: show.description,
        thumbnailUrl: show.thumbnailUrl,
        url: show.url,
        itemTotal: show.itemTotal,
        subscribed: true,
        seenRunId: run.runId,
      })),
    )
    .onConflictDoUpdate({
      target: subscriptionSource.id,
      set: {
        title: sql`excluded.title`,
        handle: sql`excluded.handle`,
        description: sql`excluded.description`,
        thumbnailUrl: sql`excluded.thumbnail_url`,
        url: sql`excluded.url`,
        // A listing without a count keeps the count of the show's last read.
        itemTotal: sql`coalesce(excluded.item_total, ${subscriptionSource.itemTotal})`,
        subscribed: true,
        seenRunId: run.runId,
        updatedAt: new Date(),
      },
      setWhere: eq(subscriptionSource.type, station),
    })
  for (const show of renamed)
    await tx
      .update(subscriptionItem)
      .set({
        search: subscriptionSearchVector(
          sql`${subscriptionItem.title}`,
          sql`${show.title}::text`,
          sql`(select coalesce(string_agg(name, ' '), '')
            from jsonb_array_elements_text(${subscriptionItem.tags} || ${subscriptionItem.artists}) name)`,
          sql`${subscriptionItem.description}`,
        ),
      })
      .where(
        and(
          eq(subscriptionItem.sourceId, show.id),
          eq(subscriptionItem.type, station),
        ),
      )
}

/**
 * Stores mixes with their show's name in the search text and returns how
 * many were not stored before. The owner's listened date is never changed.
 */
async function upsertEpisodes(
  tx: Transaction,
  station: MixStation,
  episodes: { show: { id: string; title: string }; episode: StationEpisode }[],
) {
  if (!episodes.length) return { added: 0, known: 0 }
  const ids = episodes.map(({ episode }) => episode.id)
  const known = await tx
    .select({ id: subscriptionItem.id })
    .from(subscriptionItem)
    .where(
      and(
        eq(subscriptionItem.type, station),
        inArray(subscriptionItem.id, ids),
      ),
    )
  await tx
    .insert(subscriptionItem)
    .values(
      episodes.map(({ show, episode }) => ({
        id: episode.id,
        sourceId: show.id,
        type: station,
        title: episode.title,
        description: episode.description,
        tags: episode.tags,
        artists: episode.artists,
        url: episode.url,
        audioUrl: episode.audioUrl,
        artworkUrl: episode.artworkUrl,
        publishedAt: episode.publishedAt,
        publishedPrecision: 'time',
        durationSec: episode.durationSec ?? 0,
        live: 'none',
        search: subscriptionSearchVector(
          sql`${episode.title}::text`,
          sql`${show.title}::text`,
          sql`${namesText(episode)}::text`,
          sql`${episode.description}::text`,
        ),
      })),
    )
    .onConflictDoUpdate({
      target: subscriptionItem.id,
      set: {
        sourceId: sql`excluded.source_id`,
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        tags: sql`excluded.tags`,
        artists: sql`excluded.artists`,
        url: sql`excluded.url`,
        audioUrl: sql`excluded.audio_url`,
        artworkUrl: sql`excluded.artwork_url`,
        publishedAt: sql`excluded.published_at`,
        publishedPrecision: sql`excluded.published_precision`,
        durationSec: sql`excluded.duration_sec`,
        live: sql`excluded.live`,
        search: sql`excluded.search`,
        updatedAt: new Date(),
      },
      setWhere: eq(subscriptionItem.type, station),
    })
  return { added: ids.length - known.length, known: known.length }
}

/** The adapter's mixes, one per ID, after checking each belongs to the station. */
function distinctEpisodes<T extends { episode: StationEpisode }>(
  station: MixStation,
  entries: T[],
) {
  const EpisodeId = stationId(MixIdSchema, station)
  const byId = new Map<string, T>()
  for (const entry of entries)
    if (!byId.has(EpisodeId.parse(entry.episode.id)))
      byId.set(entry.episode.id, entry)
  return [...byId.values()]
}

/**
 * Reads one page of the station's show catalogue. After the last page the run
 * reads each show's mixes. A show the catalogue no longer lists keeps its
 * mixes and stays in the library: station archives are kept.
 */
async function syncShowsPage(
  station: MixStation,
  catalogue: Catalogue,
  request: StationRequest,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const page = await catalogue.listShows(request, run.pageToken)
  // A page that arrives after cancellation is discarded.
  if (!(await context.isActive())) return 'lost'
  const shows = distinctShows(station, page.entries)
  return db.transaction(async (tx) => {
    if (!(await ownedRun(tx, station, token, run))) return 'lost'
    await upsertShows(tx, station, run, [...shows.values()])
    if (page.next !== null) {
      const listed = await tx.$count(
        subscriptionSource,
        and(
          eq(subscriptionSource.type, station),
          run.runId === null
            ? sql`false`
            : eq(subscriptionSource.seenRunId, run.runId),
        ),
      )
      await tx
        .update(subscriptionSync)
        .set({ pageToken: page.next, sourcesTotal: listed })
        .where(stationRun(station, run.userId))
      return 'more'
    }
    const total = await tx.$count(
      subscriptionSource,
      and(
        eq(subscriptionSource.type, station),
        isNotNull(subscriptionSource.handle),
      ),
    )
    await tx
      .update(subscriptionSync)
      .set({
        phase: 'items',
        pageToken: null,
        sourceCursor: null,
        sourcesDone: 0,
        sourcesTotal: total,
      })
      .where(stationRun(station, run.userId))
    return 'more'
  })
}

/** The next stored show of the station after the cursor, in ID order. */
async function nextShow(station: MixStation, run: SyncRow) {
  const [show] = await db
    .select({
      id: subscriptionSource.id,
      title: subscriptionSource.title,
      handle: subscriptionSource.handle,
      historyComplete: subscriptionSource.historyComplete,
    })
    .from(subscriptionSource)
    .where(
      and(
        eq(subscriptionSource.type, station),
        // Every station show is stored with the handle its pages are read by.
        isNotNull(subscriptionSource.handle),
        run.sourceCursor === null
          ? undefined
          : gt(subscriptionSource.id, run.sourceCursor),
      ),
    )
    .orderBy(asc(subscriptionSource.id))
    .limit(1)
  return show && show.handle !== null ? { ...show, handle: show.handle } : null
}

/**
 * Reads one page of the next show's mixes. A show whose history is not stored
 * is read to its last page; one whose history is stored stops at the first page
 * that holds a stored mix. After the last show the station's history is
 * complete and the run ends.
 */
async function syncShowEpisodesPage(
  station: MixStation,
  catalogue: Catalogue,
  request: StationRequest,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const show = await nextShow(station, run)
  if (!show)
    return db.transaction(async (tx) => {
      if (!(await ownedRun(tx, station, token, run))) return 'lost'
      await completeRun(tx, station, run, { historyComplete: true })
      return 'fetched-all'
    })
  const page = await catalogue.listShowEpisodes(
    request,
    { id: show.id, handle: show.handle },
    run.pageToken,
  )
  if (!(await context.isActive())) return 'lost'
  const episodes = distinctEpisodes(
    station,
    page.entries.map((episode) => ({ show, episode })),
  )
  return db.transaction(async (tx) => {
    const current = await ownedRun(tx, station, token, run)
    if (!current) return 'lost'
    const { added, known } = await upsertEpisodes(tx, station, episodes)
    const stop = show.historyComplete && known > 0
    if (page.next !== null && !stop) {
      await tx
        .update(subscriptionSync)
        .set({ pageToken: page.next, newItems: current.newItems + added })
        .where(stationRun(station, run.userId))
      return 'more'
    }
    await tx
      .update(subscriptionSource)
      .set({
        historyComplete: true,
        ...(page.total === null ? {} : { itemTotal: page.total }),
      })
      .where(
        and(
          eq(subscriptionSource.id, show.id),
          eq(subscriptionSource.type, station),
        ),
      )
    await tx
      .update(subscriptionSync)
      .set({
        pageToken: null,
        sourceCursor: show.id,
        sourcesDone: current.sourcesDone + 1,
        newItems: current.newItems + added,
      })
      .where(stationRun(station, run.userId))
    return 'show-done'
  })
}

/**
 * The shows of a feed page to store. A show the feed names in full is stored
 * as given. One it names only partially is left as it is when stored; a new
 * one is read with `getShow`, or stored from the partial details without it.
 */
async function feedShows(
  station: MixStation,
  adapter: MixStationAdapter,
  request: StationRequest,
  entries: { show: StationShow; showPartial: boolean }[],
) {
  const full = distinctShows(
    station,
    entries.filter((entry) => !entry.showPartial).map((entry) => entry.show),
  )
  const partial = distinctShows(
    station,
    entries
      .filter((entry) => entry.showPartial && !full.has(entry.show.id))
      .map((entry) => entry.show),
  )
  if (!partial.size) return [...full.values()]
  const stored = new Set(
    (
      await db
        .select({ id: subscriptionSource.id })
        .from(subscriptionSource)
        .where(
          and(
            eq(subscriptionSource.type, station),
            inArray(subscriptionSource.id, [...partial.keys()]),
          ),
        )
    ).map((row) => row.id),
  )
  const shows = [...full.values()]
  for (const show of partial.values()) {
    if (stored.has(show.id)) continue
    const details = adapter.getShow
      ? await adapter.getShow(request, show.handle)
      : null
    if (details && details.id !== show.id)
      throw new Error(`${stationName(station)} returned a different show.`)
    shows.push(details ?? show)
  }
  return shows
}

/**
 * Reads one page of the station-wide feed: the whole archive while the
 * station's history is not stored, otherwise the additions since the last
 * completed run. A run that read a truncated page and can read the catalogue
 * clears the station's history, so the next run reads every show again.
 */
async function syncFeedPage(
  station: MixStation,
  adapter: MixStationAdapter,
  request: StationRequest,
  token: string,
  run: SyncRow,
  context: LastfmSyncJobContext,
) {
  const mode = run.historyComplete ? 'recent' : 'archive'
  const page = await adapter.listFeed(
    request,
    mode,
    run.pageToken,
    run.completedAt,
  )
  if (!(await context.isActive())) return 'lost'
  const shows = await feedShows(station, adapter, request, page.entries)
  if (!(await context.isActive())) return 'lost'
  const episodes = distinctEpisodes(station, page.entries)
  // A run continued by a later job still knows an earlier page was truncated.
  const truncated = run.feedTruncated || page.truncated
  const step = await db.transaction(async (tx) => {
    const current = await ownedRun(tx, station, token, run)
    if (!current) return 'lost'
    await upsertShows(tx, station, run, shows)
    const titles = new Map(
      (
        await tx
          .select({
            id: subscriptionSource.id,
            title: subscriptionSource.title,
          })
          .from(subscriptionSource)
          .where(
            and(
              eq(subscriptionSource.type, station),
              inArray(subscriptionSource.id, [
                ...new Set(episodes.map((entry) => entry.show.id)),
              ]),
            ),
          )
      ).map((row) => [row.id, row.title]),
    )
    const { added } = await upsertEpisodes(
      tx,
      station,
      episodes.map((entry) => ({
        show: {
          id: entry.show.id,
          title: titles.get(entry.show.id) ?? entry.show.title,
        },
        episode: entry.episode,
      })),
    )
    // A feed has no show total: the run counts the pages it has read.
    const progress = {
      phase: 'items',
      feedTruncated: truncated,
      sourcesDone: current.sourcesDone + 1,
      sourcesTotal: 0,
      newItems: current.newItems + added,
    }
    if (page.next !== null) {
      await tx
        .update(subscriptionSync)
        .set({ ...progress, pageToken: page.next })
        .where(stationRun(station, run.userId))
      return 'more'
    }
    await completeRun(tx, station, run, {
      ...progress,
      historyComplete:
        mode === 'archive' ||
        (current.historyComplete && !(truncated && adapter.catalogue)),
    })
    return 'fetched-all'
  })
  if (step === 'fetched-all' && truncated && adapter.catalogue)
    await context.log(
      'warn',
      'The feed ended before the last completed sync, so some mixes may be missing. The next sync reads every show again.',
    )
  return step
}

type ChunkOptions = {
  maxSteps?: number
  budgetMs?: number
  /** Reads the station through this adapter instead of the station's own. */
  adapter?: MixStationAdapter
}

/**
 * One sync job: reads pages from the saved checkpoint until the run completes
 * or the chunk limit is reached. A station with a catalogue is read show by
 * show until its history is stored, and from its feed afterwards; a station
 * without one is read from its feed. `continue` asks the job system to queue a
 * follow-on job. A rate limit or cooldown pauses the run for the schedule to
 * resume; any other failure ends the job.
 */
export async function runMixStationSyncJob(
  station: MixStation,
  context: LastfmSyncJobContext,
  options: ChunkOptions = {},
): Promise<LastfmSyncJobResult> {
  const adapter = options.adapter ?? mixStationAdapters[station]
  const plugin = mixStationPlugins[station]
  const maxSteps = options.maxSteps ?? CHUNK_STEPS
  const deadline = Date.now() + (options.budgetMs ?? CHUNK_BUDGET_MS)
  const token = randomUUID()
  const owned = and(
    eq(subscriptionSync.provider, station),
    eq(subscriptionSync.status, 'running'),
    eq(subscriptionSync.leaseToken, token),
  )
  let steps = 0
  try {
    const request = createProviderRequest(plugin, context.assertActive)
    for (;;) {
      if (!(await context.isActive())) return { outcome: 'stopped' }
      const run = await claim(station, token)
      if (!run) return { outcome: 'complete', message: 'No sync run was open.' }
      const catalogue = run.historyComplete ? null : adapter.catalogue
      const step = !catalogue
        ? await syncFeedPage(station, adapter, request, token, run, context)
        : run.phase === 'items'
          ? await syncShowEpisodesPage(
              station,
              catalogue,
              request,
              token,
              run,
              context,
            )
          : await syncShowsPage(
              station,
              catalogue,
              request,
              token,
              run,
              context,
            )
      if (step === 'lost') return { outcome: 'stopped' }
      if (step === 'fetched-all') {
        await recordProviderSuccess(station)
        const status = await getMixStationSyncStatus(station, run.userId)
        return {
          outcome: 'complete',
          message: `Sync complete. ${status.newItems} new mixes; ${status.storedItems} mixes from ${status.storedSources} shows are stored.`,
        }
      }
      steps += 1
      const done = run.sourcesDone + 1
      if (catalogue && step === 'show-done' && done % LOG_EVERY_SHOWS === 0)
        await context.log('info', `Read ${done} of ${run.sourcesTotal} shows.`)
      if (!catalogue && done % LOG_EVERY_PAGES === 0)
        await context.log('info', `Read ${done} pages of mixes.`)
      if (steps >= maxSteps || Date.now() >= deadline) {
        await recordProviderSuccess(station)
        return {
          outcome: 'continue',
          message: !catalogue
            ? `Read ${done} pages of mixes. The next job continues.`
            : run.phase === 'items'
              ? `Read ${step === 'show-done' ? done : run.sourcesDone} of ${run.sourcesTotal} shows. The next job continues.`
              : 'Reading the shows. The next job continues.',
        }
      }
    }
  } catch (error) {
    // A cancelled job's request rejects before it is sent; that is not a provider failure.
    if (!(await context.isActive())) return { outcome: 'stopped' }
    if (
      error instanceof ProviderRequestError &&
      (error.code === 'rate-limit' || error.code === 'cooldown')
    ) {
      const resumeAfter = new Date(
        error.retryAt ?? Date.now() + DEFAULT_PAUSE_MS,
      )
      await db
        .update(subscriptionSync)
        .set({ status: 'paused', resumeAfter, leaseToken: null })
        .where(owned)
      return {
        outcome: 'complete',
        message: `Paused: ${error.message.replace(/\.$/, '')}. Stored mixes are kept; the schedule resumes the sync after ${resumeAfter.toISOString()}.`,
      }
    }
    if (!(error instanceof ServerError))
      await recordProviderFailure(plugin, error)
    await db
      .update(subscriptionSync)
      .set({
        status: 'failed',
        errorMessage:
          error instanceof ProviderRequestError || error instanceof ServerError
            ? error.message
            : `${stationName(station)} sync failed or returned invalid data. No further requests were made.`,
        leaseToken: null,
      })
      .where(owned)
    return { outcome: 'failed', error }
  }
}

/** Accounts whose schedule is due, or whose rate-limit pause has passed. */
export function dueMixStationSyncUsers(
  station: MixStation,
  now: number,
): Promise<string[]> {
  return dueSubscriptionSyncUsers(station, now, (userId) =>
    getMixStationSyncStatus(station, userId),
  )
}
