import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DeviceSnapshotPageSchema,
  type DeviceEntity,
} from '@repo/schemas/device'
import { applyRows } from '../src/apply'
import type { SqlValue, SqliteDriver } from '../src/driver'
import { openBetterSqliteDriver } from '../src/drivers/better-sqlite3'
import { openWasmMemoryDriver } from '../src/drivers/sqlite-wasm'
import { globContains } from '../src/fold'
import { openStore } from '../src/store'
import { albumPayload, artistPayload, trackPayload } from './fixtures'

/**
 * Store size and speed on a synthetic library (run with `pnpm measure`).
 * Every value is generated here; nothing is read from a real library.
 */

const TRACKS = 30_000
const ALBUMS = 5_000
const ARTISTS = 3_000
const PAGE = 500

const WORDS = [
  'night',
  'light',
  'river',
  'stone',
  'echo',
  'glass',
  'winter',
  'signal',
  'harbor',
  'motion',
  'velvet',
  'ember',
  'paper',
  'orbit',
  'meadow',
  'static',
  'cinder',
  'hollow',
  'lantern',
  'mirror',
  'Öresund',
  'İzmir',
  'Σήμα',
  'café',
]

function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

type Page = { entity: DeviceEntity; rows: unknown[] }

function buildPages(): { pages: Page[]; plays: number } {
  const next = random(7)
  const pick = <T>(list: readonly T[]): T => {
    const value = list[Math.floor(next() * list.length)]
    if (value === undefined) throw new Error('Empty list')
    return value
  }
  const phrase = (words: number) =>
    Array.from({ length: words }, () => pick(WORDS)).join(' ')
  const artists = Array.from(
    { length: ARTISTS },
    (_, index) => `${phrase(2)} ${index}`,
  )
  const albums = Array.from(
    { length: ALBUMS },
    (_, index) => `${phrase(3)} ${index}`,
  )

  let seq = 0
  const rows: Record<string, unknown[]> = {
    track: [],
    album: [],
    artist: [],
    scrobble_name: [],
  }
  let plays = 0
  for (let index = 0; index < TRACKS; index += 1) {
    const id = `track-${index}`
    const payload = trackPayload(id, {
      title: `${phrase(3)} ${index}`,
      artist: pick(artists),
      album: next() < 0.1 ? null : pick(albums),
      dateAddedDay: Math.floor(next() * 3_000),
      durationSec: 60 + Math.floor(next() * 480),
      scrobbles: Math.floor(next() * 40),
      tagIds: [
        `tag-${Math.floor(next() * 300)}`,
        `tag-${Math.floor(next() * 300)}`,
      ],
      nameIds: [`name-${index}`],
    })
    seq += 1
    rows.track?.push({ entity: 'track', id, seq, deleted: false, payload })
    const count = Math.floor(next() * 20)
    const start = 1_500_000_000 + Math.floor(next() * 200_000_000)
    const times = Array.from({ length: count }, (_, n) => start + n * 86_400)
    plays += count
    seq += 1
    rows.scrobble_name?.push({
      entity: 'scrobble_name',
      id: `name-${index}`,
      seq,
      deleted: false,
      payload: { plays: times },
    })
  }
  for (let index = 0; index < ALBUMS; index += 1) {
    seq += 1
    rows.album?.push({
      entity: 'album',
      id: `album-${index}`,
      seq,
      deleted: false,
      payload: albumPayload(`album-${index}`, {
        title: albums[index],
        dateAddedDay: Math.floor(next() * 3_000),
      }),
    })
  }
  for (let index = 0; index < ARTISTS; index += 1) {
    seq += 1
    rows.artist?.push({
      entity: 'artist',
      id: `artist-${index}`,
      seq,
      deleted: false,
      payload: artistPayload(`artist-${index}`, { name: artists[index] }),
    })
  }
  const pages: Page[] = []
  for (const [entity, list] of Object.entries(rows)) {
    for (let start = 0; start < list.length; start += PAGE) {
      pages.push({
        entity: z
          .enum(['track', 'album', 'artist', 'scrobble_name'])
          .parse(entity),
        rows: list.slice(start, start + PAGE),
      })
    }
  }
  return { pages, plays }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function time(work: () => Promise<unknown>, runs = 15) {
  await work()
  const times: number[] = []
  for (let run = 0; run < runs; run += 1) {
    const start = performance.now()
    await work()
    times.push(performance.now() - start)
  }
  return Number(median(times).toFixed(2))
}

const VISIBLE = 'archived = 0 AND redundant_placeholder = 0'
const NATURAL = `natural_artist, natural_year, sort_album, album_id,
  natural_spotify_album_id, natural_position, sort_title, id`

const reads: Record<string, { sql: string; params: () => SqlValue[] }> = {
  'tracks, dateAdded desc, first page': {
    sql: `SELECT j.item FROM track JOIN item_json j ON j.entity = 'track' AND j.rid = track.rid WHERE ${VISIBLE}
      ORDER BY date_added DESC NULLS LAST, ${NATURAL} LIMIT 25`,
    params: () => [],
  },
  'tracks, title asc, first page': {
    sql: `SELECT j.item FROM track JOIN item_json j ON j.entity = 'track' AND j.rid = track.rid WHERE ${VISIBLE}
      ORDER BY sort_title ASC NULLS LAST, ${NATURAL} LIMIT 25`,
    params: () => [],
  },
  'tracks, q trigram (title, artist, album), page and count': {
    sql: `WITH hits AS (
        SELECT v.rid FROM item_text_fts f JOIN item_text v ON v.tid = f.rowid
        WHERE f.folded GLOB ? AND v.entity = 'track'
          AND v.field IN ('title', 'artist', 'album')
      )
      SELECT j.item, (SELECT count(*) FROM track t2 WHERE t2.rid IN hits AND t2.archived = 0) AS total
      FROM track JOIN item_json j ON j.entity = 'track' AND j.rid = track.rid
      WHERE track.rid IN hits AND ${VISIBLE}
      ORDER BY date_added DESC NULLS LAST, ${NATURAL} LIMIT 25`,
    params: () => [globContains('ANTER')],
  },
  'tracks, durationSec range, page and count': {
    sql: `WITH hits AS (
        SELECT rid FROM item_num
        WHERE entity = 'track' AND field = 'durationSec' AND value BETWEEN ? AND ?
      )
      SELECT j.item, (SELECT count(*) FROM track t2 WHERE t2.rid IN hits AND t2.archived = 0) AS total
      FROM track JOIN item_json j ON j.entity = 'track' AND j.rid = track.rid
      WHERE track.rid IN hits AND ${VISIBLE}
      ORDER BY date_added DESC NULLS LAST, ${NATURAL} LIMIT 25`,
    params: () => [180, 240],
  },
  'tracks, scrobbles in the last year (plays)': {
    sql: `SELECT tn.rid, count(*) AS plays FROM track_name tn
      JOIN play_set ps ON ps.entity = 'scrobble_name' AND ps.id = tn.name_id
      JOIN name_play np ON np.pid = ps.pid AND np.played_at >= ?
      GROUP BY tn.rid ORDER BY plays DESC LIMIT 25`,
    params: () => [1_650_000_000],
  },
}

describe('store measurements', () => {
  let built: ReturnType<typeof buildPages> | undefined
  const library = () => (built ??= buildPages())

  async function fill(driver: SqliteDriver) {
    const perEntity = new Map<
      string,
      { rows: number; parse: number; apply: number }
    >()
    for (const page of library().pages) {
      const parseStart = performance.now()
      const parsed = DeviceSnapshotPageSchema.parse({
        reset: false,
        rows: page.rows,
        seq: 0,
        hasMore: false,
      })
      const applyStart = performance.now()
      await driver.transaction((tx) => applyRows(tx, parsed.rows))
      const end = performance.now()
      const entry = perEntity.get(page.entity) ?? {
        rows: 0,
        parse: 0,
        apply: 0,
      }
      entry.rows += page.rows.length
      entry.parse += applyStart - parseStart
      entry.apply += end - applyStart
      perEntity.set(page.entity, entry)
    }
    return [...perEntity.entries()].map(([entity, entry]) => ({
      entity,
      rows: entry.rows,
      'parse ms / 1000 rows': Number(
        ((entry.parse / entry.rows) * 1000).toFixed(1),
      ),
      'apply ms / 1000 rows': Number(
        ((entry.apply / entry.rows) * 1000).toFixed(1),
      ),
    }))
  }

  async function measureReads(driver: SqliteDriver) {
    const result: Record<string, number> = {}
    for (const [name, read] of Object.entries(reads)) {
      const rows = await driver.all(read.sql, read.params())
      expect(rows.length).toBeGreaterThan(0)
      result[`${name} (ms)`] = await time(() =>
        driver.all(read.sql, read.params()),
      )
    }
    return result
  }

  async function sizeOf(driver: SqliteDriver) {
    const tables = await driver.all(
      `SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12`,
    )
    return tables
  }

  it('better-sqlite3 file database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'library-source-measure-'))
    const filename = join(directory, 'store.sqlite3')
    const driver = openBetterSqliteDriver({ filename })
    try {
      await openStore(driver)
      const fillStart = performance.now()
      const perEntity = await fill(driver)
      const fillMs = performance.now() - fillStart
      await driver.run('PRAGMA wal_checkpoint(TRUNCATE)')
      const bytes = statSync(filename).size
      console.info(
        `better-sqlite3: ${library().plays} play times; fill ${fillMs.toFixed(0)} ms; file ${(bytes / 1_048_576).toFixed(1)} MiB`,
      )
      console.table(perEntity)
      console.table(await measureReads(driver))
      console.table(await sizeOf(driver))
    } finally {
      await driver.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 600_000)

  it('sqlite-wasm in memory', async () => {
    const driver = await openWasmMemoryDriver()
    try {
      await openStore(driver)
      const fillStart = performance.now()
      const perEntity = await fill(driver)
      const fillMs = performance.now() - fillStart
      const pageRows = z
        .object({ page_count: z.number(), page_size: z.number() })
        .parse(
          (
            await driver.all(
              'SELECT page_count, page_size FROM pragma_page_count, pragma_page_size',
            )
          )[0],
        )
      const bytes = pageRows.page_count * pageRows.page_size
      console.info(
        `sqlite-wasm: fill ${fillMs.toFixed(0)} ms; database ${(bytes / 1_048_576).toFixed(1)} MiB`,
      )
      console.table(perEntity)
      console.table(await measureReads(driver))
    } finally {
      await driver.close()
    }
  }, 600_000)
})
