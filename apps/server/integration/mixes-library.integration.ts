import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ArtistMixQuerySchema } from '@repo/schemas/creators'
import {
  SubscriptionItemQuerySchema,
  type MixSort,
  type SubscriptionItem,
  type SubscriptionItemQuery,
  type SubscriptionType,
} from '@repo/schemas/subscriptions'
import { env } from '@/env'
import * as schema from '@/schemas/db'

const database = `mixes_${randomUUID().replaceAll('-', '')}`
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
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

// Every name is synthetic. The YouTube channel shares its title, a tag and an
// artist-like name with the Mixes rows so that a leak between the libraries
// shows in every count.
const CHANNEL = `UC${'nightshift'.padEnd(22, '0')}`
const VIDEO = 'nightvideo1'
const PODCAST = 'NightShiftPodcast00001'
const EPISODE = 'NightShiftEpisode00001'
const NIGHT_SHIFT = 'nts.night-shift'
const WAREHOUSE = 'rinse.warehouse-weekly'
const DAWN = 'lotradio.dawn-chorus'
const FILLER_COUNT = 110
const DAY = 24 * 60 * 60 * 1000
const fillerId = (index: number) =>
  `lotradio.dawn-${String(index).padStart(3, '0')}`

type Source = {
  id: string
  type: SubscriptionType
  title: string
  url?: string
  itemTotal?: number
}
type Item = {
  id: string
  sourceId: string
  type: SubscriptionType
  title: string
  description?: string
  tags?: string[]
  artists?: string[]
  url?: string
  audioUrl?: string
  artworkUrl?: string
  publishedAt: string
  durationSec: number
}

const sources: Source[] = [
  { id: CHANNEL, type: 'youtube', title: 'Night Shift' },
  { id: PODCAST, type: 'spotify', title: 'Night Shift Radio' },
  {
    id: NIGHT_SHIFT,
    type: 'nts',
    title: 'Night Shift',
    url: 'https://www.nts.live/shows/night-shift',
    itemTotal: 2,
  },
  { id: WAREHOUSE, type: 'rinse', title: 'Warehouse Weekly' },
  { id: DAWN, type: 'lotradio', title: 'Dawn Chorus' },
]

const mixes: Item[] = [
  {
    id: 'nts.night-shift-1',
    sourceId: NIGHT_SHIFT,
    type: 'nts',
    title: 'Night Shift w/ Synthetic DJ',
    description: 'Two hours of warehouse records.',
    tags: ['Deep  house'],
    artists: ['Synthetic DJ'],
    url: 'https://www.nts.live/shows/night-shift/episodes/one',
    audioUrl: 'https://audio.example/night-shift-one.mp3',
    artworkUrl: 'https://media.example/night-shift-one.jpg',
    publishedAt: '2026-03-01T22:00:00Z',
    durationSec: 7200,
  },
  {
    id: 'nts.night-shift-2',
    sourceId: NIGHT_SHIFT,
    type: 'nts',
    title: 'Night Shift w/ Guest Two',
    tags: ['Techno', 'Minimal'],
    artists: ['synthetic dj', 'Guest Two'],
    publishedAt: '2026-02-01T22:00:00Z',
    durationSec: 0,
  },
  {
    id: 'rinse.warehouse-weekly-1',
    sourceId: WAREHOUSE,
    type: 'rinse',
    title: 'Warehouse Weekly',
    tags: ['Minimal'],
    artists: ['Guest Two'],
    publishedAt: '2026-01-15T12:00:00Z',
    durationSec: 3600,
  },
  {
    id: 'lotradio.dawn-the-the',
    sourceId: DAWN,
    type: 'lotradio',
    title: 'Dawn set',
    tags: ['House'],
    artists: ['The The'],
    publishedAt: '2026-01-10T08:00:00Z',
    durationSec: 5400,
  },
  // Newest first by index; the oldest carries the only rare tag and artist.
  ...Array.from({ length: FILLER_COUNT }, (_, index): Item => {
    const last = index === FILLER_COUNT - 1
    return {
      id: fillerId(index),
      sourceId: DAWN,
      type: 'lotradio',
      title: `Dawn chorus ${String(index).padStart(3, '0')}`,
      tags: last ? ['Rare Dub'] : ['Ambient'],
      artists: last ? ['Rare Selector'] : ['Filler Selector'],
      publishedAt: new Date(
        Date.parse('2025-12-31T08:00:00Z') - index * DAY,
      ).toISOString(),
      durationSec: index % 6 === 0 ? 0 : (index % 4) * 900,
    }
  }),
]

