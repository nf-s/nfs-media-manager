import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  SubscriptionItemQuerySchema,
  type SubscriptionItem,
  type SubscriptionItemQuery,
  type SubscriptionSort,
} from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `subscriptions_${randomUUID().replaceAll('-', '')}`
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

const KEPLER = channelId('kepler')
const BREAD = channelId('bread')
const RETIRED = channelId('retired')
const ORBIT_TALK = spotifyId('OrbitTalkShow')
const KITCHEN = spotifyId('QuietKitchenShow')

/** Many videos, so filter values and sorts reach past the first page of 100. */
const BREAD_COUNT = 120
const DAY = 24 * 60 * 60 * 1000
const breadId = (index: number) =>
  videoId(`bread${String(index).padStart(3, '0')}`)

type Source = {
  id: string
  type: 'youtube' | 'spotify'
  title: string
  handle?: string
  subscribed?: boolean
  itemTotal?: number
}
type Item = {
  id: string
  sourceId: string
  type: 'youtube' | 'spotify'
  title: string
  description?: string
  tags?: string[]
  publishedAt: string
  publishedPrecision?: string
  durationSec: number
  viewCount?: number | null
  likeCount?: number | null
  commentCount?: number | null
  live?: string
  artworkUrl?: string
}

const sources: Source[] = [
  {
    id: KEPLER,
    type: 'youtube',
    title: 'Kepler Mechanics Lab',
    handle: '@keplerlab',
  },
  { id: BREAD, type: 'youtube', title: 'Bread Bench' },
  {
    id: RETIRED,
    type: 'youtube',
    title: 'Retired Orbit Channel',
    subscribed: false,
  },
  { id: ORBIT_TALK, type: 'spotify', title: 'Orbit Talk', itemTotal: 2 },
  { id: KITCHEN, type: 'spotify', title: 'Quiet Kitchen Radio', itemTotal: 1 },
]

const items: Item[] = [
  {
    id: videoId('k1'),
    sourceId: KEPLER,
    type: 'youtube',
    title: 'Transfer orbits explained',
    description: 'Hohmann transfers and delta-v budgets.',
    tags: ['Spaceflight'],
    publishedAt: '2026-03-01T23:30:00Z',
    durationSec: 750,
    viewCount: 5000,
    likeCount: 70,
    commentCount: 4,
  },
  {
    id: videoId('k2'),
    sourceId: KEPLER,
    type: 'youtube',
    title: 'Launch window livestream',
    description: 'Crew questions on isolation.',
    tags: ['spaceflight'],
    publishedAt: '2026-04-01T18:00:00Z',
    durationSec: 0,
    live: 'upcoming',
  },
  {
    id: spotifyId('OrbitEpisodeOne'),
    sourceId: ORBIT_TALK,
    type: 'spotify',
    title: 'Orbits for beginners',
    description: 'A gentle start.',
    publishedAt: '2026-03-01T00:00:00Z',
    publishedPrecision: 'day',
    durationSec: 1800,
    artworkUrl: 'https://i.scdn.example/orbit-one.jpg',
  },
  {
    id: spotifyId('OrbitEpisodeTwo'),
    sourceId: ORBIT_TALK,
    type: 'spotify',
    title: 'Rendezvous and docking',
    description: 'Mentions spaceflight safety.',
    publishedAt: '2025-01-01T00:00:00Z',
    publishedPrecision: 'year',
    durationSec: 3600,
  },
  {
    id: spotifyId('KitchenEpisode'),
    sourceId: KITCHEN,
    type: 'spotify',
    title: 'Sourdough at dawn',
    description: 'Baking before sunrise.',
    publishedAt: '2026-02-15T00:00:00Z',
    publishedPrecision: 'day',
    durationSec: 1200,
  },
  {
    id: videoId('r1'),
    sourceId: RETIRED,
    type: 'youtube',
    title: 'Orbit retired episode',
    publishedAt: '2026-05-01T00:00:00Z',
    durationSec: 300,
    viewCount: 1,
  },
  // Newest first by index; the oldest carries the only rare tag.
  ...Array.from({ length: BREAD_COUNT }, (_, index): Item => {
    const views = index % 4 === 0 ? null : (index % 7) * 100
    return {
      id: breadId(index),
      sourceId: BREAD,
      type: 'youtube',
      title: `Bread batch ${String(index).padStart(3, '0')}`,
      tags: index === BREAD_COUNT - 1 ? ['Rare Rye'] : ['Baking'],
      publishedAt: new Date(
        Date.parse('2026-01-31T12:00:00Z') - index * DAY,
      ).toISOString(),
      durationSec: (index % 5) * 60,
      viewCount: views,
      likeCount: views === null ? null : index % 3,
      commentCount: views === null ? null : index % 2,
    }
  }),
]

