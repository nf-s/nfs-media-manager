import { afterEach, describe, expect, it } from 'vitest'
import { ArtistListeningHistogramQuerySchema } from '@repo/schemas/creators'
import { listeningHistogramEdges } from '@repo/schemas/listening'
import { AlbumListeningHistogramQuerySchema } from '@repo/schemas/media'
import {
  FIXED_NOW,
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import {
  artist,
  artistFields,
  artistPlays,
  listeningStart,
} from './library-fixtures'
import {
  albumFieldsRow,
  albumPlays,
  albumRow,
  seconds,
  type AlbumRowPatch,
} from './media-fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

let store: DeviceStore | undefined

async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore(
    [albumFieldsRow(), artistFields(), listeningStart('2024-01-01'), ...rows],
    { trackFields: null, ...options },
  )
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const allTime = { kind: 'all' }
const rollingMonth = { kind: 'rolling', amount: 1, unit: 'months' }

/** Counts per bar from [edge, items] pairs; the other bars are zero. */
function bars(edges: readonly number[], entries: [number, number][]) {
  const byEdge = new Map(entries)
  return {
    edges: [...edges],
    counts: edges.map((edge) => byEdge.get(edge) ?? 0),
  }
}

/** `count` plays a minute apart from a fixed instant. */
function times(count: number, start = '2020-01-01T00:00:00Z') {
  return Array.from({ length: count }, (_, n) => seconds(start) + n * 60)
}

describe('album listening histogram', () => {
  const edges = listeningHistogramEdges.album
  const album = (id: string, patch: AlbumRowPatch = {}) => albumRow(id, patch)

  async function histogram(
    device: DeviceStore,
    period: Record<string, unknown>,
    input: Record<string, unknown> = {},
  ) {
    return served(
      await device.source.albumHistogram(
        AlbumListeningHistogramQuerySchema.parse({
          ...input,
          period: JSON.stringify(period),
        }),
      ),
    )
  }

  it('puts each album in the bar of its count, with empty bars at zero', async () => {
    const device = await open([
      album('silent'),
      album('once'),
      album('four'),
      album('five'),
      album('many'),
      albumPlays('once', times(1)),
      albumPlays('four', times(4)),
      albumPlays('five', times(5)),
      albumPlays('many', times(250)),
    ])
    expect(await histogram(device, allTime)).toEqual(
      bars(edges, [
        [0, 1],
        [1, 2],
        [5, 1],
        [200, 1],
      ]),
    )
  })

  it('bounds a rolling month by the clock, both ends inclusive', async () => {
    expect(FIXED_NOW.toISOString()).toBe('2024-06-15T12:00:00.000Z')
    const device = await open([
      album('a'),
      albumPlays('a', [
        seconds('2024-05-15T11:59:59Z'),
        seconds('2024-05-15T12:00:00Z'),
        seconds('2024-06-15T12:00:00Z'),
        seconds('2024-06-15T12:00:01Z'),
      ]),
    ])
    // Two plays: the bar from 1 holds the counts below 5.
    expect(await histogram(device, rollingMonth)).toEqual(bars(edges, [[1, 1]]))
  })

  it('ends a date period after its last UTC day, across a year boundary', async () => {
    const device = await open([
      album('a'),
      albumPlays('a', [
        ...times(5, '2023-12-01T00:00:00Z'),
        seconds('2023-11-30T23:59:59Z'),
        seconds('2023-12-31T23:59:59Z'),
        seconds('2024-01-01T00:00:00Z'),
      ]),
    ])
    expect(
      await histogram(device, {
        kind: 'dates',
        from: '2023-12-01',
        to: '2023-12-31',
      }),
    ).toEqual(bars(edges, [[5, 1]]))
    expect(
      await histogram(device, { kind: 'dates', to: '2023-11-30' }),
    ).toEqual(bars(edges, [[1, 1]]))
    expect(
      await histogram(device, { kind: 'dates', from: '2024-01-01' }),
    ).toEqual(bars(edges, [[1, 1]]))
  })

  it('keeps filters and toggles and leaves out listening rules, the cap and the page', async () => {
    const device = await open([
      album('a', { text: { artist: ['Ember'] } }),
      album('b', { text: { artist: ['Ember'] } }),
      album('c', { text: { artist: ['Other'] } }),
      album('archived', {
        text: { artist: ['Ember'] },
        extra: { archived: true },
      }),
      album('edition', {
        text: { artist: ['Ember'], edition: ['Edition of another album'] },
        extra: { isEdition: true },
      }),
      albumPlays('a', times(1)),
      albumPlays('c', times(1)),
      albumPlays('archived', times(1)),
      albumPlays('edition', times(1)),
    ])
    const filtered = {
      filters: JSON.stringify([{ field: 'artist', value: 'ember' }]),
      listening: JSON.stringify({
        match: 'all',
        rules: [{ period: { kind: 'all' }, min: 1 }],
      }),
      limitResults: 1,
      page: 3,
      sortBy: 'title',
    }
    expect(await histogram(device, allTime, filtered)).toEqual(
      bars(edges, [
        [0, 1],
        [1, 1],
      ]),
    )
    expect(
      await histogram(device, allTime, {
        ...filtered,
        includeArchived: 'true',
        editions: 'true',
      }),
    ).toEqual(
      bars(edges, [
        [0, 1],
        [1, 3],
      ]),
    )
  })

  it('leaves a catalog scope other than the library to the API', async () => {
    const device = await open([album('a')])
    expect(
      reason(
        await device.source.albumHistogram(
          AlbumListeningHistogramQuerySchema.parse({
            period: JSON.stringify(allTime),
            libraryScope: 'all',
          }),
        ),
      ),
    ).toBe('catalog-scope')
  })
})

describe('artist listening histogram', () => {
  const edges = listeningHistogramEdges.artist

  async function histogram(
    device: DeviceStore,
    period: Record<string, unknown>,
    input: Record<string, unknown> = {},
  ) {
    return served(
      await device.source.artistHistogram(
        ArtistListeningHistogramQuerySchema.parse({
          ...input,
          period: JSON.stringify(period),
        }),
      ),
    )
  }

  it('puts each artist in the bar of its scrobbles, with empty bars at zero', async () => {
    const device = await open([
      artist('silent', 'Silent'),
      artist('nine', 'Nine'),
      artist('ten', 'Ten'),
      artist('many', 'Many'),
      artistPlays('nine', times(9)),
      artistPlays('ten', times(10)),
      artistPlays('many', times(1000)),
    ])
    expect(await histogram(device, allTime)).toEqual(
      bars(edges, [
        [0, 1],
        [1, 1],
        [10, 1],
        [1000, 1],
      ]),
    )
  })

  it('starts a rolling month on the last day of a shorter month', async () => {
    const now = new Date('2024-03-31T10:00:00.000Z')
    const device = await open(
      [
        artist('a', 'A'),
        artistPlays('a', [
          seconds('2024-02-29T09:59:59Z'),
          ...times(10, '2024-02-29T10:00:00Z'),
          seconds('2024-03-31T10:00:01Z'),
        ]),
      ],
      { now },
    )
    expect(await histogram(device, rollingMonth)).toEqual(
      bars(edges, [[10, 1]]),
    )
    expect(
      await histogram(device, { kind: 'rolling', amount: 1, unit: 'years' }),
    ).toEqual(bars(edges, [[10, 1]]))
    expect(
      await histogram(device, {
        kind: 'dates',
        from: '2024-03-01',
        to: '2024-03-31',
      }),
    ).toEqual(bars(edges, [[1, 1]]))
  })

  it('keeps filters, playlists and provider filters and leaves out rules and the cap', async () => {
    const device = await open([
      artist('a', 'Ember One', { text: { provider: ['discogs'] } }),
      artist('b', 'Ember Two', {
        text: { provider: ['discogs'] },
        extra: { playlistIds: ['playlist-2'] },
      }),
      artist('c', 'Other', { text: { provider: ['lastfm'] } }),
      artistPlays('a', times(1)),
      artistPlays('c', times(1)),
    ])
    const filtered = {
      q: 'ember',
      filters: JSON.stringify([
        { field: 'provider', value: 'discogs', mode: 'required' },
      ]),
      listening: JSON.stringify({
        match: 'all',
        rules: [{ period: { kind: 'all' }, min: 1 }],
      }),
      limitResults: 1,
      sortBy: 'name',
    }
    expect(await histogram(device, allTime, filtered)).toEqual(
      bars(edges, [
        [0, 1],
        [1, 1],
      ]),
    )
    expect(
      await histogram(device, allTime, {
        ...filtered,
        playlistIds: JSON.stringify(['playlist-1']),
      }),
    ).toEqual(bars(edges, [[1, 1]]))
  })

  it('leaves a catalog scope other than the library to the API', async () => {
    const device = await open([artist('a', 'A')])
    expect(
      reason(
        await device.source.artistHistogram(
          ArtistListeningHistogramQuerySchema.parse({
            period: JSON.stringify(allTime),
            libraryScope: 'outside',
          }),
        ),
      ),
    ).toBe('catalog-scope')
  })
})
