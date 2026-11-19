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
import { CreateJobSchema } from '@repo/schemas/job'
import { env } from '@/env'
import { replaceAlbumTracks } from '@/services/album-library-tracks'
import * as schema from '@/schemas/db'
import { lastfmPlugin } from '@/plugins/builtin/lastfm'

const database = `lastfm_jobs_${randomUUID().replaceAll('-', '')}`
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
vi.mock('@/plugins/registry', () => ({
  getScrapePlugin: async (id: string) =>
    id === 'lastfm' ? lastfmPlugin : null,
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({ apiKey: 'offline-fixture-key' }),
}))
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
  await databaseClient.delete(schema.scrapeJob)
  await databaseClient.delete(schema.providerSnapshot)
  await databaseClient.delete(schema.mediaItem)
  await databaseClient.delete(schema.tagIdentity)
  await databaseClient.delete(schema.tag)
  await databaseClient.delete(schema.artist)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.insert(schema.mediaItem).values({
    id: 'album-fixture',
    slug: 'album-fixture',
    title: 'Album fixture',
    mediaType: 'album',
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
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function runJob(payload: unknown) {
  request.mockImplementationOnce(async () => Response.json(payload))
  const { createJob, processQueuedJobs, getJob } =
    await import('@/services/jobs')
  const job = await createJob(
    CreateJobSchema.parse({
      provider: 'lastfm',
      scope: { mediaItemIds: ['album-fixture'], mediaType: 'album' },
    }),
    null,
  )
  await processQueuedJobs()
  expect(request).toHaveBeenCalledTimes(1)
  return getJob(job.id)
}

const base = {
  name: 'Album fixture',
  artist: 'Artist fixture',
  url: 'https://www.last.fm/music/Artist+fixture/Album+fixture',
}

const spotifyTracks = [60, 73, 85, 97, 110, 122, 134, 146, 158, 170].map(
  (durationSec, index) => ({ title: `Album track ${index + 1}`, durationSec }),
)

async function seedSpotifyTracks() {
  const id = '0123456789012345678901'
  await databaseClient.transaction(async (tx) => {
    await replaceAlbumTracks(
      tx,
      'album-fixture',
      spotifyTracks.map((track, index) => ({ ...track, position: index + 1 })),
    )
    await tx.insert(schema.providerReference).values({
      id: 'spotify-fixture-reference',
      mediaItemId: 'album-fixture',
      provider: 'spotify',
      referenceType: 'album',
      externalId: id,
      isPrimary: true,
    })
    await tx.insert(schema.providerSnapshot).values({
      id: 'spotify-fixture-snapshot',
      mediaItemId: 'album-fixture',
      provider: 'spotify',
      source: 'scrape',
      checksum: 'spotify-fixture',
      payload: {
        id,
        name: base.name,
        album_type: 'album',
        total_tracks: spotifyTracks.length,
        tracks: {
          offset: 0,
          next: null,
          total: spotifyTracks.length,
          items: spotifyTracks.map((track, index) => ({
            name: track.title,
            duration_ms: track.durationSec * 1000,
            disc_number: 1,
            track_number: index + 1,
          })),
        },
      },
    })
  })
}

const shortProgram = [
  { name: 'Album track 1', duration: 220 },
  { name: 'Album track 2', duration: 250 },
  { name: 'Single mix', duration: 300 },
  { name: 'Instrumental', duration: null },
]

describe('Last.fm adapter through queue and persistence, with offline HTTP', () => {
  it('holds a short conflicting Last.fm program during automatic name lookup', async () => {
    await seedSpotifyTracks()
    const scrape = vi.spyOn(lastfmPlugin, 'scrapeMediaItem')
    const job = await runJob({
      album: { ...base, tracks: { track: shortProgram } },
    }).finally(() => {
      const hints = scrape.mock.calls[0]?.[0].media?.releaseHints
      scrape.mockRestore()
      expect(hints).toMatchObject([
        {
          source: 'spotify',
          trackEvidence: { exactSequence: true, tracks: spotifyTracks },
        },
      ])
    })

    expect(job?.status).toBe('failed')
    expect(
      job?.logs.find((log) => log.level === 'error')?.metadata,
    ).toMatchObject({
      classification: 'ambiguous',
    })
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toEqual([])
    expect(
      (await databaseClient.select().from(schema.providerSnapshot)).map(
        ({ provider }) => provider,
      ),
    ).toEqual(['spotify'])
    const { getProviderSafety } = await import('@/services/provider-requests')
    expect(await getProviderSafety('lastfm')).toMatchObject({
      consecutiveFailures: 0,
      halted: false,
    })
  })

  it.each(['url', 'mbid'])(
    'keeps a reviewed Last.fm %s despite the short program',
    async (referenceType) => {
      await seedSpotifyTracks()
      const mbid = '11111111-1111-4111-8111-111111111111'
      await databaseClient.insert(schema.providerReferenceOverride).values({
        id: 'reviewed-fixture-reference',
        mediaItemId: 'album-fixture',
        provider: 'lastfm',
        referenceType,
        externalId: referenceType === 'mbid' ? mbid : base.url,
      })
      expect(
        (
          await runJob({
            album: { ...base, mbid, tracks: { track: shortProgram } },
          })
        )?.status,
      ).toBe('succeeded')
    },
  )

  it.each([
    {
      evidence: 'one possible timing alignment',
      track: shortProgram.map((entry, index) =>
        index === 0 ? { ...entry, duration: 180 } : entry,
      ),
    },
    {
      evidence: 'too few observed durations',
      track: shortProgram.map((entry, index) =>
        index === 2 ? { ...entry, duration: null } : entry,
      ),
    },
    {
      evidence: 'a continuous program',
      track: { name: 'Continuous album', duration: 1100 },
    },
    {
      evidence: 'a complete program with alternate metadata',
      track: spotifyTracks.map((_, index) => ({
        name: `Localized track ${index + 1}`,
        duration: 320 + index * 20,
      })),
    },
  ])('keeps automatic lookup with $evidence', async ({ track }) => {
    await seedSpotifyTracks()
    expect(
      (await runJob({ album: { ...base, tracks: { track } } }))?.status,
    ).toBe('succeeded')
  })

  it('keeps automatic lookup when the library has no complete Spotify evidence', async () => {
    expect(
      (
        await runJob({
          album: { ...base, tracks: { track: shortProgram } },
        })
      )?.status,
    ).toBe('succeeded')
  })

  it('keeps a replayed response when its track hint has an inconsistent count', async () => {
    const scrape = lastfmPlugin.scrapeMediaItem
    if (!scrape) throw new Error('Missing Last.fm album scraper')
    await expect(
      scrape({
        mediaItemId: 'album-fixture',
        mediaType: 'album',
        media: {
          title: base.name,
          artists: [base.artist],
          releaseHints: [
            {
              source: 'spotify',
              title: base.name,
              releaseType: 'album',
              trackEvidence: {
                exactSequence: true,
                libraryTracks: spotifyTracks.length + 1,
                matchedTracks: spotifyTracks.length,
                tracks: spotifyTracks,
              },
            },
          ],
        },
        existingReferences: [],
        secrets: { apiKey: 'offline-fixture-key' },
        request: async () =>
          Response.json({
            album: { ...base, tracks: { track: shortProgram } },
          }),
        log: async () => {},
      }),
    ).resolves.toMatchObject({ normalized: { tracks: expect.any(Array) } })
  })

  it('passes the top-tags opt-in through a job and merges an existing tag across sources', async () => {
    const { lockTagWrites, upsertProviderTags } =
      await import('@/services/tag-state')
    await databaseClient.transaction(async (tx) => {
      await lockTagWrites(tx)
      await upsertProviderTags(tx, 'album-fixture', 'serply', 'album', [
        { name: 'Ambient', kind: 'genre', source: 'rym' },
      ])
    })
    const topTagsResponse = {
      toptags: {
        '@attr': { artist: base.artist, album: base.name },
        tag: [
          {
            name: 'ambient',
            count: 100,
            url: 'https://www.last.fm/tag/ambient',
          },
          { name: 'dreamy', count: 80, url: 'https://www.last.fm/tag/dreamy' },
        ],
      },
    }
    const tracks = { track: { name: 'Different Last.fm track', duration: 5 } }
    await databaseClient.transaction((tx) =>
      replaceAlbumTracks(tx, 'album-fixture', [
        { title: 'Original streaming track', position: 1 },
      ]),
    )
    request.mockImplementationOnce(async () =>
      Response.json({ album: { ...base, tracks } }),
    )
    request.mockImplementationOnce(async () => Response.json(topTagsResponse))
    const { createJob, processQueuedJobs, getJob } =
      await import('@/services/jobs')
    const job = await createJob(
      CreateJobSchema.parse({
        provider: 'lastfm',
        scope: { mediaItemIds: ['album-fixture'], mediaType: 'album' },
        options: { includeTopTags: true, tagsOnly: true },
      }),
      null,
    )
    await processQueuedJobs()
    expect((await getJob(job.id))?.status).toBe('succeeded')
    expect(request).toHaveBeenCalledTimes(2)
    expect(
      (await databaseClient.select().from(schema.tag))
        .map((t) => t.name)
        .sort(),
    ).toEqual(['Ambient', 'dreamy'])
    expect(
      await databaseClient.select().from(schema.tagOccurrence),
    ).toHaveLength(3)
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.payload).toMatchObject({
      album: { ...base, tracks },
      topTagsResponse,
    })
    expect(
      (await databaseClient.select().from(schema.track)).map((t) => t.title),
    ).toEqual(['Original streaming track'])
  })

  it('honors a Last.fm rate-limit error inside HTTP 200 without retrying', async () => {
    const job = await runJob({ error: 29, message: 'Rate limit exceeded' })
    expect(job?.status).toBe('failed')
    const [safety] = await databaseClient
      .select()
      .from(schema.providerRequestState)
    expect(safety?.cooldownUntil?.getTime()).toBeGreaterThan(Date.now())
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
  })

  it('persists singleton tags/tracks and empty images without losing source payloads', async () => {
    const payload = {
      album: {
        ...base,
        url: 'https://www.last.fm/music/+noredirect/Artist+fixture/Album+fixture',
        tags: {
          tag: { name: 'Ambient', url: 'https://www.last.fm/tag/ambient' },
        },
        tracks: { track: { name: 'Only track', duration: null } },
        image: [{ '#text': '', size: 'large' }],
        listeners: '0',
        playcount: '3',
      },
    }
    expect((await runJob(payload))?.status).toBe('succeeded')
    const [snapshot] = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshot?.payload).toEqual(payload)
    const [current] = await databaseClient
      .select()
      .from(schema.providerCurrentState)
    expect(current?.payload).toEqual(payload)
    const tags = await databaseClient.select().from(schema.tag)
    expect(tags.some((tag) => tag.name === 'Ambient')).toBe(true)
    const [track] = await databaseClient.select().from(schema.track)
    expect(track).toMatchObject({
      title: 'Only track',
      durationSec: null,
      externalId: null,
    })
  })

  it('persists empty tags and array tracks with unknown and zero durations', async () => {
    expect(
      (
        await runJob({
          album: {
            ...base,
            tags: '',
            tracks: {
              track: [
                { name: 'Unknown', duration: null },
                { name: 'Zero', duration: '0' },
              ],
            },
          },
        })
      )?.status,
    ).toBe('succeeded')
    const tracks = await databaseClient.select().from(schema.track)
    expect(tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Unknown', durationSec: null }),
        expect.objectContaining({ title: 'Zero', durationSec: 0 }),
      ]),
    )
  })

  it('retains validation errors and stacks without publishing malformed provider data', async () => {
    const job = await runJob({
      album: { ...base, tags: { tag: { name: 123 } } },
    })
    expect(job?.status).toBe('failed')
    expect(
      job?.logs.find((log) => log.level === 'error')?.metadata,
    ).toMatchObject({
      error: { name: 'ZodError', stack: expect.stringContaining('ZodError') },
    })
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      [],
    )
    expect(
      await databaseClient.select().from(schema.providerCurrentState),
    ).toEqual([])
  })
})
