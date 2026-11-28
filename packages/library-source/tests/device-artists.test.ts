import { afterEach, describe, expect, it } from 'vitest'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import type { BrowseField, BrowseFilter } from '@repo/schemas/browse'
import {
  ArtistQuerySchema,
  ArtistSummarySchema,
  type ArtistQuery,
} from '@repo/schemas/creators'
import type { DeviceArtistRow } from '@repo/schemas/device'
import {
  FIXED_NOW,
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import { artistPayload, tagPayload, type TagOptions } from './fixtures'
import {
  artist,
  artistFields,
  artistPlays,
  listeningStart,
  microseconds,
  seconds,
  tagKey,
  type ArtistRowPatch,
} from './library-fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

let store: DeviceStore | undefined

type OpenOptions = StoreOptions & {
  /** The `fields:artist` row; the shared field list by default, left out when null. */
  fields?: StoreRow | null
  /** The `listening` row; a March 2024 start by default, left out when null. */
  listening?: StoreRow | null
}

async function open(rows: StoreRow[], options: OpenOptions = {}) {
  const { fields, listening, ...storeOptions } = options
  const meta = [
    fields === undefined ? artistFields() : fields,
    listening === undefined ? listeningStart('2024-03-01') : listening,
  ].filter((row) => row !== null)
  store = await openDeviceStore([...meta, ...rows], {
    trackFields: null,
    ...storeOptions,
  })
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

function artistQuery(input: Record<string, unknown> = {}): ArtistQuery {
  return ArtistQuerySchema.parse(input)
}

async function page(device: DeviceStore, input: Record<string, unknown> = {}) {
  return served(
    await device.source.artistPage(artistQuery({ size: 100, ...input })),
  )
}

async function ids(device: DeviceStore, input: Record<string, unknown> = {}) {
  return (await page(device, input)).items.map((item) => item.id)
}

async function count(device: DeviceStore, input: Record<string, unknown> = {}) {
  return served(await device.source.artistCount(artistQuery(input)))
}

/** Page IDs and, for a read the page does not serve, the count's total. */
async function matching(device: DeviceStore, input: Record<string, unknown>) {
  return {
    ids: await ids(device, input),
    total: (await count(device, input)).totalCount,
  }
}

function tag(id: string, options: TagOptions): StoreRow {
  return { entity: 'tag', id, payload: tagPayload(options) }
}

const sorted = (list: string[]) => [...list].sort()

describe('artist items', () => {
  it('returns the stored item with its months from the history start to now', async () => {
    const device = await open([
      artist('a', 'Alpha'),
      artist('b', 'Beta'),
      artistPlays('a', [
        seconds('2023-01-01T00:00:00Z'),
        seconds('2024-04-30T23:59:59Z'),
        seconds('2024-06-01T00:00:00Z'),
        seconds('2024-06-14T08:00:00Z'),
      ]),
    ])
    const result = await page(device)
    const base = artistPayload('a', { name: 'Alpha' }).item
    expect(result.items[0]).toEqual(
      ArtistSummarySchema.parse({ ...base, listeningMonths: [0, 1, 0, 2] }),
    )
    expect(result.items[0]).not.toHaveProperty('listeningScrobbles')
    expect(result.items[0]).not.toHaveProperty('links')
    expect(result.items[1]?.listeningMonths).toEqual([0, 0, 0, 0])
    expect(result).toMatchObject({ page: 1, size: 100, hasMore: false })
  })

  it('counts months in UTC', async () => {
    const device = await open([
      artist('a', 'Alpha'),
      artistPlays('a', [
        seconds('2024-04-30T23:59:59Z'),
        seconds('2024-05-01T00:00:00Z'),
      ]),
    ])
    expect((await page(device)).items[0]?.listeningMonths).toEqual([0, 1, 1, 0])
  })

  it('covers the current month only without a history start', async () => {
    const device = await open(
      [
        artist('a', 'Alpha'),
        artistPlays('a', [seconds('2024-06-02T00:00:00Z')]),
      ],
      { listening: listeningStart(null) },
    )
    expect((await page(device)).items[0]?.listeningMonths).toEqual([1])
  })

  it('adds the period count when a sort period applies', async () => {
    const device = await open([
      artist('a', 'Alpha'),
      artist('b', 'Beta'),
      artistPlays('a', [seconds('2024-06-02T00:00:00Z')]),
    ])
    const items = (await page(device, { listeningSort: { kind: 'all' } })).items
    expect(items.map((item) => [item.id, item.listeningScrobbles])).toEqual([
      ['a', 1],
      ['b', 0],
    ])
  })
})

describe('filters', () => {
  const rows = () => [
    artist('a', 'Alpha', {
      text: {
        playlist: ['Morning'],
        genre: ['Dark Ambient'],
        country: ['Finland'],
        type: ['Person'],
        provider: ['lastfm', 'musicbrainz'],
      },
      extra: { rawTagKeys: ['dark ambient'], playlistIds: ['p-morning'] },
    }),
    artist('b', 'Beta', {
      text: {
        playlist: ['Evening'],
        genre: ['Techno'],
        country: ['Norway'],
        type: ['Group'],
        provider: ['discogs'],
      },
      extra: { rawTagKeys: ['techno'], playlistIds: ['p-evening'] },
    }),
    artist('c', 'Gamma', {
      text: { playlist: [], genre: [], country: [], type: [], provider: [] },
      extra: { rawTagKeys: [], playlistIds: [] },
    }),
  ]

  const cases: [string, string, string[]][] = [
    ['name', 'ALPHA', ['a']],
    ['playlist', 'morning', ['a']],
    ['genre', 'Techno', ['b']],
    ['country', 'NORWAY', ['b']],
    ['type', 'person', ['a']],
    ['provider', 'MusicBrainz', ['a']],
  ]

  for (const [field, value, expected] of cases) {
    it(`matches ${field} by case-insensitive equality in every mode`, async () => {
      const device = await open(rows())
      const rest = ['a', 'b', 'c'].filter((id) => !expected.includes(id))
      const modes: BrowseFilter['mode'][] = [undefined, 'any', 'required']
      for (const mode of modes) {
        const filters = [{ field, value, mode }]
        expect((await count(device, { filters })).totalCount).toBe(
          expected.length,
        )
        if (field !== 'provider')
          expect(await ids(device, { filters })).toEqual(expected)
      }
      expect(
        await ids(device, { filters: [{ field, value, mode: 'exclude' }] }),
      ).toEqual(rest)
    })
  }

  it('does not match part of a value', async () => {
    const device = await open(rows())
    expect(
      await ids(device, { filters: [{ field: 'name', value: 'Alph' }] }),
    ).toEqual([])
    expect(
      await ids(device, { filters: [{ field: 'country', value: 'Fin' }] }),
    ).toEqual([])
  })

  it('puts any and unset filters in one OR group across fields', async () => {
    const device = await open(rows())
    const anyOf = [
      { field: 'name', value: 'Alpha' },
      { field: 'country', value: 'Norway', mode: 'any' },
    ]
    expect(await ids(device, { filters: anyOf })).toEqual(['a', 'b'])
    expect(
      await ids(device, {
        filters: [
          ...anyOf,
          { field: 'type', value: 'Group', mode: 'required' },
        ],
      }),
    ).toEqual(['b'])
    expect(
      await ids(device, {
        filters: [...anyOf, { field: 'type', value: 'Group', mode: 'exclude' }],
      }),
    ).toEqual(['a'])
  })

  it('matches a tag through its aliases and visible descendants', async () => {
    const device = await open([
      ...rows(),
      tagKey('dark ambient', ['ambient']),
      tag('tag-techno', { name: 'Techno' }),
      tag('tag-electronica', {
        name: 'Electronica',
        aliasTargetId: 'tag-techno',
      }),
    ])
    const genre = async (value: string) =>
      ids(device, { filters: [{ field: 'genre', value }] })
    expect(await genre('Ambient')).toEqual(['a'])
    expect(await genre('dark ambient')).toEqual(['a'])
    expect(await genre('Electronica')).toEqual(['b'])
    expect(await genre('Drone')).toEqual([])
  })

  it('leaves out hidden descendants of a tag', async () => {
    const device = await open([
      ...rows(),
      tagKey('dark ambient', ['ambient']),
      tag('tag-dark', { name: 'Dark Ambient', hidden: true }),
    ])
    const genre = async (value: string) =>
      ids(device, { filters: [{ field: 'genre', value }] })
    expect(await genre('Ambient')).toEqual([])
    expect(await genre('Dark Ambient')).toEqual(['a'])
  })

  it('narrows to the artists of the selected playlists', async () => {
    const device = await open(rows())
    expect(await ids(device, { playlistIds: ['p-morning'] })).toEqual(['a'])
    expect(
      await ids(device, { playlistIds: ['p-morning', 'p-evening'] }),
    ).toEqual(['a', 'b'])
    expect(await ids(device, { playlistIds: ['p-unknown'] })).toEqual([])
    expect(await ids(device, { playlistIds: [] })).toEqual(['a', 'b', 'c'])
  })
})

describe('search', () => {
  const rows = () => [
    artist('a', 'Alpha', {
      text: {
        playlist: ['Morning'],
        genre: ['Dark Ambient'],
        country: ['Finland'],
        type: ['Person'],
        provider: ['musicbrainz'],
      },
    }),
    artist('b', 'Beta', {
      text: {
        playlist: ['Evening'],
        genre: ['Techno'],
        country: ['Norway'],
        type: ['Group'],
        provider: ['discogs'],
      },
    }),
    artist('d', 'The Delta', { search: { name: ['The Delta', 'Delta, The'] } }),
  ]

  it('matches each word as a substring of some text field or the sort name', async () => {
    const device = await open(rows())
    const q = async (value: string) => ids(device, { q: value })
    expect(await q('lph')).toEqual(['a'])
    expect(await q('ALPHA morning')).toEqual(['a'])
    expect(await q('alpha evening')).toEqual([])
    expect(await q('finl')).toEqual(['a'])
    expect(await q('dark')).toEqual(['a'])
    expect(await q('techn')).toEqual(['b'])
    expect(await q('roup')).toEqual(['b'])
    expect(await q('discog')).toEqual(['b'])
    expect(await q('Delta,')).toEqual(['d'])
  })

  it('matches short words without the trigram index', async () => {
    const device = await open(rows())
    expect(await ids(device, { q: 'et' })).toEqual(['b'])
    expect(await ids(device, { q: 'et no' })).toEqual(['b'])
  })

  it('takes pattern characters literally', async () => {
    const device = await open([...rows(), artist('s', 'Star*Gazer')])
    expect(await ids(device, { q: 'a*' })).toEqual([])
    expect(await ids(device, { q: 'r*g' })).toEqual(['s'])
    expect(await ids(device, { q: '%' })).toEqual([])
    expect(await ids(device, { q: 'a?p' })).toEqual([])
  })
})

describe('ranges', () => {
  const rows = () => [
    artist('x', 'Xavier', {
      num: {
        createdAt: microseconds('2024-01-01T00:00:00Z'),
        albumCount: 0,
        trackCount: 5,
        scrobbles: 0,
        playlistCount: 0,
      },
    }),
    artist('y', 'Yolanda', {
      item: { albumCount: 1 },
      num: {
        createdAt: microseconds('2024-02-01T00:00:00Z'),
        albumCount: 3,
        trackCount: 20,
        scrobbles: 40,
        playlistCount: 2,
      },
    }),
    artist('z', 'Zed', {
      num: {
        createdAt: microseconds('2024-03-01T00:00:00Z'),
        albumCount: 7,
        trackCount: 0,
        scrobbles: null,
        playlistCount: 5,
      },
    }),
  ]

  const range = async (device: DeviceStore, value: Record<string, unknown>) =>
    ids(device, { ranges: [value] })

  it('bounds the counts inclusively, including items outside the library', async () => {
    const device = await open(rows())
    expect(await range(device, { field: 'albumCount', min: 3 })).toEqual([
      'y',
      'z',
    ])
    expect(
      await range(device, { field: 'albumCount', min: 3, max: 3 }),
    ).toEqual(['y'])
    expect(await range(device, { field: 'trackCount', max: 5 })).toEqual([
      'x',
      'z',
    ])
    expect(
      await range(device, { field: 'playlistCount', min: 1, max: 4 }),
    ).toEqual(['y'])
    expect(await range(device, { field: 'scrobbles', min: 0 })).toEqual([
      'x',
      'y',
    ])
  })

  it('passes a missing value only with includeMissing', async () => {
    const device = await open(rows())
    expect(
      await range(device, {
        field: 'scrobbles',
        min: 1,
        includeMissing: true,
      }),
    ).toEqual(['y', 'z'])
    expect(await range(device, { field: 'scrobbles' })).toEqual(['x', 'y'])
    expect(
      await range(device, { field: 'scrobbles', includeMissing: true }),
    ).toEqual(['x', 'y', 'z'])
  })

  it('compares millisecond date bounds with stored microseconds', async () => {
    const device = await open(rows())
    const february = Date.parse('2024-02-01T00:00:00Z')
    expect(await range(device, { field: 'createdAt', min: february })).toEqual([
      'y',
      'z',
    ])
    expect(await range(device, { field: 'createdAt', max: february })).toEqual([
      'x',
      'y',
    ])
    expect(
      await range(device, { field: 'createdAt', max: february - 0.5 }),
    ).toEqual(['x'])
    expect(
      await range(device, { field: 'createdAt', min: february + 0.5 }),
    ).toEqual(['z'])
  })
})

describe('sorting', () => {
  type TextKey = keyof DeviceArtistRow['sort']
  type NumberKey = keyof DeviceArtistRow['num']
  const textKeys: TextKey[] = [
    'name',
    'playlist',
    'genre',
    'country',
    'type',
    'provider',
  ]
  const numberKeys: NumberKey[] = [
    'createdAt',
    'albumCount',
    'trackCount',
    'scrobbles',
    'playlistCount',
  ]

  const named = (patches: ArtistRowPatch[]) =>
    patches.map((patch, index) =>
      artist(`k${index + 1}`, `Artist ${index + 1}`, patch),
    )

  /** Artists k1 to k4 with these sort values. */
  function textRows(key: TextKey, values: (string | null)[]) {
    return named(
      values.map((value) => {
        const sort: Partial<DeviceArtistRow['sort']> = {}
        sort[key] = value
        return { sort }
      }),
    )
  }

  function numberRows(key: NumberKey, values: (number | null)[]) {
    return named(
      values.map((value) => {
        const num: Partial<DeviceArtistRow['num']> = {}
        num[key] = value
        return { num }
      }),
    )
  }

  // k1 and k4 tie; k2 has no value.
  const cases = [
    ...textKeys.map((key) => ({
      key,
      rows: () => textRows(key, ['m', null, 'b', 'm']),
    })),
    ...numberKeys.map((key) => ({
      key,
      rows: () => numberRows(key, [20, null, 3, 20]),
    })),
  ]

  for (const { key, rows } of cases) {
    it(`sorts by ${key} in both directions, nulls last, ties by ID`, async () => {
      const device = await open(rows())
      expect(await ids(device, { sortBy: key })).toEqual([
        'k3',
        'k1',
        'k4',
        'k2',
      ])
      expect(await ids(device, { sortBy: key, direction: 'desc' })).toEqual([
        'k1',
        'k4',
        'k3',
        'k2',
      ])
    })
  }

  it('orders text by code point', async () => {
    const device = await open(textRows('name', ['é', 'z', 'a', 'Z']))
    expect(await ids(device, { sortBy: 'name' })).toEqual([
      'k4',
      'k3',
      'k2',
      'k1',
    ])
  })

  it('sorts by the period count, the last year by default', async () => {
    const device = await open([
      artist('a', 'Alpha'),
      artist('b', 'Beta'),
      artist('c', 'Gamma'),
      artistPlays('a', [
        seconds('2022-01-01T00:00:00Z'),
        seconds('2022-02-01T00:00:00Z'),
        seconds('2024-06-01T00:00:00Z'),
      ]),
      artistPlays('b', [
        seconds('2024-06-01T00:00:00Z'),
        seconds('2024-06-02T00:00:00Z'),
      ]),
    ])
    const rows = async (input: Record<string, unknown>) =>
      (await page(device, input)).items.map((item) => [
        item.id,
        item.listeningScrobbles,
      ])
    expect(
      await rows({ sortBy: 'listeningScrobbles', direction: 'desc' }),
    ).toEqual([
      ['b', 2],
      ['a', 1],
      ['c', 0],
    ])
    expect(
      await rows({
        sortBy: 'listeningScrobbles',
        direction: 'desc',
        listeningSort: { kind: 'all' },
      }),
    ).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 0],
    ])
    expect(
      await rows({ sortBy: 'name', listeningSort: { kind: 'all' } }),
    ).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 0],
    ])
  })
})