const subscriptionItems: Item[] = [
  {
    id: VIDEO,
    sourceId: CHANNEL,
    type: 'youtube',
    title: 'Night Shift w/ Synthetic DJ',
    tags: ['House', 'Rare Dub'],
    publishedAt: '2026-04-01T00:00:00Z',
    durationSec: 600,
  },
  {
    id: EPISODE,
    sourceId: PODCAST,
    type: 'spotify',
    title: 'Dawn chorus talk',
    publishedAt: '2026-04-02T00:00:00Z',
    durationSec: 1800,
  },
]

async function library() {
  return import('@/services/subscription-library')
}

function query(input: Record<string, unknown> = {}): SubscriptionItemQuery {
  return SubscriptionItemQuerySchema.parse({
    library: 'mixes',
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
      url: source.url ?? null,
      itemTotal: source.itemTotal ?? null,
      historyComplete: true,
    })),
  )
  await databaseClient.insert(schema.subscriptionItem).values(
    [...mixes, ...subscriptionItems].map((item) => {
      const source = sources.find((entry) => entry.id === item.sourceId)
      const tags = item.tags ?? []
      const artists = item.artists ?? []
      const description = item.description ?? ''
      return {
        id: item.id,
        sourceId: item.sourceId,
        type: item.type,
        title: item.title,
        description,
        tags,
        artists,
        url: item.url ?? null,
        audioUrl: item.audioUrl ?? null,
        artworkUrl: item.artworkUrl ?? null,
        publishedAt: new Date(item.publishedAt),
        durationSec: item.durationSec,
        search: subscriptionSearchVector(
          sql`${item.title}::text`,
          sql`${source?.title ?? ''}::text`,
          sql`${[...tags, ...artists].join(' ')}::text`,
          sql`${description}::text`,
        ),
      }
    }),
  )

  // The music tag hierarchy: deep house under House, minimal (hidden) under
  // Techno. Rock is unrelated.
  await databaseClient.insert(schema.tag).values([
    { id: 'tag-house', mediaType: 'album', name: 'House' },
    { id: 'tag-deep-house', mediaType: 'album', name: 'Deep House' },
    { id: 'tag-techno', mediaType: 'album', name: 'Techno' },
    { id: 'tag-minimal', mediaType: 'album', name: 'Minimal', hidden: true },
    { id: 'tag-rock', mediaType: 'album', name: 'Rock' },
    { id: 'tag-film-house', mediaType: 'film', name: 'Ambient' },
  ])
  await databaseClient.insert(schema.tagParent).values([
    { mediaType: 'album', childKey: 'deep house', parentKey: 'house' },
    { mediaType: 'album', childKey: 'minimal', parentKey: 'techno' },
    { mediaType: 'film', childKey: 'ambient', parentKey: 'house' },
  ])
  const { rebuildTagAncestors } = await import('@/services/tag-hierarchy')
  const { db } = await import('@/lib/db')
  await rebuildTagAncestors(db, 'album')
  await rebuildTagAncestors(db, 'film')

  // Library artists: two with an album to show, one without.
  await databaseClient.insert(schema.artist).values([
    { id: 'artist-dj', name: 'Synthetic DJ' },
    { id: 'artist-show', name: 'night shift' },
    { id: 'artist-guest', name: 'Guest Two' },
    { id: 'artist-none', name: 'Unbilled Artist' },
  ])
  await databaseClient.insert(schema.mediaItem).values([
    {
      id: 'album-one',
      slug: 'album-one',
      title: 'Album one',
      mediaType: 'album',
    },
  ])
  await databaseClient
    .insert(schema.album)
    .values([{ mediaItemId: 'album-one' }])
  await databaseClient.insert(schema.mediaCredit).values([
    { mediaItemId: 'album-one', artistId: 'artist-dj', role: 'artist' },
    { mediaItemId: 'album-one', artistId: 'artist-show', role: 'artist' },
    { mediaItemId: 'album-one', artistId: 'artist-none', role: 'artist' },
  ])
})
afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

