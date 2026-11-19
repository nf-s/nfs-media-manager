import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { ProviderOverviewSchema } from '@repo/schemas/provider'
import type { MixStation } from '@repo/schemas/subscriptions'
import { env } from '@/env'
import type {
  MixStationAdapter,
  StationEpisode,
  StationRequest,
  StationShow,
} from '@/lib/mix-station'
import * as schema from '@/schemas/db'
import type { LastfmSyncJobContext } from '@/services/lastfm-scrobbles'
import { subscriptionSearchVector } from '@/services/subscription-library'

const database = `mix_station_sync_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const request = vi.fn<typeof fetch>()
const USER = 'owner-fixture'

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
// No request spacing, so the fixture stations answer immediately.
vi.mock('@/plugins/builtin/mix-stations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/plugins/builtin/mix-stations')>()
  const fast = (plugin: typeof actual.rinsePlugin) => ({
    ...plugin,
    manifest: {
      ...plugin.manifest,
      rateLimit: { ...plugin.manifest.rateLimit, minTimeMs: 0 },
    },
  })
  const rinsePlugin = fast(actual.rinsePlugin)
  const ntsPlugin = fast(actual.ntsPlugin)
  const lotRadioPlugin = fast(actual.lotRadioPlugin)
  return {
    rinsePlugin,
    ntsPlugin,
    lotRadioPlugin,
    mixStationPlugins: {
      rinse: rinsePlugin,
      nts: ntsPlugin,
      lotradio: lotRadioPlugin,
    },
  }
})
vi.mock('@/plugins/registry', async () => {
  const { mixStationPlugins } = await import('@/plugins/builtin/mix-stations')
  const { getBuiltinProviderCatalog } = await import('@/lib/provider-catalog')
  const plugins = new Map(
    Object.values(mixStationPlugins).map((plugin) => [
      plugin.manifest.id,
      plugin,
    ]),
  )
  return {
    getScrapePlugin: async (id: string) => plugins.get(id) ?? null,
    listLoadedScrapePlugins: async () => [],
    listProviderCatalog: async () => getBuiltinProviderCatalog(),
  }
})
// The stations are read through fake adapters that request the fixture hosts
// through the real request gate.
const useRealStationAdapters = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/lib/mix-stations', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/mix-stations')>()
  return {
    get mixStationAdapters() {
      return useRealStationAdapters.enabled ? real.mixStationAdapters : adapters
    },
  }
})
// Two steps per job, so longer syncs chain follow-on jobs.
vi.mock('@/services/mix-station-sync', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/mix-station-sync')>()
  return {
    ...actual,
    runMixStationSyncJob: (
      station: MixStation,
      context: LastfmSyncJobContext,
    ) =>
      actual.runMixStationSyncJob(station, context, {
        maxSteps: 2,
        adapter: useRealStationAdapters.enabled ? undefined : adapters[station],
      }),
  }
})

type FakeShow = {
  key: string
  title: string
  /** The catalogue lists the show. */
  listed: boolean
  /** The feed names the show only partially, with this title. */
  partialTitle: string | null
  /** `getShow` finds the show. */
  resolvable: boolean
}
type FakeMix = {
  key: string
  show: string
  title: string
  date: string
  artists: string[]
  tags: string[]
  durationSec: number | null
  /** When the mix appeared; the recent feed lists those added since the last run. */
  addedAt: number
}

const show = (key: string, title: string, extra: Partial<FakeShow> = {}) => ({
  key,
  title,
  listed: true,
  partialTitle: null,
  resolvable: true,
  ...extra,
})
const mix = (
  key: string,
  showKey: string,
  title: string,
  date: string,
  extra: Partial<FakeMix> = {},
): FakeMix => ({
  key,
  show: showKey,
  title,
  date,
  artists: [],
  tags: [],
  durationSec: 3600,
  addedAt: 0,
  ...extra,
})

function rinseLibrary() {
  return {
    shows: [
      show('basement', 'Basement Hours'),
      show('dawn', 'Dawn Chorus', { partialTitle: 'DAWN' }),
      show('tidal', 'Tidal Rhythms'),
    ],
    mixes: [
      mix('b3', 'basement', 'Kora B2B Lumen', '2026-03-03', {
        artists: ['Kora', 'Lumen'],
        tags: ['Techno'],
        durationSec: 7200,
      }),
      mix('b2', 'basement', 'Late set', '2026-02-03', { durationSec: null }),
      mix('b1', 'basement', 'Pilot session', '2026-01-03'),
      mix('d1', 'dawn', 'Field recordings', '2026-02-10', {
        artists: ['Sora Vale'],
        tags: ['Ambient'],
      }),
      mix('t2', 'tidal', 'Low tide', '2026-03-20'),
      mix('t1', 'tidal', 'High tide', '2026-01-20'),
    ],
  }
}

function lotRadioLibrary() {
  return {
    shows: [
      show('corner', 'Corner Booth'),
      show('rooftop', 'Rooftop Sessions'),
    ],
    mixes: [
      mix('c2', 'corner', 'Corner Booth with Ines', '2026-05-02'),
      mix('c1', 'corner', 'Corner Booth with Theo', '2026-04-02'),
      mix('r1', 'rooftop', 'Rooftop with Mara', '2026-04-20'),
    ],
  }
}

const fixtures: Record<MixStation, { shows: FakeShow[]; mixes: FakeMix[] }> = {
  rinse: rinseLibrary(),
  nts: { shows: [], mixes: [] },
  lotradio: lotRadioLibrary(),
}

const idle: (count: number) => Promise<void> = async () => {}

const api: {
  /** The recent feed ends before reaching `since`. */
  truncate: boolean
  /** Returns a mix with another station's identifier. */
  foreignId: boolean
  /**
   * The catalogue names its shows by handle alone; a show's first page of
   * mixes carries its details.
   */
  partialCatalogue: boolean
  /** Answers this numbered request with `failStatus`; a 429 carries Retry-After. */
  failAt: number
  failStatus: number
  requests: number
  before: typeof idle
  /** The `since` of each feed read. */
  since: Array<Date | null>
} = {
  truncate: false,
  foreignId: false,
  partialCatalogue: false,
  failAt: 0,
  failStatus: 500,
  requests: 0,
  before: idle,
  since: [],
}

// The fixture adapters page by two.
const PAGE = 2

function paged<T>(entries: T[], page: string | null) {
  const start = Number(page ?? 0)
  const next = start + PAGE
  return {
    entries: entries.slice(start, next),
    next: next < entries.length ? String(next) : null,
    total: entries.length,
  }
}

const newestFirst = (mixes: FakeMix[]) =>
  [...mixes].sort((a, b) => b.date.localeCompare(a.date))

function stationShow(station: MixStation, item: FakeShow): StationShow {
  return {
    id: `${station}.${item.key}`,
    title: item.title,
    handle: item.key,
    description: `About ${item.title}`,
    thumbnailUrl: `https://img.fixture.test/${item.key}.jpg`,
    url: `https://${station}.fixture.test/shows/${item.key}`,
    itemTotal: null,
  }
}

