import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEVICE_ROW_VERSION } from '@repo/schemas/device'
import type { SqliteDriver } from '../src/driver'
import { openBetterSqliteDriver } from '../src/drivers/better-sqlite3'
import { clearStore, openStore, readStoreStatus } from '../src/store'
import { FeedError, syncStore, type SyncProgress } from '../src/sync'
import { FakeFeed } from './fake-feed'
import {
  albumPayload,
  artistPayload,
  drivers,
  foldPayload,
  sharedPayloads,
  trackPayload,
} from './fixtures'

const TrackRowSchema = z.object({ id: z.string(), sort_title: z.string() })
const CountSchema = z.object({ count: z.number().int() })

async function storedTracks(driver: SqliteDriver) {
  const rows = await driver.all('SELECT id, sort_title FROM track ORDER BY id')
  return rows.map((row) => TrackRowSchema.parse(row))
}

async function count(driver: SqliteDriver, table: string) {
  const [row] = await driver.all(`SELECT count(*) AS count FROM ${table}`)
  return CountSchema.parse(row).count
}

/** Throws from the `failAt`-th statement inside a transaction that starts with `prefix`. */
function failingDriver(
  base: SqliteDriver,
  prefix: string,
  failAt: number,
): SqliteDriver {
  let runs = 0
  return {
    ...base,
    transaction: (work) =>
      base.transaction((tx) =>
        work({
          all: (sql, params) => tx.all(sql, params),
          run: (sql, params) => {
            if (sql.trimStart().startsWith(prefix)) runs += 1
            if (runs === failAt) {
              return Promise.reject(new Error('Simulated storage failure'))
            }
            return tx.run(sql, params)
          },
        }),
      ),
  }
}

function seedFeed(feed: FakeFeed, tracks: number) {
  feed.put('meta', 'fold', foldPayload)
  for (let index = 1; index <= tracks; index += 1) {
    feed.put('track', `track-${index}`, trackPayload(`track-${index}`))
  }
  feed.put('album', 'album-1', albumPayload('album-1'))
  feed.put('album', 'album-2', albumPayload('album-2'))
  feed.put('artist', 'artist-1', artistPayload('artist-1'))
  feed.put('tag', 'tag-1', sharedPayloads.tag)
  feed.put('scrobble_name', 'name-track-1', sharedPayloads.scrobble_name)
  feed.put('meta', 'listening', sharedPayloads.meta)
}

