import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq } from 'drizzle-orm'
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
import { spotifyPlugin } from '@/plugins/builtin/spotify'
import { tmdbPlugin } from '@/plugins/builtin/tmdb'
import {
  spotifyAlbumFixture,
  spotifyAlbumId,
  spotifyTokenFixture,
} from '@/plugins/builtin/__tests__/fixtures/spotify'
import { createCatalogEntryFromPlugin } from '@/lib/provider-catalog'

const database = `manual_add_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const plugins = [spotifyPlugin, tmdbPlugin]
const request = vi.fn(async (input: string | URL) => {
  const url = new URL(input)
  if (url.hostname === 'accounts.spotify.com')
    return Response.json(spotifyTokenFixture)
  if (url.pathname === `/v1/albums/${spotifyAlbumId}`)
    return Response.json(spotifyAlbumFixture())
  const filmId = /^\/3\/movie\/(\d+)$/.exec(url.pathname)?.[1]
  if (filmId)
    return Response.json({
      id: Number(filmId),
      title: 'Example Film',
      imdb_id: 'tt1234567',
      release_date: '2021-01-02',
      credits: { cast: [], crew: [] },
      keywords: { keywords: [] },
    })
  throw new Error('Unexpected mocked request')
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => plugins,
  getScrapePlugin: async (id: string) =>
    plugins.find((plugin) => plugin.manifest.id === id) ?? null,
  listProviderCatalog: async () =>
    plugins.map((plugin) => createCatalogEntryFromPlugin(plugin, null)),
}))
vi.mock('@/lib/provider-secrets', () => ({
  resolveProviderSecrets: () => ({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    apiKey: 'test-key',
  }),
}))
vi.mock('@/services/provider-requests', () => ({
  createProviderRequest: () => request,
  recordProviderFailure: async () => {},
  recordProviderSuccess: async () => {},
}))
import { addManualMedia } from '@/services/manual-add'

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Live requests forbidden')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.mediaItem)
  request.mockClear()
})
afterAll(async () => {
  expect(fetch).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
})

describe('manual additions through the canonical persistence path', () => {
  it('serializes concurrent album additions and retains original metadata on repeat', async () => {
    const results = await Promise.all([
      addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
      addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ])
    const first = results[0]
    if (!first) throw new Error('Missing add result')
    expect(results.map((result) => result.mediaItemId)).toEqual([
      first.mediaItemId,
      first.mediaItemId,
    ])
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(1)
    const [storedAlbum] = await databaseClient.select().from(schema.album)
    expect(storedAlbum?.dateAdded).toBeInstanceOf(Date)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.source).toBe('manual-add')
    expect(await databaseClient.select().from(schema.track)).toHaveLength(1)
    await databaseClient
      .update(schema.mediaItem)
      .set({ title: 'Corrected title' })
      .where(eq(schema.mediaItem.id, first.mediaItemId))
    request.mockClear()
    expect(
      await addManualMedia({ mediaType: 'album', externalId: spotifyAlbumId }),
    ).toEqual({ mediaItemId: first.mediaItemId, created: false })
    expect(request).not.toHaveBeenCalled()
    const [item] = await databaseClient.select().from(schema.mediaItem)
    expect(item?.title).toBe('Corrected title')
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    expect(
      (await databaseClient.select().from(schema.album))[0]?.dateAdded,
    ).toEqual(storedAlbum?.dateAdded)
  })

  it('reconciles a film by its shared IMDb identifier and never overwrites existing state', async () => {
    const first = await addManualMedia({ mediaType: 'film', externalId: '701' })
    expect(first.created).toBe(true)
    await databaseClient
      .update(schema.mediaItem)
      .set({ title: 'Corrected title' })
      .where(eq(schema.mediaItem.id, first.mediaItemId))
    await databaseClient
      .update(schema.film)
      .set({ watched: true })
      .where(eq(schema.film.mediaItemId, first.mediaItemId))
    const beforeFilm = await databaseClient.select().from(schema.film)
    const snapshots = await databaseClient
      .select()
      .from(schema.providerSnapshot)
    expect(snapshots[0]?.source).toBe('manual-add')
    expect(
      await addManualMedia({ mediaType: 'film', externalId: '702' }),
    ).toEqual({ mediaItemId: first.mediaItemId, created: false })
    expect(await databaseClient.select().from(schema.mediaItem)).toHaveLength(1)
    expect(
      (await databaseClient.select().from(schema.mediaItem))[0]?.title,
    ).toBe('Corrected title')
    expect(await databaseClient.select().from(schema.film)).toEqual(beforeFilm)
    expect(await databaseClient.select().from(schema.providerSnapshot)).toEqual(
      snapshots,
    )
    expect(await databaseClient.select().from(schema.scrapeJob)).toHaveLength(0)
  })
})
