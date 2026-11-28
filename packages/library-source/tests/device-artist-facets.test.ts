import { afterEach, describe, expect, it } from 'vitest'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { BrowseFacetQuerySchema, type BrowseField } from '@repo/schemas/browse'
import { formatTagName } from '@repo/schemas/tags'
import type { ArtistFilterOption } from '../src/source'
import {
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreRow,
} from './device-store'
import { tagPayload, type TagOptions } from './fixtures'
import { artist, artistFields, tagKey } from './library-fixtures'

/** Synthetic rows only: every name, ID and tag below is invented. */

let store: DeviceStore | undefined

const providers: StoreRow = {
  entity: 'meta',
  id: 'providers',
  payload: {
    kind: 'providers',
    names: [
      { id: 'lastfm', displayName: 'Last.fm' },
      { id: 'plugin-gram', displayName: 'Gramophone Archive' },
    ],
  },
}

/** The Artists field list with only these keys. */
function fieldsOf(...keys: string[]): BrowseField[] {
  return artistBrowseFields.filter((field) => keys.includes(field.key))
}

async function open(rows: StoreRow[], fields: BrowseField[]) {
  store = await openDeviceStore([artistFields(fields), providers, ...rows], {
    trackFields: null,
  })
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

function tag(id: string, options: TagOptions): StoreRow {
  return { entity: 'tag', id, payload: tagPayload(options) }
}

async function facets(
  device: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<ArtistFilterOption[]> {
  return served(
    await device.source.artistFacets(BrowseFacetQuerySchema.parse(input)),
  )
}

function counts(
  rows: readonly ArtistFilterOption[],
  field: string,
): [string, number][] {
  return rows
    .filter((row) => row.field === field)
    .map((row) => [row.value, row.count])
}

describe('text facets', () => {
  it('groups values case-insensitively under the least value, each artist once', async () => {
    const device = await open(
      [
        artist('a', 'One', { text: { country: ['Chile', 'chile'] } }),
        artist('b', 'Two', { text: { country: ['chile'] } }),
        artist('c', 'Three', { text: { country: ['CHILE'] } }),
        artist('d', 'Four', { text: { country: ['Peru', ''] } }),
      ],
      fieldsOf('country'),
    )
    expect(await facets(device)).toEqual([
      { field: 'country', value: 'CHILE', count: 3, label: 'Country: CHILE' },
      { field: 'country', value: 'Peru', count: 1, label: 'Country: Peru' },
    ])
  })

  it('suggests every text field, labelling providers by name', async () => {
    const device = await open(
      [
        artist('a', 'Night Owl', {
          text: { type: ['Group'], provider: ['lastfm', 'plugin-gram'] },
        }),
        artist('b', 'Day Owl', { text: { country: ['Chile'] } }),
      ],
      artistBrowseFields.map((field) =>
        field.key === 'type' ? { ...field, filterable: false } : field,
      ),
    )
    expect((await facets(device)).map((row) => [row.label, row.count])).toEqual(
      [
        ['Playlists: Example Playlist', 2],
        ['Provider: Last.fm', 2],
        ['Tags: Drone', 2],
        ['Artist: Day Owl', 1],
        ['Artist: Night Owl', 1],
        ['Country: Chile', 1],
        ['Provider: Gramophone Archive', 1],
        ['Type: Group', 1],
      ],
    )
  })

  it('matches words as typed, keeping label words on Name only', async () => {
    const device = await open(
      [
        artist('a', 'Country Joe'),
        artist('b', 'Joe', { text: { country: ['Ireland'] } }),
        artist('c', 'ΣΑΣ'),
      ],
      fieldsOf('name', 'country', 'provider'),
    )
    const rows = await facets(device, { q: 'country: ire' })
    expect(counts(rows, 'country')).toEqual([['Ireland', 1]])
    expect(counts(rows, 'name')).toEqual([])
    expect(counts(await facets(device, { q: 'country' }), 'name')).toEqual([
      ['Country Joe', 1],
    ])
    expect(counts(await facets(device, { q: 'gramo' }), 'provider')).toEqual([])
    expect(counts(await facets(device, { q: 'last.' }), 'provider')).toEqual([
      ['lastfm', 3],
    ])
    // The word is folded as typed (σασ), not lower-cased first (σας).
    expect(counts(await facets(device, { q: 'ΣΑΣ' }), 'name')).toEqual([
      ['ΣΑΣ', 1],
    ])
  })

  it('puts the exact match first and lists limitPerField values per field', async () => {
    const device = await open(
      [
        artist('a', 'Owl'),
        artist('b', 'Owl City', { text: { name: ['Owl City'] } }),
        artist('c', 'owl city'),
        artist('d', 'Night Owl'),
      ],
      fieldsOf('name'),
    )
    expect(
      counts(await facets(device, { q: 'OWL', limitPerField: 1 }), 'name'),
    ).toEqual([['Owl', 1]])
    expect(
      counts(await facets(device, { q: 'owl', limitPerField: 2 }), 'name'),
    ).toEqual([
      ['Owl City', 2],
      ['Owl', 1],
    ])
  })

  it('keeps limitPerField whatever the number of fields', async () => {
    const country: BrowseField = {
      key: 'country',
      label: 'Country',
      type: 'text',
      filterable: true,
    }
    const many = Array.from({ length: 60 }, () => country)
    const device = await open(
      Array.from({ length: 30 }, (_, index) =>
        artist(`a${index}`, `Artist ${index}`, {
          text: { country: [`Country ${String(index).padStart(2, '0')}`] },
        }),
      ),
      many,
    )
    const rows = await facets(device, { limitPerField: 30 })
    // 60 copies of one field, each with all 30 values: no 1000-value rule.
    expect(rows).toHaveLength(60 * 30)
  })
})

describe('tag facets', () => {
  /** Album tags: rock above indie rock and a hidden tag; the artist raw key "secret" is hidden itself. */
  const rows = () => [
    tag('tag-rock', { name: 'Rock' }),
    tag('tag-indie', { name: 'Indie Rock' }),
    tag('tag-secret', { name: 'Secret', hidden: true }),
    tagKey('indie rock', ['rock']),
    tagKey('secret', ['rock']),
    artist('a', 'One', { extra: { rawTagKeys: ['indie rock'] } }),
    artist('b', 'Two', { extra: { rawTagKeys: ['rock', 'indie rock'] } }),
    artist('c', 'Three', { extra: { rawTagKeys: ['secret', ''] } }),
  ]

  it('counts artists per raw tag key and each visible ancestor of a visible key', async () => {
    const device = await open(rows(), fieldsOf('genre'))
    expect(await facets(device)).toEqual([
      {
        field: 'genre',
        value: 'indie rock',
        count: 2,
        label: `Tags: ${formatTagName('indie rock')}`,
      },
      {
        field: 'genre',
        value: 'rock',
        count: 2,
        subtags: 1,
        label: `Tags: ${formatTagName('rock')}`,
      },
      {
        field: 'genre',
        value: 'secret',
        count: 1,
        label: `Tags: ${formatTagName('secret')}`,
      },
    ])
    expect(counts(await facets(device, { q: 'tags: rock' }), 'genre')).toEqual([
      ['indie rock', 2],
      ['rock', 2],
    ])
    expect(
      counts(await facets(device, { q: 'rock', limitPerField: 1 }), 'genre'),
    ).toEqual([['rock', 2]])
  })
})

describe('fall-throughs', () => {
  it('leaves a catalog scope other than the library to the API', async () => {
    const device = await open([artist('a', 'One')], fieldsOf('name'))
    expect(
      reason(
        await device.source.artistFacets(
          BrowseFacetQuerySchema.parse({ libraryScope: 'all' }),
        ),
      ),
    ).toBe('catalog-scope')
  })

  it('leaves a text field the device cannot read to the API', async () => {
    const device = await open(
      [artist('a', 'One')],
      [
        ...fieldsOf('name'),
        { key: 'label', label: 'Label', type: 'text', filterable: true },
      ],
    )
    expect(
      reason(
        await device.source.artistFacets(BrowseFacetQuerySchema.parse({})),
      ),
    ).toBe('unknown-field')
  })
})