describe('paging', () => {
  const rows = () =>
    ['a', 'b', 'c', 'd', 'e'].map((id) => artist(id, `Artist ${id}`))

  it('reads size + 1 rows to tell whether the page continues', async () => {
    const device = await open(rows())
    const at = async (pageNumber: number) => {
      const result = await page(device, { page: pageNumber, size: 2 })
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await at(1)).toEqual([['a', 'b'], true])
    expect(await at(2)).toEqual([['c', 'd'], true])
    expect(await at(3)).toEqual([['e'], false])
    expect(await at(4)).toEqual([[], false])
  })

  it('ends the result at limitResults', async () => {
    const device = await open(rows())
    const at = async (pageNumber: number) => {
      const result = await page(device, {
        page: pageNumber,
        size: 2,
        limitResults: 3,
      })
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await at(1)).toEqual([['a', 'b'], true])
    expect(await at(2)).toEqual([['c'], false])
    expect(await at(3)).toEqual([[], false])
  })
})

describe('listening rules', () => {
  const rows = () => [
    artist('a', 'Alpha'),
    artist('b', 'Beta'),
    artist('c', 'Gamma'),
    artistPlays('a', [
      seconds('2022-01-01T00:00:00Z'),
      seconds('2023-06-15T12:00:00Z'),
      seconds('2024-01-01T10:00:00Z'),
      seconds('2024-06-10T00:00:00Z'),
    ]),
    artistPlays('b', [
      seconds('2024-06-14T00:00:00Z'),
      seconds('2024-06-15T12:00:00Z'),
    ]),
  ]
  const week = { kind: 'rolling', amount: 7, unit: 'days' }
  const year = { kind: 'rolling', amount: 1, unit: 'years' }

  it('bounds the count in each period, inclusive', async () => {
    const device = await open(rows(), { now: FIXED_NOW })
    const rule = async (period: unknown, bounds: Record<string, number>) =>
      sorted(
        await ids(device, {
          listening: { match: 'all', rules: [{ period, ...bounds }] },
        }),
      )
    expect(await rule(week, { min: 1 })).toEqual(['a', 'b'])
    expect(await rule(week, { min: 2 })).toEqual(['b'])
    expect(await rule(year, { min: 3 })).toEqual(['a'])
    expect(await rule({ kind: 'all' }, { max: 0 })).toEqual(['c'])
    expect(
      await rule(
        { kind: 'dates', from: '2024-01-01', to: '2024-01-01' },
        {
          min: 1,
        },
      ),
    ).toEqual(['a'])
    expect(await rule({ kind: 'dates', to: '2022-12-31' }, { min: 1 })).toEqual(
      ['a'],
    )
  })

  it('ANDs rules for all and ORs them for any', async () => {
    const device = await open(rows(), { now: FIXED_NOW })
    const rules = [
      { period: { kind: 'all' }, min: 3 },
      { period: week, max: 1 },
    ]
    expect(
      sorted(await ids(device, { listening: { match: 'all', rules } })),
    ).toEqual(['a'])
    expect(
      sorted(
        await ids(device, {
          listening: {
            match: 'any',
            rules: [
              { period: week, min: 2 },
              { period: { kind: 'all' }, max: 0 },
            ],
          },
        }),
      ),
    ).toEqual(['b', 'c'])
    expect(
      (await count(device, { listening: { match: 'all', rules } })).totalCount,
    ).toBe(1)
  })
})

