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
import {
  ProviderLibraryCoverageSchema,
  ProviderRequestSeriesSchema,
} from '@repo/schemas/provider'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `media_provider_page_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Network forbidden in provider page tests')
})

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))
vi.mock('@/plugins/registry', () => ({
  listProviderCatalog: async () => [
    { id: 'fixture', mediaTypes: ['album'] },
    { id: 'fixture-films', mediaTypes: ['film', 'album'] },
    { id: 'fixture-account', mediaTypes: [] },
    { id: 'sonovault', mediaTypes: ['album'] },
  ],
}))

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
})
beforeEach(async () => {
  await databaseClient.delete(schema.providerRequestEvent)
  await databaseClient.delete(schema.providerRequestState)
  await databaseClient.delete(schema.providerCurrentState)
  await databaseClient.delete(schema.mediaItem)
  network.mockClear()
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

function item(
  id: string,
  mediaType: 'album' | 'film' | 'track',
  hidden = false,
) {
  return {
    id,
    mediaType,
    slug: id,
    title: `Synthetic ${id}`,
    metadata: hidden ? { legacyHidden: true } : {},
  }
}

function state(
  mediaItemId: string,
  provider: string,
  lastScrapedAt: Date | null,
) {
  return {
    id: `${mediaItemId}:${provider}`,
    mediaItemId,
    provider,
    checksum: 'synthetic',
    payload: {},
    status: 'ok',
    lastScrapedAt,
  }
}

describe('provider request series', () => {
  it('counts requests per UTC day over the last 90 days, for this provider only', async () => {
    const now = new Date('2026-11-16T10:00:00.000Z')
    await databaseClient.insert(schema.providerRequestState).values({
      provider: 'fixture',
      historyStartedAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    await databaseClient.insert(schema.providerRequestEvent).values(
      [
        ['2026-11-16T09:59:00.000Z', 'fixture'],
        ['2026-11-16T00:00:00.000Z', 'fixture'],
        ['2026-11-15T23:59:59.000Z', 'fixture'],
        ['2026-08-19T00:00:00.000Z', 'fixture'],
        // Before the window, after today, and another provider.
        ['2026-08-18T23:59:59.000Z', 'fixture'],
        ['2026-11-17T00:00:00.000Z', 'fixture'],
        ['2026-11-16T09:00:00.000Z', 'fixture-films'],
      ].map(([requestedAt, provider]) => ({
        id: randomUUID(),
        provider,
        requestedAt: new Date(requestedAt),
      })),
    )
    const { getProviderRequestSeries } =
      await import('@/services/provider-activity')
    expect(
      ProviderRequestSeriesSchema.parse(
        await getProviderRequestSeries('fixture', now),
      ),
    ).toEqual({
      provider: 'fixture',
      recordedSince: '2026-09-01T00:00:00.000Z',
      daysFrom: '2026-08-19',
      daysTo: '2026-11-16',
      total: 4,
      days: [
        { date: '2026-08-19', count: 1 },
        { date: '2026-11-15', count: 1 },
        { date: '2026-11-16', count: 2 },
      ],
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('returns an empty series without recorded history and rejects unknown providers', async () => {
    const { getProviderRequestSeries } =
      await import('@/services/provider-activity')
    expect(
      await getProviderRequestSeries(
        'fixture',
        new Date('2026-11-16T10:00:00.000Z'),
      ),
    ).toEqual({
      provider: 'fixture',
      recordedSince: null,
      daysFrom: '2026-08-19',
      daysTo: '2026-11-16',
      total: 0,
      days: [],
    })
    await expect(getProviderRequestSeries('unknown')).rejects.toThrow(
      'Provider not found',
    )
  })
})

describe('provider library coverage', () => {
  it('counts visible items of each manifest media type with a successful scrape', async () => {
    await databaseClient
      .insert(schema.mediaItem)
      .values([
        item('album-a', 'album'),
        item('album-b', 'album'),
        item('album-c', 'album'),
        item('album-hidden', 'album', true),
        item('film-a', 'film'),
        item('track-a', 'track'),
      ])
    await databaseClient.insert(schema.providerCurrentState).values([
      state('album-a', 'fixture', new Date('2026-11-01T00:00:00.000Z')),
      // Imported data never sets last_scraped_at.
      state('album-b', 'fixture', null),
      state('album-hidden', 'fixture', new Date('2026-11-01T00:00:00.000Z')),
      state('album-c', 'fixture-films', new Date('2026-11-01T00:00:00.000Z')),
      state('film-a', 'fixture-films', new Date('2026-11-01T00:00:00.000Z')),
    ])
    const { getProviderLibraryCoverage } =
      await import('@/services/provider-activity')
    expect(
      ProviderLibraryCoverageSchema.parse(
        await getProviderLibraryCoverage('fixture'),
      ),
    ).toEqual({
      provider: 'fixture',
      mediaTypes: [
        { mediaType: 'album', covered: 1, total: 3, queueFrom: 'metadata' },
      ],
    })
    expect(await getProviderLibraryCoverage('fixture-films')).toEqual({
      provider: 'fixture-films',
      mediaTypes: [
        { mediaType: 'film', covered: 1, total: 1, queueFrom: 'metadata' },
        { mediaType: 'album', covered: 1, total: 3, queueFrom: 'metadata' },
      ],
    })
    expect(network).not.toHaveBeenCalled()
  })

  it('counts what a task-job provider looked up, not item scrapes', async () => {
    await databaseClient
      .insert(schema.mediaItem)
      .values([
        item('track-a', 'track'),
        item('track-b', 'track'),
        item('track-c', 'track'),
        item('track-hidden', 'track', true),
        item('album-a', 'album'),
        item('album-b', 'album'),
      ])
    const lookedUpAt = new Date('2026-11-01T00:00:00.000Z')
    await databaseClient.insert(schema.sonovaultTrackLookup).values([
      {
        mediaItemId: 'track-a',
        inputType: 'isrc',
        input: 'X',
        status: 'matched',
        lookedUpAt,
      },
      {
        mediaItemId: 'track-b',
        inputType: 'isrc',
        input: 'Y',
        status: 'not_found',
        lookedUpAt,
      },
      {
        mediaItemId: 'track-hidden',
        inputType: 'isrc',
        input: 'Z',
        status: 'matched',
        lookedUpAt,
      },
    ])
    await databaseClient.insert(schema.sonovaultAlbumLookup).values([
      { mediaItemId: 'album-a', status: 'confirmed', lookedUpAt },
      { mediaItemId: 'album-b', status: 'not_found', lookedUpAt },
    ])
    // An item scrape state is not Sonovault coverage.
    await databaseClient
      .insert(schema.providerCurrentState)
      .values([state('album-b', 'sonovault', lookedUpAt)])
    const { getProviderLibraryCoverage } =
      await import('@/services/provider-activity')
    expect(await getProviderLibraryCoverage('sonovault')).toEqual({
      provider: 'sonovault',
      mediaTypes: [
        { mediaType: 'track', covered: 1, total: 3, queueFrom: 'metadata' },
        { mediaType: 'album', covered: 1, total: 2, queueFrom: 'item' },
      ],
    })
  })

  it('has no coverage for account-level providers and zero for an empty library', async () => {
    const { getProviderLibraryCoverage } =
      await import('@/services/provider-activity')
    expect(await getProviderLibraryCoverage('fixture-account')).toEqual({
      provider: 'fixture-account',
      mediaTypes: [],
    })
    expect(await getProviderLibraryCoverage('fixture')).toEqual({
      provider: 'fixture',
      mediaTypes: [
        { mediaType: 'album', covered: 0, total: 0, queueFrom: 'metadata' },
      ],
    })
    await expect(getProviderLibraryCoverage('unknown')).rejects.toThrow(
      'Provider not found',
    )
  })
})
