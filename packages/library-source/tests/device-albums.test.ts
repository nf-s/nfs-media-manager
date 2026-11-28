import { afterEach, describe, expect, it } from 'vitest'
import {
  albumBrowseFields,
  LIBRARY_PLAYLIST_FILTER_FIELD,
} from '@repo/schemas/browse'
import { AlbumListeningHistogramQuerySchema } from '@repo/schemas/media'
import {
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import {
  BASE_US,
  DAY_US,
  addedOn,
  albumFieldsRow,
  albumPlays,
  albumPluginFields,
  albumQuery,
  albumRow,
  albumTag,
  fieldsRow,
  seconds,
  sorted,
  tagKey,
  titled,
  type AlbumRowPatch,
} from './media-fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

let store: DeviceStore | undefined

/** A store with the rows and the Albums field list (with plugin fields). */
async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore([albumFieldsRow(), ...rows], options)
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const album = (id: string, patch: AlbumRowPatch = {}) => albumRow(id, patch)

async function pageIds(
  device: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<string[]> {
  const page = served(
    await device.source.albumPage(albumQuery({ size: 100, ...input })),
  )
  return page.items.map((item) => item.id)
}

async function count(device: DeviceStore, input: Record<string, unknown>) {
  return served(await device.source.albumCount(albumQuery(input)))
}

describe('visibility', () => {
  const rows = () => [
    album('normal', addedOn(3)),
    album('archived', addedOn(2, { extra: { archived: true } })),
    album(
      'edition',
      addedOn(1, {
        text: { edition: ['Edition of another album'] },
        extra: { isEdition: true },
      }),
    ),
  ]

  it('hides archived albums unless asked for', async () => {
    const device = await open(rows())
    expect(await pageIds(device)).toEqual(['normal'])
    expect(await pageIds(device, { includeArchived: 'true' })).toEqual([
      'normal',
      'archived',
    ])
    expect(await pageIds(device, { includeArchived: 'false' })).toEqual([
      'normal',
    ])
  })

  it('hides editions unless asked for as rows or by an Edition filter in any mode', async () => {
    const device = await open(rows())
    expect(await pageIds(device, { editions: 'true' })).toEqual([
      'normal',
      'edition',
    ])
    const edition = { field: 'edition', value: 'edition of another album' }
    expect(await pageIds(device, { filters: [edition] })).toEqual(['edition'])
    expect(
      await pageIds(device, { filters: [{ ...edition, mode: 'exclude' }] }),
    ).toEqual(['normal'])
    expect(
      await pageIds(device, {
        filters: [{ field: 'edition', value: 'Not an edition' }],
      }),
    ).toEqual(['normal'])
  })

  it('keeps the toggles and hides editions again in unfilteredCount', async () => {
    const device = await open(rows())
    expect(
      await count(device, {
        filters: [{ field: 'edition', value: 'Edition of another album' }],
      }),
    ).toEqual({ totalCount: 1, unfilteredCount: 1 })
    expect(
      await count(device, {
        includeArchived: 'true',
        editions: 'true',
        filters: [{ field: 'title', value: 'Album normal' }],
      }),
    ).toEqual({ totalCount: 1, unfilteredCount: 3 })
    expect(await count(device, {})).toEqual({
      totalCount: 1,
      unfilteredCount: 1,
    })
  })
})

describe('filters', () => {
  const rows = () => [
    album(
      'a',
      titled('Alpha', {
        text: {
          artist: ['Ann'],
          country: ['Norway'],
          playlist: ['Morning'],
          collection: ['Shelf'],
          source: ['Bandcamp'],
          provider: ['discogs'],
          pluginMood: ['Calm'],
        },
      }),
    ),
    album(
      'b',
      titled('Beta', {
        text: {
          artist: ['Bob'],
          country: ['Japan', 'Norway'],
          playlist: ['Evening'],
          provider: ['musicbrainz'],
          pluginMood: ['Bright'],
        },
      }),
    ),
    album(
      'c',
      titled('Gamma', {
        text: { artist: ['Ann', 'Cem'], playlist: [], pluginMood: [] },
      }),
    ),
    album('d', titled('İstanbul', { text: { artist: ['Cem'] } })),
  ]
  const ids = async (filters: unknown[]) =>
    sorted(await pageIds(await open(rows()), { filters }))

  it('compares text case-insensitively as PostgreSQL lower() does', async () => {
    expect(await ids([{ field: 'title', value: 'ALPHA' }])).toEqual(['a'])
    expect(await ids([{ field: 'title', value: 'istanbul' }])).toEqual(['d'])
    expect(await ids([{ field: 'title', value: 'İSTANBUL' }])).toEqual(['d'])
    expect(await ids([{ field: 'title', value: 'alph' }])).toEqual([])
  })

  it('matches every text field and plugin text by value', async () => {
    expect(await ids([{ field: 'artist', value: 'ann' }])).toEqual(['a', 'c'])
    expect(await ids([{ field: 'country', value: 'NORWAY' }])).toEqual([
      'a',
      'b',
    ])
    expect(await ids([{ field: 'playlist', value: 'morning' }])).toEqual(['a'])
    expect(await ids([{ field: 'collection', value: 'shelf' }])).toEqual(['a'])
    expect(await ids([{ field: 'source', value: 'bandcamp' }])).toEqual(['a'])
    expect(await ids([{ field: 'provider', value: 'MusicBrainz' }])).toEqual([
      'b',
    ])
    expect(await ids([{ field: 'pluginMood', value: 'bright' }])).toEqual(['b'])
  })

  it('ORs any and unset filters across fields', async () => {
    expect(
      await ids([
        { field: 'title', value: 'Alpha' },
        { field: 'artist', value: 'bob', mode: 'any' },
      ]),
    ).toEqual(['a', 'b'])
  })

  it('ANDs required filters and the any group', async () => {
    expect(
      await ids([
        { field: 'artist', value: 'ann', mode: 'required' },
        { field: 'title', value: 'gamma' },
        { field: 'title', value: 'beta' },
      ]),
    ).toEqual(['c'])
  })

  it('negates exclude filters', async () => {
    expect(
      await ids([{ field: 'artist', value: 'cem', mode: 'exclude' }]),
    ).toEqual(['a', 'b'])
  })

  it('matches the Edition labels as toLowerCase compares them', async () => {
    const device = await open([
      album('plain'),
      album('edition', {
        text: { edition: ['Edition of another album'] },
        extra: { isEdition: true },
      }),
    ])
    const edition = async (value: string) =>
      pageIds(device, { filters: [{ field: 'edition', value }] })
    expect(await edition('EDITION OF ANOTHER ALBUM')).toEqual(['edition'])
    expect(await edition('not an edition')).toEqual(['plain'])
    expect(await edition('edition')).toEqual([])
  })
})

describe('tags', () => {
  const tags = () => [
    albumTag('tag-amb', { name: 'Ambient', identityKeys: ['ambience'] }),
    albumTag('tag-dark', { name: 'Dark Ambient' }),
    albumTag('tag-secret', { name: 'Secret Ambient', hidden: true }),
    albumTag('tag-chill', { name: 'Chill', aliasTargetId: 'tag-amb' }),
    albumTag('tag-noise', { name: 'Noise', hidden: true }),
    albumTag('tag-old', { name: 'Old Noise', aliasTargetId: 'tag-noise' }),
    albumTag('tag-rock', { name: 'Rock' }),
    albumTag('tag-jazz', { name: 'Jazz' }),
    tagKey('album', 'dark ambient', ['ambient']),
    tagKey('album', 'secret ambient', ['ambient']),
  ]
  const tagged = (
    id: string,
    extra: {
      tagIds?: string[]
      releaseTagCount?: number
      artistTagKeys?: string[]
      trackTagIds?: string[]
    },
  ) =>
    album(id, {
      extra: {
        tagIds: [],
        releaseTagCount: 0,
        artistTagKeys: [],
        trackTagIds: [],
        ...extra,
      },
    })
  const albums = () => [
    tagged('a1', { tagIds: ['tag-amb'], releaseTagCount: 1 }),
    tagged('a2', { tagIds: ['tag-dark'], releaseTagCount: 1 }),
    tagged('a3', { tagIds: ['tag-secret'] }),
    tagged('a4', { artistTagKeys: ['ambient'] }),
    tagged('a5', {
      tagIds: ['tag-rock', 'tag-jazz'],
      releaseTagCount: 2,
      artistTagKeys: ['ambient'],
    }),
    tagged('a6', { tagIds: ['tag-chill'], releaseTagCount: 1 }),
    tagged('a7', { tagIds: ['tag-noise'] }),
    tagged('a8', { trackTagIds: ['tag-amb'] }),
    tagged('a9', {
      tagIds: ['tag-rock'],
      releaseTagCount: 1,
      artistTagKeys: ['ambient'],
    }),
  ]
  const ids = async (filters: unknown[], input: Record<string, unknown> = {}) =>
    sorted(
      await pageIds(await open([...tags(), ...albums()]), {
        filters,
        ...input,
      }),
    )
  const genre = (value: string) => [{ field: 'genre', value }]

  it('matches the tag, its visible descendants and the artist fallback at Auto', async () => {
    expect(await ids(genre('ambient'))).toEqual(['a1', 'a2', 'a4', 'a9'])
    expect(await ids(genre('  AMBIENT '))).toEqual(['a1', 'a2', 'a4', 'a9'])
  })

  it('resolves identity keys and aliases, hidden targets included', async () => {
    expect(await ids(genre('Ambience'))).toEqual(['a1', 'a2', 'a4', 'a9'])
    expect(await ids(genre('chill'))).toEqual(['a1', 'a2', 'a4', 'a6', 'a9'])
    expect(await ids(genre('old noise'))).toEqual(['a7'])
  })

  it('matches direct carriers of a hidden tag, but not hidden descendants', async () => {
    expect(await ids(genre('noise'))).toEqual(['a7'])
    expect(await ids(genre('secret ambient'))).toEqual(['a3'])
  })

  it('reads the chosen tag levels', async () => {
    const levels = (tagLevels: string) => ids(genre('ambient'), { tagLevels })
    expect(await levels('track')).toEqual(['a8'])
    expect(await levels('album')).toEqual(['a1', 'a2'])
    expect(await levels('artist')).toEqual(['a4', 'a5', 'a9'])
    expect(await levels('artist,track')).toEqual(['a4', 'a5', 'a8', 'a9'])
  })

  it('serves the Album and Artist tag fields, whatever the levels', async () => {
    for (const tagLevels of [undefined, 'track']) {
      expect(
        await ids([{ field: 'albumTag', value: 'ambient' }], { tagLevels }),
      ).toEqual(['a1', 'a2'])
      expect(
        await ids([{ field: 'artistTag', value: 'ambient' }], { tagLevels }),
      ).toEqual(['a4', 'a5', 'a9'])
    }
  })

  it('takes the tag scope as a required Tags filter', async () => {
    expect(await ids([], { tag: 'ambient' })).toEqual(['a1', 'a2', 'a4', 'a9'])
    expect(
      await ids([{ field: 'albumTag', value: 'rock' }], { tag: 'ambient' }),
    ).toEqual(['a9'])
    const device = await open([...tags(), ...albums()])
    expect(await count(device, { tag: 'ambient' })).toEqual({
      totalCount: 4,
      unfilteredCount: 4,
    })
    expect(
      await count(device, { tag: 'ambient', q: 'a1', tagLevels: 'album' }),
    ).toEqual({ totalCount: 1, unfilteredCount: 2 })
  })
})

describe('search', () => {
  const rows = () => [
    album('s1', titled('Blue Train', { text: { artist: ['Coltrane'] } })),
    album('s2', { text: { country: ['Japan'] } }),
    album('s3', { text: { playlist: ['Morning Mix'] } }),
    album('s4', { search: { albumTag: ['Hard Bop'] } }),
    album('s5', { search: { artistTag: ['Free Jazz'] } }),
    album('s6', { text: { provider: ['discogs'], collection: ['Vault'] } }),
    album('s7', { text: { pluginMood: ['Melancholy'] } }),
    album('s8', {
      text: { source: ['Bandcamp'], edition: ['Edition of another album'] },
      extra: { isEdition: true },
    }),
  ]
  const ids = async (q: string, input: Record<string, unknown> = {}) =>
    sorted(await pageIds(await open(rows()), { q, ...input }))

  it('needs every word in some searched field', async () => {
    expect(await ids('blue coltrane')).toEqual(['s1'])
    expect(await ids('blue morning')).toEqual([])
  })

  it('reads every searched field, plugin text included', async () => {
    expect(await ids('japan')).toEqual(['s2'])
    expect(await ids('MIX')).toEqual(['s3'])
    expect(await ids('bop')).toEqual(['s4'])
    expect(await ids('free')).toEqual(['s5'])
    expect(await ids('discogs')).toEqual(['s6'])
    expect(await ids('vault')).toEqual(['s6'])
    expect(await ids('melan')).toEqual(['s7'])
    expect(await ids('bandcamp', { editions: 'true' })).toEqual(['s8'])
  })

  it('matches short words and takes pattern characters literally', async () => {
    expect(await ids('ja')).toEqual(['s2', 's5'])
    expect(await ids('b*p')).toEqual([])
  })

  it('leaves out the Edition labels', async () => {
    expect(await ids('edition', { editions: 'true' })).toEqual([])
    expect(await ids('not')).toEqual([])
  })
})

describe('ranges', () => {
  const released = (day: number) => BASE_US + day * DAY_US
  const rows = () => [
    album('r1', {
      num: {
        releaseDate: released(1),
        lastListenedAt: released(1),
        pluginScore: 3,
        pluginSeen: released(1),
      },
    }),
    album('r2', {
      num: {
        releaseDate: released(2),
        lastListenedAt: null,
        pluginScore: 8,
        pluginSeen: null,
      },
    }),
    album('r3', {
      num: { releaseDate: null, durationSec: null, pluginScore: null },
    }),
  ]
  const ids = async (ranges: unknown[]) =>
    sorted(await pageIds(await open(rows()), { ranges }))
  const ms = (day: number) => released(day) / 1000

  it('compares millisecond date bounds with microsecond values, inclusively', async () => {
    expect(
      await ids([{ field: 'releaseDate', min: ms(1), max: ms(1) }]),
    ).toEqual(['r1'])
    expect(await ids([{ field: 'releaseDate', min: ms(1) + 0.0005 }])).toEqual([
      'r2',
    ])
    expect(
      await ids([{ field: 'lastListenedAt', max: ms(1) - 0.0005 }]),
    ).toEqual([])
    expect(await ids([{ field: 'pluginSeen', min: ms(1) }])).toEqual(['r1'])
    expect(
      await ids([
        { field: 'dateAdded', min: BASE_US / 1000, max: BASE_US / 1000 },
      ]),
    ).toEqual(['r1', 'r2', 'r3'])
  })

  it('treats missing values with includeMissing', async () => {
    expect(await ids([{ field: 'releaseDate' }])).toEqual(['r1', 'r2'])
    expect(await ids([{ field: 'releaseDate', includeMissing: true }])).toEqual(
      ['r1', 'r2', 'r3'],
    )
    expect(
      await ids([{ field: 'pluginScore', min: 5, includeMissing: true }]),
    ).toEqual(['r2', 'r3'])
    expect(
      await ids([
        { field: 'lastListenedAt', min: ms(0), includeMissing: true },
      ]),
    ).toEqual(['r1', 'r2', 'r3'])
    expect(await ids([{ field: 'durationSec', max: 3000 }])).toEqual([
      'r1',
      'r2',
    ])
  })

  it('ANDs ranges', async () => {
    expect(
      await ids([
        { field: 'pluginScore', min: 1 },
        { field: 'trackCount', min: 10, max: 10 },
        { field: 'releaseDate', max: ms(1) },
      ]),
    ).toEqual(['r1'])
  })
})

describe('sorting', () => {
  type Value = string | number | null
  /** A primary value per album; t1 and t4 tie and keep ID order. */
  const text: Value[] = ['b', 'a', null, 'b']
  const number: Value[] = [2, 1, null, 2]
  const ascending = ['t2', 't1', 't4', 't3']
  const descending = ['t1', 't4', 't2', 't3']

  type Case = {
    sortBy: string
    values: Value[]
    patch: (value: Value) => AlbumRowPatch
    tagLevels?: string
  }
  const str = (value: Value) =>
    typeof value === 'number' ? String(value) : value
  const num = (value: Value) =>
    typeof value === 'string' ? Number(value) : value
  const textSort = (key: string): Case => ({
    sortBy: key,
    values: text,
    patch: (v) => ({ sort: { [key]: str(v) } }),
  })
  const numberSort = (key: string): Case => ({
    sortBy: key,
    values: number,
    patch: (v) => ({ num: { [key]: num(v) } }),
  })
  const cases: Case[] = [
    ...[
      'title',
      'artist',
      'albumTag',
      'artistTag',
      'country',
      'playlist',
      'collection',
      'source',
      'provider',
      'edition',
      'pluginMood',
    ].map(textSort),
    {
      sortBy: 'genre',
      values: text,
      patch: (v) => ({ genre: { auto: str(v) } }),
    },
    {
      sortBy: 'genre',
      tagLevels: 'album,track',
      values: text,
      patch: (v) => ({ genre: { 'track,album': str(v) } }),
    },
    ...[
      'releaseDate',
      'dateAdded',
      'durationSec',
      'trackCount',
      'scrobbles',
      'lastListenedAt',
      'scrobblesLast1y',
      'scrobblesLast5y',
      'ratingRymValue',
      'ratingRymVotes',
      'ratingDiscogsValue',
      'ratingDiscogsVotes',
      'ratingMetacriticValue',
      'ratingMetacriticVotes',
      'popularityDiscogs',
      'popularitySpotify',
      'popularityLastFm',
      'pluginScore',
      'pluginSeen',
    ].map(numberSort),
  ]

  it('covers every field of the list', () => {
    expect(new Set(cases.map((testCase) => testCase.sortBy))).toEqual(
      new Set([...albumBrowseFields, ...albumPluginFields].map((f) => f.key)),
    )
  })

  it.each(cases)(
    'orders $sortBy ($tagLevels) in both directions with nulls last',
    async (testCase) => {
      const device = await open(
        testCase.values.map((value, index) =>
          album(`t${index + 1}`, testCase.patch(value)),
        ),
      )
      const order = (direction: string) =>
        pageIds(device, {
          sortBy: testCase.sortBy,
          direction,
          tagLevels: testCase.tagLevels,
        })
      expect(await order('asc')).toEqual(ascending)
      expect(await order('desc')).toEqual(
        testCase.sortBy === 'title' ? ['t3', 't1', 't4', 't2'] : descending,
      )
    },
  )

  it('orders text by code point', async () => {
    const device = await open([
      album('upper', { sort: { artist: 'Zed' } }),
      album('lower', { sort: { artist: 'zed' } }),
      album('accent', { sort: { artist: 'éclair' } }),
      album('astral', { sort: { artist: '\u{1F600}' } }),
      album('bmp', { sort: { artist: '～' } }),
    ])
    expect(
      await pageIds(device, { sortBy: 'artist', direction: 'asc' }),
    ).toEqual(['upper', 'lower', 'accent', 'bmp', 'astral'])
  })

  it('sorts by the default, Added descending, with the ID tie-break', async () => {
    const device = await open([
      album('b', addedOn(1)),
      album('a', addedOn(1)),
      album('c', addedOn(2)),
    ])
    expect(await pageIds(device)).toEqual(['c', 'a', 'b'])
  })

  it('sorts by the scrobbles in a period, the rolling year by default', async () => {
    const device = await open([
      album('quiet'),
      album('busy'),
      album('old'),
      albumPlays('quiet', [seconds('2024-06-01T00:00:00Z')]),
      albumPlays('busy', [
        seconds('2024-05-01T00:00:00Z'),
        seconds('2024-06-01T00:00:00Z'),
      ]),
      albumPlays('old', [
        seconds('2020-01-01T00:00:00Z'),
        seconds('2020-01-02T00:00:00Z'),
        seconds('2020-01-03T00:00:00Z'),
      ]),
    ])
    const page = served(
      await device.source.albumPage(
        albumQuery({ sortBy: 'listeningScrobbles' }),
      ),
    )
    expect(
      page.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['busy', 2],
      ['quiet', 1],
      ['old', 0],
    ])
    const allTime = served(
      await device.source.albumPage(
        albumQuery({
          sortBy: 'listeningScrobbles',
          listeningSort: { kind: 'all' },
          direction: 'asc',
        }),
      ),
    )
    expect(allTime.items.map((item) => item.id)).toEqual([
      'quiet',
      'busy',
      'old',
    ])
    const plain = served(await device.source.albumPage(albumQuery()))
    expect(plain.items.every((item) => !('listeningScrobbles' in item))).toBe(
      true,
    )
    const column = served(
      await device.source.albumList(
        albumQuery({
          listeningSort: { kind: 'all' },
          sortBy: 'title',
          direction: 'asc',
        }),
      ),
    )
    expect(
      column.items.map((item) => [item.id, item.listeningScrobbles]),
    ).toEqual([
      ['busy', 2],
      ['old', 3],
      ['quiet', 1],
    ])
  })
})

describe('listening rules', () => {
  const at = seconds
  const rows = () => [
    album('recent'),
    album('once'),
    album('silent'),
    albumPlays('recent', [
      at('2024-06-01T00:00:00Z'),
      at('2024-06-02T00:00:00Z'),
    ]),
    albumPlays('once', [at('2001-01-01T00:00:00Z')]),
  ]
  const ids = async (listening: Record<string, unknown>) =>
    sorted(await pageIds(await open(rows()), { listening }))
  const recent = { kind: 'rolling', amount: 30, unit: 'days' }

  it('filters with rules, ANDed or ORed, and counts absent plays as zero', async () => {
    expect(
      await ids({ match: 'all', rules: [{ period: recent, min: 1 }] }),
    ).toEqual(['recent'])
    expect(
      await ids({ match: 'all', rules: [{ period: { kind: 'all' }, max: 0 }] }),
    ).toEqual(['silent'])
    expect(
      await ids({
        match: 'any',
        rules: [
          { period: recent, min: 2 },
          { period: { kind: 'all' }, min: 1, max: 1 },
        ],
      }),
    ).toEqual(['once', 'recent'])
    expect(
      await ids({
        match: 'all',
        rules: [
          { period: recent, min: 1 },
          { period: { kind: 'dates', from: '2024-06-02' }, min: 1 },
        ],
      }),
    ).toEqual(['recent'])
    expect(
      await ids({
        match: 'all',
        rules: [{ period: { kind: 'dates', to: '2024-06-01' }, min: 2 }],
      }),
    ).toEqual([])
  })

  it('counts with the rules only, never the sort period', async () => {
    const device = await open(rows())
    expect(
      await count(device, {
        sortBy: 'listeningScrobbles',
        listening: {
          match: 'all',
          rules: [{ period: { kind: 'all' }, min: 1 }],
        },
      }),
    ).toEqual({ totalCount: 2, unfilteredCount: 3 })
  })

  it('reads now once from the clock it is given', async () => {
    const device = await open(rows(), {
      now: new Date('2024-07-15T00:00:00.000Z'),
    })
    expect(
      await pageIds(device, {
        listening: { match: 'all', rules: [{ period: recent, min: 1 }] },
      }),
    ).toEqual([])
  })
})

describe('creator scope', () => {
  it('keeps albums credited to the artist', async () => {
    const device = await open([
      album('mine', { extra: { artistIds: ['artist-2', 'artist-3'] } }),
      album('other'),
    ])
    expect(await pageIds(device, { creatorId: 'artist-3' })).toEqual(['mine'])
    expect(await count(device, { creatorId: 'artist-3' })).toEqual({
      totalCount: 1,
      unfilteredCount: 2,
    })
    expect(await pageIds(device, { creatorId: 'artist-9' })).toEqual([])
  })
})

describe('paging', () => {
  const rows = () =>
    [1, 2, 3, 4, 5].map((day) => album(`p${day}`, addedOn(day)))

  it('reads size + 1 rows for hasMore and stops at limitResults', async () => {
    const device = await open(rows())
    const page = async (input: Record<string, unknown>) => {
      const result = served(await device.source.albumPage(albumQuery(input)))
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await page({ size: 2 })).toEqual([['p5', 'p4'], true])
    expect(await page({ size: 2, page: 3 })).toEqual([['p1'], false])
    expect(await page({ size: 2, page: 2, limitResults: 3 })).toEqual([
      ['p3'],
      false,
    ])
    expect(await page({ size: 2, page: 1, limitResults: 3 })).toEqual([
      ['p5', 'p4'],
      true,
    ])
    expect(await page({ size: 2, page: 3, limitResults: 3 })).toEqual([
      [],
      false,
    ])
  })

  it('answers the paginated list with capped totals', async () => {
    const device = await open(rows())
    const list = served(
      await device.source.albumList(
        albumQuery({ size: 2, page: 2, limitResults: 3 }),
      ),
    )
    expect(list).toMatchObject({
      page: 2,
      size: 2,
      totalCount: 3,
      pageCount: 2,
    })
    expect(list.items.map((item) => item.id)).toEqual(['p3'])
    const beyond = served(
      await device.source.albumList(albumQuery({ size: 2, page: 4 })),
    )
    expect(beyond).toMatchObject({ totalCount: 5, pageCount: 3, items: [] })
  })

  it('counts with the cap and the unfiltered total', async () => {
    const device = await open(rows())
    expect(await count(device, { limitResults: 3 })).toEqual({
      totalCount: 3,
      unfilteredCount: 5,
    })
    expect(
      await count(device, {
        limitResults: 2,
        ranges: [{ field: 'dateAdded', min: (BASE_US + 2 * DAY_US) / 1000 }],
      }),
    ).toEqual({ totalCount: 2, unfilteredCount: 5 })
  })

  it('returns the stored item', async () => {
    const device = await open([album('one')])
    const [item] = served(await device.source.albumPage(albumQuery())).items
    expect(item).toMatchObject({
      id: 'one',
      mediaType: 'album',
      title: 'Album one',
      artistTags: ['Drone'],
      trackCount: 10,
    })
  })
})

describe('reads the device does not serve', () => {
  it('waits for a completed fill and the field list', async () => {
    store = await openDeviceStore([albumFieldsRow(), album('a')], {
      ready: false,
    })
    expect(reason(await store.source.albumPage(albumQuery()))).toBe('not-ready')
    await store.close()
    store = await openDeviceStore([album('a')])
    expect(reason(await store.source.albumPage(albumQuery()))).toBe('not-ready')
    expect(reason(await store.source.albumCount(albumQuery()))).toBe(
      'not-ready',
    )
    expect(reason(await store.source.albumList(albumQuery()))).toBe('not-ready')
  })

  it('reports a failing store', async () => {
    const device = await open([album('a')])
    await device.driver.run("DELETE FROM item_json WHERE entity = 'album'")
    expect(reason(await device.source.albumPage(albumQuery()))).toBe(
      'store-error',
    )
    expect(
      served(await device.source.albumCount(albumQuery())).totalCount,
    ).toBe(1)
  })

  it('leaves catalog scopes other than the library to the API', async () => {
    const device = await open([album('a')])
    const scope = async (input: Record<string, unknown>) =>
      reason(await device.source.albumPage(albumQuery(input)))
    expect(await scope({ libraryScope: 'outside' })).toBe('catalog-scope')
    expect(await scope({ libraryScope: 'all' })).toBe('catalog-scope')
    expect(
      await scope({
        discoverySources: 'scrobble',
        discoverySourceScope: 'selection',
      }),
    ).toBe('catalog-scope')
    expect(await scope({ discoverySources: 'spotify-search' })).toBeNull()
    expect(await scope({ libraryScope: 'library' })).toBeNull()
  })

  it('leaves a libraryPlaylist filter in any mode to the API', async () => {
    const device = await open([album('a')])
    for (const mode of [undefined, 'required', 'any', 'exclude']) {
      const filters = [
        { field: LIBRARY_PLAYLIST_FILTER_FIELD, value: 'list-1', mode },
      ]
      for (const outcome of [
        reason(await device.source.albumPage(albumQuery({ filters }))),
        reason(
          await device.source.albumCount(albumQuery({ filters, tag: 'Rock' })),
        ),
        reason(await device.source.albumList(albumQuery({ filters }))),
        reason(
          await device.source.albumHistogram(
            AlbumListeningHistogramQuerySchema.parse({
              filters: JSON.stringify(filters),
              period: JSON.stringify({ kind: 'all' }),
            }),
          ),
        ),
      ])
        expect(outcome, mode).toBe('library-playlist')
    }
    expect(
      served(await device.source.albumCount(albumQuery())).totalCount,
    ).toBe(1)
  })

  it('leaves queries the API rejects to it', async () => {
    const device = await open([album('a')])
    const rejected = async (input: Record<string, unknown>) =>
      reason(await device.source.albumPage(albumQuery(input)))
    expect(
      await rejected({ filters: [{ field: 'nothing', value: 'x' }] }),
    ).toBe('invalid-query')
    expect(
      await rejected({ filters: [{ field: 'trackCount', value: '10' }] }),
    ).toBe('invalid-query')
    expect(await rejected({ ranges: [{ field: 'title', min: 1 }] })).toBe(
      'invalid-query',
    )
    expect(
      await rejected({ ranges: [{ field: 'listeningScrobbles', min: 1 }] }),
    ).toBe('invalid-query')
    expect(await rejected({ sortBy: 'nothing' })).toBe('invalid-query')
    expect(await rejected({ sortBy: 'bpm' })).toBe('invalid-query')
  })

  it('leaves fields it cannot read to the API', async () => {
    const device = await open([
      fieldsRow('album', [
        ...albumBrowseFields,
        ...albumPluginFields,
        { key: 'energy', label: 'Energy', type: 'text', filterable: true },
      ]),
      album('a'),
    ])
    expect(
      reason(await device.source.albumPage(albumQuery({ q: 'calm' }))),
    ).toBe('unknown-field')
    expect(reason(await device.source.albumPage(albumQuery()))).toBeNull()
  })

  it('leaves a plugin text sort to the API while an album holds a number for it', async () => {
    const device = await open([
      album('a'),
      album('b', { num: { pluginMood: 4 } }),
    ])
    expect(
      reason(
        await device.source.albumPage(albumQuery({ sortBy: 'pluginMood' })),
      ),
    ).toBe('unknown-field')
    expect(
      reason(
        await device.source.albumPage(
          albumQuery({ filters: [{ field: 'pluginMood', value: 'calm' }] }),
        ),
      ),
    ).toBeNull()
  })
})
