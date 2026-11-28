import { afterEach, describe, expect, it } from 'vitest'
import {
  ArchivableBrowseFacetQuerySchema,
  albumBrowseFields,
  type BrowseField,
} from '@repo/schemas/browse'
import { formatTagName } from '@repo/schemas/tags'
import type { AlbumFilterOption } from '../src/source'
import {
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import {
  albumPluginFields,
  albumRow,
  albumTag,
  fieldsRow,
  tagKey,
  titled,
  type AlbumRowPatch,
} from './media-fixtures'

/** Synthetic rows only: every name, ID and tag below is invented. */

let store: DeviceStore | undefined

/** The Albums field list with only these keys, plugin fields included. */
function fieldsOf(...keys: string[]): BrowseField[] {
  return [...albumBrowseFields, ...albumPluginFields].filter((field) =>
    keys.includes(field.key),
  )
}

async function open(
  rows: StoreRow[],
  fields: BrowseField[],
  options: StoreOptions = {},
) {
  store = await openDeviceStore([fieldsRow('album', fields), ...rows], {
    trackFields: null,
    ...options,
  })
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const album = (id: string, patch: AlbumRowPatch = {}) => albumRow(id, patch)

function providers(names: { id: string; displayName: string }[]): StoreRow {
  return {
    entity: 'meta',
    id: 'providers',
    payload: { kind: 'providers', names },
  }
}

function facetQuery(input: Record<string, unknown> = {}) {
  return ArchivableBrowseFacetQuerySchema.parse(input)
}

async function facets(
  device: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<AlbumFilterOption[]> {
  return served(await device.source.albumFacets(facetQuery(input)))
}

/** One field's rows as [value, count], in response order. */
function counts(
  rows: readonly AlbumFilterOption[],
  field: string,
): [string, number][] {
  return rows
    .filter((row) => row.field === field)
    .map((row) => [row.value, row.count])
}

describe('text facets', () => {
  it('counts visible albums per exact value, case-sensitively, editions included', async () => {
    const device = await open(
      [
        album('a', { text: { artist: ['Night Owl'] } }),
        album('b', { text: { artist: ['night owl'] } }),
        album('c', { text: { artist: ['Night Owl', 'Day Owl'] } }),
        album('d', {
          text: { artist: ['Night Owl'] },
          extra: { archived: true },
        }),
        album('e', {
          text: {
            artist: ['Night Owl'],
            edition: ['Edition of another album'],
          },
          extra: { isEdition: true },
        }),
        album('f', { text: { artist: [''] } }),
      ],
      fieldsOf('artist'),
    )
    expect(counts(await facets(device), 'artist')).toEqual([
      ['Night Owl', 3],
      ['Day Owl', 1],
      ['night owl', 1],
    ])
    expect(
      counts(await facets(device, { includeArchived: 'true' }), 'artist'),
    ).toEqual([
      ['Night Owl', 4],
      ['Day Owl', 1],
      ['night owl', 1],
    ])
  })

  it('counts every Albums text field from its stored values', async () => {
    const fields = fieldsOf(
      'title',
      'artist',
      'country',
      'playlist',
      'collection',
      'source',
      'provider',
      'edition',
      'pluginMood',
    )
    const device = await open(
      [
        providers([{ id: 'discogs', displayName: 'Discogs' }]),
        album(
          'a',
          titled('Glass', {
            text: {
              country: ['Iceland'],
              playlist: ['Late Night'],
              collection: ['Shelf'],
              source: ['spotify'],
              provider: ['discogs'],
            },
          }),
        ),
        album(
          'b',
          titled('Glass', {
            text: {
              edition: ['Edition of another album'],
              pluginMood: ['Bright'],
            },
            extra: { isEdition: true },
          }),
        ),
      ],
      fields,
    )
    expect((await facets(device)).map((row) => [row.label, row.count])).toEqual(
      [
        ['Artists: Example Artist', 2],
        ['Title: Glass', 2],
        ['Collections: Shelf', 1],
        ['Countries: Iceland', 1],
        ['Edition: Edition of another album', 1],
        ['Edition: Not an edition', 1],
        ['Mood: Bright', 1],
        ['Mood: Calm', 1],
        ['Playlists: Late Night', 1],
        ['Provider: Discogs', 1],
        ['Source: spotify', 1],
      ],
    )
  })

  it('is not narrowed by filters, search, editions or a creator on the request', async () => {
    const device = await open(
      [
        album('a', { text: { artist: ['Ember'] } }),
        album('b', { text: { artist: ['Ember'] } }),
      ],
      fieldsOf('artist'),
    )
    const plain = await facets(device)
    expect(
      await facets(device, {
        creatorId: 'artist-1',
        editions: 'true',
        filters: JSON.stringify([{ field: 'artist', value: 'Other' }]),
      }),
    ).toEqual(plain)
    expect(counts(plain, 'artist')).toEqual([['Ember', 2]])
  })
})

describe('typed text', () => {
  const titles = ['River Stone', 'river song', 'Öresund', '100% Pure', 'Pure']
  const rows = () =>
    titles.map((title, index) => album(`a${index}`, titled(title)))
  const titlesFor = async (q: string) => {
    const device = await open(rows(), fieldsOf('title'))
    const values = counts(await facets(device, { q }), 'title').map(
      ([value]) => value,
    )
    await device.close()
    store = undefined
    return values
  }

  it('matches each word as a case-insensitive substring, LIKE characters literally', async () => {
    expect(await titlesFor('riv')).toEqual(['river song', 'River Stone'])
    expect(await titlesFor('STONE riv')).toEqual(['River Stone'])
    expect(await titlesFor('ÖRE')).toEqual(['Öresund'])
    expect(await titlesFor('100%')).toEqual(['100% Pure'])
  })

  it('puts the exact match first, then count and code point', async () => {
    const device = await open(
      [
        album('a', titled('Pure')),
        album('b', titled('Pure Joy')),
        album('c', titled('Pure Joy')),
        album('d', titled('pure joy')),
      ],
      fieldsOf('title'),
    )
    expect(counts(await facets(device, { q: 'pure' }), 'title')).toEqual([
      ['Pure Joy', 2],
      ['Pure', 1],
      ['pure joy', 1],
    ])
    expect(
      counts(await facets(device, { q: 'pure', limitPerField: 1 }), 'title'),
    ).toEqual([['Pure', 1]])
    expect(
      counts(
        await facets(device, { q: 'PURE JOY', limitPerField: 2 }),
        'title',
      ),
    ).toEqual([
      ['Pure Joy', 2],
      ['pure joy', 1],
    ])
  })

  it("drops a word found in the field's label, except on Title", async () => {
    const device = await open(
      [
        album('a', titled('Countries', { text: { country: ['Chile'] } })),
        album('b', titled('Chile', { text: { country: ['Peru'] } })),
      ],
      fieldsOf('title', 'country'),
    )
    const rows = await facets(device, { q: 'countries: chile' })
    expect(counts(rows, 'country')).toEqual([['Chile', 1]])
    expect(counts(rows, 'title')).toEqual([])
    expect(counts(await facets(device, { q: 'countries' }), 'title')).toEqual([
      ['Countries', 1],
    ])
  })
})

describe('limits', () => {
  it('limits one field by limitPerField', async () => {
    const device = await open(
      ['One', 'Two', 'Three'].map((title, index) =>
        album(`a${index}`, titled(title)),
      ),
      fieldsOf('title'),
    )
    expect(counts(await facets(device, { limitPerField: 2 }), 'title')).toEqual(
      [
        ['One', 1],
        ['Three', 1],
      ],
    )
  })

  it('limits each of many fields to 1000 values over all of them', async () => {
    const extra: BrowseField[] = Array.from({ length: 40 }, (_, index) => ({
      key: `pluginText${index}`,
      label: `Text ${index}`,
      type: 'text',
      filterable: true,
    }))
    const device = await open(
      Array.from({ length: 30 }, (_, index) =>
        album(`a${index}`, titled(`Title ${String(index).padStart(2, '0')}`)),
      ),
      [...fieldsOf('title'), ...extra],
    )
    // 41 fields: at most floor(1000 / 41) = 24 values each.
    expect(
      counts(await facets(device, { limitPerField: 50 }), 'title'),
    ).toHaveLength(24)
  })
})

describe('tag facets', () => {
  /**
   * Album tags: rock, with indie rock and a hidden secret tag beneath it,
   * and jazz. Artist tags: drone, beneath electronic (a key with no tag
   * row). Album b has too few release tags, so Tags at Auto adds its
   * artists' tags; album c has a library track tagged indie rock.
   */
  const tagRows = () => [
    albumTag('tag-rock', { name: 'Rock' }),
    albumTag('tag-indie', { name: 'Indie Rock' }),
    albumTag('tag-jazz', { name: 'Jazz' }),
    albumTag('tag-secret', { name: 'Secret', hidden: true }),
    tagKey('album', 'indie rock', ['rock']),
    tagKey('album', 'secret', ['rock']),
    tagKey('album', 'drone', ['electronic']),
  ]
  const albums = () => [
    album('a', {
      extra: {
        tagIds: ['tag-indie', 'tag-secret'],
        releaseTagCount: 2,
        artistTagLabelKeys: ['drone'],
        trackTagIds: [],
      },
    }),
    album('b', {
      extra: {
        tagIds: ['tag-rock'],
        releaseTagCount: 1,
        artistTagLabelKeys: ['drone'],
        trackTagIds: ['tag-jazz'],
      },
    }),
    album('c', {
      extra: {
        tagIds: [],
        releaseTagCount: 0,
        artistTagLabelKeys: [],
        trackTagIds: ['tag-indie'],
      },
    }),
    album('d', {
      extra: {
        archived: true,
        tagIds: ['tag-rock'],
        releaseTagCount: 1,
        artistTagLabelKeys: ['drone'],
        trackTagIds: [],
      },
    }),
  ]
  const tagFields = () => fieldsOf('genre', 'albumTag', 'artistTag')

  it('counts albums per key and visible ancestor at each tag field', async () => {
    const device = await open([...tagRows(), ...albums()], tagFields())
    const rows = await facets(device)
    expect(counts(rows, 'albumTag')).toEqual([
      ['rock', 2],
      ['indie rock', 1],
    ])
    expect(counts(rows, 'artistTag')).toEqual([
      ['drone', 2],
      ['electronic', 2],
    ])
    expect(counts(rows, 'genre')).toEqual([
      ['rock', 2],
      ['drone', 1],
      ['electronic', 1],
      ['indie rock', 1],
    ])
    expect(rows.find((row) => row.label === 'Tags: Rock')).toEqual({
      field: 'genre',
      value: 'rock',
      count: 2,
      subtags: 1,
      label: `Tags: ${formatTagName('rock')}`,
    })
    expect(
      rows.find(
        (row) => row.field === 'artistTag' && row.value === 'electronic',
      )?.subtags,
    ).toBe(1)
    expect(rows.some((row) => row.value === 'secret')).toBe(false)
  })

  it('counts Tags at the chosen levels', async () => {
    const device = await open([...tagRows(), ...albums()], tagFields())
    const genre = async (tagLevels: string) =>
      counts(await facets(device, { tagLevels }), 'genre')
    expect(await genre('track')).toEqual([
      ['indie rock', 1],
      ['jazz', 1],
      ['rock', 1],
    ])
    expect(await genre('track,album')).toEqual([
      ['rock', 3],
      ['indie rock', 2],
      ['jazz', 1],
    ])
    expect(await genre('artist')).toEqual([
      ['drone', 2],
      ['electronic', 2],
    ])
    // Album tags and Artist tags do not move with the location.
    expect(
      counts(await facets(device, { tagLevels: 'track' }), 'albumTag'),
    ).toEqual([
      ['rock', 2],
      ['indie rock', 1],
    ])
  })

  it('counts archived albums with includeArchived', async () => {
    const device = await open([...tagRows(), ...albums()], tagFields())
    const rows = await facets(device, { includeArchived: 'true' })
    expect(counts(rows, 'albumTag')).toEqual([
      ['rock', 3],
      ['indie rock', 1],
    ])
    expect(counts(rows, 'genre')).toEqual([
      ['rock', 3],
      ['drone', 2],
      ['electronic', 2],
      ['indie rock', 1],
    ])
  })

  it('matches typed words against tag keys and limits the keys it reads', async () => {
    const device = await open([...tagRows(), ...albums()], tagFields())
    const rows = await facets(device, { q: 'ROCK' })
    expect(counts(rows, 'genre')).toEqual([
      ['rock', 2],
      ['indie rock', 1],
    ])
    expect(counts(rows, 'artistTag')).toEqual([])
    expect(counts(await facets(device, { q: 'tags: elec' }), 'genre')).toEqual([
      ['electronic', 1],
    ])
  })

  it('falls through when an archived album credits an artist no listed album credits', async () => {
    const orphan = album('e', {
      extra: {
        archived: true,
        artistIds: ['artist-9'],
        tagIds: [],
        releaseTagCount: 0,
        artistTagLabelKeys: ['drone'],
        trackTagIds: [],
      },
    })
    const device = await open([...tagRows(), ...albums(), orphan], tagFields())
    const archived = facetQuery({ includeArchived: 'true' })
    expect(reason(await device.source.albumFacets(archived))).toBe(
      'archived-artist-tags',
    )
    expect(
      reason(
        await device.source.albumFacets(
          facetQuery({ includeArchived: 'true', tagLevels: 'album' }),
        ),
      ),
    ).toBe('archived-artist-tags')
    expect(await facets(device)).toEqual(
      await facets(device, { includeArchived: 'false' }),
    )
    await device.close()
    const releaseOnly = await open(
      [...tagRows(), ...albums(), orphan],
      fieldsOf('genre', 'albumTag'),
    )
    expect(
      counts(
        await facets(releaseOnly, {
          includeArchived: 'true',
          tagLevels: 'track,album',
        }),
        'genre',
      ),
    ).toEqual([
      ['rock', 4],
      ['indie rock', 2],
      ['jazz', 1],
    ])
  })
})

describe('fall-throughs', () => {
  it('leaves a catalog scope other than the library to the API', async () => {
    const device = await open([album('a')], fieldsOf('title'))
    expect(
      reason(
        await device.source.albumFacets(facetQuery({ libraryScope: 'all' })),
      ),
    ).toBe('catalog-scope')
  })

  it('leaves plugin fields whose values the row does not carry to the API', async () => {
    const plugin = (key: string): BrowseField => ({
      key,
      label: key,
      type: 'text',
      filterable: true,
    })
    for (const key of ['summary', 'keyword', 'danceability']) {
      const device = await open(
        [album('a')],
        [...fieldsOf('title'), plugin(key)],
      )
      expect(reason(await device.source.albumFacets(facetQuery()))).toBe(
        'unknown-field',
      )
      await device.close()
      store = undefined
    }
    const unfiltered = await open(
      [album('a')],
      [...fieldsOf('title'), { ...plugin('summary'), filterable: false }],
    )
    expect(counts(await facets(unfiltered), 'title')).toEqual([['Album a', 1]])
  })

  it('answers not-ready before the first fill or without the field list', async () => {
    const empty = await open([album('a')], fieldsOf('title'), { ready: false })
    expect(reason(await empty.source.albumFacets(facetQuery()))).toBe(
      'not-ready',
    )
    await empty.close()
    store = await openDeviceStore([album('a')], { trackFields: null })
    expect(reason(await store.source.albumFacets(facetQuery()))).toBe(
      'not-ready',
    )
  })
})
