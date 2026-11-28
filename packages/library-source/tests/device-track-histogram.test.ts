import { afterEach, describe, expect, it } from 'vitest'
import { LIBRARY_PLAYLIST_FILTER_FIELD } from '@repo/schemas/browse'
import { listeningHistogramEdges } from '@repo/schemas/listening'
import { TrackListeningHistogramQuerySchema } from '@repo/schemas/tracks'
import {
  FIXED_NOW,
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import { trackRow, type TrackRowPatch } from './fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

function track(id: string, patch: TrackRowPatch = {}): StoreRow {
  return { entity: 'track', id, payload: trackRow(id, patch) }
}

function plays(nameId: string, times: number[]): StoreRow {
  return { entity: 'scrobble_name', id: nameId, payload: { plays: times } }
}

const at = (iso: string) => Date.parse(iso) / 1000

/** A track whose scrobbles are those of the named names. */
function listened(id: string, nameIds: string[], patch: TrackRowPatch = {}) {
  return track(id, {
    ...patch,
    extra: { scrobbleNameIds: nameIds, ...patch.extra },
  })
}

let store: DeviceStore | undefined

async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore(rows, options)
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

const edges = [...listeningHistogramEdges.track]

async function histogram(
  device: DeviceStore,
  period: Record<string, unknown>,
  input: Record<string, unknown> = {},
) {
  return served(
    await device.source.trackHistogram(
      TrackListeningHistogramQuerySchema.parse({
        ...input,
        period: JSON.stringify(period),
      }),
    ),
  )
}

/** Counts per bar from [edge, items] pairs; the other bars are zero. */
function bars(entries: [number, number][]) {
  const byEdge = new Map(entries)
  return { edges, counts: edges.map((edge) => byEdge.get(edge) ?? 0) }
}

const allTime = { kind: 'all' }
const rollingMonth = { kind: 'rolling', amount: 1, unit: 'months' }

describe('track listening histogram', () => {
  it('puts each track in the bar of its count, with empty bars at zero', async () => {
    const device = await open([
      listened('silent', []),
      listened('once', ['name-once']),
      listened('three', ['name-three']),
      listened('many', ['name-many']),
      plays('name-once', [at('2020-01-01T00:00:00Z')]),
      plays(
        'name-three',
        [1, 2, 3].map((day) => at(`2020-01-0${day}T00:00:00Z`)),
      ),
      plays(
        'name-many',
        Array.from({ length: 120 }, (_, n) => 1_500_000_000 + n * 60),
      ),
    ])
    expect(await histogram(device, allTime)).toEqual(
      bars([
        [0, 1],
        [1, 1],
        [2, 1],
        [100, 1],
      ]),
    )
  })

  it('counts a name shared by two tracks for each of them', async () => {
    const device = await open([
      listened('a', ['name-shared']),
      listened('b', ['name-shared', 'name-own']),
      plays('name-shared', [at('2023-01-01T00:00:00Z')]),
      plays('name-own', [at('2023-01-02T00:00:00Z')]),
    ])
    expect(await histogram(device, allTime)).toEqual(
      bars([
        [1, 1],
        [2, 1],
      ]),
    )
  })

  it('counts a recording group once, with each of its names once', async () => {
    const device = await open([
      listened('v1', ['name-shared'], { extra: { recording: { key: 'rec' } } }),
      listened('v2', ['name-shared', 'name-own'], {
        extra: { recording: { key: 'rec' } },
      }),
      listened('alone', []),
      plays('name-shared', [at('2023-01-01T00:00:00Z')]),
      plays('name-own', [at('2023-01-02T00:00:00Z')]),
    ])
    expect(await histogram(device, allTime, { groupRecordings: true })).toEqual(
      bars([
        [0, 1],
        [2, 1],
      ]),
    )
  })

  it('bounds a rolling month by the injected clock, both ends inclusive', async () => {
    const now = new Date('2024-03-31T10:00:00.000Z')
    const device = await open(
      [
        listened('a', ['name-a']),
        plays('name-a', [
          at('2024-02-29T09:59:59Z'),
          at('2024-02-29T10:00:00Z'),
          at('2024-03-31T10:00:00Z'),
          at('2024-03-31T10:00:01Z'),
        ]),
      ],
      { now },
    )
    expect(await histogram(device, rollingMonth)).toEqual(bars([[2, 1]]))
  })

  it('ends a date period after its last UTC day, across a year boundary', async () => {
    const device = await open([
      listened('a', ['name-a']),
      plays('name-a', [
        at('2023-11-30T23:59:59Z'),
        at('2023-12-01T00:00:00Z'),
        at('2023-12-31T23:59:59Z'),
        at('2024-01-01T00:00:00Z'),
      ]),
    ])
    expect(
      await histogram(device, {
        kind: 'dates',
        from: '2023-12-01',
        to: '2023-12-31',
      }),
    ).toEqual(bars([[2, 1]]))
    expect(
      await histogram(device, { kind: 'dates', to: '2023-11-30' }),
    ).toEqual(bars([[1, 1]]))
  })

  it('starts a rolling month at the same instant of the previous month', async () => {
    const device = await open([
      listened('a', ['name-a']),
      plays('name-a', [at('2024-05-15T12:00:00Z'), at('2024-05-15T11:59:59Z')]),
    ])
    expect(FIXED_NOW.toISOString()).toBe('2024-06-15T12:00:00.000Z')
    expect(await histogram(device, rollingMonth)).toEqual(bars([[1, 1]]))
  })

  it('keeps filters and leaves out listening rules, the result cap and archived tracks', async () => {
    const device = await open([
      listened('a', ['name-a'], { text: { artist: ['Ember'] } }),
      listened('b', [], { text: { artist: ['Ember'] } }),
      listened('c', ['name-a'], { text: { artist: ['Other'] } }),
      listened('archived', ['name-a'], {
        text: { artist: ['Ember'] },
        extra: { archived: true },
      }),
      plays('name-a', [at('2023-01-01T00:00:00Z')]),
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
      bars([
        [0, 1],
        [1, 1],
      ]),
    )
  })

  it('serves counts with a Provider filter, which carry no links', async () => {
    const device = await open([
      listened('a', [], { text: { provider: ['discogs'] } }),
      listened('b', []),
    ])
    expect(
      await histogram(device, allTime, {
        filters: JSON.stringify([{ field: 'provider', value: 'discogs' }]),
      }),
    ).toEqual(bars([[0, 1]]))
  })

  it('leaves grouped recordings in a creator scope and other catalog scopes to the API', async () => {
    const device = await open([listened('a', [])])
    const query = (input: Record<string, unknown>) =>
      TrackListeningHistogramQuerySchema.parse({
        ...input,
        period: JSON.stringify(allTime),
      })
    expect(
      reason(
        await device.source.trackHistogram(
          query({ groupRecordings: true, creatorId: 'artist-1' }),
        ),
      ),
    ).toBe('grouped-creator-scope')
    expect(
      reason(
        await device.source.trackHistogram(query({ libraryScope: 'all' })),
      ),
    ).toBe('catalog-scope')
    expect(
      reason(
        await device.source.trackHistogram(
          query({
            filters: [
              {
                field: LIBRARY_PLAYLIST_FILTER_FIELD,
                value: 'list-1',
                mode: 'exclude',
              },
            ],
          }),
        ),
      ),
    ).toBe('library-playlist')
  })
})