function stationEpisode(station: MixStation, item: FakeMix): StationEpisode {
  return {
    id: `${api.foreignId ? 'nts' : station}.${item.key}`,
    title: item.title,
    description: `Recorded live: ${item.title}`,
    url: `https://${station}.fixture.test/episodes/${item.key}`,
    audioUrl: `https://audio.fixture.test/${item.key}.mp3`,
    artworkUrl: `https://img.fixture.test/${item.key}.jpg`,
    publishedAt: new Date(`${item.date}T20:00:00Z`),
    durationSec: item.durationSec,
    artists: item.artists,
    tags: item.tags,
  }
}

function fakeAdapter(
  station: MixStation,
  features: { catalogue: boolean; getShow: boolean },
): MixStationAdapter {
  const fixture = () => fixtures[station]
  const call = async (
    stationRequest: StationRequest,
    path: string,
    page: string | null,
  ) => {
    await stationRequest(
      `https://${station}.fixture.test/${path}?page=${page ?? 0}`,
    )
  }
  const findShow = (key: string) => {
    const found = fixture().shows.find((item) => item.key === key)
    if (!found) throw new Error('Missing fixture show')
    return found
  }
  return {
    station,
    catalogue: features.catalogue
      ? {
          listShows: async (stationRequest, page) => {
            await call(stationRequest, 'shows', page)
            const listed = paged(
              fixture()
                .shows.filter((item) => item.listed)
                .map((item) => stationShow(station, item)),
              page,
            )
            return api.partialCatalogue
              ? {
                  ...listed,
                  entries: listed.entries.map((entry) => ({
                    ...entry,
                    title: entry.handle,
                    description: null,
                    thumbnailUrl: null,
                  })),
                  partial: true,
                }
              : listed
          },
          listShowEpisodes: async (stationRequest, target, page) => {
            await call(stationRequest, `episodes/${target.handle}`, page)
            const listed = paged(
              newestFirst(
                fixture().mixes.filter((item) => item.show === target.handle),
              ).map((item) => stationEpisode(station, item)),
              page,
            )
            return api.partialCatalogue && page === null
              ? {
                  ...listed,
                  show: stationShow(station, findShow(target.handle)),
                }
              : listed
          },
        }
      : null,
    listFeed: async (stationRequest, mode, page, since) => {
      await call(stationRequest, `feed/${mode}`, page)
      api.since.push(since)
      const listed = paged(
        newestFirst(
          fixture().mixes.filter(
            (item) =>
              mode === 'archive' ||
              (since !== null && item.addedAt >= since.getTime()),
          ),
        ),
        page,
      )
      return {
        next: listed.next,
        total: null,
        truncated: api.truncate && listed.next === null,
        entries: listed.entries.map((item) => {
          const owner = findShow(item.show)
          const full = stationShow(station, owner)
          return {
            show:
              owner.partialTitle === null
                ? full
                : {
                    ...full,
                    title: owner.partialTitle,
                    description: null,
                    thumbnailUrl: null,
                  },
            showPartial: owner.partialTitle !== null,
            episode: stationEpisode(station, item),
          }
        }),
      }
    },
    getShow: features.getShow
      ? async (stationRequest, handle) => {
          await call(stationRequest, `show/${handle}`, null)
          const found = fixture().shows.find((item) => item.key === handle)
          return found?.resolvable ? stationShow(station, found) : null
        }
      : null,
  }
}

