import { afterEach, describe, expect, it } from 'vitest'
import {
  ArchivableBrowseFacetQuerySchema,
  filmBrowseFields,
  type BrowseField,
} from '@repo/schemas/browse'
import { formatTagName } from '@repo/schemas/tags'
import type { FilmFilterOption } from '../src/source'
import {
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreRow,
} from './device-store'
import {
  albumTag,
  fieldsRow,
  filmPluginFields,
  filmRow,
  filmTag,
  tagKey,
  titled,
  type MediaRowPatch,
} from './media-fixtures'

/** Synthetic rows only: every name, ID and tag below is invented. */

let store: DeviceStore | undefined

/** The Films field list with only these keys, plugin fields included. */
function fieldsOf(...keys: string[]): BrowseField[] {
  return [...filmBrowseFields, ...filmPluginFields].filter((field) =>
    keys.includes(field.key),
  )
}

async function open(rows: StoreRow[], fields: BrowseField[]) {
  store = await openDeviceStore([fieldsRow('film', fields), ...rows], {
    trackFields: null,
  })
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const film = (id: string, patch: MediaRowPatch = {}) => filmRow(id, patch)

/** providerDisplayNames as the feed publishes them; Provider needs the row. */
const providers: StoreRow = {
  entity: 'meta',
  id: 'providers',
  payload: { kind: 'providers', names: [{ id: 'tmdb', displayName: 'TMDb' }] },
}

function facetQuery(input: Record<string, unknown> = {}) {
  return ArchivableBrowseFacetQuerySchema.parse(input)
}

async function facets(
  device: DeviceStore,
  input: Record<string, unknown> = {},
): Promise<FilmFilterOption[]> {
  return served(await device.source.filmFacets(facetQuery(input)))
}

function counts(
  rows: readonly FilmFilterOption[],
  field: string,
): [string, number][] {
  return rows
    .filter((row) => row.field === field)
    .map((row) => [row.value, row.count])
}

describe('text facets', () => {
  it('counts every filterable Films text field, and not Description or Awards', async () => {
    const device = await open(
      [
        providers,
        film(
          'a',
          titled('Harbor', {
            text: {
              summary: ['A quiet film'],
              actor: ['Ada Example'],
              writer: ['Wes Example'],
              country: ['Chile'],
              language: ['Spanish'],
              productionCompany: ['Lantern Pictures'],
              awards: ['Best Example'],
              collection: ['Shelf'],
              playlist: ['Weekend'],
              provider: ['tmdb'],
              pluginCut: ['Director'],
            },
          }),
        ),
        film(
          'b',
          titled('Harbor', {
            text: { watched: ['No'], identification: ['Identified'] },
          }),
        ),
      ],
      filmBrowseFields.concat(filmPluginFields),
    )
    const rows = (await facets(device)).filter((row) => row.field !== 'genre')
    expect(rows.map((row) => [row.label, row.count])).toEqual([
      ['Directors: Example Person', 2],
      ['Source: file', 2],
      ['Title: Harbor', 2],
      ['Actors: Ada Example', 1],
      ['Collections: Shelf', 1],
      ['Countries: Chile', 1],
      ['Cut: Director', 1],
      ['Identification: Identified', 1],
      ['Identification: Needs ID', 1],
      ['Languages: Spanish', 1],
      ['Playlists: Weekend', 1],
      ['Production companies: Lantern Pictures', 1],
      ['Provider: TMDb', 1],
      ['Watched: No', 1],
      ['Watched: Yes', 1],
      ['Writers: Wes Example', 1],
    ])
  })

  it('counts archived films only with includeArchived', async () => {
    const device = await open(
      [
        film('a', { text: { country: ['Chile'] } }),
        film('b', { text: { country: ['Chile'] }, extra: { archived: true } }),
      ],
      fieldsOf('country'),
    )
    expect(counts(await facets(device), 'country')).toEqual([['Chile', 1]])
    expect(
      counts(await facets(device, { includeArchived: 'true' }), 'country'),
    ).toEqual([['Chile', 2]])
  })

  it('matches typed words and puts the exact match first', async () => {
    const device = await open(
      [
        film('a', { text: { country: ['Peru'] } }),
        film('b', { text: { country: ['Peruvian Coast'] } }),
        film('c', { text: { country: ['Peruvian Coast'] } }),
      ],
      fieldsOf('country'),
    )
    expect(
      counts(await facets(device, { q: 'PERU', limitPerField: 1 }), 'country'),
    ).toEqual([['Peru', 1]])
    expect(
      counts(await facets(device, { q: 'countries: coast' }), 'country'),
    ).toEqual([['Peruvian Coast', 2]])
  })
})

describe('tag facets', () => {
  /** Film tags: drama with crime drama beneath it, and a hidden film tag. An album tag of the same name is not a film tag. */
  const rows = () => [
    filmTag('film-drama', { name: 'Drama' }),
    filmTag('film-crime', { name: 'Crime Drama' }),
    filmTag('film-hidden', { name: 'Hidden', hidden: true }),
    albumTag('album-drama', { name: 'Drama' }),
    tagKey('film', 'crime drama', ['drama']),
    tagKey('film', 'hidden', ['drama']),
    film('a', { extra: { tagIds: ['film-crime'] } }),
    film('b', { extra: { tagIds: ['film-drama', 'film-crime'] } }),
    film('c', { extra: { tagIds: ['film-hidden', 'album-drama'] } }),
    film('d', { extra: { tagIds: ['film-drama'], archived: true } }),
  ]

  it('counts films per film tag key and visible ancestor, once per film', async () => {
    const device = await open(rows(), fieldsOf('genre'))
    const result = await facets(device)
    expect(counts(result, 'genre')).toEqual([
      ['crime drama', 2],
      ['drama', 2],
    ])
    expect(result.find((row) => row.value === 'drama')).toEqual({
      field: 'genre',
      value: 'drama',
      count: 2,
      subtags: 1,
      label: `Tags: ${formatTagName('drama')}`,
    })
    expect(
      counts(await facets(device, { includeArchived: 'true' }), 'genre'),
    ).toEqual([
      ['drama', 3],
      ['crime drama', 2],
    ])
  })

  it('ignores tag levels and matches typed words against keys', async () => {
    const device = await open(rows(), fieldsOf('genre'))
    expect(await facets(device, { tagLevels: 'track' })).toEqual(
      await facets(device),
    )
    expect(counts(await facets(device, { q: 'crim' }), 'genre')).toEqual([
      ['crime drama', 2],
    ])
    // The exact match leads within the limit; the response orders by label.
    expect(
      counts(await facets(device, { q: 'drama', limitPerField: 1 }), 'genre'),
    ).toEqual([['drama', 2]])
    expect(counts(await facets(device, { q: 'drama' }), 'genre')).toEqual([
      ['crime drama', 2],
      ['drama', 2],
    ])
  })
})

describe('fall-throughs', () => {
  it('leaves a catalog scope other than the library to the API', async () => {
    const device = await open([film('a')], fieldsOf('title'))
    expect(
      reason(
        await device.source.filmFacets(facetQuery({ libraryScope: 'outside' })),
      ),
    ).toBe('catalog-scope')
    expect(
      reason(
        await device.source.filmFacets(
          facetQuery({
            discoverySources: 'search',
            discoverySourceScope: 'selection',
          }),
        ),
      ),
    ).toBe('catalog-scope')
  })

  it('leaves plugin fields whose values the row does not carry to the API', async () => {
    for (const key of ['artist', 'keyword', 'albumTag', 'tempo']) {
      const device = await open(
        [film('a')],
        [
          ...fieldsOf('title'),
          { key, label: key, type: 'text', filterable: true },
        ],
      )
      expect(reason(await device.source.filmFacets(facetQuery()))).toBe(
        'unknown-field',
      )
      await device.close()
      store = undefined
    }
  })
})