describe('counts', () => {
  const rows = () => [
    artist('a', 'Alpha', { text: { country: ['Finland'] } }),
    artist('b', 'Beta'),
    artist('c', 'Gamma'),
  ]

  it('gives the unfiltered count after Clear filters', async () => {
    const device = await open(rows())
    expect(await count(device)).toEqual({ totalCount: 3, unfilteredCount: 3 })
    expect(
      await count(device, {
        filters: [{ field: 'country', value: 'finland' }],
      }),
    ).toEqual({ totalCount: 1, unfilteredCount: 3 })
    expect(await count(device, { q: 'beta' })).toEqual({
      totalCount: 1,
      unfilteredCount: 3,
    })
    expect(
      await count(device, { ranges: [{ field: 'albumCount', min: 2 }] }),
    ).toEqual({ totalCount: 0, unfilteredCount: 3 })
    expect(await count(device, { playlistIds: ['p-none'] })).toEqual({
      totalCount: 0,
      unfilteredCount: 3,
    })
    expect(
      await count(device, {
        listening: {
          match: 'all',
          rules: [{ period: { kind: 'all' }, min: 1 }],
        },
      }),
    ).toEqual({ totalCount: 0, unfilteredCount: 3 })
  })

  it('caps the total at limitResults but not the unfiltered count', async () => {
    const device = await open(rows())
    expect(await count(device, { limitResults: 2 })).toEqual({
      totalCount: 2,
      unfilteredCount: 3,
    })
    expect(await count(device, { limitResults: 1, q: 'a' })).toEqual({
      totalCount: 1,
      unfilteredCount: 3,
    })
  })

  it('leaves the count alone for a sort period without rules', async () => {
    const device = await open(rows())
    expect(
      await count(device, {
        sortBy: 'listeningScrobbles',
        listeningSort: { kind: 'all' },
      }),
    ).toEqual({ totalCount: 3, unfilteredCount: 3 })
  })
})