const mixIds = mixes.map((item) => item.id)

describe('library isolation', () => {
  it('lists, pages and counts only the rows of the requested library', async () => {
    const {
      countSubscriptionBrowseItems,
      listSubscriptionBrowsePage,
      listSubscriptionItems,
      subscriptionBrowseCounts,
    } = await library()
    const everyMix = await all({}, 100)
    expect(new Set(everyMix.ids)).toEqual(new Set(mixIds))
    const subscriptions = await listSubscriptionItems(
      SubscriptionItemQuerySchema.parse({ size: 100 }),
    )
    expect(subscriptions.items.map((item) => item.id).sort()).toEqual(
      [EPISODE, VIDEO].sort(),
    )
    // Searches reach only their own library.
    expect((await list({ q: 'night shift' })).ids.sort()).toEqual(
      ['nts.night-shift-1', 'nts.night-shift-2'].sort(),
    )
    expect(
      (
        await listSubscriptionItems(
          SubscriptionItemQuerySchema.parse({ q: 'night shift' }),
        )
      ).items
        .map((item) => item.id)
        .sort(),
    ).toEqual([EPISODE, VIDEO].sort())
    expect(await subscriptionBrowseCounts(query({ q: 'night shift' }))).toEqual(
      { totalCount: 2, unfilteredCount: mixes.length },
    )
    expect(
      await subscriptionBrowseCounts(
        SubscriptionItemQuerySchema.parse({ q: 'dawn' }),
      ),
    ).toEqual({ totalCount: 1, unfilteredCount: 2 })
    expect(await countSubscriptionBrowseItems(query())).toEqual({
      totalCount: mixes.length,
    })
    const page = await listSubscriptionBrowsePage(query({ size: 3 }))
    expect(page).toMatchObject({ hasMore: true, page: 1, size: 3 })
    expect(page.items.map((item) => item.id)).toEqual([
      'nts.night-shift-1',
      'nts.night-shift-2',
      'rinse.warehouse-weekly-1',
    ])
  })

  it('lists the sources and source names of one library', async () => {
    const { listSubscriptionSources } = await library()
    const { listSubscribedSourceNames } =
      await import('@/services/subscription-source-names')
    expect(
      (await listSubscriptionSources({ library: 'mixes' })).items.map(
        (source) => source.id,
      ),
    ).toEqual([DAWN, NIGHT_SHIFT, WAREHOUSE])
    expect(
      (await listSubscriptionSources()).items.map((source) => source.id),
    ).toEqual([CHANNEL, PODCAST])
    expect(
      (await listSubscriptionSources({ library: 'mixes', type: 'rinse' }))
        .items,
    ).toHaveLength(1)
    await expect(
      listSubscriptionSources({ library: 'subscriptions', type: 'nts' }),
    ).rejects.toThrow()
    expect(
      (await listSubscribedSourceNames('mixes')).map((source) => source.id),
    ).toEqual([DAWN, NIGHT_SHIFT, WAREHOUSE])
    expect(
      (await listSubscribedSourceNames('subscriptions')).map(
        (source) => source.id,
      ),
    ).toEqual([CHANNEL, PODCAST])
  })

  it('suggests filters from one library with its own labels', async () => {
    const { listSubscriptionFacets } = await library()
    const subscriptionFacets = await listSubscriptionFacets({
      q: 'night shift',
    })
    expect(
      subscriptionFacets.find((row) => row.field === 'source'),
    ).toMatchObject({
      value: 'Night Shift',
      count: 1,
      label: 'Channel: Night Shift',
    })
    expect(
      subscriptionFacets.some((row) => row.label.startsWith('Show:')),
    ).toBe(false)
    expect(
      (await listSubscriptionFacets({ q: 'rare dub' })).map((row) => row.label),
    ).toEqual(['Tags: Rare Dub'])
    expect((await listSubscriptionFacets({ q: 'rare dub' }))[0]?.count).toBe(1)
    expect(
      (await listSubscriptionFacets({ q: 'type' })).filter(
        (row) => row.field === 'type',
      ),
    ).toEqual([
      { field: 'type', value: 'Podcast', count: 1, label: 'Type: Podcast' },
      { field: 'type', value: 'YouTube', count: 1, label: 'Type: YouTube' },
    ])
  })

  it('reads one item or one source by ID in the library of its type', async () => {
    const { getSubscriptionItem, getSubscriptionSource } = await library()
    expect(await getSubscriptionItem(VIDEO)).toMatchObject({ type: 'youtube' })
    expect(await getSubscriptionItem('nts.night-shift-1')).toMatchObject({
      type: 'nts',
    })
    // The query's library is the default, Subscriptions; the show's type decides.
    expect(
      await getSubscriptionSource(
        NIGHT_SHIFT,
        SubscriptionItemQuerySchema.parse({ sortBy: 'durationSec' }),
      ),
    ).toMatchObject({
      source: { id: NIGHT_SHIFT, type: 'nts', storedItems: 2 },
      items: {
        totalCount: 2,
        items: [{ id: 'nts.night-shift-1' }, { id: 'nts.night-shift-2' }],
      },
    })
    expect(
      await getSubscriptionSource(CHANNEL, query({ size: 5 })),
    ).toMatchObject({
      source: { id: CHANNEL, type: 'youtube' },
      items: { totalCount: 1, items: [{ id: VIDEO }] },
    })
  })

  it('rejects filters, ranges and sorts of the other library', async () => {
    const { getSubscriptionSource, listSubscriptionItems } = await library()
    const artist = {
      ...SubscriptionItemQuerySchema.parse({}),
      filters: [{ field: 'artist', value: 'Synthetic DJ' }],
    }
    await expect(listSubscriptionItems(artist)).rejects.toMatchObject({
      response: { statusCode: 422 },
    })
    await expect(getSubscriptionSource(CHANNEL, artist)).rejects.toMatchObject({
      response: { statusCode: 422 },
    })
    await expect(
      listSubscriptionItems({
        ...query(),
        ranges: [{ field: 'viewCount', min: 0, includeMissing: false }],
      }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    await expect(
      listSubscriptionItems({ ...query(), sortBy: 'likeCount' }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
    await expect(
      getSubscriptionSource(NIGHT_SHIFT, {
        ...SubscriptionItemQuerySchema.parse({}),
        sortBy: 'viewCount',
      }),
    ).rejects.toMatchObject({ response: { statusCode: 422 } })
  })
})

describe('mix rows', () => {
  it('maps a mix with its stored addresses, artists and recording', async () => {
    const { items } = await list({ size: 2 })
    expect(items[0]).toEqual({
      type: 'nts',
      id: 'nts.night-shift-1',
      sourceId: NIGHT_SHIFT,
      sourceTitle: 'Night Shift',
      sourceThumbnailUrl: null,
      title: 'Night Shift w/ Synthetic DJ',
      description: 'Two hours of warehouse records.',
      tags: ['Deep  house'],
      publishedAt: '2026-03-01T22:00:00.000Z',
      publishedPrecision: 'time',
      durationSec: 7200,
      url: 'https://www.nts.live/shows/night-shift/episodes/one',
      watchedAt: null,
      artworkUrl: 'https://media.example/night-shift-one.jpg',
      artists: ['Synthetic DJ'],
      audioUrl: 'https://audio.example/night-shift-one.mp3',
      libraryArtists: [],
    })
    expect(items[1]).toMatchObject({
      durationSec: null,
      url: 'https://www.nts.live',
      audioUrl: null,
      artworkUrl: null,
    })
  })

  it('maps station shows with their stored or station address and totals', async () => {
    const { listSubscriptionSources } = await library()
    const { items } = await listSubscriptionSources({ library: 'mixes' })
    expect(items.find((source) => source.id === NIGHT_SHIFT)).toEqual({
      type: 'nts',
      id: NIGHT_SHIFT,
      title: 'Night Shift',
      description: null,
      thumbnailUrl: null,
      url: 'https://www.nts.live/shows/night-shift',
      storedItems: 2,
      latestItemAt: '2026-03-01T22:00:00.000Z',
      historyComplete: true,
      itemTotal: 2,
    })
    expect(items.find((source) => source.id === WAREHOUSE)).toMatchObject({
      type: 'rinse',
      url: 'https://www.rinse.fm',
      itemTotal: null,
    })
  })

  it('fills the library artists named by a mix’s billed artists or show when read alone', async () => {
    const { getSubscriptionItem, setSubscriptionItemWatched } = await library()
    expect(await getSubscriptionItem('nts.night-shift-2')).toMatchObject({
      artists: ['synthetic dj', 'Guest Two'],
      // Guest Two has nothing in the library to show; no artist is created.
      libraryArtists: [
        { id: 'artist-show', name: 'night shift' },
        { id: 'artist-dj', name: 'Synthetic DJ' },
      ],
    })
    expect(await getSubscriptionItem('rinse.warehouse-weekly-1')).toMatchObject(
      { artists: ['Guest Two'], libraryArtists: [] },
    )
    const listened = await setSubscriptionItemWatched('nts.night-shift-2', {
      watchedAt: '2026-03-02T10:00:00.000Z',
    })
    expect(listened).toMatchObject({
      watchedAt: '2026-03-02T10:00:00.000Z',
      libraryArtists: [{ id: 'artist-show' }, { id: 'artist-dj' }],
    })
    expect(
      (await list({ filters: [{ field: 'watched', value: 'Yes' }] })).ids,
    ).toEqual(['nts.night-shift-2'])
    expect(
      (
        await list({
          ranges: [
            {
              field: 'watchedAt',
              min: Date.parse('2026-03-02T00:00:00Z'),
              max: Date.parse('2026-03-02T23:59:59Z'),
            },
          ],
        })
      ).ids,
    ).toEqual(['nts.night-shift-2'])
    await setSubscriptionItemWatched('nts.night-shift-2', { watchedAt: null })
    expect(
      await databaseClient
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.artist),
    ).toEqual([{ count: 4 }])
  })
})

describe('mixes search and filters', () => {
  it('searches billed artists and falls back to the literal artist for stop words', async () => {
    expect((await list({ q: 'synthetic' })).ids.sort()).toEqual(
      ['nts.night-shift-1', 'nts.night-shift-2'].sort(),
    )
    expect((await list({ q: 'the the' })).ids).toEqual([
      'lotradio.dawn-the-the',
    ])
    // Subscriptions keep the title and channel fallback only.
    const { listSubscriptionItems } = await library()
    expect(
      (
        await listSubscriptionItems(
          SubscriptionItemQuerySchema.parse({ q: 'the the' }),
        )
      ).totalCount,
    ).toBe(0)
  })

  it('applies each Mixes text filter and mode with exact, case-insensitive values', async () => {
    expect(
      (
        await list({
          filters: [
            { field: 'artist', value: 'SYNTHETIC DJ', mode: 'required' },
          ],
        })
      ).ids,
    ).toEqual(['nts.night-shift-1', 'nts.night-shift-2'])
    expect(
      (await list({ filters: [{ field: 'artist', value: 'Synthetic' }] }))
        .totalCount,
    ).toBe(0)
    expect(
      (await list({ filters: [{ field: 'artist', value: 'Guest Two' }] })).ids,
    ).toEqual(['nts.night-shift-2', 'rinse.warehouse-weekly-1'])
    expect(
      (await list({ filters: [{ field: 'artist', value: 'Rare Selector' }] }))
        .ids,
    ).toEqual([fillerId(FILLER_COUNT - 1)])
    expect(
      (await list({ filters: [{ field: 'source', value: 'night shift' }] }))
        .ids,
    ).toEqual(['nts.night-shift-1', 'nts.night-shift-2'])
    expect(
      (
        await list({
          filters: [{ field: 'type', value: 'rinse fm', mode: 'required' }],
        })
      ).ids,
    ).toEqual(['rinse.warehouse-weekly-1'])
    expect(
      (
        await list({
          filters: [{ field: 'type', value: 'The Lot Radio', mode: 'exclude' }],
        })
      ).ids,
    ).toEqual([
      'nts.night-shift-1',
      'nts.night-shift-2',
      'rinse.warehouse-weekly-1',
    ])
    expect(
      (
        await list({
          filters: [{ field: 'title', value: 'WAREHOUSE WEEKLY' }],
        })
      ).ids,
    ).toEqual(['rinse.warehouse-weekly-1'])
    // Any filters form one group across fields; required and excluded are ANDed.
    expect(
      (
        await list({
          filters: [
            { field: 'artist', value: 'The The', mode: 'any' },
            { field: 'type', value: 'NTS', mode: 'any' },
            { field: 'artist', value: 'Guest Two', mode: 'exclude' },
          ],
        })
      ).ids,
    ).toEqual(['nts.night-shift-1', 'lotradio.dawn-the-the'])
    expect(
      (
        await list({
          filters: [
            { field: 'type', value: 'The Lot Radio', mode: 'required' },
            { field: 'genre', value: 'ambient', mode: 'required' },
          ],
        })
      ).totalCount,
    ).toBe(FILLER_COUNT - 1)
  })

  it('matches a tag filter with the tags beneath it in the music hierarchy by normalized name', async () => {
    // House matches its own name and deep house, stored as "Deep  house".
    expect(
      (
        await list({
          filters: [{ field: 'genre', value: 'house', mode: 'required' }],
        })
      ).ids,
    ).toEqual(['nts.night-shift-1', 'lotradio.dawn-the-the'])
    expect(
      (await list({ filters: [{ field: 'genre', value: ' DEEP HOUSE ' }] }))
        .ids,
    ).toEqual(['nts.night-shift-1'])
    expect(
      (
        await list({
          filters: [{ field: 'genre', value: 'House', mode: 'exclude' }],
          size: 3,
        })
      ).ids,
    ).toEqual(['nts.night-shift-2', 'rinse.warehouse-weekly-1', fillerId(0)])
    // A hidden subtag is left out of its parent; named itself, it matches.
    expect(
      (await list({ filters: [{ field: 'genre', value: 'techno' }] })).ids,
    ).toEqual(['nts.night-shift-2'])
    expect(
      (await list({ filters: [{ field: 'genre', value: 'minimal' }] })).ids,
    ).toEqual(['nts.night-shift-2', 'rinse.warehouse-weekly-1'])
    // Unrelated tags and the film hierarchy do not match.
    expect(
      (await list({ filters: [{ field: 'genre', value: 'Rock' }] })).totalCount,
    ).toBe(0)
    expect(
      (
        await list({
          filters: [{ field: 'genre', value: 'house' }],
        })
      ).ids,
    ).not.toContain(fillerId(0))
    // Subscriptions tags keep the plain exact match.
    const { listSubscriptionItems } = await library()
    expect(
      (
        await listSubscriptionItems(
          SubscriptionItemQuerySchema.parse({
            filters: JSON.stringify([{ field: 'genre', value: 'house' }]),
          }),
        )
      ).items.map((item) => item.id),
    ).toEqual([VIDEO])
  })

  it('applies inclusive ranges with missing durations only on request', async () => {
    const start = Date.parse('2026-01-10T08:00:00Z')
    const end = Date.parse('2026-01-15T12:00:00Z')
    expect(
      (await list({ ranges: [{ field: 'publishedAt', min: start, max: end }] }))
        .ids,
    ).toEqual(['rinse.warehouse-weekly-1', 'lotradio.dawn-the-the'])
    expect(
      (
        await list({
          ranges: [{ field: 'publishedAt', min: start + 1, max: end - 1 }],
        })
      ).totalCount,
    ).toBe(0)
    const long = await list({
      ranges: [{ field: 'durationSec', min: 3600, max: 7200 }],
    })
    expect(long.ids.slice(0, 3)).toEqual([
      'nts.night-shift-1',
      'rinse.warehouse-weekly-1',
      'lotradio.dawn-the-the',
    ])
    expect(long.ids).not.toContain('nts.night-shift-2')
    const missing = mixes.filter((item) => item.durationSec === 0).length
    expect(
      (
        await list({
          ranges: [
            {
              field: 'durationSec',
              min: 3600,
              max: 7200,
              includeMissing: true,
            },
          ],
        })
      ).totalCount,
    ).toBe(long.totalCount + missing)
  })

  const sorts: MixSort[] = [
    'relevance',
    'publishedAt',
    'title',
    'source',
    'durationSec',
    'watchedAt',
  ]
  const keyOf: Record<
    Exclude<MixSort, 'relevance' | 'watchedAt'>,
    (item: SubscriptionItem) => string | number | null
  > = {
    publishedAt: (item) => Date.parse(item.publishedAt),
    title: (item) => item.title.toLowerCase(),
    source: (item) => item.sourceTitle.toLowerCase(),
    durationSec: (item) => item.durationSec,
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
      expect(new Set(small.ids).size).toBe(mixes.length)
      if (sortBy === 'relevance' || sortBy === 'watchedAt') return
      const keys = small.items.map(keyOf[sortBy])
      const present = keys.filter((key) => key !== null)
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

  it('counts Mixes suggestions over the whole library, including values past the first page', async () => {
    const { listSubscriptionFacets } = await library()
    expect(
      await listSubscriptionFacets({ library: 'mixes', q: 'rare' }),
    ).toEqual([
      {
        field: 'artist',
        value: 'Rare Selector',
        count: 1,
        label: 'Artist: Rare Selector',
      },
      { field: 'genre', value: 'Rare Dub', count: 1, label: 'Tags: Rare Dub' },
    ])
    const night = await listSubscriptionFacets({
      library: 'mixes',
      q: 'night shift',
    })
    expect(night.find((row) => row.field === 'source')).toEqual({
      field: 'source',
      value: 'Night Shift',
      count: 2,
      label: 'Show: Night Shift',
    })
    expect(
      (await listSubscriptionFacets({ library: 'mixes', q: 'station' })).filter(
        (row) => row.field === 'type',
      ),
    ).toEqual([
      {
        field: 'type',
        value: 'The Lot Radio',
        count: FILLER_COUNT + 1,
        label: 'Station: The Lot Radio',
      },
      { field: 'type', value: 'NTS', count: 2, label: 'Station: NTS' },
      {
        field: 'type',
        value: 'Rinse FM',
        count: 1,
        label: 'Station: Rinse FM',
      },
    ])
    // Case variants of a billed name are one suggestion counting both mixes.
    expect(
      (
        await listSubscriptionFacets({
          library: 'mixes',
          q: 'artist synthetic',
        })
      ).filter((row) => row.field === 'artist'),
    ).toEqual([
      {
        field: 'artist',
        value: expect.stringMatching(/synthetic dj/i),
        count: 2,
        label: expect.stringMatching(/^Artist: .*synthetic dj/i),
      },
    ])
    // Tag facets are the mixes' own tag names.
    expect(
      (await listSubscriptionFacets({ library: 'mixes', q: 'house' }))
        .filter((row) => row.field === 'genre')
        .map((row) => row.value)
        .sort(),
    ).toEqual(['Deep  house', 'House'])
    expect(
      (
        await listSubscriptionFacets({
          library: 'mixes',
          q: 'dawn',
          limitPerField: 50,
        })
      ).filter((row) => row.field === 'title'),
    ).toHaveLength(50)
  })
})

describe('artist mixes', () => {
  it('counts and pages the mixes billing an artist or on its show, newest first', async () => {
    const { getArtist, listArtistMixes } = await import('@/services/creators')
    expect((await getArtist('artist-dj')).mixCount).toBe(2)
    expect((await getArtist('artist-show')).mixCount).toBe(2)
    expect((await getArtist('artist-none')).mixCount).toBe(0)
    const first = await listArtistMixes(
      'artist-dj',
      ArtistMixQuerySchema.parse({ size: 1 }),
    )
    expect(first).toMatchObject({
      totalCount: 2,
      pageCount: 2,
      page: 1,
      size: 1,
      items: [{ id: 'nts.night-shift-1', libraryArtists: [] }],
    })
    expect(
      await listArtistMixes(
        'artist-dj',
        ArtistMixQuerySchema.parse({ size: 1, page: 2 }),
      ),
    ).toMatchObject({ items: [{ id: 'nts.night-shift-2' }] })
    expect(
      (
        await listArtistMixes(
          'artist-show',
          ArtistMixQuerySchema.parse({ sortBy: 'durationSec' }),
        )
      ).items.map((item) => item.id),
    ).toEqual(['nts.night-shift-1', 'nts.night-shift-2'])
    expect(
      (
        await listArtistMixes(
          'artist-dj',
          ArtistMixQuerySchema.parse({ q: 'guest' }),
        )
      ).items.map((item) => item.id),
    ).toEqual(['nts.night-shift-2'])
    // The YouTube video bills nobody and its channel is not a show.
    expect(
      (
        await listArtistMixes('artist-show', ArtistMixQuerySchema.parse({}))
      ).items.every((item) => item.type === 'nts'),
    ).toBe(true)
    await expect(
      listArtistMixes('artist-guest', ArtistMixQuerySchema.parse({})),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
  })

  it('narrows the artist lookups with the search index at library scale', async () => {
    await pool.query(`
      insert into subscription_source (id, type, title)
      select 'nts.bulk-' || n, 'nts', 'Bulk show ' || n
      from generate_series(1, 2000) n;
      insert into subscription_item (id, source_id, type, title, artists,
        published_at, search)
      select 'nts.bulk-' || n || '-1', 'nts.bulk-' || (n % 2000 + 1), 'nts',
        'Bulk mix ' || n, jsonb_build_array('Bulk artist ' || n),
        timestamp '2025-01-01' - n * interval '1 hour',
        to_tsvector('simple', 'Bulk mix ' || n || ' Bulk show ' || (n % 2000 + 1)
          || ' Bulk artist ' || n)
      from generate_series(1, 40000) n;
    `)
    // Flush the GIN pending list and refresh statistics, as autovacuum does.
    for (const table of ['subscription_source', 'subscription_item'])
      await pool.query(`vacuum analyze ${table}`)
    const { countMixesNamingArtist } = await library()
    expect(await countMixesNamingArtist('Synthetic DJ')).toBe(2)
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `explain select count(*) from subscription_item i
        join subscription_source s on s.id = i.source_id
        where s.subscribed and i.type in ('rinse', 'nts', 'lotradio')
          and i.search @@ plainto_tsquery('simple', $1)
          and (lower(btrim(s.title)) = lower(btrim($1))
            or exists (select 1 from jsonb_array_elements_text(i.artists) billed(value)
              where lower(btrim(billed.value)) = lower(btrim($1))))`,
      ['Synthetic DJ'],
    )
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'subscription_item_search_idx',
    )
  })
})