const adapters: Record<MixStation, MixStationAdapter> = {
  rinse: fakeAdapter('rinse', { catalogue: true, getShow: true }),
  nts: fakeAdapter('nts', { catalogue: true, getShow: false }),
  lotradio: fakeAdapter('lotradio', { catalogue: false, getShow: false }),
}

async function fakeStation(input: Parameters<typeof fetch>[0]) {
  const url = new URL(String(input))
  if (!url.host.endsWith('.fixture.test')) throw new Error('Unexpected request')
  api.requests += 1
  await api.before(api.requests)
  if (api.requests === api.failAt)
    return api.failStatus === 429
      ? Response.json(
          { error: 'Too many requests' },
          { status: 429, headers: { 'Retry-After': '120' } },
        )
      : Response.json({ error: 'Fixture failure' }, { status: api.failStatus })
  return Response.json({})
}

/** Each station request as `path@page`. */
function calls() {
  return request.mock.calls
    .map(([input]) => new URL(String(input)))
    .map((url) => `${url.pathname.slice(1)}@${url.searchParams.get('page')}`)
}

async function status(station: MixStation = 'rinse') {
  const { getMixStationSyncStatus } =
    await import('@/services/mix-station-sync')
  return getMixStationSyncStatus(station, USER)
}

async function syncJobs() {
  return databaseClient
    .select()
    .from(schema.scrapeJob)
    .orderBy(schema.scrapeJob.createdAt, schema.scrapeJob.id)
}

// Stands in for the job worker's polling loop.
async function drain(station: MixStation = 'rinse') {
  const { processQueuedJobs } = await import('@/services/jobs')
  await vi.waitFor(
    async () => {
      await processQueuedJobs()
      expect((await status(station)).state).not.toBe('running')
    },
    { timeout: 20000, interval: 50 },
  )
  return status(station)
}

async function syncToEnd(station: MixStation = 'rinse') {
  const { queueSubscriptionSync } = await import('@/services/subscription-sync')
  await queueSubscriptionSync(station, USER)
  return drain(station)
}

// Stands in for a cooldown, request backoff or access halt being cleared.
async function clearProviderState() {
  await databaseClient.delete(schema.providerRequestState)
}

async function lastJobLogs() {
  const { getJob } = await import('@/services/jobs')
  const jobs = await syncJobs()
  return (await getJob(jobs.at(-1)?.id ?? ''))?.logs ?? []
}

async function source(id: string) {
  const [row] = await databaseClient
    .select()
    .from(schema.subscriptionSource)
    .where(eq(schema.subscriptionSource.id, id))
  return row
}

async function item(id: string) {
  const [row] = await databaseClient
    .select()
    .from(schema.subscriptionItem)
    .where(eq(schema.subscriptionItem.id, id))
  return row
}

async function checkpoint(station: MixStation) {
  const [row] = await databaseClient
    .select()
    .from(schema.subscriptionSync)
    .where(
      and(
        eq(schema.subscriptionSync.userId, USER),
        eq(schema.subscriptionSync.provider, station),
      ),
    )
  return row
}

/** Stored mixes whose search text holds the word. */
async function matching(word: string) {
  const rows = await databaseClient
    .select({ id: schema.subscriptionItem.id })
    .from(schema.subscriptionItem)
    .where(
      sql`${schema.subscriptionItem.search} @@ plainto_tsquery('simple', ${word})`,
    )
    .orderBy(schema.subscriptionItem.id)
  return rows.map((row) => row.id)
}

function fixtureShow(station: MixStation, key: string) {
  const found = fixtures[station].shows.find((entry) => entry.key === key)
  if (!found) throw new Error('Missing fixture show')
  return found
}

function fixtureMix(station: MixStation, key: string) {
  const found = fixtures[station].mixes.find((entry) => entry.key === key)
  if (!found) throw new Error('Missing fixture mix')
  return found
}

