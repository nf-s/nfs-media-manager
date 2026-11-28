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
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import {
  ArchivableBrowseFacetQuerySchema,
  BrowseFacetQuerySchema,
  albumBrowseFields,
  trackBrowseFields,
} from '@repo/schemas/browse'
import { ArtistListeningHistogramQuerySchema } from '@repo/schemas/creators'
import { AlbumListeningHistogramQuerySchema } from '@repo/schemas/media'
import {
  TrackListeningHistogramQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import { applyRows } from '../src/apply'
import { createDeviceLibrarySource } from '../src/device/source'
import type { SqlValue, SqliteDriver } from '../src/driver'
import { openBetterSqliteDriver } from '../src/drivers/better-sqlite3'
import { openWasmMemoryDriver } from '../src/drivers/sqlite-wasm'
import { globContains } from '../src/fold'
import { openStore } from '../src/store'
import { albumPayload, artistPayload, tagPayload, trackRow } from './fixtures'

/**
 * Store size and speed on a synthetic library (run with `pnpm measure`).
 * Every value is generated here; nothing is read from a real library.
 */

const TRACKS = 30_000
const ALBUMS = 5_000
const ARTISTS = 3_000
const TAGS = 300
/** Tags 1 to 20 sit beneath tag 0, so a filter on tag 0 reads 21 tags. */
const SUBTAGS = 20
/** A quarter of the tracks share a recording key with about three others. */
const RECORDING_KEYS = 2_000
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
    tag: [],
    tag_key: [],
    track: [],
    album: [],
    artist: [],
    scrobble_name: [],
    album_plays: [],
    artist_plays: [],
    meta: [],
  }
  /** Up to 40 plays a day apart, from a random start. */
  const playTimes = () => {
    const count = Math.floor(next() * 40)
    const start = 1_500_000_000 + Math.floor(next() * 200_000_000)
    return Array.from({ length: count }, (_, n) => start + n * 86_400)
  }
  for (let index = 0; index < TAGS; index += 1) {
    seq += 1
    rows.tag?.push({
      entity: 'tag',
      id: `tag-${index}`,
      seq,
      deleted: false,
      payload: tagPayload({ name: `Genre ${index}` }),
    })
  }
  for (let index = 1; index <= SUBTAGS; index += 1) {
    seq += 1
    rows.tag_key?.push({
      entity: 'tag_key',
      id: `album:genre ${index}`,
      seq,
      deleted: false,
      payload: {
        mediaType: 'album',
        key: `genre ${index}`,
        ancestorKeys: ['genre 0'],
      },
    })
  }
  let plays = 0
  for (let index = 0; index < TRACKS; index += 1) {
    const id = `track-${index}`
    const payload = trackRow(
      id,
      {
        extra: {
          recording: {
            key: index % 4 === 0 ? `rec-${index % RECORDING_KEYS}` : null,
          },
        },
      },
      {
        title: `${phrase(3)} ${index}`,
        artist: pick(artists),
        album: next() < 0.1 ? null : pick(albums),
        dateAddedDay: Math.floor(next() * 3_000),
        durationSec: 60 + Math.floor(next() * 480),
        scrobbles: Math.floor(next() * 40),
        tagIds: [
          `tag-${Math.floor(next() * TAGS)}`,
          `tag-${Math.floor(next() * TAGS)}`,
        ],
        nameIds: [`name-${index}`],
      },
    )
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
    seq += 1
    rows.album_plays?.push({
      entity: 'album_plays',
      id: `album-${index}`,
      seq,
      deleted: false,
      payload: { plays: playTimes() },
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
    seq += 1
    rows.artist_plays?.push({
      entity: 'artist_plays',
      id: `artist-${index}`,
      seq,
      deleted: false,
      payload: { plays: playTimes() },
    })
  }
  seq += 1
  rows.meta?.push({
    entity: 'meta',
    id: 'fields:track',
    seq,
    deleted: false,
    payload: { kind: 'fields', library: 'track', fields: trackBrowseFields },
  })
  seq += 1
  rows.meta?.push({
    entity: 'meta',
    id: 'fields:album',
    seq,
    deleted: false,
    payload: { kind: 'fields', library: 'album', fields: albumBrowseFields },
  })
  seq += 1
  rows.meta?.push({
    entity: 'meta',
    id: 'fields:artist',
    seq,
    deleted: false,
    payload: { kind: 'fields', library: 'artist', fields: artistBrowseFields },
  })
  seq += 1
  rows.meta?.push({
    entity: 'meta',
    id: 'providers',
    seq,
    deleted: false,
    payload: {
      kind: 'providers',
      names: [{ id: 'example-provider', displayName: 'Example Provider' }],
    },
  })
  const pages: Page[] = []
  for (const [entity, list] of Object.entries(rows)) {
    for (let start = 0; start < list.length; start += PAGE) {
      pages.push({
        entity: z
          .enum([
            'tag',
            'tag_key',
            'track',
            'album',
            'artist',
            'scrobble_name',
            'album_plays',
            'artist_plays',
            'meta',
          ])
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

  /** Reads through the device source, as a page asks for them. */
  async function measureSource(driver: SqliteDriver) {
    await driver.run(
      `UPDATE sync_state SET phase = 'ready', epoch = 'measure', row_version = 1,
         cursor = 0, filled_at = 0, synced_at = 0 WHERE id = 1`,
    )
    const source = createDeviceLibrarySource(driver, {
      now: () => new Date('2024-06-15T12:00:00.000Z'),
    })
    const queries: Record<string, Record<string, unknown>> = {
      'first page, dateAdded desc': {},
      'three-word search': { q: 'night river ember' },
      'tag filter with 20 subtags': {
        filters: [{ field: 'genre', value: 'Genre 0' }],
      },
      'listening sort, rolling year': { sortBy: 'listeningScrobbles' },
      'grouped first page': { groupRecordings: true },
      'grouped, listening sort': {
        groupRecordings: true,
        sortBy: 'listeningScrobbles',
      },
    }
    const result: Record<string, { page: number; count: number }> = {}
    for (const [name, input] of Object.entries(queries)) {
      const query = TrackQuerySchema.parse(input)
      const page = await source.trackPage(query)
      const count = await source.trackCount(query)
      if (!page.served || !count.served)
        throw new Error(`${name} was not served`)
      expect(page.data.items.length).toBeGreaterThan(0)
      result[`${name} (ms)`] = {
        page: await time(() => source.trackPage(query)),
        count: await time(() => source.trackCount(query)),
      }
    }
    return result
  }

  /** Tracks suggestions and the listening histogram, through the device source. */
  async function measureSuggestions(driver: SqliteDriver) {
    const source = createDeviceLibrarySource(driver, {
      now: () => new Date('2024-06-15T12:00:00.000Z'),
    })
    const result: Record<string, number> = {}
    const facetQueries: Record<string, Record<string, unknown>> = {
      'facets, no typed text': {},
      'facets, one typed word': { q: 'river' },
    }
    for (const [name, input] of Object.entries(facetQueries)) {
      const query = BrowseFacetQuerySchema.parse(input)
      const facets = await source.trackFacets(query)
      if (!facets.served) throw new Error(`${name} was not served`)
      expect(facets.data.length).toBeGreaterThan(0)
      result[`${name} (ms)`] = await time(() => source.trackFacets(query))
    }
    const histogramQueries: Record<string, Record<string, unknown>> = {
      'histogram, rolling year': {
        period: JSON.stringify({ kind: 'rolling', amount: 1, unit: 'years' }),
      },
      'histogram, grouped, all time': {
        groupRecordings: true,
        period: JSON.stringify({ kind: 'all' }),
      },
    }
    for (const [name, input] of Object.entries(histogramQueries)) {
      const query = TrackListeningHistogramQuerySchema.parse(input)
      const histogram = await source.trackHistogram(query)
      if (!histogram.served) throw new Error(`${name} was not served`)
      result[`${name} (ms)`] = await time(() => source.trackHistogram(query))
    }
    return result
  }

  /** Albums and Artists suggestions and histograms, through the device source. */
  async function measureLibraries(driver: SqliteDriver) {
    const source = createDeviceLibrarySource(driver, {
      now: () => new Date('2024-06-15T12:00:00.000Z'),
    })
    const year = JSON.stringify({ kind: 'rolling', amount: 1, unit: 'years' })
    const reads: Record<string, () => Promise<{ served: boolean }>> = {
      'album facets, no typed text': () =>
        source.albumFacets(ArchivableBrowseFacetQuerySchema.parse({})),
      'album facets, one typed word': () =>
        source.albumFacets(
          ArchivableBrowseFacetQuerySchema.parse({ q: 'river' }),
        ),
      'album facets, Tags at track and album': () =>
        source.albumFacets(
          ArchivableBrowseFacetQuerySchema.parse({ tagLevels: 'track,album' }),
        ),
      'album histogram, rolling year': () =>
        source.albumHistogram(
          AlbumListeningHistogramQuerySchema.parse({ period: year }),
        ),
      'artist facets, no typed text': () =>
        source.artistFacets(BrowseFacetQuerySchema.parse({})),
      'artist facets, one typed word': () =>
        source.artistFacets(BrowseFacetQuerySchema.parse({ q: 'river' })),
      'artist histogram, rolling year': () =>
        source.artistHistogram(
          ArtistListeningHistogramQuerySchema.parse({ period: year }),
        ),
    }
    const result: Record<string, number> = {}
    for (const [name, read] of Object.entries(reads)) {
      if (!(await read()).served) throw new Error(`${name} was not served`)
      result[`${name} (ms)`] = await time(read)
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
      console.table(await measureSource(driver))
      console.table(await measureSuggestions(driver))
      console.table(await measureLibraries(driver))
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
      console.table(await measureSource(driver))
      console.table(await measureSuggestions(driver))
      console.table(await measureLibraries(driver))
    } finally {
      await driver.close()
    }
  }, 600_000)
})
