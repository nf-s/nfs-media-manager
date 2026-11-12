import { randomUUID } from 'node:crypto'
import pg from 'pg'
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
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `lastfm_scrobbles_${randomUUID().replaceAll('-', '')}`
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
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    apiKey: 'offline-fixture-key',
    username: 'Fixture-Listener',
  }),
}))

const recent = Math.floor(Date.now() / 1000) - 3600
const old = Math.floor(Date.UTC(2015, 4, 10) / 1000)

function scrobble(uts: number, name: string, album = 'Album fixture') {
  return {
    artist: { mbid: '', '#text': 'Artist fixture' },
    album: { mbid: '', '#text': album },
    name,
    mbid: '',
    url: 'https://www.last.fm/music/Artist+fixture/_/track',
    date: { uts: String(uts), '#text': 'synthetic' },
  }
}

function page(number: number, totalPages: number, track: unknown) {
  return {
    recenttracks: {
      track,
      '@attr': {
        user: 'Fixture-Listener',
        page: String(number),
        perPage: '200',
        totalPages: String(totalPages),
        total: '3',
      },
    },
  }
}

const nowPlaying = {
  artist: { mbid: '', '#text': 'Artist fixture' },
  album: { mbid: '', '#text': 'Album fixture' },
  name: 'First track',
  '@attr': { nowplaying: 'true' },
}

function requestedUrl(call: number) {
  return new URL(String(request.mock.calls[call]?.[0]))
}

