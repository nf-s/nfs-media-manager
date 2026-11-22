import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { trackBrowseFields } from '@repo/schemas/browse'
import { AlbumQuerySchema } from '@repo/schemas/media'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { env } from '@/env'
import { slugifyParts } from '@/lib/media-utils'
import * as schema from '@/schemas/db'

const database = `track_tag_location_${randomUUID().replaceAll('-', '')}`
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

// Invented tags. Deep Current and the hidden Hidden Current sit beneath
// Current; Microhouse is a tag no Sonovault row carries.
const tags = [
  ['tag-current', 'Current', false],
  ['tag-deep-current', 'Deep Current', false],
  ['tag-hidden-current', 'Hidden Current', true],
  ['tag-harbour-bass', 'Harbour Bass', false],
  ['tag-glass-pop', 'Glass Pop', false],
  ['tag-microhouse', 'Microhouse', false],
  ['tag-quiet', 'Quiet Tide', false],
] as const

// Albums: Dense (Deep Current, Microhouse; credited to artist B, Harbour
// Bass), Sparse (Harbour Bass and the hidden Hidden Current; credited to
// artist A, Glass Pop and Deep Current), Glass (Glass Pop, Current) and Quiet
// (Quiet Tide, no tracks).
const albums = [
  ['album-dense', 'Dense album', ['tag-deep-current', 'tag-microhouse']],
  ['album-sparse', 'Sparse album', ['tag-harbour-bass', 'tag-hidden-current']],
  ['album-glass', 'Glass album', ['tag-glass-pop', 'tag-current']],
  ['album-quiet', 'Quiet album', ['tag-quiet']],
] as const

