import { afterEach, describe, expect, it } from 'vitest'
import { DEVICE_ROW_VERSION } from '@repo/schemas/device'
import { readSource, type LibraryQueries } from '../src/reads'
import { resolveLibraryRead } from '../src/resolve'
import { STORE_SCHEMA_VERSION } from '../src/schema'
import type { LibraryMethod, LibrarySource } from '../src/source'
import {
  openDeviceStore,
  reason,
  totalCount,
  trackQuery,
  type DeviceStore,
} from './device-store'
import { trackRow } from './fixtures'

/** Synthetic rows only. */

let store: DeviceStore | undefined

afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open() {
  store = await openDeviceStore([
    { entity: 'track', id: 'track-1', payload: trackRow('track-1') },
  ])
  return store
}

function read<Method extends LibraryMethod>(
  source: LibrarySource,
  request: { method: Method; query: LibraryQueries[Method] },
) {
  return readSource(source, request.method, request.query)
}

describe('a store that cannot answer', () => {
  it('is not ready when it was filled for another row version', async () => {
    const device = await open()
    expect(await totalCount(device)).toBe(1)
    await device.driver.run('UPDATE sync_state SET row_version = ?', [
      DEVICE_ROW_VERSION + 1,
    ])
    expect(reason(await device.source.trackCount(trackQuery()))).toBe(
      'not-ready',
    )
  })

  it('is not ready under another schema version', async () => {
    const device = await open()
    await device.driver.run(`PRAGMA user_version = ${STORE_SCHEMA_VERSION + 1}`)
    expect(reason(await device.source.trackCount(trackQuery()))).toBe(
      'not-ready',
    )
  })

  it('is not ready without the fold row', async () => {
    const device = await open()
    await device.driver.run("DELETE FROM meta WHERE id = 'fold'")
    expect(reason(await device.source.trackCount(trackQuery()))).toBe(
      'not-ready',
    )
  })
})

const allTime = encodeURIComponent(JSON.stringify({ kind: 'all' }))

/** Every read with a text parameter, as the web client asks for it. */
const nulPaths = [
  'tracks?q=hum%00',
  'tracks/browse-page?q=hum%00',
  'tracks/browse-count?q=hum%00',
  'tracks/positions?positions=0&q=hum%00',
  'tracks/facets?q=hum%00',
  `tracks/listening-histogram?q=hum%00&period=${allTime}`,
  'tracks/track-1/recordings?q=hum%00',
  'albums?q=hum%00',
  'albums/browse-page?q=hum%00',
  'albums/browse-count?q=hum%00',
  'albums/facets?q=hum%00',
  `albums/listening-histogram?q=hum%00&period=${allTime}`,
  'films?q=hum%00',
  'films/browse-page?q=hum%00',
  'films/browse-count?q=hum%00',
  'films/facets?q=hum%00',
  'artists/browse-page?q=hum%00',
  'artists/browse-count?q=hum%00',
  'artists/facets?q=hum%00',
  `artists/listening-histogram?q=hum%00&period=${allTime}`,
  'playlists/browse-page?q=hum%00',
  'playlists/browse-count?name=hum%00',
  `tracks/browse-page?filters=${encodeURIComponent(
    JSON.stringify([{ field: 'title', value: 'Hum\u0000' }]),
  )}`,
  `albums/browse-count?tag=${encodeURIComponent('rock\u0000')}`,
]

describe('text the API rejects', () => {
  it('falls through as invalid-query in every read that takes text', async () => {
    const device = await open()
    for (const path of nulPaths) {
      const request = resolveLibraryRead(`/api/v1/${path}`)
      expect(request, path).toBeDefined()
      if (request === undefined) continue
      expect(reason(await read(device.source, request)), path).toBe(
        'invalid-query',
      )
    }
  })

  it('serves the same reads without the NUL', async () => {
    const device = await open()
    for (const path of nulPaths) {
      const request = resolveLibraryRead(
        `/api/v1/${path.replaceAll('%00', '').replaceAll('%5Cu0000', '')}`,
      )
      if (request === undefined) continue
      expect(reason(await read(device.source, request)), path).not.toBe(
        'invalid-query',
      )
    }
  })
})
