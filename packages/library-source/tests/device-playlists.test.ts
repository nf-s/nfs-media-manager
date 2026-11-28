import { afterEach, describe, expect, it } from 'vitest'
import type {
  DevicePlaylistJobRow,
  DevicePlaylistRow,
} from '@repo/schemas/device'
import {
  PlaylistBrowseQuerySchema,
  PlaylistSummarySchema,
  type PlaylistBrowseQuery,
} from '@repo/schemas/tracks'
import {
  openDeviceStore,
  reason,
  served,
  type DeviceStore,
  type StoreOptions,
  type StoreRow,
} from './device-store'
import { playlistPayload } from './fixtures'
import {
  playlist,
  playlistJob,
  type PlaylistRowPatch,
} from './library-fixtures'

/** Synthetic rows only: every name, ID and time below is invented. */

type JobStatus = DevicePlaylistJobRow['status']

let store: DeviceStore | undefined

async function open(rows: StoreRow[], options: StoreOptions = {}) {
  store = await openDeviceStore(rows, { trackFields: null, ...options })
  return store
}

afterEach(async () => {
  await store?.close()
  store = undefined
})

function playlistQuery(
  input: Record<string, unknown> = {},
): PlaylistBrowseQuery {
  return PlaylistBrowseQuerySchema.parse(input)
}

/** A playlist in its own sync group, `spotify:<id>`. */
function own(id: string, name: string, patch: PlaylistRowPatch = {}) {
  return playlist(id, name, {
    ...patch,
    extra: { syncGroupKey: `spotify:${id}`, ...patch.extra },
  })
}

async function page(device: DeviceStore, input: Record<string, unknown> = {}) {
  return served(await device.source.playlistPage(playlistQuery(input)))
}

async function ids(device: DeviceStore, input: Record<string, unknown> = {}) {
  return (await page(device, input)).items.map((item) => item.id)
}

async function total(device: DeviceStore, input: Record<string, unknown> = {}) {
  return served(await device.source.playlistCount(playlistQuery(input)))
}

describe('playlist items and jobs', () => {
  const base = playlistPayload('p1').item

  it('returns the stored summary with no job', async () => {
    const device = await open([own('p1', 'Example Playlist')])
    expect((await page(device)).items).toEqual([
      PlaylistSummarySchema.parse({
        ...base,
        sync: { ...base.sync, job: null },
      }),
    ])
  })

  it('joins the latest succeeded job and keeps the next sync', async () => {
    const job = playlistJob('spotify:p1', 'succeeded')
    const device = await open([own('p1', 'Example Playlist'), job])
    const [item] = (await page(device)).items
    expect(item?.sync).toEqual({ ...base.sync, job: job.payload })
  })

  it('clears the next sync after a failed or cancelled job', async () => {
    const ended: JobStatus[] = ['failed', 'cancelled']
    for (const status of ended) {
      const job = playlistJob('spotify:p1', status)
      const device = await open([own('p1', 'Example Playlist'), job])
      const [item] = (await page(device)).items
      expect(item?.sync).toEqual({
        ...base.sync,
        nextScheduledAt: null,
        job: job.payload,
      })
      await device.close()
    }
    store = undefined
  })

  it('reads the job of the playlist sync group only', async () => {
    const device = await open([
      own('p1', 'First'),
      own('p2', 'Second'),
      playlist('p3', 'Third', { extra: { syncGroupKey: null } }),
      playlistJob('spotify:p2', 'failed'),
    ])
    const jobs = (await page(device)).items.map((item) => [
      item.id,
      item.sync.job?.status ?? null,
    ])
    expect(jobs).toEqual([
      ['p1', null],
      ['p2', 'failed'],
      ['p3', null],
    ])
  })

  it('leaves a page holding a queued or running import, and serves its count', async () => {
    const active: JobStatus[] = ['queued', 'running']
    for (const status of active) {
      const device = await open([
        own('p1', 'First'),
        own('p2', 'Second'),
        playlistJob('spotify:p2', status),
      ])
      expect(reason(await device.source.playlistPage(playlistQuery()))).toBe(
        'active-import',
      )
      expect(await total(device)).toEqual({ totalCount: 2 })
      expect(await ids(device, { size: 1 })).toEqual(['p1'])
      expect(await ids(device, { ids: ['p1'] })).toEqual(['p1'])
      await device.close()
    }
    store = undefined
  })
})