function expectedTracks(ids: string[], titles: Record<string, string> = {}) {
  return ids
    .map((id) => ({
      id,
      sort_title: (titles[id] ?? `Track ${id}`).toLowerCase(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

describe.each(drivers)('sync on $name', ({ open }) => {
  let driver: SqliteDriver
  let feed: FakeFeed

  beforeEach(async () => {
    driver = await open()
    await openStore(driver)
    feed = new FakeFeed()
  })

  afterEach(async () => {
    await driver.close()
  })

  it('fills from paged snapshots, then reports ready', async () => {
    seedFeed(feed, 5)
    const progress: SyncProgress[] = []
    const result = await syncStore(driver, feed.transport, {
      pageSize: 2,
      onProgress: (update) => progress.push(update),
      now: () => 1000,
    })

    expect(result).toEqual({
      status: 'synced',
      refilled: true,
      rowsApplied: 12,
      seq: feed.seq,
    })
    expect(
      feed.requests.filter((path) => path.includes('entity=track')),
    ).toHaveLength(3)
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2', 'track-3', 'track-4', 'track-5']),
    )
    expect(await count(driver, 'album')).toBe(2)
    expect(await count(driver, 'name_play')).toBe(3)
    expect(await readStoreStatus(driver)).toEqual({
      ready: true,
      phase: 'ready',
      epoch: 'epoch-1',
      rowVersion: DEVICE_ROW_VERSION,
      cursor: feed.seq,
      fill: null,
      filledAt: 1000,
      syncedAt: 1000,
    })
    expect(progress.filter((update) => update.entity === 'track')).toEqual([
      { phase: 'snapshot', entity: 'track', rowsApplied: 4, done: false },
      { phase: 'snapshot', entity: 'track', rowsApplied: 6, done: false },
      { phase: 'snapshot', entity: 'track', rowsApplied: 7, done: false },
    ])
    expect(progress.at(-1)).toEqual({
      phase: 'changes',
      entity: null,
      rowsApplied: 12,
      done: true,
    })
  })

  it('reports not ready until the fill has caught up with the change feed', async () => {
    seedFeed(feed, 3)
    const phases: boolean[] = []
    feed.beforeRequest = () => {
      void readStoreStatus(driver).then((status) => phases.push(status.ready))
    }
    await syncStore(driver, feed.transport, { pageSize: 1 })
    expect(phases.every((ready) => !ready)).toBe(true)
    expect((await readStoreStatus(driver)).ready).toBe(true)
  })

  it('ends with the feed rows when rows change between snapshot pages', async () => {
    seedFeed(feed, 5)
    let changed = false
    feed.beforeRequest = (path) => {
      if (
        !changed &&
        path.includes('entity=track') &&
        path.includes('after=3')
      ) {
        changed = true
        feed.put(
          'track',
          'track-1',
          trackPayload('track-1', { title: 'Renamed' }),
        )
        feed.remove('track', 'track-4')
        feed.put('track', 'track-6', trackPayload('track-6'))
      }
    }
    await syncStore(driver, feed.transport, { pageSize: 2 })
    expect(changed).toBe(true)
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2', 'track-3', 'track-5', 'track-6'], {
        'track-1': 'Renamed',
      }),
    )
  })

  it('applies incremental changes and tombstones from the cursor', async () => {
    seedFeed(feed, 3)
    await syncStore(driver, feed.transport)
    feed.put('track', 'track-2', trackPayload('track-2', { title: 'Edited' }))
    feed.remove('track', 'track-3')
    feed.remove('scrobble_name', 'name-track-1')
    feed.put('track', 'track-7', trackPayload('track-7'))
    feed.requests.length = 0

    const result = await syncStore(driver, feed.transport, { pageSize: 2 })
    expect(result).toEqual({
      status: 'synced',
      refilled: false,
      rowsApplied: 4,
      seq: feed.seq,
    })
    expect(feed.requests.some((path) => path.includes('snapshot'))).toBe(false)
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2', 'track-7'], {
        'track-2': 'Edited',
      }),
    )
    expect(await count(driver, 'name_play')).toBe(0)
    expect((await readStoreStatus(driver)).cursor).toBe(feed.seq)
  })

  it('refills after a reset', async () => {
    seedFeed(feed, 3)
    await syncStore(driver, feed.transport)
    feed.put('track', 'track-1', trackPayload('track-1', { title: 'Later' }))
    feed.minSeq = feed.seq
    const result = await syncStore(driver, feed.transport)
    expect(result).toMatchObject({ status: 'synced', refilled: true })
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2', 'track-3'], { 'track-1': 'Later' }),
    )
  })

  it('refills after the epoch changes', async () => {
    seedFeed(feed, 3)
    await syncStore(driver, feed.transport)
    feed.remove('track', 'track-2')
    feed.rebuild('epoch-2')
    const result = await syncStore(driver, feed.transport)
    expect(result).toMatchObject({ status: 'synced', refilled: true })
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-3']),
    )
    expect((await readStoreStatus(driver)).epoch).toBe('epoch-2')
  })

  it('refills a store filled under another row version', async () => {
    seedFeed(feed, 2)
    await syncStore(driver, feed.transport)
    await driver.run('UPDATE sync_state SET row_version = ?', [
      DEVICE_ROW_VERSION + 1,
    ])
    await driver.run("UPDATE track SET sort_title = 'stale'")
    const result = await syncStore(driver, feed.transport)
    expect(result).toMatchObject({ status: 'synced', refilled: true })
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2']),
    )
  })

  it('clears the store when the server sends another row version', async () => {
    seedFeed(feed, 2)
    await syncStore(driver, feed.transport)
    feed.rowVersion = DEVICE_ROW_VERSION + 1
    await expect(syncStore(driver, feed.transport)).rejects.toBeInstanceOf(
      FeedError,
    )
    expect(await readStoreStatus(driver)).toMatchObject({
      ready: false,
      phase: 'empty',
    })
    expect(await count(driver, 'track')).toBe(0)
  })

  it('keeps the previous state when a change page fails midway', async () => {
    seedFeed(feed, 3)
    await syncStore(driver, feed.transport)
    const before = await readStoreStatus(driver)
    feed.put('track', 'track-1', trackPayload('track-1', { title: 'Edited' }))
    feed.put('track', 'track-2', trackPayload('track-2', { title: 'Edited' }))
    feed.remove('track', 'track-3')

    await expect(
      syncStore(
        failingDriver(driver, 'INSERT INTO item_text', 2),
        feed.transport,
      ),
    ).rejects.toThrow('Simulated storage failure')
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2', 'track-3']),
    )
    expect(await readStoreStatus(driver)).toEqual(before)
    expect(await count(driver, 'item_text_fts')).toBe(
      await count(driver, 'item_text'),
    )

    await syncStore(driver, feed.transport)
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2'], {
        'track-1': 'Edited',
        'track-2': 'Edited',
      }),
    )
  })

  it('resumes a fill from the last committed snapshot page', async () => {
    seedFeed(feed, 5)
    await expect(
      syncStore(
        failingDriver(driver, 'INSERT INTO item_text', 4),
        feed.transport,
        {
          pageSize: 2,
        },
      ),
    ).rejects.toThrow('Simulated storage failure')
    const stopped = await readStoreStatus(driver)
    expect(stopped.ready).toBe(false)
    expect(stopped.fill).not.toBeNull()
    const tracksBefore = await count(driver, 'track')
    expect(tracksBefore).toBeGreaterThan(0)

    feed.requests.length = 0
    const result = await syncStore(driver, feed.transport, { pageSize: 2 })
    expect(result).toMatchObject({ status: 'synced', refilled: false })
    expect(
      feed.requests.some(
        (path) => path.includes('after=0&') && path.includes('entity=track'),
      ),
    ).toBe(false)
    expect(await storedTracks(driver)).toEqual(
      expectedTracks(['track-1', 'track-2', 'track-3', 'track-4', 'track-5']),
    )
  })

  it('leaves the store alone while the feed is not ready', async () => {
    feed.ready = false
    expect(await syncStore(driver, feed.transport)).toEqual({
      status: 'feed-not-ready',
    })
    expect((await readStoreStatus(driver)).phase).toBe('empty')
  })

  it('shares one run between concurrent calls', async () => {
    seedFeed(feed, 2)
    const [first, second] = await Promise.all([
      syncStore(driver, feed.transport),
      syncStore(driver, feed.transport),
    ])
    expect(second).toBe(first)
    expect(
      feed.requests.filter((path) => path.endsWith('/state')),
    ).toHaveLength(1)
  })

  it('clears every row and the cursor', async () => {
    seedFeed(feed, 3)
    await syncStore(driver, feed.transport)
    await clearStore(driver)
    expect(await readStoreStatus(driver)).toEqual({
      ready: false,
      phase: 'empty',
      epoch: null,
      rowVersion: null,
      cursor: null,
      fill: null,
      filledAt: null,
      syncedAt: null,
    })
    for (const table of [
      'track',
      'album',
      'artist',
      'item_text',
      'item_text_fts',
      'item_search',
      'item_num',
      'item_sort',
      'tag',
      'play_set',
      'name_play',
      'meta',
    ]) {
      expect(await count(driver, table)).toBe(0)
    }
    const result = await syncStore(driver, feed.transport)
    expect(result).toMatchObject({ status: 'synced', refilled: true })
  })

  it('stops a fill that a clear interrupts, and fills again afterwards', async () => {
    seedFeed(feed, 120)
    let snapshots = 0
    let cleared: Promise<void> | undefined
    feed.beforeRequest = (path) => {
      if (!path.includes('/snapshot') || !path.includes('entity=track')) return
      snapshots += 1
      // Sign-out while the fill is between track pages.
      if (snapshots === 2) cleared = clearStore(driver)
    }
    expect(await syncStore(driver, feed.transport, { pageSize: 50 })).toEqual({
      status: 'cleared',
    })
    await cleared
    expect(await readStoreStatus(driver)).toMatchObject({
      ready: false,
      phase: 'empty',
    })
    for (const table of ['track', 'album', 'meta', 'item_text'])
      expect(await count(driver, table)).toBe(0)

    feed.beforeRequest = null
    expect(
      await syncStore(driver, feed.transport, { pageSize: 50 }),
    ).toMatchObject({ status: 'synced', refilled: true })
    expect(await count(driver, 'track')).toBe(120)
    expect((await readStoreStatus(driver)).ready).toBe(true)
  })

  it('stops a change sync that a clear interrupts', async () => {
    seedFeed(feed, 10)
    await syncStore(driver, feed.transport, { pageSize: 50 })
    for (let index = 1; index <= 60; index += 1)
      feed.put('track', `track-${index}`, trackPayload(`track-${index}`))
    let changes = 0
    let cleared: Promise<void> | undefined
    feed.beforeRequest = (path) => {
      if (!path.includes('/changes')) return
      changes += 1
      if (changes === 2) cleared = clearStore(driver)
    }
    expect(await syncStore(driver, feed.transport, { pageSize: 50 })).toEqual({
      status: 'cleared',
    })
    await cleared
    expect((await readStoreStatus(driver)).phase).toBe('empty')
    expect(await count(driver, 'track')).toBe(0)
    expect(await count(driver, 'meta')).toBe(0)
  })

  it('runs a sync asked for after a clear, while the cleared one ends', async () => {
    seedFeed(feed, 120)
    let later: Promise<unknown> | undefined
    feed.beforeRequest = (path) => {
      if (later !== undefined || !path.includes('entity=track')) return
      later = clearStore(driver).then(() =>
        syncStore(driver, feed.transport, { pageSize: 50 }),
      )
    }
    expect(await syncStore(driver, feed.transport, { pageSize: 50 })).toEqual({
      status: 'cleared',
    })
    feed.beforeRequest = null
    expect(await later).toMatchObject({ status: 'synced', refilled: true })
    expect(await count(driver, 'track')).toBe(120)
    expect((await readStoreStatus(driver)).ready).toBe(true)
  })

  it('refills when a change page brings another fold mapping', async () => {
    seedFeed(feed, 2)
    feed.put(
      'track',
      'track-sigma',
      trackPayload('track-sigma', { title: 'ΣΑΣ' }),
    )
    await syncStore(driver, feed.transport)
    const folded = async () =>
      (
        await driver.all(
          "SELECT folded FROM item_text WHERE field = 'title' AND value = 'ΣΑΣ'",
        )
      ).map((row) => row.folded)
    expect(await folded()).toEqual(['σασ'])
    // The server's database now leaves Greek capitals alone.
    feed.put('meta', 'fold', {
      kind: 'fold',
      codePoints: foldPayload.codePoints.filter(
        (codePoint) => codePoint < 0x370,
      ),
      lower: foldPayload.lower.filter(
        (_, index) => (foldPayload.codePoints[index] ?? 0) < 0x370,
      ),
    })
    const result = await syncStore(driver, feed.transport)
    expect(result).toMatchObject({ status: 'synced', refilled: true })
    expect(await folded()).toEqual(['ΣΑΣ'])
    expect(await count(driver, 'track')).toBe(3)
    // The same mapping again changes nothing.
    feed.put('meta', 'fold', {
      kind: 'fold',
      codePoints: foldPayload.codePoints.filter(
        (codePoint) => codePoint < 0x370,
      ),
      lower: foldPayload.lower.filter(
        (_, index) => (foldPayload.codePoints[index] ?? 0) < 0x370,
      ),
    })
    expect(await syncStore(driver, feed.transport)).toMatchObject({
      status: 'synced',
      refilled: false,
    })
  })

  it('fails a fill whose item rows come before any fold row', async () => {
    feed.put('track', 'track-1', trackPayload('track-1'))
    await expect(syncStore(driver, feed.transport)).rejects.toThrow(
      'before the fold row',
    )
    expect((await readStoreStatus(driver)).ready).toBe(false)
    expect(await count(driver, 'track')).toBe(0)
  })

  it('pages the fold row before every item row', async () => {
    seedFeed(feed, 2)
    await syncStore(driver, feed.transport)
    const snapshots = feed.requests.filter((path) => path.includes('/snapshot'))
    expect(snapshots[0]).toContain('entity=meta')
  })

  it('rebuilds a store whose sync state is missing or corrupt, then fills it', async () => {
    seedFeed(feed, 2)
    await syncStore(driver, feed.transport)
    await driver.run("UPDATE sync_state SET epoch = 7, cursor = 'later'")
    expect(await syncStore(driver, feed.transport)).toMatchObject({
      status: 'synced',
      refilled: true,
    })
    expect(await count(driver, 'track')).toBe(2)
    await driver.run('DELETE FROM sync_state')
    expect(await syncStore(driver, feed.transport)).toMatchObject({
      status: 'synced',
      refilled: true,
    })
    expect((await readStoreStatus(driver)).ready).toBe(true)
    await driver.run('DROP TABLE sync_state')
    expect(await syncStore(driver, feed.transport)).toMatchObject({
      status: 'synced',
      refilled: true,
    })
    expect(await count(driver, 'track')).toBe(2)
  })
})

describe('a clear from another connection', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'library-source-sync-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('stops a sync on this one before its next page', async () => {
    const filename = join(directory, 'store.sqlite3')
    const syncing = openBetterSqliteDriver({ filename })
    const other = openBetterSqliteDriver({ filename })
    const feed = new FakeFeed()
    seedFeed(feed, 120)
    let snapshots = 0
    // The other connection (another tab, in a browser) clears between pages;
    // here it finishes before the page returns, as one thread runs both.
    const transport = async (path: string) => {
      if (path.includes('entity=track')) snapshots += 1
      if (snapshots === 2 && path.includes('entity=track'))
        await clearStore(other)
      return feed.transport(path)
    }
    expect(await syncStore(syncing, transport, { pageSize: 50 })).toEqual({
      status: 'cleared',
    })
    expect((await readStoreStatus(syncing)).phase).toBe('empty')
    expect(await count(syncing, 'track')).toBe(0)
    await syncing.close()
    await other.close()
  })
})
