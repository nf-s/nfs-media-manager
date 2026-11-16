import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SubscriptionItemQuerySchema } from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `subscription_watched_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const databaseClient = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))

const channelId = (key: string) => `UC${key.padEnd(22, '0')}`
const videoId = (key: string) => key.padEnd(11, '0')
const spotifyId = (key: string) => key.padEnd(22, '0')

const WORKSHOP = channelId('workshop')
const RETIRED = channelId('retired')
const SHOW = spotifyId('SyntheticShow')
const LATHE = videoId('lathe')
const CHISEL = videoId('chisel')
const EPISODE = spotifyId('SyntheticEpisode')
const OLD = videoId('old')

async function library() {
  return import('@/services/subscription-library')
}

function query(input: Record<string, unknown> = {}) {
  return SubscriptionItemQuerySchema.parse({
    ...input,
    ...('filters' in input ? { filters: JSON.stringify(input.filters) } : {}),
    ...('ranges' in input ? { ranges: JSON.stringify(input.ranges) } : {}),
  })
}

async function ids(input: Record<string, unknown> = {}) {
  const { listSubscriptionItems } = await library()
  return (await listSubscriptionItems(query(input))).items.map(
    (item) => item.id,
  )
}

let created = false
beforeAll(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('Network forbidden')
  })
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient.insert(schema.subscriptionSource).values([
    { id: WORKSHOP, type: 'youtube', title: 'Synthetic Workshop' },
    { id: SHOW, type: 'spotify', title: 'Synthetic Show' },
    {
      id: RETIRED,
      type: 'youtube',
      title: 'Retired Channel',
      subscribed: false,
    },
  ])
  await databaseClient.insert(schema.subscriptionItem).values(
    [
      [LATHE, WORKSHOP, 'youtube', 'Lathe basics', '2026-01-03T10:00:00Z'],
      [CHISEL, WORKSHOP, 'youtube', 'Chisel care', '2026-01-02T10:00:00Z'],
      [EPISODE, SHOW, 'spotify', 'Wood grain', '2026-01-01T00:00:00Z'],
      [OLD, RETIRED, 'youtube', 'Old video', '2025-01-01T00:00:00Z'],
    ].map(
      ([id = '', sourceId = '', type = '', title = '', published = '']) => ({
        id,
        sourceId,
        type,
        title,
        publishedAt: new Date(published),
        durationSec: 600,
        search: sql`to_tsvector('simple', ${title}::text)`,
      }),
    ),
  )
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('subscription item watched date', () => {
  it('adds a nullable column without a default', async () => {
    const { rows } = await pool.query(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'subscription_item' and column_name = 'watched_at'`,
    )
    expect(rows).toEqual([{ is_nullable: 'YES', column_default: null }])
  })

  it('starts unwatched in lists and detail', async () => {
    const { getSubscriptionItem, listSubscriptionItems } = await library()
    expect(await getSubscriptionItem(LATHE)).toMatchObject({ watchedAt: null })
    expect(
      (await listSubscriptionItems(query())).items.map(
        (item) => item.watchedAt,
      ),
    ).toEqual([null, null, null])
  })

  it('sets the date as given, in UTC, and serves it in lists and detail', async () => {
    const { getSubscriptionItem, setSubscriptionItemWatched } = await library()
    expect(
      await setSubscriptionItemWatched(LATHE, {
        watchedAt: '2026-09-21T18:30:00.000Z',
      }),
    ).toMatchObject({ id: LATHE, watchedAt: '2026-09-21T18:30:00.000Z' })
    expect(
      await setSubscriptionItemWatched(EPISODE, {
        watchedAt: '2026-08-01T07:00:00.000Z',
      }),
    ).toMatchObject({ type: 'spotify', watchedAt: '2026-08-01T07:00:00.000Z' })
    expect(await getSubscriptionItem(LATHE)).toMatchObject({
      watchedAt: '2026-09-21T18:30:00.000Z',
    })
    expect(await getSubscriptionItem(CHISEL)).toMatchObject({
      watchedAt: null,
    })
  })

  it('filters, ranges and sorts by the watched date', async () => {
    expect(
      await ids({ filters: [{ field: 'watched', value: 'Yes' }] }),
    ).toEqual([LATHE, EPISODE])
    expect(await ids({ filters: [{ field: 'watched', value: 'no' }] })).toEqual(
      [CHISEL],
    )
    expect(
      await ids({
        filters: [{ field: 'watched', value: 'Yes', mode: 'exclude' }],
      }),
    ).toEqual([CHISEL])
    expect(
      await ids({
        ranges: [{ field: 'watchedAt', min: Date.parse('2026-09-01') }],
      }),
    ).toEqual([LATHE])
    expect(
      await ids({
        ranges: [
          {
            field: 'watchedAt',
            max: Date.parse('2026-09-01'),
            includeMissing: true,
          },
        ],
      }),
    ).toEqual([CHISEL, EPISODE])
    expect(await ids({ sortBy: 'watchedAt', direction: 'desc' })).toEqual([
      LATHE,
      EPISODE,
      CHISEL,
    ])
    expect(await ids({ sortBy: 'watchedAt', direction: 'asc' })).toEqual([
      EPISODE,
      LATHE,
      CHISEL,
    ])
  })

  it('suggests Watched: Yes and No with their counts', async () => {
    const { listSubscriptionFacets } = await library()
    const watched = (await listSubscriptionFacets({ q: 'watched' })).filter(
      (option) => option.field === 'watched',
    )
    expect(watched).toEqual([
      { field: 'watched', value: 'Yes', count: 2, label: 'Watched: Yes' },
      { field: 'watched', value: 'No', count: 1, label: 'Watched: No' },
    ])
  })

  it('clears the date with null', async () => {
    const { setSubscriptionItemWatched } = await library()
    expect(
      await setSubscriptionItemWatched(EPISODE, { watchedAt: null }),
    ).toMatchObject({ id: EPISODE, watchedAt: null })
    expect(
      await ids({ filters: [{ field: 'watched', value: 'Yes' }] }),
    ).toEqual([LATHE])
  })

  it('answers 404 for an unknown item or one of an unsubscribed source', async () => {
    const { setSubscriptionItemWatched } = await library()
    for (const id of [videoId('missing'), OLD])
      await expect(
        setSubscriptionItemWatched(id, {
          watchedAt: '2026-09-21T18:30:00.000Z',
        }),
      ).rejects.toMatchObject({ response: { statusCode: 404 } })
    const { rows } = await pool.query(
      'select watched_at from subscription_item where id = $1',
      [OLD],
    )
    expect(rows).toEqual([{ watched_at: null }])
  })
})