describe('directory filters', () => {
  const rows = () => [
    own('p1', 'Morning Mix', {
      search: { owner: ['Example Owner'], description: ['Slow starts'] },
      extra: { source: 'spotify' },
      item: { acceptsAdditions: true },
    }),
    own('p2', 'Morning', {
      search: { owner: ['Mix Owner'], description: [] },
      extra: { source: 'spotify-liked' },
    }),
    own('p3', 'Evening 100%', {
      search: { owner: [], description: ['Late morning tracks'] },
      extra: { source: 'library', syncGroupKey: null },
    }),
  ]

  it('matches q as one substring of the name, owner or description', async () => {
    const device = await open(rows())
    const q = async (value: string) => ids(device, { q: value })
    expect(await q('morning mix')).toEqual(['p1'])
    expect(await q('MORNING')).toEqual(['p3', 'p2', 'p1'])
    expect(await q('mix')).toEqual(['p2', 'p1'])
    expect(await q('slow')).toEqual(['p1'])
    expect(await q('ix')).toEqual(['p2', 'p1'])
    expect(await q('100%')).toEqual(['p3'])
    expect(await q('0_')).toEqual([])
    expect((await total(device, { q: 'mix' })).totalCount).toBe(2)
  })

  it('matches name against the name only', async () => {
    const device = await open(rows())
    expect(await ids(device, { name: 'mix' })).toEqual(['p1'])
    expect(await ids(device, { name: 'ning' })).toEqual(['p3', 'p2', 'p1'])
    expect(await ids(device, { q: 'morning', name: 'eve' })).toEqual(['p3'])
  })

  it('filters by source, ID and whether the playlist accepts additions', async () => {
    const device = await open(rows())
    expect(await ids(device, { sources: ['library'] })).toEqual(['p3'])
    expect(
      await ids(device, { sources: ['spotify', 'spotify-liked'] }),
    ).toEqual(['p2', 'p1'])
    expect(await ids(device, { ids: ['p2', 'p3', 'p-none'] })).toEqual([
      'p3',
      'p2',
    ])
    expect(await ids(device, { acceptsAdditions: 'true' })).toEqual(['p1'])
    expect(await ids(device, { acceptsAdditions: 'false' })).toEqual([
      'p3',
      'p2',
    ])
    expect(
      await total(device, { sources: ['spotify'], acceptsAdditions: 'false' }),
    ).toEqual({ totalCount: 0 })
  })
})

