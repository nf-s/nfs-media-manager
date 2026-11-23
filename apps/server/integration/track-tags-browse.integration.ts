import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `track_tags_browse_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
}
const admin = new pg.Client({ ...connection, database: env.DATABASE_NAME })
const pool = new pg.Pool({ ...connection, database })
const fixture = drizzle(pool, { schema })

vi.mock('@/lib/db', () => ({
  get db() {
    return fixture
  },
}))
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...actual.env,
      APP_URL: 'https://web.example.test',
      AUTH_BASE_URL: 'https://api.example.test',
      TRUSTED_ORIGINS: ['https://web.example.test', 'https://api.example.test'],
    },
  }
})
vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      async getSession({ headers }: { headers: Headers }) {
        if (!headers.has('cookie')) return null
        return {
          user: { id: 'fixture-owner', email: 'owner@example.test' },
          session: { userId: 'fixture-owner' },
        }
      },
    },
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

// Invented tags: Current with Deep Current beneath it, and four others.
const tags = [
  ['tag-current', 'Current'],
  ['tag-deep-current', 'Deep Current'],
  ['tag-harbour-bass', 'Harbour Bass'],
  ['tag-glass-pop', 'Glass Pop'],
  ['tag-quiet', 'Quiet Tide'],
] as const

let created = false
beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Network forbidden')
    }),
  )
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(fixture, { migrationsFolder: './drizzle' })
  for (const [id, name] of tags) {
    await fixture
      .insert(schema.tag)
      .values({ id, mediaType: 'album', name, kind: 'genre' })
    await fixture.insert(schema.tagIdentity).values({
      mediaType: 'album',
      normalizedName: name.toLowerCase(),
      kind: 'genre',
      tagId: id,
    })
  }
  await fixture.insert(schema.tagParent).values({
    mediaType: 'album',
    childKey: 'deep current',
    parentKey: 'current',
  })
  const { rebuildTagAncestors } = await import('@/services/tag-hierarchy')
  await rebuildTagAncestors(fixture, 'album')
  await fixture.insert(schema.mediaItem).values({
    id: 'album-1',
    slug: 'album-1',
    title: 'Fixture album',
    mediaType: 'album',
  })
  await fixture.insert(schema.album).values({ mediaItemId: 'album-1' })
  await fixture
    .insert(schema.mediaItemTag)
    .values({ mediaItemId: 'album-1', tagId: 'tag-harbour-bass' })
  for (const [index, title] of [
    'Alpha fixture',
    'Bravo fixture',
    'Charlie fixture',
    'Delta fixture',
    'Echo fixture',
  ].entries()) {
    const id = `track-${index + 1}`
    await fixture.insert(schema.mediaItem).values({
      id,
      slug: slugifyParts(id),
      title,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })
    await fixture.insert(schema.libraryTrack).values({
      mediaItemId: id,
      durationSec: 200,
      albumMediaItemId: id === 'track-5' ? 'album-1' : null,
      dateAdded: new Date(Date.UTC(2026, 0, index + 1)),
    })
  }
  // track-1: Sonovault's Deep Current and an unverified Glass Pop.
  // track-2: Harbour Bass added by the owner. track-3: Deep Current, removed
  // by the owner. track-4: Sonovault's Current. track-5: only its album's tag.
  await fixture.insert(schema.trackTag).values([
    {
      mediaItemId: 'track-1',
      tagId: 'tag-deep-current',
      sonovault: true,
      verified: true,
    },
    {
      mediaItemId: 'track-1',
      tagId: 'tag-glass-pop',
      sonovault: true,
      verified: false,
    },
    {
      mediaItemId: 'track-2',
      tagId: 'tag-harbour-bass',
      owner: 'added',
      ownerChangedAt: new Date('2026-11-01T00:00:00Z'),
    },
    {
      mediaItemId: 'track-3',
      tagId: 'tag-deep-current',
      sonovault: true,
      verified: true,
      owner: 'removed',
      ownerChangedAt: new Date('2026-11-02T00:00:00Z'),
    },
    {
      mediaItemId: 'track-4',
      tagId: 'tag-current',
      sonovault: true,
      verified: true,
    },
  ])
  await fixture.insert(schema.tagOccurrence).values({
    id: 'occurrence-1',
    mediaItemId: 'track-1',
    tagId: 'tag-deep-current',
    provider: 'sonovault',
    rawName: 'Deep Current',
    kind: 'subgenre',
  })
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

async function page(input: Record<string, unknown>) {
  const { listTrackBrowsePage } = await import('@/services/tracks')
  return listTrackBrowsePage(
    TrackQuerySchema.parse({
      size: 50,
      sortBy: 'title',
      direction: 'asc',
      ...input,
    }),
  )
}
const ids = (result: { items: { id: string }[] }) =>
  result.items.map((item) => item.id)
const filters = (...chips: Record<string, string>[]) => JSON.stringify(chips)

describe('the Track tags field (TTAG-13)', () => {
  it('filters on a tag and its subtags, in Browse rows only', async () => {
    expect(
      ids(
        await page({
          filters: filters({ field: 'trackTag', value: 'Current' }),
        }),
      ),
    ).toEqual(['track-1', 'track-4'])
    // Not a removed row, an unverified one, or the album's tag.
    expect(
      ids(
        await page({
          filters: filters({ field: 'trackTag', value: 'deep current' }),
        }),
      ),
    ).toEqual(['track-1'])
    expect(
      ids(
        await page({
          filters: filters({ field: 'trackTag', value: 'Glass Pop' }),
        }),
      ),
    ).toEqual([])
    expect(
      ids(
        await page({
          filters: filters({ field: 'trackTag', value: 'Harbour Bass' }),
        }),
      ),
    ).toEqual(['track-2'])
    expect(
      ids(
        await page({
          filters: filters({
            field: 'trackTag',
            value: 'Current',
            mode: 'exclude',
          }),
        }),
      ),
    ).toEqual(['track-2', 'track-3', 'track-5'])
    // Grouped recordings read the same condition.
    expect(
      ids(
        await page({
          groupRecordings: 'true',
          sortBy: 'scrobbles',
          filters: filters({ field: 'trackTag', value: 'Current' }),
        }),
      ).sort(),
    ).toEqual(['track-1', 'track-4'])
    const { queryBrowseCount } = await import('@/services/browse')
    expect(
      await queryBrowseCount(
        'track',
        TrackQuerySchema.parse({
          filters: filters({ field: 'trackTag', value: 'Current' }),
        }),
      ),
    ).toEqual({ totalCount: 2 })
  })

  it('sorts by the first own tag and hydrates each row’s own tags', async () => {
    const sorted = await page({ sortBy: 'trackTag', direction: 'asc' })
    // Untagged tracks follow, in the natural order of ties.
    expect(ids(sorted).slice(0, 3)).toEqual(['track-4', 'track-1', 'track-2'])
    expect(ids(sorted).slice(3).sort()).toEqual(['track-3', 'track-5'])
    expect(
      Object.fromEntries(sorted.items.map((item) => [item.id, item.trackTags])),
    ).toEqual({
      'track-1': ['Deep Current'],
      'track-2': ['Harbour Bass'],
      'track-3': [],
      'track-4': ['Current'],
      'track-5': [],
    })
    expect(
      sorted.items.find((item) => item.id === 'track-5')?.albumTags,
    ).toEqual(['Harbour Bass'])
  })

  it('sorts an artist’s tracks by their first own tag', async () => {
    await fixture
      .insert(schema.artist)
      .values({ id: 'artist-1', name: 'Fixture artist' })
    await fixture.insert(schema.mediaCredit).values(
      ['track-1', 'track-2', 'track-4'].map((mediaItemId) => ({
        mediaItemId,
        artistId: 'artist-1',
        role: 'artist',
      })),
    )
    expect(
      ids(
        await page({
          creatorId: 'artist-1',
          sortBy: 'trackTag',
          direction: 'desc',
        }),
      ),
    ).toEqual(['track-2', 'track-1', 'track-4'])
  })

  it('finds search words in own tags as in album tags', async () => {
    expect(ids(await page({ q: 'harbour' }))).toEqual(['track-2', 'track-5'])
    expect(ids(await page({ q: 'glass' }))).toEqual([])
  })

  it('suggests own tags with their parents counted over their subtags', async () => {
    const { listTrackFilterOptions } = await import('@/services/tracks')
    const options = (await listTrackFilterOptions({ q: 'current' })).filter(
      (option) => option.field === 'trackTag',
    )
    expect(options).toEqual([
      expect.objectContaining({
        value: 'current',
        count: 2,
        subtags: 1,
        label: 'Track tags: Current',
      }),
      expect.objectContaining({
        value: 'deep current',
        count: 1,
        label: 'Track tags: Deep Current',
      }),
    ])
  })
})

describe('the Has track tags field', () => {
  const hasTags = (value: string, mode?: string) =>
    filters({ field: 'hasTrackTags', value, ...(mode ? { mode } : {}) })
  const counts = async (q: string) => {
    const { listTrackFilterOptions } = await import('@/services/tracks')
    return (await listTrackFilterOptions({ q }))
      .filter((option) => option.field === 'hasTrackTags')
      .map(({ value, count, label }) => ({ value, count, label }))
  }

  it('filters on tags of the track’s own in Browse, in each mode', async () => {
    // track-3's only tag was removed by the owner; track-5 has its album's.
    expect(ids(await page({ filters: hasTags('Yes') }))).toEqual([
      'track-1',
      'track-2',
      'track-4',
    ])
    expect(ids(await page({ filters: hasTags('no', 'required') }))).toEqual([
      'track-3',
      'track-5',
    ])
    expect(ids(await page({ filters: hasTags('Yes', 'exclude') }))).toEqual([
      'track-3',
      'track-5',
    ])
    expect(ids(await page({ filters: hasTags('Maybe') }))).toEqual([])
    // Any: either value of this field or a value of another field.
    expect(
      ids(
        await page({
          filters: filters(
            { field: 'hasTrackTags', value: 'No' },
            { field: 'trackTag', value: 'Harbour Bass' },
          ),
        }),
      ),
    ).toEqual(['track-2', 'track-3', 'track-5'])
  })

  it('sorts No before Yes and shows the value as a column', async () => {
    const sorted = await page({ sortBy: 'hasTrackTags', direction: 'asc' })
    // Ties keep the Tracks natural order: the album track first.
    expect(ids(sorted)).toEqual([
      'track-5',
      'track-3',
      'track-1',
      'track-2',
      'track-4',
    ])
    const { getTrackBrowseValues } = await import('@repo/schemas/tracks')
    expect(
      sorted.items.map((item) => getTrackBrowseValues(item).hasTrackTags),
    ).toEqual(['No', 'No', 'Yes', 'Yes', 'Yes'])
    expect(
      ids(await page({ sortBy: 'hasTrackTags', direction: 'desc' })).slice(
        0,
        3,
      ),
    ).toEqual(['track-1', 'track-2', 'track-4'])
  })

  it('is not matched by the ordinary words of a free-text search', async () => {
    expect(ids(await page({ q: 'yes' }))).toEqual([])
  })

  it('suggests both values from live rows and from the stored vocabulary', async () => {
    const expected = [
      { value: 'Yes', count: 3, label: 'Has track tags: Yes' },
      { value: 'No', count: 2, label: 'Has track tags: No' },
    ]
    await pool.query('delete from track_facet_state')
    // A selective request reads live rows while the vocabulary is not built.
    expect(await counts('track tags')).toEqual(expected)
    expect(
      (await pool.query('select 1 from track_facet_state where ready'))
        .rowCount,
    ).toBe(0)
    // A broad request builds the vocabulary and reads it.
    expect(await counts('')).toEqual(expected)
    expect(
      (await pool.query('select 1 from track_facet_state where ready'))
        .rowCount,
    ).toBe(1)
    expect(
      (
        await pool.query(
          `select value, count from track_facet_value
            where field = 'hasTrackTags' order by rank`,
        )
      ).rows,
    ).toEqual([
      { value: 'Yes', count: 3 },
      { value: 'No', count: 2 },
    ])
  })

  it('marks the stored counts stale when a track gains its own tag', async () => {
    await counts('')
    try {
      await pool.query(`insert into track_tag (media_item_id, tag_id, owner, owner_changed_at)
        values ('track-5', 'tag-quiet', 'added', now())`)
      expect(
        (await pool.query('select 1 from track_facet_dirty')).rowCount,
      ).toBeGreaterThan(0)
      expect(await counts('')).toEqual([
        { value: 'Yes', count: 4, label: 'Has track tags: Yes' },
        { value: 'No', count: 1, label: 'Has track tags: No' },
      ])
    } finally {
      await pool.query(
        `delete from track_tag where media_item_id = 'track-5' and tag_id = 'tag-quiet'`,
      )
    }
    expect(await counts('')).toEqual([
      { value: 'Yes', count: 3, label: 'Has track tags: Yes' },
      { value: 'No', count: 2, label: 'Has track tags: No' },
    ])
  })
})

describe('track details and tag pages (TTAG-11, TTAG-15)', () => {
  it('lists own, unverified and removed tags apart', async () => {
    const { getTrackDetail } = await import('@/services/tracks')
    expect((await getTrackDetail('track-1'))?.tags).toEqual({
      own: [
        {
          id: 'tag-deep-current',
          name: 'Deep Current',
          added: false,
          sonovault: true,
        },
      ],
      unverified: [{ id: 'tag-glass-pop', name: 'Glass Pop' }],
      removed: [],
    })
    expect((await getTrackDetail('track-3'))?.tags).toEqual({
      own: [],
      unverified: [],
      removed: [{ id: 'tag-deep-current', name: 'Deep Current' }],
    })
  })

  it('explains a track’s own tag from its Sonovault names and the owner’s change', async () => {
    const { getItemTagProvenance } =
      await import('@/services/item-tag-provenance')
    const query = {
      resourceType: 'track',
      resourceId: 'track-1',
      name: 'Deep Current',
      level: 'track',
    } as const
    expect(await getItemTagProvenance(query)).toMatchObject({
      reason: 'track',
      tagId: 'tag-deep-current',
      trackTag: { owner: null, sonovault: true, verified: true },
      totalCount: 1,
      items: [
        {
          provider: 'sonovault',
          providerLabel: 'Sonovault',
          rawName: 'Deep Current',
          kind: 'subgenre',
          originType: 'track',
          originTitle: 'Alpha fixture',
        },
      ],
    })
    expect(
      await getItemTagProvenance({
        ...query,
        resourceId: 'track-2',
        name: 'Harbour Bass',
      }),
    ).toMatchObject({
      reason: 'track',
      trackTag: {
        owner: 'added',
        ownerChangedAt: '2026-11-01T00:00:00.000Z',
        sonovault: false,
      },
      items: [],
    })
    await expect(
      getItemTagProvenance({ ...query, resourceId: 'track-5' }),
    ).rejects.toMatchObject({ response: { statusCode: 404 } })
    // Without the level, a track's tag is still its album's.
    expect(
      await getItemTagProvenance({
        resourceType: 'track',
        resourceId: 'track-5',
        name: 'Harbour Bass',
      }),
    ).toMatchObject({ reason: 'linked-album' })
  })

  it('counts the tracks carrying each tag themselves and sorts by them', async () => {
    const { listTags } = await import('@/services/tags')
    const listed = await listTags({
      mediaType: 'album',
      sortBy: 'trackCount',
      direction: 'desc',
      visibility: 'visible',
      placement: 'any',
      page: 1,
      size: 25,
    })
    expect(
      listed.items.map((tag) => [tag.name, tag.mediaCount, tag.trackCount]),
    ).toEqual([
      ['Current', 0, 1],
      ['Deep Current', 0, 1],
      ['Harbour Bass', 1, 1],
      ['Glass Pop', 0, 0],
      ['Quiet Tide', 0, 0],
    ])
  })
})

describe('owner edits through the tracks API (TTAG-12)', () => {
  const headers = {
    'content-type': 'application/json',
    cookie: 'session=fixture',
    origin: 'https://web.example.test',
  }
  async function send(
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const { default: app } = await import('@/app')
    return app.request(`/api/v1/tracks/track-1${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  async function own() {
    const { getTrackDetail } = await import('@/services/tracks')
    return (await getTrackDetail('track-1'))?.tags
  }

  it('authorises and validates each edit', async () => {
    const { default: app } = await import('@/app')
    expect(
      (
        await app.request('/api/v1/tracks/track-1/tags', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: headers.origin,
          },
          body: JSON.stringify({ tagId: 'tag-quiet' }),
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await send(
          'POST',
          '/tags',
          { tagId: 'tag-quiet' },
          {
            origin: 'https://untrusted.example',
          },
        )
      ).status,
    ).toBe(403)
    expect((await send('POST', '/tags', {})).status).toBe(422)
    expect(
      (await send('POST', '/tags', { tagId: 'tag-quiet', extra: 1 })).status,
    ).toBe(422)
    expect((await send('POST', '/tags', { tagId: 'no-such-tag' })).status).toBe(
      404,
    )
    const { default: appAgain } = await import('@/app')
    expect(
      (
        await appAgain.request('/api/v1/tracks/no-such-track/tags', {
          method: 'POST',
          headers,
          body: JSON.stringify({ tagId: 'tag-quiet' }),
        })
      ).status,
    ).toBe(404)
  })

  it('adds, removes, restores and resets to Sonovault', async () => {
    const added = await send('POST', '/tags', { tagId: 'tag-glass-pop' })
    expect(added.status).toBe(200)
    expect(await added.json()).toMatchObject({
      data: { tagId: 'tag-glass-pop', changed: true },
    })
    expect(await own()).toMatchObject({
      own: [
        { name: 'Deep Current', added: false, sonovault: true },
        { name: 'Glass Pop', added: true, sonovault: true },
      ],
      unverified: [],
    })
    const removed = await send('DELETE', '/tags', { tagId: 'tag-deep-current' })
    expect(await removed.json()).toMatchObject({
      data: { tagId: 'tag-deep-current', changed: true },
    })
    expect(await own()).toMatchObject({
      own: [{ name: 'Glass Pop' }],
      removed: [{ name: 'Deep Current' }],
    })
    expect(
      ids(
        await page({
          filters: filters({ field: 'trackTag', value: 'Glass Pop' }),
        }),
      ),
    ).toEqual(['track-1'])
    const reset = await send('POST', '/tags/reset')
    expect(await reset.json()).toMatchObject({ data: { changed: 2 } })
    expect(await own()).toEqual({
      own: [
        {
          id: 'tag-deep-current',
          name: 'Deep Current',
          added: false,
          sonovault: true,
        },
      ],
      unverified: [{ id: 'tag-glass-pop', name: 'Glass Pop' }],
      removed: [],
    })
  })
})
