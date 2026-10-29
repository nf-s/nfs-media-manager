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

describe('Last.fm adapter through queue and persistence, with offline HTTP', () => {
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