describe('directory sorting', () => {
  type TextKey = 'owner' | 'description'
  type StoredNumberKey = 'source' | 'schedule' | 'nextSync'
  type NumberKey = keyof DevicePlaylistRow['num']

  // k1 and k4 share a value and a name, so the ID decides; k2 has no value.
  const names = ['Same', 'Other', 'Third', 'Same']

  function rowsWith(patches: PlaylistRowPatch[]) {
    return patches.map((patch, index) =>
      own(`k${index + 1}`, names[index] ?? 'Unnamed', patch),
    )
  }

  const textRows = (key: TextKey) =>
    rowsWith(
      ['m', null, 'b', 'm'].map((value) => {
        const sort: Partial<DevicePlaylistRow['sort']> = {}
        sort[key] = value
        return { sort }
      }),
    )
  const storedNumberRows = (key: StoredNumberKey) =>
    rowsWith(
      [20, null, 3, 20].map((value) => {
        const sort: Partial<DevicePlaylistRow['sort']> = {}
        sort[key] = value
        return { sort }
      }),
    )
  const numberRows = (key: NumberKey) =>
    rowsWith(
      [20, null, 3, 20].map((value) => {
        const num: Partial<DevicePlaylistRow['num']> = {}
        num[key] = value
        return { num }
      }),
    )

  const numberKeys: NumberKey[] = [
    'tracks',
    'linkedTracks',
    'albums',
    'duration',
    'imported',
    'checked',
    'added',
  ]
  const textKeys: TextKey[] = ['owner', 'description']
  const storedNumberKeys: StoredNumberKey[] = ['source', 'schedule', 'nextSync']
  const cases = [
    ...textKeys.map((key) => ({
      key,
      rows: () => textRows(key),
    })),
    ...storedNumberKeys.map((key) => ({
      key,
      rows: () => storedNumberRows(key),
    })),
    ...numberKeys.map((key) => ({ key, rows: () => numberRows(key) })),
  ]

  for (const { key, rows } of cases) {
    it(`sorts by ${key} in both directions, nulls last, then name and ID`, async () => {
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

  it('sorts by name, then ID, by code point', async () => {
    const device = await open([
      own('k1', 'b'),
      own('k2', 'B'),
      own('k3', 'é'),
      own('k0', 'a'),
    ])
    expect(await ids(device)).toEqual(['k0', 'k1', 'k2', 'k3'])
    expect(await ids(device, { direction: 'desc' })).toEqual([
      'k3',
      'k1',
      'k2',
      'k0',
    ])
  })

  it('breaks ties by the lower-cased name ascending in both directions', async () => {
    const device = await open([
      own('k1', 'Zulu', { num: { tracks: 5 } }),
      own('k2', 'alpha', { num: { tracks: 5 } }),
      own('k3', 'Mike', { num: { tracks: 9 } }),
    ])
    expect(await ids(device, { sortBy: 'tracks' })).toEqual(['k2', 'k1', 'k3'])
    expect(await ids(device, { sortBy: 'tracks', direction: 'desc' })).toEqual([
      'k3',
      'k2',
      'k1',
    ])
  })

  it('orders Type and Count without `library` by name and ID, and Updated by the import date', async () => {
    const device = await open(
      rowsWith([20, null, 3, 20].map((imported) => ({ num: { imported } }))),
    )
    for (const sortBy of ['type', 'count'])
      for (const direction of ['asc', 'desc'])
        expect(await ids(device, { sortBy, direction }), sortBy).toEqual([
          'k2',
          'k1',
          'k4',
          'k3',
        ])
    expect(await ids(device, { sortBy: 'updated' })).toEqual([
      'k3',
      'k1',
      'k4',
      'k2',
    ])
    expect(await ids(device, { sortBy: 'updated', direction: 'desc' })).toEqual(
      ['k1', 'k4', 'k3', 'k2'],
    )
  })

  it('puts the next sync last when the latest job has not succeeded', async () => {
    const device = await open([
      own('k1', 'First', { sort: { nextSync: 10 } }),
      own('k2', 'Second', { sort: { nextSync: 20 } }),
      own('k3', 'Third', { sort: { nextSync: 30 } }),
      playlistJob('spotify:k1', 'failed'),
      playlistJob('spotify:k3', 'succeeded'),
    ])
    expect(await ids(device, { sortBy: 'nextSync' })).toEqual([
      'k2',
      'k3',
      'k1',
    ])
    expect(
      await ids(device, { sortBy: 'nextSync', direction: 'desc' }),
    ).toEqual(['k3', 'k2', 'k1'])
  })
})

describe('directory paging and fall-throughs', () => {
  const rows = () =>
    ['a', 'b', 'c', 'd', 'e'].map((id) => own(id, `Playlist ${id}`))

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
    expect(await total(device)).toEqual({ totalCount: 5 })
  })

  it('leaves catalog scopes other than the library', async () => {
    const device = await open(rows())
    for (const scope of [
      { libraryScope: 'all' },
      { libraryScope: 'outside' },
      { discoverySourceScope: 'selection', discoverySources: 'spotify' },
    ]) {
      expect(
        reason(await device.source.playlistPage(playlistQuery(scope))),
      ).toBe('catalog-scope')
      expect(
        reason(await device.source.playlistCount(playlistQuery(scope))),
      ).toBe('catalog-scope')
    }
  })

  it('answers not-ready before the first fill', async () => {
    const device = await open(rows(), { ready: false })
    expect(reason(await device.source.playlistPage(playlistQuery()))).toBe(
      'not-ready',
    )
    expect(reason(await device.source.playlistCount(playlistQuery()))).toBe(
      'not-ready',
    )
  })
})