describe('reads the device leaves to the API', () => {
  const rows = () => [artist('a', 'Alpha'), artist('b', 'Beta')]

  it('leaves catalog scopes other than the library', async () => {
    const device = await open(rows())
    for (const scope of [
      { libraryScope: 'all' },
      { libraryScope: 'outside' },
      { discoverySourceScope: 'selection', discoverySources: 'scrobble' },
    ]) {
      expect(reason(await device.source.artistPage(artistQuery(scope)))).toBe(
        'catalog-scope',
      )
      expect(reason(await device.source.artistCount(artistQuery(scope)))).toBe(
        'catalog-scope',
      )
    }
    expect(
      await ids(device, {
        libraryScope: 'library',
        discoverySourceScope: 'selection',
      }),
    ).toEqual(['a', 'b'])
  })

  it('leaves a page with a Provider filter other than exclude, and serves its count', async () => {
    const device = await open(rows())
    for (const mode of [undefined, 'any', 'required']) {
      const filters = [{ field: 'provider', value: 'lastfm', mode }]
      expect(
        reason(await device.source.artistPage(artistQuery({ filters }))),
      ).toBe('provider-filter')
      expect((await count(device, { filters })).totalCount).toBe(2)
    }
    expect(
      await ids(device, {
        filters: [{ field: 'provider', value: 'lastfm', mode: 'exclude' }],
      }),
    ).toEqual([])
    expect(
      await matching(device, {
        filters: [{ field: 'provider', value: 'other', mode: 'exclude' }],
      }),
    ).toEqual({ ids: ['a', 'b'], total: 2 })
  })

  it('leaves a field the API does not list as an invalid query', async () => {
    const fields = artistBrowseFields.filter(
      (field) => field.key !== 'country' && field.key !== 'albumCount',
    )
    const device = await open(rows(), { fields: artistFields(fields) })
    expect(
      reason(
        await device.source.artistPage(
          artistQuery({ filters: [{ field: 'country', value: 'Finland' }] }),
        ),
      ),
    ).toBe('invalid-query')
    expect(
      reason(
        await device.source.artistCount(
          artistQuery({ ranges: [{ field: 'albumCount', min: 1 }] }),
        ),
      ),
    ).toBe('invalid-query')
    expect(
      reason(
        await device.source.artistPage(artistQuery({ sortBy: 'country' })),
      ),
    ).toBe('invalid-query')
  })

  it('leaves a search over a field the rows do not carry', async () => {
    const label: BrowseField = {
      key: 'pluginLabel',
      label: 'Label',
      type: 'text',
      filterable: true,
    }
    const device = await open(rows(), {
      fields: artistFields([...artistBrowseFields, label]),
    })
    expect(
      reason(await device.source.artistPage(artistQuery({ q: 'alpha' }))),
    ).toBe('unknown-field')
    expect(await ids(device)).toEqual(['a', 'b'])
  })

  it('answers not-ready before the first fill or without its meta rows', async () => {
    const empty = await open(rows(), { ready: false })
    expect(reason(await empty.source.artistPage(artistQuery()))).toBe(
      'not-ready',
    )
    await empty.close()
    const noFields = await open(rows(), { fields: null })
    expect(reason(await noFields.source.artistCount(artistQuery()))).toBe(
      'not-ready',
    )
    await noFields.close()
    const noListening = await open(rows(), { listening: null })
    expect(reason(await noListening.source.artistPage(artistQuery()))).toBe(
      'not-ready',
    )
    expect((await count(noListening)).totalCount).toBe(2)
    expect(await ids(noListening, { q: 'nobody' })).toEqual([])
  })
})