// Tracks, with durations of 100 s × their number:
// t1 Dense, Sonovault's Harbour Bass. t2 Dense, Sonovault's Deep Current.
// t3 Dense, no own tags, credited to artist A. t4 Sparse, no own tags,
// credited to artist A. t5 Dense, Glass Pop added by the owner.
// t6 Glass, Sonovault's Harbour Bass. t7 Glass, an unverified Deep Current
// and a Current the owner removed. t8 no album, credited to artist B.
// t9 Sparse, Sonovault's Hidden Current only.
const tracks = [
  ['t1', 'Alpha fixture', 'album-dense'],
  ['t2', 'Bravo fixture', 'album-dense'],
  ['t3', 'Charlie fixture', 'album-dense'],
  ['t4', 'Delta fixture', 'album-sparse'],
  ['t5', 'Echo fixture', 'album-dense'],
  ['t6', 'Foxtrot fixture', 'album-glass'],
  ['t7', 'Golf fixture', 'album-glass'],
  ['t8', 'Hotel fixture', null],
  ['t9', 'India fixture', 'album-sparse'],
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
  for (const [id, name, hidden] of tags) {
    await fixture
      .insert(schema.tag)
      .values({ id, mediaType: 'album', name, kind: 'genre', hidden })
    await fixture.insert(schema.tagIdentity).values({
      mediaType: 'album',
      normalizedName: name.toLowerCase(),
      kind: 'genre',
      tagId: id,
    })
  }
  await fixture.insert(schema.tagParent).values([
    { mediaType: 'album', childKey: 'deep current', parentKey: 'current' },
    { mediaType: 'album', childKey: 'hidden current', parentKey: 'current' },
  ])
  const { rebuildTagAncestors } = await import('@/services/tag-hierarchy')
  await rebuildTagAncestors(fixture, 'album')

  await fixture.insert(schema.artist).values([
    { id: 'artist-a', name: 'Fixture artist A' },
    { id: 'artist-b', name: 'Fixture artist B' },
  ])
  await fixture.insert(schema.artistProviderSnapshot).values([
    {
      id: 'profile-a',
      artistId: 'artist-a',
      provider: 'lastfm',
      payload: {},
      normalizedData: { tags: ['Glass Pop', 'Deep Current'] },
    },
    {
      id: 'profile-b',
      artistId: 'artist-b',
      provider: 'lastfm',
      payload: {},
      normalizedData: { tags: ['Harbour Bass'] },
    },
  ])
  await fixture.insert(schema.artistProviderCurrentState).values([
    { artistId: 'artist-a', provider: 'lastfm', latestSnapshotId: 'profile-a' },
    { artistId: 'artist-b', provider: 'lastfm', latestSnapshotId: 'profile-b' },
  ])

  for (const [id, title, albumTags] of albums) {
    await fixture
      .insert(schema.mediaItem)
      .values({ id, slug: id, title, mediaType: 'album' })
    await fixture.insert(schema.album).values({ mediaItemId: id })
    await fixture
      .insert(schema.mediaItemTag)
      .values(albumTags.map((tagId) => ({ mediaItemId: id, tagId })))
  }
  await fixture.insert(schema.mediaCredit).values([
    { mediaItemId: 'album-dense', artistId: 'artist-b', role: 'artist' },
    { mediaItemId: 'album-sparse', artistId: 'artist-a', role: 'artist' },
  ])

  for (const [index, [id, title, albumId]] of tracks.entries()) {
    await fixture.insert(schema.mediaItem).values({
      id,
      slug: slugifyParts(id),
      title,
      mediaType: 'track',
      sourceLabel: 'spotify',
    })
    await fixture.insert(schema.libraryTrack).values({
      mediaItemId: id,
      durationSec: (index + 1) * 100,
      albumMediaItemId: albumId,
      dateAdded: new Date(Date.UTC(2026, 0, index + 1)),
    })
  }
  await fixture.insert(schema.mediaCredit).values([
    { mediaItemId: 't3', artistId: 'artist-a', role: 'artist' },
    { mediaItemId: 't4', artistId: 'artist-a', role: 'artist' },
    { mediaItemId: 't8', artistId: 'artist-b', role: 'artist' },
  ])

  const sonovault = { sonovault: true, verified: true } as const
  await fixture.insert(schema.trackTag).values([
    { mediaItemId: 't1', tagId: 'tag-harbour-bass', ...sonovault },
    { mediaItemId: 't2', tagId: 'tag-deep-current', ...sonovault },
    {
      mediaItemId: 't5',
      tagId: 'tag-glass-pop',
      owner: 'added',
      ownerChangedAt: new Date('2026-11-01T00:00:00Z'),
    },
    { mediaItemId: 't6', tagId: 'tag-harbour-bass', ...sonovault },
    {
      mediaItemId: 't7',
      tagId: 'tag-deep-current',
      sonovault: true,
      verified: false,
    },
    {
      mediaItemId: 't7',
      tagId: 'tag-current',
      ...sonovault,
      owner: 'removed',
      ownerChangedAt: new Date('2026-11-02T00:00:00Z'),
    },
    { mediaItemId: 't9', tagId: 'tag-hidden-current', ...sonovault },
  ])
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

type Mode = 'any' | 'required' | 'exclude'
const tagFilter = (value: string, mode?: Mode) => ({
  field: 'genre',
  value,
  ...(mode ? { mode } : {}),
})
const filters = (...chips: ReturnType<typeof tagFilter>[]) =>
  JSON.stringify(chips)
const sorted = (ids: readonly string[]) => [...ids].sort()

function trackQuery(input: Record<string, unknown>) {
  return TrackQuerySchema.parse({
    size: 50,
    sortBy: 'title',
    direction: 'asc',
    ...input,
  })
}
async function trackIds(input: Record<string, unknown>) {
  const { queryBrowsePageIds } = await import('@/services/browse')
  return (await queryBrowsePageIds('track', trackQuery(input))).ids
}
async function trackCount(input: Record<string, unknown>) {
  const { queryBrowseCount } = await import('@/services/browse')
  return (await queryBrowseCount('track', trackQuery(input))).totalCount
}
async function albumIds(input: Record<string, unknown>) {
  const { queryBrowseIds } = await import('@/services/browse')
  const result = await queryBrowseIds(
    'album',
    AlbumQuerySchema.parse({
      size: 50,
      sortBy: 'title',
      direction: 'asc',
      ...input,
    }),
  )
  return sorted(result.ids)
}

// Tag locations as the URL holds them; Auto is left out.
const locations = [
  'auto',
  'track',
  'album',
  'artist',
  'track,album',
  'track,album,artist',
] as const
type Location = (typeof locations)[number]
const levelsParam = (location: Location) =>
  location === 'auto' ? undefined : location

// The tracks a Tags filter on each tag matches at each location (TTAG-21,
// TTAG-22, TTAG-25), worked out by hand from the fixture above.
const expected: Record<string, Record<Location, string[]>> = {
  Current: {
    // t2's own Deep Current; t3 and t7 inherit their album's; t4 its artist's
    // on a sparse album. t1, t5 and t6 have own tags, and Sonovault uses
    // Deep Current. t9's own Hidden Current is hidden.
    auto: ['t2', 't3', 't4', 't7'],
    track: ['t2'],
    album: ['t1', 't2', 't3', 't5', 't6', 't7'],
    artist: ['t3', 't4'],
    'track,album': ['t1', 't2', 't3', 't5', 't6', 't7'],
    'track,album,artist': ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
  },
  'Deep Current': {
    auto: ['t2', 't3', 't4'],
    track: ['t2'],
    album: ['t1', 't2', 't3', 't5'],
    artist: ['t3', 't4'],
    'track,album': ['t1', 't2', 't3', 't5'],
    'track,album,artist': ['t1', 't2', 't3', 't4', 't5'],
  },
  'Harbour Bass': {
    auto: ['t1', 't4', 't6', 't8', 't9'],
    track: ['t1', 't6'],
    album: ['t4', 't9'],
    artist: ['t8'],
    'track,album': ['t1', 't4', 't6', 't9'],
    'track,album,artist': ['t1', 't4', 't6', 't8', 't9'],
  },
  // No Sonovault row carries Glass Pop: t5's is the owner's, so t6 and t7
  // still inherit Glass Album's. t3's artist tag is not read on a dense album.
  'Glass Pop': {
    auto: ['t4', 't5', 't6', 't7'],
    track: ['t5'],
    album: ['t6', 't7'],
    artist: ['t3', 't4'],
    'track,album': ['t5', 't6', 't7'],
    'track,album,artist': ['t3', 't4', 't5', 't6', 't7'],
  },
  // Sonovault says nothing about Microhouse: every Dense album track matches.
  Microhouse: {
    auto: ['t1', 't2', 't3', 't5'],
    track: [],
    album: ['t1', 't2', 't3', 't5'],
    artist: [],
    'track,album': ['t1', 't2', 't3', 't5'],
    'track,album,artist': ['t1', 't2', 't3', 't5'],
  },
}
const expectedEntries = Object.entries(expected)

describe('Tags filters on Tracks at each location (TTAG-20 to TTAG-22)', () => {
  it.each(locations)('filters and counts at %s', async (location) => {
    const tagLevels = levelsParam(location)
    for (const [tag, byLocation] of expectedEntries) {
      const input = { filters: filters(tagFilter(tag)), tagLevels }
      const want = byLocation[location]
      expect({ tag, ids: sorted(await trackIds(input)) }).toEqual({
        tag,
        ids: want,
      })
      expect({ tag, count: await trackCount(input) }).toEqual({
        tag,
        count: want.length,
      })
    }
  })

  it('reads the Album tags field at the album whatever the location', async () => {
    for (const location of locations)
      expect(
        sorted(
          await trackIds({
            filters: JSON.stringify([{ field: 'albumTag', value: 'Current' }]),
            tagLevels: levelsParam(location),
          }),
        ),
      ).toEqual(expected.Current.album)
  })
})

describe('Auto (TTAG-21)', () => {
  it('judges a track with own tags by them for a tag Sonovault uses', async () => {
    // t1's album is tagged Deep Current; its own tags say Harbour Bass.
    const deep = await trackIds({ filters: filters(tagFilter('Deep Current')) })
    expect(deep).not.toContain('t1')
    expect(deep).toContain('t2')
  })

  it('still matches a track through its album for a tag Sonovault does not use', async () => {
    expect(
      await trackIds({ filters: filters(tagFilter('Microhouse')) }),
    ).toContain('t1')
  })

  it('inherits the album’s tags, and the artists’ on a sparse album', async () => {
    const deep = await trackIds({ filters: filters(tagFilter('Deep Current')) })
    // t3: no own tags, its album's Deep Current. t4: its artist's.
    expect(deep).toEqual(expect.arrayContaining(['t3', 't4']))
    // t3's artist tag Glass Pop is not read on an album with two tags.
    expect(
      await trackIds({ filters: filters(tagFilter('Glass Pop')) }),
    ).not.toContain('t3')
    // t8 has no album: its artist's tags.
    expect(
      await trackIds({ filters: filters(tagFilter('Harbour Bass')) }),
    ).toContain('t8')
  })

  it('counts an owner tag as own without changing which tags Sonovault uses', async () => {
    const glass = await trackIds({ filters: filters(tagFilter('Glass Pop')) })
    // t5's owner tag matches; t6 (own Sonovault tags) still inherits Glass Pop.
    expect(glass).toEqual(expect.arrayContaining(['t5', 't6']))
    // t5's owner tag makes it a track with own tags for Deep Current.
    expect(
      await trackIds({ filters: filters(tagFilter('Deep Current')) }),
    ).not.toContain('t5')
  })

  it('does not count unverified or owner-removed rows as own tags', async () => {
    // t7 inherits its album's Current although its own rows name Current and
    // Deep Current; neither is in Browse.
    const current = await trackIds({ filters: filters(tagFilter('Current')) })
    expect(current).toContain('t7')
    expect(
      await trackIds({ filters: filters(tagFilter('Deep Current')) }),
    ).not.toContain('t7')
    expect(
      await trackIds({
        filters: filters(tagFilter('Current')),
        tagLevels: 'track',
      }),
    ).not.toContain('t7')
  })
})

describe('the hierarchy at each level (TTAG-25)', () => {
  it('matches a parent through its descendants at every level', async () => {
    // Current reaches Deep Current on t2, Dense album and artist A.
    expect(
      await trackIds({
        filters: filters(tagFilter('Current')),
        tagLevels: 'track',
      }),
    ).toEqual(['t2'])
    expect(
      await trackIds({
        filters: filters(tagFilter('Current')),
        tagLevels: 'album',
      }),
    ).toEqual(expect.arrayContaining(['t1', 't2', 't3', 't5']))
    expect(
      sorted(
        await trackIds({
          filters: filters(tagFilter('Current')),
          tagLevels: 'artist',
        }),
      ),
    ).toEqual(['t3', 't4'])
  })

  it('leaves out a hidden descendant and matches an explicit hidden tag', async () => {
    for (const location of locations)
      expect(
        await trackIds({
          filters: filters(tagFilter('Current')),
          tagLevels: levelsParam(location),
        }),
      ).not.toContain('t9')
    const hidden = async (tagLevels?: string) =>
      sorted(
        await trackIds({
          filters: filters(tagFilter('Hidden Current')),
          tagLevels,
        }),
      )
    expect(await hidden('track')).toEqual(['t9'])
    expect(await hidden('album')).toEqual(['t4', 't9'])
    expect(await hidden()).toEqual(['t4', 't9'])
  })
})

describe('modes, ranges and search words at a location (TTAG-24)', () => {
  it('applies Required, Any and Exclude over the location', async () => {
    expect(
      await trackIds({
        filters: filters(
          tagFilter('Glass Pop', 'required'),
          tagFilter('Microhouse', 'required'),
        ),
      }),
    ).toEqual(['t5'])
    expect(
      sorted(
        await trackIds({
          filters: filters(
            tagFilter('Glass Pop', 'any'),
            tagFilter('Harbour Bass', 'any'),
          ),
        }),
      ),
    ).toEqual(['t1', 't4', 't5', 't6', 't7', 't8', 't9'])
    expect(
      sorted(
        await trackIds({
          filters: filters(
            tagFilter('Glass Pop', 'any'),
            tagFilter('Harbour Bass', 'any'),
          ),
          tagLevels: 'track',
        }),
      ),
    ).toEqual(['t1', 't5', 't6'])
    expect(
      sorted(
        await trackIds({
          filters: filters(tagFilter('Harbour Bass', 'exclude')),
          tagLevels: 'track',
        }),
      ),
    ).toEqual(['t2', 't3', 't4', 't5', 't7', 't8', 't9'])
    const excludeCurrent = {
      filters: filters(tagFilter('Current', 'exclude')),
    }
    expect(sorted(await trackIds(excludeCurrent))).toEqual([
      't1',
      't5',
      't6',
      't8',
      't9',
    ])
    expect(await trackCount(excludeCurrent)).toBe(5)
  })

  it('keeps ranges and search words', async () => {
    const microhouse = filters(tagFilter('Microhouse'))
    expect(
      await trackIds({
        filters: microhouse,
        ranges: JSON.stringify([{ field: 'durationSec', min: 250 }]),
      }),
    ).toEqual(['t3', 't5'])
    expect(
      await trackIds({
        filters: microhouse,
        tagLevels: 'album',
        ranges: JSON.stringify([{ field: 'durationSec', max: 250 }]),
      }),
    ).toEqual(['t1', 't2'])
    expect(
      await trackIds({
        filters: filters(tagFilter('Deep Current')),
        q: 'bravo',
      }),
    ).toEqual(['t2'])
    expect(
      await trackIds({
        filters: filters(tagFilter('Deep Current')),
        q: 'alpha',
      }),
    ).toEqual([])
    expect(
      await trackIds({
        filters: filters(tagFilter('Deep Current')),
        tagLevels: 'album',
        q: 'alpha',
      }),
    ).toEqual(['t1'])
  })
})

describe('sorting by Tags (TTAG-28)', () => {
  // Groups of ties, compared without their order within the group.
  async function groups(
    tagLevels: string | undefined,
    sizes: number[],
    direction: 'asc' | 'desc' = 'asc',
  ) {
    const ids = await trackIds({ sortBy: 'genre', direction, tagLevels })
    expect(ids).toHaveLength(tracks.length)
    let start = 0
    return sizes.map((size) => {
      const group = sorted(ids.slice(start, start + size))
      start += size
      return group
    })
  }

  it('orders by own first tag at Auto, else the inherited first tag', async () => {
    // t7 Current; t2 (own), t3, t4 Deep Current; t5 Glass Pop (own; its
    // album's first tag is Deep Current); t1 and t6 Harbour Bass (own), t8
    // and t9 Harbour Bass (inherited; t9's own tag is hidden).
    expect(await groups(undefined, [1, 3, 1, 4])).toEqual([
      ['t7'],
      ['t2', 't3', 't4'],
      ['t5'],
      ['t1', 't6', 't8', 't9'],
    ])
  })

  it('orders by the first tag on the track or its album', async () => {
    // t6 and t7 Current; t1, t2, t3, t5 Deep Current; t4 and t9 Harbour
    // Bass; t8 has neither and follows.
    expect(await groups('track,album', [2, 4, 2, 1])).toEqual([
      ['t6', 't7'],
      ['t1', 't2', 't3', 't5'],
      ['t4', 't9'],
      ['t8'],
    ])
  })
})

describe('Tags suggestions (TTAG-29)', () => {
  const genreFields = trackBrowseFields.filter((field) => field.key === 'genre')
  const suggestions = [
    ['current', 'Current'],
    ['deep current', 'Deep Current'],
    ['harbour bass', 'Harbour Bass'],
    ['glass pop', 'Glass Pop'],
    ['microhouse', 'Microhouse'],
  ] as const

  async function suggestedCounts(live: boolean) {
    const { listBrowseFacets } = await import('@/services/browse')
    const counts: Record<string, Partial<Record<Location, number>>> = {}
    for (const [value, tag] of suggestions) {
      counts[tag] = {}
      for (const location of locations) {
        const rows = await listBrowseFacets(
          'track',
          { q: value, tagLevels: levelsParam(location) },
          live ? { fields: genreFields } : {},
        )
        counts[tag][location] =
          rows.find((row) => row.field === 'genre' && row.value === value)
            ?.count ?? 0
      }
    }
    return counts
  }
  const expectedCounts = Object.fromEntries(
    expectedEntries.map(([tag, byLocation]) => [
      tag,
      Object.fromEntries(
        locations.map((location) => [location, byLocation[location].length]),
      ),
    ]),
  )

  it('counts live as the filter does at each location', async () => {
    expect(await suggestedCounts(true)).toEqual(expectedCounts)
  })

  it('counts from the stored vocabulary as the filter does', async () => {
    const { refreshTrackFacetVocabularyForMaintenance } =
      await import('@/services/browse')
    await pool.query(`insert into track_facet_state (singleton, builder, retry_after)
      values (true, 'fixture', '-infinity')`)
    expect(await refreshTrackFacetVocabularyForMaintenance()).toBe(true)
    expect(
      (await pool.query('select 1 from track_facet_value limit 1')).rowCount,
    ).toBe(1)
    expect(await suggestedCounts(false)).toEqual(expectedCounts)
    // The reads above used the stored vocabulary: it is ready and clean.
    expect(
      (await pool.query('select ready from track_facet_state')).rows,
    ).toEqual([{ ready: true }])
    expect((await pool.query('select 1 from track_facet_dirty')).rowCount).toBe(
      0,
    )
  })
})

describe('Tags filters on Albums at each location (TTAG-23)', () => {
  const albumFilter = async (tag: string, tagLevels?: string) =>
    albumIds({ filters: filters(tagFilter(tag)), tagLevels })

  it('keeps Auto: album tags, and the artists’ on an album with fewer than two', async () => {
    // Sparse album inherits artist A's Deep Current; Dense album has two
    // tags, so artist B's Harbour Bass is not read.
    expect(await albumFilter('Current')).toEqual([
      'album-dense',
      'album-glass',
      'album-sparse',
    ])
    expect(await albumFilter('Harbour Bass')).toEqual(['album-sparse'])
    expect(await albumFilter('Glass Pop')).toEqual([
      'album-glass',
      'album-sparse',
    ])
  })

  it('reads the album, the artists and the tracks at their levels', async () => {
    expect(await albumFilter('Harbour Bass', 'album')).toEqual(['album-sparse'])
    // The hidden Hidden Current on Sparse album is left out of Current.
    expect(await albumFilter('Current', 'album')).toEqual([
      'album-dense',
      'album-glass',
    ])
    expect(await albumFilter('Harbour Bass', 'artist')).toEqual(['album-dense'])
    expect(await albumFilter('Glass Pop', 'artist')).toEqual(['album-sparse'])
    // Tracks carrying the tag themselves: t1 and t6 Harbour Bass, t5's owner
    // Glass Pop; not t7's unverified Deep Current or removed Current.
    expect(await albumFilter('Harbour Bass', 'track')).toEqual([
      'album-dense',
      'album-glass',
    ])
    expect(await albumFilter('Glass Pop', 'track')).toEqual(['album-dense'])
    expect(await albumFilter('Current', 'track')).toEqual(['album-dense'])
  })

  it('combines levels', async () => {
    expect(await albumFilter('Harbour Bass', 'track,album')).toEqual([
      'album-dense',
      'album-glass',
      'album-sparse',
    ])
    // Without the two-tag rule, artist B's Harbour Bass reaches Dense album.
    expect(await albumFilter('Harbour Bass', 'album,artist')).toEqual([
      'album-dense',
      'album-sparse',
    ])
    expect(await albumFilter('Glass Pop', 'track,album,artist')).toEqual([
      'album-dense',
      'album-glass',
      'album-sparse',
    ])
    expect(
      await albumIds({
        filters: filters(tagFilter('Glass Pop', 'exclude')),
        tagLevels: 'track',
      }),
    ).toEqual(['album-glass', 'album-quiet', 'album-sparse'])
  })
})

describe('the tagLevels URL parameter (TTAG-26)', () => {
  const headers = {
    cookie: 'session=fixture',
    origin: 'https://web.example.test',
  }
  const ListSchema = z.object({
    data: z.object({ items: z.array(z.object({ id: z.string() })) }),
  })
  async function get(path: string) {
    const { default: app } = await import('@/app')
    return app.request(path, { headers })
  }

  it('answers an unknown location with 422', async () => {
    expect((await get('/api/v1/tracks?tagLevels=bogus')).status).toBe(422)
    expect((await get('/api/v1/albums?tagLevels=bogus')).status).toBe(422)
    expect((await get('/api/v1/tracks?tagLevels=track,track')).status).toBe(422)
  })

  it('accepts levels in any order and normalises them', async () => {
    expect(
      TrackQuerySchema.parse({ tagLevels: 'album,track' }).tagLevels,
    ).toEqual(['track', 'album'])
    expect(
      AlbumQuerySchema.parse({ tagLevels: 'artist,album' }).tagLevels,
    ).toEqual(['album', 'artist'])
    expect(TrackQuerySchema.parse({}).tagLevels).toBeUndefined()
    const params = new URLSearchParams({
      tagLevels: 'album,track',
      filters: filters(tagFilter('Glass Pop')),
      size: '50',
    })
    const tracksResponse = await get(`/api/v1/tracks?${params}`)
    expect(tracksResponse.status).toBe(200)
    expect(
      sorted(
        ListSchema.parse(await tracksResponse.json()).data.items.map(
          (item) => item.id,
        ),
      ),
    ).toEqual(expected['Glass Pop']['track,album'])
    const albumsResponse = await get(`/api/v1/albums?${params}`)
    expect(albumsResponse.status).toBe(200)
    expect(
      sorted(
        ListSchema.parse(await albumsResponse.json()).data.items.map(
          (item) => item.id,
        ),
      ),
    ).toEqual(['album-dense', 'album-glass'])
  })
})