async function library() {
  return import('@/services/subscription-library')
}

function query(input: Record<string, unknown> = {}): SubscriptionItemQuery {
  return SubscriptionItemQuerySchema.parse({
    ...input,
    ...('filters' in input ? { filters: JSON.stringify(input.filters) } : {}),
    ...('ranges' in input ? { ranges: JSON.stringify(input.ranges) } : {}),
  })
}

async function list(input: Record<string, unknown> = {}) {
  const { listSubscriptionItems } = await library()
  const page = await listSubscriptionItems(query(input))
  return { ...page, ids: page.items.map((item) => item.id) }
}

/** Every page of a query, in order. */
async function all(input: Record<string, unknown>, size: number) {
  const ids: string[] = []
  const found: SubscriptionItem[] = []
  for (let page = 1; ; page += 1) {
    const result = await list({ ...input, page, size })
    ids.push(...result.ids)
    found.push(...result.items)
    if (page >= result.pageCount) return { ids, items: found, result }
  }
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
  const { subscriptionSearchVector } = await library()
  await databaseClient.insert(schema.subscriptionSource).values(
    sources.map((source) => ({
      id: source.id,
      type: source.type,
      title: source.title,
      handle: source.handle ?? null,
      thumbnailUrl: `https://thumbs.example/${source.id}.jpg`,
      itemTotal: source.itemTotal ?? null,
      subscribed: source.subscribed ?? true,
    })),
  )
  await databaseClient.insert(schema.subscriptionItem).values(
    items.map((item) => {
      const source = sources.find((entry) => entry.id === item.sourceId)
      const tags = item.tags ?? []
      const description = item.description ?? ''
      return {
        id: item.id,
        sourceId: item.sourceId,
        type: item.type,
        title: item.title,
        description,
        tags,
        publishedAt: new Date(item.publishedAt),
        publishedPrecision: item.publishedPrecision ?? 'time',
        durationSec: item.durationSec,
        viewCount: item.viewCount ?? null,
        likeCount: item.likeCount ?? null,
        commentCount: item.commentCount ?? null,
        live: item.live ?? 'none',
        artworkUrl: item.artworkUrl ?? null,
        search: subscriptionSearchVector(
          sql`${item.title}::text`,
          sql`${source?.title ?? ''}::text`,
          sql`${tags.join(' ')}::text`,
          sql`${description}::text`,
        ),
      }
    }),
  )
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const visible = items.filter((item) => item.sourceId !== RETIRED)

describe('subscription items', () => {
  it('lists both types newest first, hides unsubscribed sources and pages by 100', async () => {
    const first = await list({ size: 100 })
    expect(first).toMatchObject({
      totalCount: visible.length,
      page: 1,
      size: 100,
      pageCount: 2,
    })
    expect(first.ids).toHaveLength(100)
    expect(first.ids.slice(0, 4)).toEqual([
      videoId('k2'),
      videoId('k1'),
      spotifyId('OrbitEpisodeOne'),
      spotifyId('KitchenEpisode'),
    ])
    const second = await list({ size: 100, page: 2 })
    expect(second.ids).toHaveLength(visible.length - 100)
    expect(new Set([...first.ids, ...second.ids]).size).toBe(visible.length)
    expect([...first.ids, ...second.ids]).not.toContain(videoId('r1'))
    // A page past the end still reports the total.
    expect(await list({ size: 100, page: 3 })).toMatchObject({
      ids: [],
      totalCount: visible.length,
    })
  })

  it('returns each type in its own shape', async () => {
    const { ids, items: found } = await all({}, 100)
    const episode = found[ids.indexOf(spotifyId('OrbitEpisodeOne'))]
    expect(episode).toEqual({
      type: 'spotify',
      id: spotifyId('OrbitEpisodeOne'),
      sourceId: ORBIT_TALK,
      sourceTitle: 'Orbit Talk',
      sourceThumbnailUrl: `https://thumbs.example/${ORBIT_TALK}.jpg`,
      title: 'Orbits for beginners',
      description: 'A gentle start.',
      tags: [],
      publishedAt: '2026-03-01T00:00:00.000Z',
      publishedPrecision: 'day',
      durationSec: 1800,
      url: `https://open.spotify.com/episode/${spotifyId('OrbitEpisodeOne')}`,
      artworkUrl: 'https://i.scdn.example/orbit-one.jpg',
    })
    expect(found[ids.indexOf(videoId('k2'))]).toMatchObject({
      type: 'youtube',
      durationSec: null,
      viewCount: null,
      live: 'upcoming',
      url: `https://www.youtube.com/watch?v=${videoId('k2')}`,
    })
  })

  it('searches videos and episodes together with the YouTube search syntax', async () => {
    // Title, source name and description matches across both types.
    expect(new Set((await list({ q: 'orbit' })).ids)).toEqual(
      new Set([
        videoId('k1'),
        spotifyId('OrbitEpisodeOne'),
        spotifyId('OrbitEpisodeTwo'),
      ]),
    )
    // Tags rank above descriptions; titles only leaves descriptions out.
    const spaceflight = (await list({ q: 'spaceflight' })).ids
    expect(new Set(spaceflight.slice(0, 2))).toEqual(
      new Set([videoId('k1'), videoId('k2')]),
    )
    expect(spaceflight[2]).toBe(spotifyId('OrbitEpisodeTwo'))
    expect(
      (await list({ q: 'spaceflight', fields: 'title' })).ids,
    ).not.toContain(spotifyId('OrbitEpisodeTwo'))
    expect((await list({ q: 'sourdo' })).ids).toEqual([
      spotifyId('KitchenEpisode'),
    ])
    expect((await list({ q: 'orbit -beginners' })).ids).not.toContain(
      spotifyId('OrbitEpisodeOne'),
    )
    expect(
      (await list({ q: 'sourdough or "transfer orbits"' })).ids.sort(),
    ).toEqual([videoId('k1'), spotifyId('KitchenEpisode')].sort())
    // Stop words alone fall back to the literal text.
    expect((await list({ q: 'the' })).totalCount).toBe(0)
    expect((await list({ q: 'retired' })).totalCount).toBe(0)
  })

  it('applies each filter field and mode with exact, case-insensitive values', async () => {
    const podcasts = [
      spotifyId('OrbitEpisodeOne'),
      spotifyId('KitchenEpisode'),
      spotifyId('OrbitEpisodeTwo'),
    ]
    expect(
      (
        await list({
          filters: [{ field: 'type', value: 'Podcast', mode: 'required' }],
        })
      ).ids,
    ).toEqual(podcasts)
    expect(
      (
        await list({
          filters: [{ field: 'type', value: 'youtube', mode: 'exclude' }],
        })
      ).ids,
    ).toEqual(podcasts)
    expect(
      (await list({ filters: [{ field: 'type', value: 'Video' }] })).totalCount,
    ).toBe(0)
    expect(
      (await list({ filters: [{ field: 'source', value: 'orbit talk' }] })).ids,
    ).toEqual([spotifyId('OrbitEpisodeOne'), spotifyId('OrbitEpisodeTwo')])
    expect(
      (await list({ filters: [{ field: 'source', value: 'Orbit' }] }))
        .totalCount,
    ).toBe(0)
    expect(
      (
        await list({
          filters: [{ field: 'title', value: 'SOURDOUGH AT DAWN' }],
        })
      ).ids,
    ).toEqual([spotifyId('KitchenEpisode')])
    expect(
      (
        await list({
          filters: [{ field: 'tag', value: 'SPACEFLIGHT', mode: 'required' }],
        })
      ).ids,
    ).toEqual([videoId('k2'), videoId('k1')])
    // Any filters form one group across fields; required and excluded are ANDed.
    expect(
      (
        await list({
          filters: [
            { field: 'source', value: 'Orbit Talk', mode: 'any' },
            { field: 'genre', value: 'Spaceflight', mode: 'any' },
            {
              field: 'title',
              value: 'Rendezvous and docking',
              mode: 'exclude',
            },
          ],
        })
      ).ids,
    ).toEqual([videoId('k2'), videoId('k1'), spotifyId('OrbitEpisodeOne')])
    expect(
      (
        await list({
          filters: [
            { field: 'genre', value: 'baking', mode: 'required' },
            { field: 'type', value: 'YouTube', mode: 'required' },
          ],
        })
      ).totalCount,
    ).toBe(BREAD_COUNT - 1)
  })

  it('applies inclusive ranges with missing values only on request', async () => {
    const start = Date.parse('2026-03-01T00:00:00Z')
    const end = Date.parse('2026-03-01T23:30:00Z')
    expect(
      (await list({ ranges: [{ field: 'publishedAt', min: start, max: end }] }))
        .ids,
    ).toEqual([videoId('k1'), spotifyId('OrbitEpisodeOne')])
    expect(
      (
        await list({
          ranges: [{ field: 'publishedAt', min: start + 1, max: end - 1 }],
        })
      ).totalCount,
    ).toBe(0)
    // An unfinished live stream has no duration.
    expect(
      (await list({ ranges: [{ field: 'durationSec', min: 1200, max: 1800 }] }))
        .ids,
    ).toEqual([spotifyId('OrbitEpisodeOne'), spotifyId('KitchenEpisode')])
    const short = await list({ ranges: [{ field: 'durationSec', max: 60 }] })
    expect(short.ids).not.toContain(videoId('k2'))
    expect(
      (
        await list({
          ranges: [{ field: 'durationSec', max: 60, includeMissing: true }],
        })
      ).totalCount,
    ).toBe(short.totalCount + 1 + BREAD_COUNT / 5)
    // Podcasts have no counts, so a count range leaves them out unless missing values are included.
    const viewed = await all({ ranges: [{ field: 'viewCount', min: 0 }] }, 100)
    expect(viewed.items.every((item) => item.type === 'youtube')).toBe(true)
    const withMissing = await list({
      ranges: [{ field: 'viewCount', min: 0, includeMissing: true }],
    })
    expect(withMissing.totalCount).toBe(visible.length)
    expect(
      (await list({ ranges: [{ field: 'commentCount', min: 4, max: 4 }] })).ids,
    ).toEqual([videoId('k1')])
  })

  const sorts: SubscriptionSort[] = [
    'relevance',
    'publishedAt',
    'title',
    'source',
    'durationSec',
    'viewCount',
    'likeCount',
    'commentCount',
  ]
  const keyOf: Record<
    Exclude<SubscriptionSort, 'relevance'>,
    (item: SubscriptionItem) => string | number | null
  > = {
    publishedAt: (item) => Date.parse(item.publishedAt),
    title: (item) => item.title.toLowerCase(),
    source: (item) => item.sourceTitle.toLowerCase(),
    durationSec: (item) => item.durationSec,
    viewCount: (item) => (item.type === 'youtube' ? item.viewCount : null),
    likeCount: (item) => (item.type === 'youtube' ? item.likeCount : null),
    commentCount: (item) =>
      item.type === 'youtube' ? item.commentCount : null,
  }

  it.each(
    sorts.flatMap((sortBy) => [
      { sortBy, direction: 'asc' },
      { sortBy, direction: 'desc' },
    ]),
  )(
    'sorts by $sortBy $direction with missing values last and no duplicates or gaps between pages',
    async ({ sortBy, direction }) => {
      const small = await all({ sortBy, direction }, 7)
      const large = await all({ sortBy, direction }, 100)
      expect(small.ids).toEqual(large.ids)
      expect(new Set(small.ids).size).toBe(visible.length)
      expect(small.result.totalCount).toBe(visible.length)
      if (sortBy === 'relevance') return
      const keys = small.items.map(keyOf[sortBy])
      const present = keys.filter((key) => key !== null)
      // Missing values come after every present value.
      expect(keys.slice(0, present.length)).toEqual(present)
      for (let index = 1; index < present.length; index += 1) {
        const previous = present[index - 1]
        const current = present[index]
        if (previous === undefined || current === undefined) continue
        if (direction === 'asc') expect(previous <= current).toBe(true)
        else expect(previous >= current).toBe(true)
      }
    },
  )

  it('ranks a search by relevance unless another sort is chosen', async () => {
    expect((await list({ q: 'orbit' })).ids).toEqual(
      (await list({ q: 'orbit', sortBy: 'relevance' })).ids,
    )
    expect(
      (await list({ q: 'orbit', sortBy: 'publishedAt', direction: 'asc' })).ids,
    ).toEqual([
      spotifyId('OrbitEpisodeTwo'),
      spotifyId('OrbitEpisodeOne'),
      videoId('k1'),
    ])
  })

  it('reads one item of a subscribed source by ID', async () => {
    const { getSubscriptionItem } = await library()
    expect(
      await getSubscriptionItem(spotifyId('KitchenEpisode')),
    ).toMatchObject({
      type: 'spotify',
      title: 'Sourdough at dawn',
      durationSec: 1200,
    })
    expect(await getSubscriptionItem(breadId(BREAD_COUNT - 1))).toMatchObject({
      type: 'youtube',
      tags: ['Rare Rye'],
    })
    expect(await getSubscriptionItem(videoId('r1'))).toBeNull()
    expect(await getSubscriptionItem(videoId('missing'))).toBeNull()
  })
})

describe('subscription facets and sources', () => {
  it('counts suggestions over the whole library, including values past the first page', async () => {
    const { listSubscriptionFacets } = await library()
    expect(await listSubscriptionFacets({ q: 'rare' })).toEqual([
      { field: 'genre', value: 'Rare Rye', count: 1, label: 'Tags: Rare Rye' },
    ])
    const types = (await listSubscriptionFacets({ q: 'type' })).filter(
      (row) => row.field === 'type',
    )
    expect(types).toEqual([
      {
        field: 'type',
        value: 'YouTube',
        count: visible.length - 3,
        label: 'Type: YouTube',
      },
      { field: 'type', value: 'Podcast', count: 3, label: 'Type: Podcast' },
    ])
    // A word in the field label selects the field; other words filter values.
    expect(
      (await listSubscriptionFacets({ q: 'channel orbit' })).filter(
        (row) => row.field === 'source',
      ),
    ).toEqual([
      {
        field: 'source',
        value: 'Orbit Talk',
        count: 2,
        label: 'Channel: Orbit Talk',
      },
    ])
    // Case variants of a tag are one suggestion counting both items.
    const spaceflight = await listSubscriptionFacets({ q: 'spaceflight' })
    expect(spaceflight).toEqual([
      {
        field: 'genre',
        value: expect.stringMatching(/^spaceflight$/i),
        count: 2,
        label: expect.stringMatching(/^Tags: spaceflight$/i),
      },
    ])
    const bread = await listSubscriptionFacets({
      q: 'bread',
      limitPerField: 50,
    })
    expect(bread.find((row) => row.field === 'source')).toEqual({
      field: 'source',
      value: 'Bread Bench',
      count: BREAD_COUNT,
      label: 'Channel: Bread Bench',
    })
    expect(bread.filter((row) => row.field === 'title')).toHaveLength(50)
    expect(
      (await listSubscriptionFacets({ q: 'retired' })).map((row) => row.value),
    ).toEqual([])
  })

  it('lists subscribed channels and podcasts with stored counts', async () => {
    const { listSubscriptionSources } = await library()
    const { items: listed } = await listSubscriptionSources()
    expect(listed.map((source) => source.id)).toEqual([
      BREAD,
      KEPLER,
      ORBIT_TALK,
      KITCHEN,
    ])
    expect(listed[2]).toEqual({
      type: 'spotify',
      id: ORBIT_TALK,
      title: 'Orbit Talk',
      description: null,
      thumbnailUrl: `https://thumbs.example/${ORBIT_TALK}.jpg`,
      url: `https://open.spotify.com/show/${ORBIT_TALK}`,
      storedItems: 2,
      latestItemAt: '2026-03-01T00:00:00.000Z',
      historyComplete: false,
      itemTotal: 2,
    })
    expect(listed[1]).toMatchObject({
      type: 'youtube',
      handle: '@keplerlab',
      storedItems: 2,
    })
    expect(
      (await listSubscriptionSources({ type: 'spotify' })).items.map(
        (source) => source.id,
      ),
    ).toEqual([ORBIT_TALK, KITCHEN])
  })
})