async function syncToEnd() {
  const { getLastfmSyncStatus, startLastfmSync } =
    await import('@/services/lastfm-scrobbles')
  await startLastfmSync(null)
  await vi.waitFor(
    async () => expect((await getLastfmSyncStatus()).state).not.toBe('running'),
    { timeout: 10000, interval: 50 },
  )
  return getLastfmSyncStatus()
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', request)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  request.mockReset()
  request.mockImplementation(async () => {
    throw new Error('Unexpected request')
  })
  await databaseClient.delete(schema.lastfmScrobble)
  await databaseClient.delete(schema.lastfmSync)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'album-fixture',
    slug: 'album-fixture',
    title: 'Album  Fixture',
    mediaType: 'album',
    metadata: { browse: { country: ['Synthetic'] } },
  })
  await databaseClient
    .insert(schema.album)
    .values({ mediaItemId: 'album-fixture' })
  await databaseClient
    .insert(schema.artist)
    .values({ id: 'artist-fixture', name: 'Artist fixture' })
  await databaseClient.insert(schema.mediaCredit).values({
    mediaItemId: 'album-fixture',
    artistId: 'artist-fixture',
    role: 'artist',
  })
  await databaseClient.insert(schema.track).values({
    id: 'track-fixture',
    albumMediaItemId: 'album-fixture',
    title: 'First Track',
    position: 1,
  })
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('Last.fm scrobble sync with offline HTTP and a temporary database', () => {
  it('stores every dated scrobble across pages, links albums by name and fills browse fields', async () => {
    request.mockImplementationOnce(async () =>
      Response.json(
        page(1, 2, [
          nowPlaying,
          scrobble(recent, 'First track'),
          scrobble(old, 'First track'),
        ]),
      ),
    )
    request.mockImplementationOnce(async () =>
      // A page holding one track arrives as a bare object.
      Response.json(page(2, 2, scrobble(old - 60, 'Other', 'Unknown album'))),
    )
    const status = await syncToEnd()

    expect(status).toMatchObject({
      configured: true,
      state: 'complete',
      pagesFetched: 2,
      totalPages: 2,
      newScrobbles: 3,
      storedScrobbles: 3,
      matchedScrobbles: 2,
      errorMessage: null,
    })
    expect(request).toHaveBeenCalledTimes(2)
    const first = requestedUrl(0).searchParams
    const second = requestedUrl(1).searchParams
    expect(first.get('method')).toBe('user.getRecentTracks')
    expect(first.get('user')).toBe('Fixture-Listener')
    expect(first.get('limit')).toBe('200')
    expect(first.get('page')).toBe('1')
    expect(first.has('from')).toBe(false)
    expect(second.get('page')).toBe('2')
    // The window is fixed for the run so page numbers cannot drift.
    expect(second.get('to')).toBe(first.get('to'))
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get('user-agent'),
    ).toBe('media-manager-lastfm-sync/1.0')

    const rows = await databaseClient.select().from(schema.lastfmScrobble)
    expect(rows.map((row) => row.username)).toEqual(
      Array(3).fill('fixture-listener'),
    )
    expect(
      rows.find((row) => row.albumName === 'Unknown album')?.albumMediaItemId,
    ).toBeNull()
    expect(
      rows.find((row) => row.listenedAt.getTime() === old * 1000)
        ?.albumMediaItemId,
    ).toBe('album-fixture')

    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.metadata?.['browse']).toEqual({
      country: ['Synthetic'],
      scrobbles: 2,
      lastListenedAt: recent * 1000,
      scrobblesLast1y: 1,
      scrobblesLast5y: 1,
    })
  })

  it('re-reads an overlap on the next sync without duplicating scrobbles', async () => {
    request.mockImplementationOnce(async () =>
      Response.json(page(1, 1, [scrobble(recent, 'First track')])),
    )
    await syncToEnd()
    const firstTo = Number(requestedUrl(0).searchParams.get('to'))

    request.mockImplementationOnce(async () =>
      Response.json(
        page(1, 1, [
          scrobble(recent + 60, 'First track'),
          scrobble(recent, 'First track'),
        ]),
      ),
    )
    const status = await syncToEnd()

    expect(requestedUrl(1).searchParams.get('from')).toBe(
      String(firstTo - 7 * 24 * 60 * 60),
    )
    expect(status).toMatchObject({
      state: 'complete',
      newScrobbles: 1,
      storedScrobbles: 2,
    })
  })

  it('completes an empty window without storing anything', async () => {
    request.mockImplementationOnce(async () =>
      Response.json(page(1, 0, [nowPlaying])),
    )
    const status = await syncToEnd()
    expect(status).toMatchObject({ state: 'complete', storedScrobbles: 0 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stops on a rate limit without retrying, then resumes the same page and window', async () => {
    request.mockImplementationOnce(async () =>
      Response.json(page(1, 2, [scrobble(recent, 'First track')])),
    )
    request.mockImplementationOnce(async () =>
      Response.json({ error: 29, message: 'Rate limit exceeded' }),
    )
    const failed = await syncToEnd()

    expect(failed).toMatchObject({
      state: 'failed',
      pagesFetched: 1,
      storedScrobbles: 1,
    })
    expect(failed.errorMessage).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety?.cooldownUntil?.getTime()).toBeGreaterThan(Date.now())

    // The cooldown is cleared by hand, as an operator would in Providers.
    await databaseClient.delete(schema.providerRequestState)
    request.mockImplementationOnce(async () =>
      Response.json(page(2, 2, [scrobble(old, 'First track')])),
    )
    const resumed = await syncToEnd()

    expect(resumed).toMatchObject({
      state: 'complete',
      pagesFetched: 2,
      newScrobbles: 2,
      storedScrobbles: 2,
    })
    expect(requestedUrl(2).searchParams.get('page')).toBe('2')
    expect(requestedUrl(2).searchParams.get('to')).toBe(
      requestedUrl(0).searchParams.get('to'),
    )
  })

  it('rejects a response for a different page', async () => {
    request.mockImplementationOnce(async () =>
      Response.json(page(3, 5, [scrobble(recent, 'First track')])),
    )
    const status = await syncToEnd()
    expect(status).toMatchObject({ state: 'failed', storedScrobbles: 0 })
  })

  it('keeps stored scrobbles when a running sync is stopped', async () => {
    const { getLastfmSyncStatus, startLastfmSync, stopLastfmSync } =
      await import('@/services/lastfm-scrobbles')
    request.mockImplementationOnce(async () =>
      Response.json(page(1, 3, [scrobble(recent, 'First track')])),
    )
    request.mockImplementation(async () => {
      await stopLastfmSync()
      return Response.json(page(2, 3, [scrobble(old, 'First track')]))
    })
    await startLastfmSync(null)
    await vi.waitFor(
      async () => expect((await getLastfmSyncStatus()).state).toBe('stopped'),
      { timeout: 10000, interval: 50 },
    )
    // Let the in-flight step observe the stop before the next test starts.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await getLastfmSyncStatus()).toMatchObject({
      state: 'stopped',
      pagesFetched: 1,
      storedScrobbles: 1,
    })
  })

  it('reports album listening by month and by track', async () => {
    const { getAlbumListening } = await import('@/services/lastfm-scrobbles')
    request.mockImplementationOnce(async () =>
      Response.json(
        page(1, 1, [
          scrobble(recent, 'First track'),
          scrobble(old + 120, 'Bonus track'),
          scrobble(old, 'First track'),
        ]),
      ),
    )
    await syncToEnd()

    const all = await getAlbumListening('album-fixture')
    expect(all.total).toBe(3)
    expect(all.firstListenedAt).toBe(new Date(old * 1000).toISOString())
    expect(all.lastListenedAt).toBe(new Date(recent * 1000).toISOString())
    expect(all.months[0]).toEqual({ month: '2015-05', count: 2 })
    expect(all.months).toHaveLength(2)
    expect(all.tracks).toEqual([
      {
        key: 'first track',
        title: 'First track',
        position: 1,
        count: 2,
        lastListenedAt: new Date(recent * 1000).toISOString(),
      },
      {
        key: 'bonus track',
        title: 'Bonus track',
        position: null,
        count: 1,
        lastListenedAt: new Date((old + 120) * 1000).toISOString(),
      },
    ])

    const bonus = await getAlbumListening('album-fixture', 'bonus track')
    expect(bonus.total).toBe(1)
    expect(bonus.months).toEqual([{ month: '2015-05', count: 1 }])
    expect(bonus.tracks).toHaveLength(2)
    expect((await getAlbumListening('missing')).total).toBe(0)
  })
})
