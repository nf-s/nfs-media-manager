import { afterEach, describe, expect, it } from 'vitest'
import {
  filmBrowseFields,
  LIBRARY_PLAYLIST_FILTER_FIELD,
} from '@repo/schemas/browse'
import type { FilmQuery } from '@repo/schemas/media'
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
  albumTag,
  fieldsRow,
  filmFieldsRow,
  filmPluginFields,
  filmQuery,
  filmRow,
  filmTag,
  sorted,
  tagKey,
  titled,
  type MediaRowPatch,
} from './media-fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

let store: DeviceStore | undefined

/** A store with the rows and the Films field list (with plugin fields). */
async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore([filmFieldsRow(), ...rows], options)
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const film = (id: string, patch: MediaRowPatch = {}) => filmRow(id, patch)

/** A patch for a film released `day` days after the base date. */
const releasedOn = (day: number, patch: MediaRowPatch = {}) => ({
  ...patch,
  num: { releaseDate: BASE_US + day * DAY_US, ...patch.num },
})

async function pageIds(
  device: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<string[]> {
  const page = served(
    await device.source.filmPage(filmQuery({ size: 100, ...input })),
  )
  return page.items.map((item) => item.id)
}

async function count(device: DeviceStore, input: Record<string, unknown>) {
  return served(await device.source.filmCount(filmQuery(input)))
}

describe('visibility', () => {
  const rows = () => [
    film('file', releasedOn(4)),
    film('archived', releasedOn(3, { extra: { archived: true } })),
    film('disc', releasedOn(2, { extra: { sourceKind: 'disc' } })),
    film('unknown', releasedOn(1, { extra: { sourceKind: null } })),
  ]

  it('hides archived films unless asked for', async () => {
    const device = await open(rows())
    expect(await pageIds(device)).toEqual(['file', 'disc', 'unknown'])
    expect(await pageIds(device, { includeArchived: 'true' })).toEqual([
      'file',
      'archived',
      'disc',
      'unknown',
    ])
  })

  it('keeps the source kind exactly, also in unfilteredCount', async () => {
    const device = await open(rows())
    expect(await pageIds(device, { sourceKind: 'disc' })).toEqual(['disc'])
    expect(await pageIds(device, { sourceKind: 'Disc' })).toEqual([])
    expect(await pageIds(device, { sourceKind: '' })).toEqual([
      'file',
      'disc',
      'unknown',
    ])
    expect(
      await count(device, {
        sourceKind: 'file',
        includeArchived: 'true',
        filters: [{ field: 'title', value: 'nothing' }],
      }),
    ).toEqual({ totalCount: 0, unfilteredCount: 2 })
  })
})

describe('filters', () => {
  const rows = () => [
    film(
      'a',
      titled('Alpha', {
        text: {
          summary: ['A quiet story'],
          director: ['Ann'],
          actor: ['Bea', 'Cal'],
          writer: ['Dee'],
          country: ['Norway'],
          language: ['Norwegian'],
          productionCompany: ['North Pictures'],
          awards: ['Best Score'],
          collection: ['Shelf'],
          playlist: ['Friday'],
          provider: ['tmdb'],
          identification: ['Identified'],
          pluginCut: ['Director'],
        },
      }),
    ),
    film(
      'b',
      titled('Beta', {
        text: {
          director: ['Bea'],
          actor: ['Ann'],
          source: ['Plex'],
          watched: ['No'],
          pluginCut: ['Theatrical'],
        },
      }),
    ),
    film('c', titled('İstanbul', { text: { director: [], actor: [] } })),
  ]
  const ids = async (filters: unknown[]) =>
    sorted(await pageIds(await open(rows()), { filters }))

  it('compares text case-insensitively as PostgreSQL lower() does', async () => {
    expect(await ids([{ field: 'title', value: 'ALPHA' }])).toEqual(['a'])
    expect(await ids([{ field: 'title', value: 'İSTANBUL' }])).toEqual(['c'])
    expect(await ids([{ field: 'title', value: 'alph' }])).toEqual([])
  })

  it('matches credits by role', async () => {
    expect(await ids([{ field: 'director', value: 'ann' }])).toEqual(['a'])
    expect(await ids([{ field: 'actor', value: 'ann' }])).toEqual(['b'])
    expect(await ids([{ field: 'actor', value: 'cal' }])).toEqual(['a'])
    expect(await ids([{ field: 'writer', value: 'DEE' }])).toEqual(['a'])
  })

  it('matches every other text field, filterable or not, and plugin text', async () => {
    const one = async (field: string, value: string) => ids([{ field, value }])
    expect(await one('summary', 'a quiet story')).toEqual(['a'])
    expect(await one('country', 'norway')).toEqual(['a'])
    expect(await one('language', 'NORWEGIAN')).toEqual(['a'])
    expect(await one('productionCompany', 'north pictures')).toEqual(['a'])
    expect(await one('awards', 'best score')).toEqual(['a'])
    expect(await one('collection', 'shelf')).toEqual(['a'])
    expect(await one('playlist', 'friday')).toEqual(['a'])
    expect(await one('provider', 'TMDB')).toEqual(['a'])
    expect(await one('source', 'plex')).toEqual(['b'])
    expect(await one('source', 'file')).toEqual(['a', 'c'])
    expect(await one('watched', 'no')).toEqual(['b'])
    expect(await one('watched', 'yes')).toEqual(['a', 'c'])
    expect(await one('identification', 'needs id')).toEqual(['b', 'c'])
    expect(await one('pluginCut', 'theatrical')).toEqual(['b'])
  })

  it('combines modes as the service does', async () => {
    expect(
      await ids([
        { field: 'director', value: 'ann' },
        { field: 'director', value: 'bea' },
      ]),
    ).toEqual(['a', 'b'])
    expect(
      await ids([
        { field: 'actor', value: 'ann', mode: 'required' },
        { field: 'director', value: 'ann' },
      ]),
    ).toEqual([])
    expect(
      await ids([{ field: 'director', value: 'ann', mode: 'exclude' }]),
    ).toEqual(['b', 'c'])
  })
})

describe('tags', () => {
  const rows = () => [
    filmTag('tag-drama', { name: 'Drama', identityKeys: ['dramatic'] }),
    filmTag('tag-crime', { name: 'Crime Drama' }),
    filmTag('tag-secret', { name: 'Secret Drama', hidden: true }),
    filmTag('tag-weepie', { name: 'Weepie', aliasTargetId: 'tag-drama' }),
    filmTag('tag-noir', { name: 'Noir', hidden: true }),
    filmTag('tag-old', { name: 'Old Noir', aliasTargetId: 'tag-noir' }),
    albumTag('tag-album-drama', { name: 'Drama' }),
    tagKey('film', 'crime drama', ['drama']),
    tagKey('film', 'secret drama', ['drama']),
    tagKey('album', 'drama', []),
    film('f1', { extra: { tagIds: ['tag-drama'] } }),
    film('f2', { extra: { tagIds: ['tag-crime'] } }),
    film('f3', { extra: { tagIds: ['tag-secret'] } }),
    film('f4', { extra: { tagIds: ['tag-weepie'] } }),
    film('f5', { extra: { tagIds: ['tag-noir'] } }),
    film('f6', { extra: { tagIds: ['tag-album-drama'] } }),
  ]
  const ids = async (filters: unknown[], input: Record<string, unknown> = {}) =>
    sorted(await pageIds(await open(rows()), { filters, ...input }))
  const genre = (value: string) => [{ field: 'genre', value }]

  it('matches film tags and their visible descendants, never album tags', async () => {
    expect(await ids(genre('drama'))).toEqual(['f1', 'f2'])
    expect(await ids(genre(' DRAMA'))).toEqual(['f1', 'f2'])
    expect(await ids([{ field: 'keyword', value: 'drama' }])).toEqual([
      'f1',
      'f2',
    ])
  })

  it('resolves identity keys and aliases, hidden targets included', async () => {
    expect(await ids(genre('dramatic'))).toEqual(['f1', 'f2'])
    expect(await ids(genre('weepie'))).toEqual(['f1', 'f2', 'f4'])
    expect(await ids(genre('old noir'))).toEqual(['f5'])
  })

  it('matches direct carriers of a hidden tag, but not hidden descendants', async () => {
    expect(await ids(genre('noir'))).toEqual(['f5'])
    expect(await ids(genre('secret drama'))).toEqual(['f3'])
  })

  it('takes the tag scope as a required Tags filter', async () => {
    expect(await ids([], { tag: 'drama' })).toEqual(['f1', 'f2'])
    expect(
      await ids([{ field: 'genre', value: 'weepie', mode: 'exclude' }], {
        tag: 'drama',
      }),
    ).toEqual([])
  })
})

describe('search', () => {
  const rows = () => [
    film(
      's1',
      titled('Night Train', {
        text: { director: ['Ann Lee'], summary: ['A long journey'] },
      }),
    ),
    film('s2', { text: { awards: ['Golden Bear'], watched: ['No'] } }),
    film('s3', { search: { genre: ['Thriller'] } }),
    film('s4', {
      text: { provider: ['imdb'], identification: ['Identified'] },
    }),
    film('s5', { text: { pluginCut: ['Extended'], writer: ['Jo Park'] } }),
  ]
  const ids = async (q: string) =>
    sorted(await pageIds(await open(rows()), { q }))

  it('searches every text field, filterable or not', async () => {
    expect(await ids('night lee')).toEqual(['s1'])
    expect(await ids('journey')).toEqual(['s1'])
    expect(await ids('golden')).toEqual(['s2'])
    expect(await ids('thrill')).toEqual(['s3'])
    expect(await ids('imdb')).toEqual(['s4'])
    expect(await ids('extended park')).toEqual(['s5'])
  })

  it('matches the computed labels', async () => {
    expect(await ids('needs')).toEqual(['s1', 's2', 's3', 's5'])
    expect(await ids('identified')).toEqual(['s4'])
    expect(await ids('yes')).toEqual(['s1', 's3', 's4', 's5'])
    expect(await ids('no')).toEqual(['s2'])
  })
})

describe('ranges', () => {
  const at = (day: number) => BASE_US + day * DAY_US
  const rows = () => [
    film('r1', {
      num: {
        releaseDate: at(1),
        updatedAt: at(1),
        ratingImdbPersonalDate: at(1),
        runtimeMinutes: 90,
        pluginRank: 1,
      },
    }),
    film('r2', {
      num: {
        releaseDate: at(2),
        updatedAt: at(2),
        ratingImdbPersonalDate: null,
        runtimeMinutes: null,
        pluginRank: 5,
      },
    }),
    film('r3', { num: { releaseDate: null, dateAdded: at(9) } }),
  ]
  const ids = async (ranges: unknown[]) =>
    sorted(await pageIds(await open(rows()), { ranges }))
  const ms = (day: number) => at(day) / 1000

  it('compares millisecond date bounds with microsecond values, inclusively', async () => {
    expect(
      await ids([{ field: 'releaseDate', min: ms(1), max: ms(1) }]),
    ).toEqual(['r1'])
    expect(await ids([{ field: 'updatedAt', min: ms(1) + 0.0005 }])).toEqual([
      'r2',
      'r3',
    ])
    expect(
      await ids([{ field: 'ratingImdbPersonalDate', max: ms(1) }]),
    ).toEqual(['r1'])
    expect(await ids([{ field: 'dateAdded', min: ms(9), max: ms(9) }])).toEqual(
      ['r3'],
    )
  })

  it('treats missing values with includeMissing', async () => {
    expect(await ids([{ field: 'runtimeMinutes' }])).toEqual(['r1', 'r3'])
    expect(
      await ids([{ field: 'runtimeMinutes', max: 90, includeMissing: true }]),
    ).toEqual(['r1', 'r2'])
    expect(await ids([{ field: 'pluginRank', min: 2 }])).toEqual(['r2'])
    expect(
      await ids([{ field: 'pluginRank', min: 2, includeMissing: true }]),
    ).toEqual(['r2', 'r3'])
  })
})

describe('sorting', () => {
  type Value = string | number | null
  const text: Value[] = ['b', 'a', null, 'b']
  const number: Value[] = [2, 1, null, 2]
  const ascending = ['t2', 't1', 't4', 't3']
  const descending = ['t1', 't4', 't2', 't3']

  type Case = {
    sortBy: string
    values: Value[]
    patch: (value: Value) => MediaRowPatch
  }
  const str = (value: Value) =>
    typeof value === 'number' ? String(value) : value
  const num = (value: Value) =>
    typeof value === 'string' ? Number(value) : value
  const cases: Case[] = [
    ...[
      'summary',
      'title',
      'director',
      'actor',
      'writer',
      'genre',
      'country',
      'language',
      'productionCompany',
      'collection',
      'playlist',
      'source',
      'watched',
      'identification',
      'provider',
      'awards',
      'pluginCut',
    ].map(
      (key): Case => ({
        sortBy: key,
        values: text,
        patch: (v) => ({ sort: { [key]: str(v) } }),
      }),
    ),
    ...[
      'releaseDate',
      'dateAdded',
      'updatedAt',
      'ratingImdbPersonal',
      'ratingImdbPersonalDate',
      'ratingImdbValue',
      'ratingImdbVotes',
      'ratingMetascore',
      'ratingTmdbValue',
      'ratingTmdbVotes',
      'popularityTmdb',
      'ratingRt',
      'ratingMetacriticUser',
      'ratingMetacriticUserVotes',
      'ratingTrakt',
      'ratingTraktVotes',
      'ratingLetterboxd',
      'ratingLetterboxdVotes',
      'ratingRtAudience',
      'ratingRtAudienceVotes',
      'runtimeMinutes',
      'budget',
      'boxOffice',
      'pluginRank',
    ].map(
      (key): Case => ({
        sortBy: key,
        values: number,
        patch: (v) => ({ num: { [key]: num(v) } }),
      }),
    ),
  ]

  it('covers every field of the list', () => {
    expect(new Set(cases.map((testCase) => testCase.sortBy))).toEqual(
      new Set([...filmBrowseFields, ...filmPluginFields].map((f) => f.key)),
    )
  })

  it.each(cases)(
    'orders $sortBy in both directions with nulls last',
    async (testCase) => {
      const device = await open(
        testCase.values.map((value, index) =>
          film(`t${index + 1}`, testCase.patch(value)),
        ),
      )
      const order = (direction: string) =>
        pageIds(device, { sortBy: testCase.sortBy, direction })
      expect(await order('asc')).toEqual(ascending)
      expect(await order('desc')).toEqual(
        testCase.sortBy === 'title' ? ['t3', 't1', 't4', 't2'] : descending,
      )
    },
  )

  it('sorts by the default, Released descending, with the ID tie-break', async () => {
    const device = await open([
      film('b', releasedOn(1)),
      film('a', releasedOn(1)),
      film('c', releasedOn(2)),
      film('none', { num: { releaseDate: null } }),
    ])
    expect(await pageIds(device)).toEqual(['c', 'a', 'b', 'none'])
  })
})

describe('paging', () => {
  const rows = () =>
    [1, 2, 3, 4, 5].map((day) => film(`p${day}`, releasedOn(day)))

  it('reads size + 1 rows for hasMore and stops at limitResults', async () => {
    const device = await open(rows())
    const page = async (input: Record<string, unknown>) => {
      const result = served(await device.source.filmPage(filmQuery(input)))
      return [result.items.map((item) => item.id), result.hasMore]
    }
    expect(await page({ size: 2 })).toEqual([['p5', 'p4'], true])
    expect(await page({ size: 2, page: 3 })).toEqual([['p1'], false])
    expect(await page({ size: 2, page: 2, limitResults: 3 })).toEqual([
      ['p3'],
      false,
    ])
    expect(await page({ size: 2, page: 3, limitResults: 3 })).toEqual([
      [],
      false,
    ])
  })

  it('answers the paginated list and counts with capped totals', async () => {
    const device = await open(rows())
    const list = served(
      await device.source.filmList(
        filmQuery({ size: 2, page: 2, limitResults: 3 }),
      ),
    )
    expect(list).toMatchObject({
      page: 2,
      size: 2,
      totalCount: 3,
      pageCount: 2,
    })
    expect(list.items.map((item) => item.id)).toEqual(['p3'])
    expect(await count(device, { limitResults: 3 })).toEqual({
      totalCount: 3,
      unfilteredCount: 5,
    })
    expect(await count(device, {})).toEqual({
      totalCount: 5,
      unfilteredCount: 5,
    })
  })

  it('returns the stored item', async () => {
    const device = await open([film('one')])
    const [item] = served(await device.source.filmPage(filmQuery())).items
    expect(item).toMatchObject({
      id: 'one',
      mediaType: 'film',
      title: 'Example Film',
      watched: true,
      sourceKind: 'file',
    })
  })
})

describe('reads the device does not serve', () => {
  it('waits for a completed fill and the field list', async () => {
    store = await openDeviceStore([film('a')])
    expect(reason(await store.source.filmPage(filmQuery()))).toBe('not-ready')
    expect(reason(await store.source.filmCount(filmQuery()))).toBe('not-ready')
    expect(reason(await store.source.filmList(filmQuery()))).toBe('not-ready')
  })

  it('leaves a creator scope to the API, which also reads catalog observations', async () => {
    const device = await open([film('a')])
    for (const input of [
      { creatorId: 'person-1' },
      { creatorId: 'person-2', creatorRole: 'actor' },
    ]) {
      expect(reason(await device.source.filmPage(filmQuery(input)))).toBe(
        'creator-films',
      )
      expect(reason(await device.source.filmCount(filmQuery(input)))).toBe(
        'creator-films',
      )
    }
  })

  it('leaves catalog scopes other than the library to the API', async () => {
    const device = await open([film('a')])
    const scope = async (input: Record<string, unknown>) =>
      reason(await device.source.filmPage(filmQuery(input)))
    expect(await scope({ libraryScope: 'outside' })).toBe('catalog-scope')
    expect(
      await scope({
        discoverySources: 'match-search',
        discoverySourceScope: 'selection',
      }),
    ).toBe('catalog-scope')
  })

  it('leaves a libraryPlaylist filter in any mode to the API', async () => {
    const device = await open([film('a')])
    for (const mode of [undefined, 'required', 'any', 'exclude']) {
      const filters = [
        { field: LIBRARY_PLAYLIST_FILTER_FIELD, value: 'list-1', mode },
      ]
      for (const outcome of [
        reason(await device.source.filmPage(filmQuery({ filters }))),
        reason(
          await device.source.filmCount(
            filmQuery({ filters, creatorId: 'person-1' }),
          ),
        ),
        reason(await device.source.filmList(filmQuery({ filters }))),
      ])
        expect(outcome, mode).toBe('library-playlist')
    }
    expect(served(await device.source.filmCount(filmQuery())).totalCount).toBe(
      1,
    )
  })

  it('leaves queries the API rejects to it', async () => {
    const device = await open([film('a')])
    const rejected = async (input: Record<string, unknown>) =>
      reason(await device.source.filmPage(filmQuery(input)))
    expect(
      await rejected({ filters: [{ field: 'nothing', value: 'x' }] }),
    ).toBe('invalid-query')
    expect(await rejected({ filters: [{ field: 'budget', value: '1' }] })).toBe(
      'invalid-query',
    )
    expect(await rejected({ ranges: [{ field: 'watched', min: 1 }] })).toBe(
      'invalid-query',
    )
    expect(await rejected({ sortBy: 'scrobbles' })).toBe('invalid-query')
    expect(
      reason(
        await device.source.filmPage({
          ...filmQuery(),
          sortBy: 'listeningScrobbles',
        }),
      ),
    ).toBe('invalid-query')
  })

  it('leaves fields it cannot read to the API', async () => {
    const device = await open([
      fieldsRow('film', [
        ...filmBrowseFields,
        { key: 'tempo', label: 'Tempo', type: 'text', filterable: true },
      ]),
      film('a'),
    ])
    expect(reason(await device.source.filmPage(filmQuery({ q: 'x' })))).toBe(
      'unknown-field',
    )
    expect(reason(await device.source.filmPage(filmQuery()))).toBeNull()
    expect(
      reason(await device.source.filmPage(filmQuery({ sortBy: 'pluginCut' }))),
    ).toBe('invalid-query')
  })

  it('leaves a plugin text sort to the API while a film holds a number for it', async () => {
    const device = await open([film('a'), film('b', { num: { pluginCut: 3 } })])
    expect(
      reason(await device.source.filmPage(filmQuery({ sortBy: 'pluginCut' }))),
    ).toBe('unknown-field')
    expect(
      reason(await device.source.filmPage(filmQuery({ sortBy: 'pluginRank' }))),
    ).toBeNull()
  })

  it('reports a failing store', async () => {
    const device = await open([film('a')])
    await device.driver.run("DELETE FROM item_json WHERE entity = 'film'")
    expect(reason(await device.source.filmPage(filmQuery()))).toBe(
      'store-error',
    )
    expect(served(await device.source.filmCount(filmQuery())).totalCount).toBe(
      1,
    )
  })
})