const firstRunCalls = [
  'shows@0',
  'shows@2',
  'episodes/basement@0',
  'episodes/basement@2',
  'episodes/dawn@0',
  'episodes/tidal@0',
]

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  useRealStationAdapters.enabled = false
  fixtures.rinse = rinseLibrary()
  fixtures.lotradio = lotRadioLibrary()
  Object.assign(api, {
    truncate: false,
    foreignId: false,
    partialCatalogue: false,
    failAt: 0,
    failStatus: 500,
    requests: 0,
    before: idle,
    since: [],
  })
  request.mockReset()
  request.mockImplementation(fakeStation)
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.subscriptionItem)
  await databaseClient.delete(schema.subscriptionSource)
  await databaseClient.delete(schema.subscriptionSync)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.delete(schema.user)
  await databaseClient.insert(schema.user).values({
    id: USER,
    name: 'Owner Fixture',
    email: 'owner@example.test',
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('mix station sync jobs with offline HTTP and a temporary database', () => {
  it('stores exact station task evidence and replays it without touching the station or library', async () => {
    useRealStationAdapters.enabled = true
    const text = '{ "entries": [], "futureNumber": 9007199254740993123 }'
    request.mockImplementation(async (url) => {
      if (
        String(url) !==
        'https://www.rinse.fm/api/query/v1/shows/filter?offset=0'
      )
        throw new Error('Unexpected fixture request')
      return new Response(text, {
        headers: { 'content-type': 'application/json' },
      })
    })
    await syncToEnd()
    const [job] = await syncJobs()
    expect(job?.status).toBe('succeeded')
    if (!job) throw new Error('Missing station fixture job')
    const { readProviderResponseAttempt } =
      await import('@/services/provider-response-history')
    const rows = await readProviderResponseAttempt({
      jobId: job.id,
      jobItemId: null,
      attempt: 1,
    })
    expect(rows).toMatchObject([
      {
        artistId: null,
        capture: {
          phase: 'task',
          ordinal: 1,
          response: { body: { state: 'captured', text, redacted: false } },
        },
      },
    ])
    expect(job.options['providerReplaySteps']).toMatchObject([
      {
        operation: 'listShows',
        args: { page: null, at: expect.any(String) },
      },
    ])
    const { runProviderReplayCommand } =
      await import('../scripts/replay-provider-response')
    const directory = await mkdtemp(join(tmpdir(), 'fixture-station-replay-'))
    try {
      const filename = join(directory, 'report.json')
      await runProviderReplayCommand([
        'replay',
        '--job',
        job.id,
        '--task',
        '--attempt',
        '1',
        '--output',
        filename,
      ])
      expect(JSON.parse(await readFile(filename, 'utf8'))).toMatchObject({
        task: 'rinse-mix-sync',
        provider: 'rinse',
        result: [{ entries: [], next: null }],
      })
      expect(request).toHaveBeenCalledTimes(1)
      expect(await databaseClient.$count(schema.subscriptionItem)).toBe(0)
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  it('reads the catalogue and every show as chained jobs on the first run', async () => {
    expect((await status()).account).toEqual({
      configured: true,
      connected: true,
      redirectUri: null,
    })
    const done = await syncToEnd()
    expect(done).toMatchObject({
      provider: 'rinse',
      state: 'complete',
      phase: 'items',
      sourcesDone: 3,
      sourcesTotal: 3,
      newItems: 6,
      storedSources: 3,
      storedItems: 6,
      schedule: 'daily',
      resumeAfter: null,
      errorMessage: null,
    })
    // Two catalogue pages, then each show's mixes in ID order; no feed.
    expect(calls()).toEqual(firstRunCalls)
    expect((await checkpoint('rinse'))?.historyComplete).toBe(true)

    const jobs = await syncJobs()
    expect(jobs.length).toBeGreaterThan(1)
    expect(new Set(jobs.map((job) => `${job.provider}:${job.status}`))).toEqual(
      new Set(['rinse:succeeded']),
    )
    expect(jobs[0]?.options).toEqual({ task: 'rinse-mix-sync' })
    expect(jobs[1]?.options).toEqual({
      task: 'rinse-mix-sync',
      continues: jobs[0]?.id,
    })
    expect((await lastJobLogs()).at(-1)?.message).toBe(
      'Sync complete. 6 new mixes; 6 mixes from 3 shows are stored.',
    )
    const { listJobs } = await import('@/services/jobs')
    expect((await listJobs({ mediaType: 'mix' })).totalCount).toBe(jobs.length)
    expect((await listJobs({ mediaType: 'subscription' })).totalCount).toBe(0)
    expect((await listJobs({ mediaType: 'album' })).totalCount).toBe(0)

    expect(await source('rinse.basement')).toMatchObject({
      type: 'rinse',
      title: 'Basement Hours',
      handle: 'basement',
      description: 'About Basement Hours',
      thumbnailUrl: 'https://img.fixture.test/basement.jpg',
      url: 'https://rinse.fixture.test/shows/basement',
      itemTotal: 3,
      subscribed: true,
      historyComplete: true,
    })
    expect(await source('rinse.dawn')).toMatchObject({
      itemTotal: 1,
      historyComplete: true,
    })
    expect(await item('rinse.b3')).toMatchObject({
      sourceId: 'rinse.basement',
      type: 'rinse',
      title: 'Kora B2B Lumen',
      description: 'Recorded live: Kora B2B Lumen',
      tags: ['Techno'],
      artists: ['Kora', 'Lumen'],
      url: 'https://rinse.fixture.test/episodes/b3',
      audioUrl: 'https://audio.fixture.test/b3.mp3',
      artworkUrl: 'https://img.fixture.test/b3.jpg',
      publishedAt: new Date('2026-03-03T20:00:00Z'),
      publishedPrecision: 'time',
      durationSec: 7200,
      live: 'none',
      watchedAt: null,
    })
    expect((await item('rinse.b2'))?.durationSec).toBe(0)
    // Mixes are found by their artists, tags and show name.
    expect(await matching('sora')).toEqual(['rinse.d1'])
    expect(await matching('ambient')).toEqual(['rinse.d1'])
    expect(await matching('tidal')).toEqual(['rinse.t1', 'rinse.t2'])
  })

  it('stores shows a catalogue names by handle, then their details from the first page of mixes', async () => {
    api.partialCatalogue = true
    await databaseClient.insert(schema.subscriptionSource).values({
      id: 'rinse.tidal',
      type: 'rinse',
      title: 'Tidal Rhythms, as stored',
      handle: 'tidal',
      description: 'Stored before',
      url: 'https://rinse.fixture.test/shows/tidal',
    })
    // The catalogue fits; the first episode page does not.
    api.failAt = 3
    expect(await syncToEnd()).toMatchObject({
      state: 'failed',
      phase: 'items',
      storedSources: 3,
    })
    // A new show is stored as named; a stored one keeps its details.
    expect(await source('rinse.basement')).toMatchObject({
      title: 'basement',
      handle: 'basement',
      description: null,
      thumbnailUrl: null,
      historyComplete: false,
    })
    expect(await source('rinse.tidal')).toMatchObject({
      title: 'Tidal Rhythms, as stored',
      description: 'Stored before',
    })

    await clearProviderState()
    api.failAt = 0
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      storedSources: 3,
      storedItems: 6,
    })
    expect(await source('rinse.basement')).toMatchObject({
      title: 'Basement Hours',
      description: 'About Basement Hours',
      thumbnailUrl: 'https://img.fixture.test/basement.jpg',
      itemTotal: 3,
      historyComplete: true,
    })
    expect(await source('rinse.tidal')).toMatchObject({
      title: 'Tidal Rhythms',
      description: 'About Tidal Rhythms',
    })
    // Every page of a show's mixes is found by the show's own name.
    expect(await matching('hours')).toEqual([
      'rinse.b1',
      'rinse.b2',
      'rinse.b3',
    ])
  })

  it('reads only the feed since the last run, resolving new partial shows', async () => {
    const first = await syncToEnd()
    request.mockClear()
    api.since = []
    const now = Date.now()
    fixtures.rinse.shows.push(
      show('night', 'Night Shift', { partialTitle: 'NIGHT' }),
      show('echo', 'Echo Chamber', {
        partialTitle: 'Echo',
        resolvable: false,
      }),
    )
    fixtureShow('rinse', 'basement').title = 'Basement Hours Renamed'
    fixtures.rinse.mixes.push(
      mix('n1', 'night', 'Night Shift with Aya', '2026-04-02', {
        addedAt: now,
      }),
      mix('b4', 'basement', 'Return set', '2026-04-01', { addedAt: now }),
      mix('e1', 'echo', 'Echo with Pell', '2026-03-31', { addedAt: now }),
      mix('d2', 'dawn', 'Morning tape', '2026-03-30', { addedAt: now }),
    )

    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      phase: 'items',
      sourcesDone: 2,
      newItems: 4,
      storedSources: 5,
      storedItems: 10,
    })
    // One request per new partial show, none for a stored one.
    expect(calls()).toEqual([
      'feed/recent@0',
      'show/night@0',
      'feed/recent@2',
      'show/echo@0',
    ])
    expect(api.since).toEqual([
      new Date(first.lastCompletedAt ?? ''),
      new Date(first.lastCompletedAt ?? ''),
    ])
    expect(await source('rinse.night')).toMatchObject({
      title: 'Night Shift',
      description: 'About Night Shift',
      thumbnailUrl: 'https://img.fixture.test/night.jpg',
    })
    // `getShow` found no details, so the partial ones are stored.
    expect(await source('rinse.echo')).toMatchObject({
      title: 'Echo',
      description: null,
      thumbnailUrl: null,
      handle: 'echo',
    })
    // A stored show named partially is left as it is.
    expect(await source('rinse.dawn')).toMatchObject({
      title: 'Dawn Chorus',
      description: 'About Dawn Chorus',
    })
    expect(await item('rinse.d2')).toMatchObject({ sourceId: 'rinse.dawn' })
    // Mixes not read again are found under the new show name.
    expect(await matching('renamed')).toEqual([
      'rinse.b1',
      'rinse.b2',
      'rinse.b3',
      'rinse.b4',
    ])
    expect((await checkpoint('rinse'))?.historyComplete).toBe(true)
  })

  it('reads the catalogue again after a truncated feed, stopping each known show at its first stored page', async () => {
    await syncToEnd()
    request.mockClear()
    const now = Date.now()
    api.truncate = true
    fixtures.rinse.mixes.push(
      mix('b4', 'basement', 'Return set', '2026-04-01', { addedAt: now }),
    )
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      newItems: 1,
      storedItems: 7,
    })
    expect(calls()).toEqual(['feed/recent@0'])
    expect((await checkpoint('rinse'))?.historyComplete).toBe(false)
    expect((await lastJobLogs()).map((log) => log.message)).toContain(
      'The feed ended before the last completed sync, so some mixes may be missing. The next sync reads every show again.',
    )

    // Additions the feed missed: a mix on a known show's first page and a new show.
    request.mockClear()
    api.truncate = false
    fixtures.rinse.shows.push(show('night', 'Night Shift'))
    fixtures.rinse.mixes.push(
      mix('t3', 'tidal', 'Spring tide', '2026-04-10'),
      mix('n3', 'night', 'Night three', '2026-03-03'),
      mix('n2', 'night', 'Night two', '2026-02-03'),
      mix('n1', 'night', 'Night one', '2026-01-03'),
    )
    fixtureMix('rinse', 'b3').title = 'Kora B2B Lumen (extended)'
    const watched = new Date('2026-06-01T12:00:00Z')
    await databaseClient
      .update(schema.subscriptionItem)
      .set({ watchedAt: watched })
      .where(eq(schema.subscriptionItem.id, 'rinse.b3'))

    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 4,
      sourcesTotal: 4,
      newItems: 4,
      storedSources: 4,
      storedItems: 11,
    })
    expect(calls()).toEqual([
      'shows@0',
      'shows@2',
      'episodes/basement@0',
      'episodes/dawn@0',
      'episodes/night@0',
      'episodes/night@2',
      'episodes/tidal@0',
    ])
    expect((await checkpoint('rinse'))?.historyComplete).toBe(true)
    // An upsert updates the station's details and keeps the listened date.
    expect(await item('rinse.b3')).toMatchObject({
      title: 'Kora B2B Lumen (extended)',
      watchedAt: watched,
    })
    expect(await source('rinse.night')).toMatchObject({
      itemTotal: 3,
      historyComplete: true,
    })
    expect(await source('rinse.tidal')).toMatchObject({ itemTotal: 3 })
  })

  it('reads a feed-only station in full, then only its recent additions', async () => {
    const archive = await syncToEnd('lotradio')
    expect(archive).toMatchObject({
      provider: 'lotradio',
      state: 'complete',
      phase: 'items',
      sourcesDone: 2,
      sourcesTotal: 0,
      newItems: 3,
      storedSources: 2,
      storedItems: 3,
    })
    expect(calls()).toEqual(['feed/archive@0', 'feed/archive@2'])
    expect((await checkpoint('lotradio'))?.historyComplete).toBe(true)
    expect(await source('lotradio.corner')).toMatchObject({
      title: 'Corner Booth',
      historyComplete: false,
    })

    request.mockClear()
    api.since = []
    api.truncate = true
    fixtures.lotradio.mixes.push(
      mix('r2', 'rooftop', 'Rooftop with Juno', '2026-05-10', {
        addedAt: Date.now(),
      }),
    )
    expect(await syncToEnd('lotradio')).toMatchObject({
      state: 'complete',
      sourcesDone: 1,
      newItems: 1,
      storedItems: 4,
    })
    expect(calls()).toEqual(['feed/recent@0'])
    expect(api.since).toEqual([new Date(archive.lastCompletedAt ?? '')])
    // Without a catalogue, a truncated feed leaves the next run a feed run.
    expect((await checkpoint('lotradio'))?.historyComplete).toBe(true)
    expect((await lastJobLogs()).map((log) => log.message)).not.toContain(
      'The feed ended before the last completed sync, so some mixes may be missing. The next sync reads every show again.',
    )
    expect(await status('rinse')).toMatchObject({
      state: 'never',
      storedSources: 0,
      storedItems: 0,
    })
  })

  it('keeps unlisted shows and never touches YouTube or podcast rows', async () => {
    const channel = `UC${'fixture'.padEnd(22, '0')}`
    const podcast = 'podcastfixture'.padEnd(22, '0')
    await databaseClient.insert(schema.subscriptionSource).values([
      {
        id: channel,
        type: 'youtube',
        title: 'Basement Hours',
        seenRunId: 'youtube-run',
      },
      {
        id: podcast,
        type: 'spotify',
        title: 'Tidal Talk',
        subscribed: false,
        seenRunId: 'spotify-run',
      },
    ])
    await databaseClient.insert(schema.subscriptionItem).values({
      id: 'videofixt01',
      sourceId: channel,
      type: 'youtube',
      title: 'Basement Hours trailer',
      publishedAt: new Date('2026-03-01T23:30:00Z'),
      search: subscriptionSearchVector(
        sql`${'Basement Hours trailer'}::text`,
        sql`${'Basement Hours'}::text`,
        sql`''::text`,
        sql`''::text`,
      ),
    })
    await syncToEnd()
    // A catalogue that no longer lists a show keeps it in the library.
    fixtureShow('rinse', 'dawn').listed = false
    fixtureShow('rinse', 'basement').title = 'Basement Hours Renamed'
    await databaseClient
      .update(schema.subscriptionSync)
      .set({ historyComplete: false })
      .where(eq(schema.subscriptionSync.provider, 'rinse'))
    request.mockClear()

    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      sourcesTotal: 3,
      storedSources: 3,
      storedItems: 6,
      newItems: 0,
    })
    expect(calls()).toEqual([
      'shows@0',
      'episodes/basement@0',
      'episodes/dawn@0',
      'episodes/tidal@0',
    ])
    expect(await source('rinse.dawn')).toMatchObject({ subscribed: true })
    expect(await source(channel)).toMatchObject({
      type: 'youtube',
      title: 'Basement Hours',
      subscribed: true,
      seenRunId: 'youtube-run',
    })
    expect(await source(podcast)).toMatchObject({
      type: 'spotify',
      subscribed: false,
      seenRunId: 'spotify-run',
    })
    expect(await matching('renamed')).toEqual([
      'rinse.b1',
      'rinse.b2',
      'rinse.b3',
    ])
    expect(await matching('trailer')).toEqual(['videofixt01'])
    const { getSubscriptionSyncStatus } =
      await import('@/services/subscription-sync')
    expect(await getSubscriptionSyncStatus('youtube', USER)).toMatchObject({
      provider: 'youtube',
      state: 'never',
      storedSources: 1,
      storedItems: 1,
    })
  })

  it('pauses on a rate limit and lets the schedule resume from the checkpoint', async () => {
    const { queueDueMixStationSync } =
      await import('@/services/mix-station-sync-jobs')
    // The catalogue fits; the first episode page does not.
    api.failAt = 3
    api.failStatus = 429
    const before = Date.now()
    const paused = await syncToEnd()
    expect(paused).toMatchObject({
      state: 'paused',
      phase: 'items',
      sourcesDone: 0,
      sourcesTotal: 3,
      storedSources: 3,
      storedItems: 0,
      errorMessage: null,
    })
    const resumeAfter = Date.parse(paused.resumeAfter ?? '')
    expect(resumeAfter).toBeGreaterThanOrEqual(before + 120_000)
    expect(paused.nextScheduledAt).toBe(paused.resumeAfter)
    expect((await syncJobs()).at(-1)?.status).toBe('succeeded')
    expect((await lastJobLogs()).at(-1)?.message).toMatch(
      /^Paused: Provider rate limit reached \(HTTP 429\)\. Stored mixes are kept;/,
    )
    const { listJobs } = await import('@/services/jobs')
    expect((await listJobs({ status: 'attention' })).totalCount).toBe(0)

    // Not due yet, and still held while the station cools down.
    expect(await queueDueMixStationSync(resumeAfter - 1000)).toBe(false)
    expect(await queueDueMixStationSync(resumeAfter + 1000)).toBe(false)
    await clearProviderState()
    api.failAt = 0
    request.mockClear()
    expect(await queueDueMixStationSync(resumeAfter + 1000)).toBe(true)
    expect(await drain()).toMatchObject({
      state: 'complete',
      sourcesDone: 3,
      newItems: 6,
      storedItems: 6,
      resumeAfter: null,
    })
    // The run continues at the episode page; the catalogue is not read again.
    expect(calls()).toEqual(firstRunCalls.slice(2))
  })

  it('fails on a provider error without an automatic retry, then resumes on request', async () => {
    const { queueDueMixStationSync } =
      await import('@/services/mix-station-sync-jobs')
    api.failAt = 4
    const failed = await syncToEnd()
    expect(failed).toMatchObject({
      state: 'failed',
      storedItems: 2,
      errorMessage: 'Provider request failed (HTTP 500)',
      nextScheduledAt: null,
      job: { status: 'failed' },
    })
    await clearProviderState()
    // The schedule never resumes a failed run.
    expect(await queueDueMixStationSync(Date.now() + 365 * 86400000)).toBe(
      false,
    )
    api.failAt = 0
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 6,
    })
    expect(calls()).toEqual(firstRunCalls.slice(3))
  })

  it('fails without storing a mix of another station', async () => {
    api.foreignId = true
    expect(await syncToEnd()).toMatchObject({
      state: 'failed',
      storedSources: 3,
      storedItems: 0,
      errorMessage:
        'Rinse FM sync failed or returned invalid data. No further requests were made.',
    })
    expect(calls()).toEqual(firstRunCalls.slice(0, 3))
  })

  it('discards the in-flight page when the job is cancelled and resumes on request', async () => {
    const { bulkCancelJobs } = await import('@/services/jobs')
    api.before = async (count) => {
      if (count !== 3) return
      const running = (await syncJobs()).find((job) => job.status === 'running')
      await bulkCancelJobs(
        { jobIds: [running?.id ?? ''], confirmRunning: true },
        null,
      )
    }
    expect(await syncToEnd()).toMatchObject({
      state: 'stopped',
      phase: 'items',
      storedItems: 0,
      job: { status: 'cancelled' },
    })

    api.before = idle
    request.mockClear()
    expect(await syncToEnd()).toMatchObject({
      state: 'complete',
      storedItems: 6,
    })
    expect(calls()).toEqual(firstRunCalls.slice(2))
  })

  it.each([
    { schedule: '1h', minutes: 60 },
    { schedule: 'daily', minutes: 1440 },
    { schedule: 'weekly', minutes: 10080 },
  ])(
    'queues a $schedule sync only when due after a completed sync',
    async ({ schedule, minutes }) => {
      const { SubscriptionSyncScheduleSchema } =
        await import('@repo/schemas/subscriptions')
      const { setSubscriptionSyncSchedule } =
        await import('@/services/subscription-sync')
      const { queueDueMixStationSync } =
        await import('@/services/mix-station-sync-jobs')
      const day = 24 * 60 * 60 * 1000

      // The setting can be saved first, but the schedule never starts the first sync.
      expect(
        await setSubscriptionSyncSchedule('rinse', USER, 'weekly'),
      ).toMatchObject({
        state: 'never',
        schedule: 'weekly',
        nextScheduledAt: null,
        startedAt: null,
      })
      expect(await queueDueMixStationSync(Date.now() + 365 * day)).toBe(false)

      const completed = await syncToEnd()
      const completedAt = Date.parse(completed.lastCompletedAt ?? '')
      const interval = minutes * 60 * 1000
      expect(
        (
          await setSubscriptionSyncSchedule(
            'rinse',
            USER,
            SubscriptionSyncScheduleSchema.parse(schedule),
          )
        ).nextScheduledAt,
      ).toBe(new Date(completedAt + interval).toISOString())
      expect(await queueDueMixStationSync(completedAt + interval - 1000)).toBe(
        false,
      )
      expect(await queueDueMixStationSync(completedAt + interval)).toBe(true)
      // The queued job is found instead of adding a second one.
      expect(await queueDueMixStationSync(completedAt + interval)).toBe(false)
      const jobs = await syncJobs()
      expect(jobs.at(-1)).toMatchObject({
        provider: 'rinse',
        options: { task: 'rinse-mix-sync' },
      })
      // The scheduled run reads the feed since the completed sync.
      api.since = []
      expect((await drain()).state).toBe('complete')
      expect(api.since).toEqual([new Date(completedAt)])
    },
  )

  it('lists exactly the stations under the Mixes providers', async () => {
    const { getProvidersOverview } =
      await import('@/services/providers-overview')
    type Library = 'album' | 'film' | 'subscription' | 'mix'
    const ids = async (mediaType: Library) =>
      ProviderOverviewSchema.parse(
        await getProvidersOverview({ mediaType }, null),
      ).providers.map((provider) => provider.id)
    const stations = ['lotradio', 'nts', 'rinse']
    expect((await ids('mix')).sort()).toEqual(stations)
    const others: Library[] = ['album', 'film', 'subscription']
    for (const library of others)
      expect(
        (await ids(library)).filter((id) => stations.includes(id)),
      ).toEqual([])
    const overview = ProviderOverviewSchema.parse(
      await getProvidersOverview({ mediaType: 'mix' }, null),
    )
    expect(
      overview.providers.find((provider) => provider.id === 'rinse'),
    ).toMatchObject({
      name: 'Rinse FM',
      roles: ['mix', 'account'],
      connection: { state: 'not-required', method: 'none' },
    })
  })
})
