import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { z } from 'zod'
import {
  createDeviceLibrarySource,
  libraryResponseSchemas,
  readSource,
  resolveLibraryRead,
  syncStore,
  type LibraryMethod,
  type LibraryQueries,
  type LibraryRead,
  type LibrarySource,
  type SourceResult,
  type SqliteDriver,
  type UnsupportedReason,
} from '@repo/library-source'
import { openBetterSqliteDriver } from '@repo/library-source/better-sqlite3'
import { LIBRARY_PLAYLIST_FILTER_FIELD } from '@repo/schemas/browse'
import type { JsonValue } from '@repo/schemas/common'
import { DeviceFeedStateSchema } from '@repo/schemas/device'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { seedParityLibrary } from '../fixtures/device-parity-library'
import { expectedHole, type ApiAnswer, type DataFacts } from './holes'

/**
 * The parity suite's set-up (DEVICE-32): a disposable database ordered by
 * code point, the synthetic library, the feed built by the real sweep, a
 * `better-sqlite3` store synced through the feed routes, and a comparison
 * of one API path with the device's answer for the same path.
 */

export const parityOrigin = 'https://media.example.test'
export const parityOwner = {
  id: 'fixture-owner',
  email: 'owner@example.test',
}

const database = `media_device_parity_test_${randomUUID().replaceAll('-', '')}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  connectionTimeoutMillis: 5000,
}
const admin = new pg.Client({ ...connection, database: 'postgres' })
export const parityPool = new pg.Pool({
  ...connection,
  database,
  max: 8,
  statement_timeout: 20_000,
  options: '-c timezone=UTC',
})
export const parityDatabase = drizzle(parityPool, { schema })

let created = false
let apiKey = ''
/** The collation the database was created with, for the report. */
export let parityCollation = ''

const IdentifierSchema = z.string().regex(/^[\w.@-]+$/)

/**
 * Creates the database ordered by code point: PostgreSQL's builtin
 * `C.UTF-8` where the server has it (version 17 and later), else the libc
 * `C.UTF-8` locale, else the `C` collation with the server's character
 * type, as device-rows.integration.ts does. Each orders text by code point.
 */
async function createCodePointDatabase() {
  const { rows } = await admin.query<{ ctype: string }>(
    "select datctype as ctype from pg_database where datname = 'postgres'",
  )
  const ctype = IdentifierSchema.parse(rows[0]?.ctype)
  // The identifier is generated locally from a UUID, never from user input.
  const attempts: [string, string][] = [
    [
      'builtin C.UTF-8',
      `create database ${database} template template0 encoding 'UTF8' locale_provider builtin builtin_locale 'C.UTF-8' locale 'C'`,
    ],
    [
      'libc C.UTF-8',
      `create database ${database} template template0 encoding 'UTF8' lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'`,
    ],
    [
      `libc C with ${ctype}`,
      `create database ${database} template template0 encoding 'UTF8' lc_collate 'C' lc_ctype '${ctype}'`,
    ],
  ]
  for (const [label, statement] of attempts) {
    try {
      await admin.query(statement)
      parityCollation = label
      return
    } catch (error) {
      if (label === attempts.at(-1)?.[0]) throw error
    }
  }
}

export async function setUpParityDatabase() {
  await admin.connect()
  await createCodePointDatabase()
  created = true
  await migrate(parityDatabase, { migrationsFolder: './drizzle' })
  await seedParityLibrary(parityPool)
  const { createApiKey } = await import('@/services/api-keys')
  await parityDatabase.insert(schema.user).values({
    id: parityOwner.id,
    name: 'Owner',
    email: parityOwner.email,
    role: 'admin',
  })
  // The clock is fixed, so a rate window would never end.
  apiKey = (
    await createApiKey(parityOwner.id, {
      name: 'Parity',
      expiresIn: null,
      rateLimit: { enabled: false },
    })
  ).key
}

export async function tearDownParityDatabase() {
  await parityPool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
}

export async function apiRequest(
  path: string,
  init: { method?: string; body?: JsonValue } = {},
) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, parityOrigin), {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

const EnvelopeSchema = z.object({ data: z.unknown() })

/** A write through the app; returns the envelope's data. */
export async function apiSend(
  method: string,
  path: string,
  body?: JsonValue,
): Promise<unknown> {
  const response = await apiRequest(path, { method, body })
  if (response.status !== 200)
    throw new Error(
      `${method} ${path} answered ${response.status}: ${await response.text()}`,
    )
  return EnvelopeSchema.parse(await response.json()).data
}

/** A read of the API: its status and, when it answered, the envelope's data. */
export async function readApi(path: string): Promise<ApiAnswer> {
  const response = await apiRequest(path)
  const envelope = EnvelopeSchema.safeParse(await response.json())
  return {
    status: response.status,
    data:
      response.status === 200 && envelope.success
        ? envelope.data.data
        : undefined,
  }
}

/** The feed routes as a device reads them: the envelope's data. */
async function feedTransport(path: string): Promise<unknown> {
  const response = await apiRequest(path)
  if (response.status !== 200)
    throw new Error(`${path} answered ${response.status}`)
  return EnvelopeSchema.parse(await response.json()).data
}

async function renderer() {
  return (await import('@/services/device-rows')).deviceRowRenderer
}

/** Builds the feed as maintenance does: the first run sweeps everything. */
export async function buildFeed() {
  const { refreshDeviceFeedForMaintenance } =
    await import('@/services/device-feed')
  await parityPool.query('delete from device_dirty')
  await refreshDeviceFeedForMaintenance(await renderer())
  const state = DeviceFeedStateSchema.parse(
    await feedTransport('/api/v1/device/state'),
  )
  if (!state.ready) throw new Error('The feed is not ready after a sweep')
}

/** Renders the marks of the edits, as the render task does. */
export async function renderMarks() {
  const { renderDirtyDeviceRows } = await import('@/services/device-feed')
  await renderDirtyDeviceRows(await renderer(), {
    wait: true,
    deadline: Date.now() + 60_000,
  })
  const marks = z
    .object({ count: z.number() })
    .parse(
      (
        await parityPool.query(
          'select count(*)::int as count from device_dirty',
        )
      ).rows[0],
    ).count
  if (marks > 0) throw new Error(`${marks} marks are left`)
}

export type ParityStore = { driver: SqliteDriver; source: LibrarySource }

export function openParityStore(): ParityStore {
  const driver = openBetterSqliteDriver()
  return {
    driver,
    source: createDeviceLibrarySource(driver, { now: () => new Date() }),
  }
}

export async function syncParityStore(store: ParityStore) {
  // Small pages, so a fill and a catch-up each take several.
  return syncStore(store.driver, feedTransport, { pageSize: 50 })
}

/** One read of the device source, the method chosen by the read. */
export function readDevice<Method extends LibraryMethod>(
  source: LibrarySource,
  read: { method: Method; query: LibraryQueries[Method] },
): Promise<SourceResult<unknown>> {
  return readSource(source, read.method, read.query)
}

export type Outcome =
  | { kind: 'served' }
  | { kind: 'fell-through'; reason: UnsupportedReason }
  | { kind: 'unresolved'; status: number }

export type Failure = { path: string; problem: string }

/** Served and fallen-through reads per library and method, and every failure. */
export class ParityReport {
  readonly failures: Failure[] = []
  readonly counts = new Map<string, Map<string, number>>()
  compared = 0

  count(method: string, outcome: string) {
    const byOutcome = this.counts.get(method) ?? new Map<string, number>()
    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1)
    this.counts.set(method, byOutcome)
  }

  /** Failures beyond the first 20 of one route are counted, not kept. */
  readonly dropped = new Map<string, number>()

  fail(path: string, problem: string) {
    const [route = path] = path.split('?', 1)
    const kept = this.failures.filter((failure) =>
      failure.path.startsWith(`${route}?`),
    ).length
    if (kept < 20) this.failures.push({ path, problem })
    else this.dropped.set(route, (this.dropped.get(route) ?? 0) + 1)
  }

  /** One line per method: served, and fall-throughs by reason. */
  summary(): string[] {
    return [...this.counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([method, outcomes]) =>
          `${method}: ${[...outcomes]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([outcome, count]) => `${outcome} ${count}`)
            .join(', ')}`,
      )
  }
}

const ItemIdsSchema = z.object({
  items: z.array(z.object({ id: z.string() }).passthrough()),
})
const PositionIdsSchema = z.object({
  items: z.array(
    z.object({ position: z.number(), item: z.object({ id: z.string() }) }),
  ),
})

/** A short account of how two answers differ, for the failure list. */
function difference(api: unknown, device: unknown): string {
  const ids = (value: unknown) => {
    const page = ItemIdsSchema.safeParse(value)
    if (page.success) return page.data.items.map((item) => item.id)
    const positions = PositionIdsSchema.safeParse(value)
    if (positions.success)
      return positions.data.items.map(
        (entry) => `${entry.position}:${entry.item.id}`,
      )
    return undefined
  }
  const apiIds = ids(api)
  const deviceIds = ids(device)
  if (
    apiIds !== undefined &&
    deviceIds !== undefined &&
    JSON.stringify(apiIds) !== JSON.stringify(deviceIds)
  )
    return `ids: api ${JSON.stringify(apiIds)} device ${JSON.stringify(deviceIds)}`
  return firstDifference(api, device, '') ?? 'a difference outside the JSON'
}

const ContainerSchema = z.union([
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
])

/** The path of the first value that differs, with both values. */
function firstDifference(
  api: unknown,
  device: unknown,
  path: string,
): string | undefined {
  if (sameData(api, device)) return undefined
  const left = ContainerSchema.safeParse(api)
  const right = ContainerSchema.safeParse(device)
  if (left.success && right.success) {
    const keys = new Set([
      ...Object.keys(left.data),
      ...Object.keys(right.data),
    ])
    const entries = (value: unknown[] | Record<string, unknown>) =>
      new Map(Object.entries(value))
    const a = entries(left.data)
    const b = entries(right.data)
    for (const key of keys) {
      const found = firstDifference(a.get(key), b.get(key), `${path}.${key}`)
      if (found !== undefined) return found
    }
  }
  const show = (value: unknown) => JSON.stringify(value)?.slice(0, 300)
  return `${path}: api ${show(api)} device ${show(device)}`
}

/** Deep equality of two parsed answers as JSON values: key order does not count. */
function sameData(api: unknown, device: unknown) {
  return isDeepStrictEqual(asJson(api), asJson(device))
}

function asJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

const FiltersSchema = z.object({
  filters: z.array(z.object({ field: z.string() })),
})

/** The report's line for a read: its method, apart for reads with a libraryPlaylist filter. */
function reportKey(read: LibraryRead): string {
  const query =
    read.method === 'trackRecordings' ? read.query.query : read.query
  const filters = FiltersSchema.safeParse(query)
  return filters.success &&
    filters.data.filters.some(
      (filter) => filter.field === LIBRARY_PLAYLIST_FILTER_FIELD,
    )
    ? `${read.method} (libraryPlaylist)`
    : read.method
}

/** Whether a path segment, or a name or value of the query string, is not valid percent-encoded UTF-8. */
export function hasMalformedEscape(path: string): boolean {
  const [target = ''] = path.split('#', 1)
  const [pathname = '', search = ''] = target.split(/\?(.*)/su)
  const parts = [
    ...pathname.split('/'),
    ...search
      .split('&')
      .flatMap((part) => part.split(/=(.*)/su))
      .map((part) => part.replaceAll('+', ' ')),
  ]
  return parts.some((part) => {
    try {
      decodeURIComponent(part)
      return false
    } catch {
      return true
    }
  })
}

/**
 * Compares one API path with the device's answer for it (DEVICE-32, 33).
 * A served answer must equal the API's after both are parsed with the read's
 * response schema; a fall-through must have the reason the Known holes give
 * that query; a path the resolver does not map must be one the API rejects.
 * Returns the API's data when it answered.
 */
export async function compareRead(
  store: ParityStore,
  facts: DataFacts,
  report: ParityReport,
  path: string,
): Promise<{ outcome: Outcome; data: unknown } | undefined> {
  report.compared += 1
  const response = await apiRequest(path)
  const body: unknown = await response.json()
  const read: LibraryRead | undefined = resolveLibraryRead(path)
  if (read === undefined) {
    // Known holes: a path with a malformed percent escape is left to the
    // API, which decodes it in part and may answer it.
    if (hasMalformedEscape(path)) report.count('unresolved', 'malformed escape')
    else {
      report.count('unresolved', `status ${response.status}`)
      if (response.status === 200)
        report.fail(path, 'the resolver maps no read, but the API answers 200')
    }
    return {
      outcome: { kind: 'unresolved', status: response.status },
      data: undefined,
    }
  }
  const responseSchema: z.ZodType = libraryResponseSchemas[read.method]
  const envelope = EnvelopeSchema.safeParse(body)
  const apiData =
    response.status === 200 && envelope.success
      ? responseSchema.parse(envelope.data.data)
      : undefined
  const result = await readDevice(store.source, read)
  const expected = await expectedHole(read, {
    status: response.status,
    data: apiData,
    facts,
    readApi,
  })
  if (result.served) {
    report.count(reportKey(read), 'served')
    if (expected !== undefined)
      report.fail(path, `served, but the Known holes say ${expected}`)
    else if (apiData === undefined)
      report.fail(path, `served, but the API answered ${response.status}`)
    else {
      const deviceData = responseSchema.parse(result.data)
      if (!sameData(apiData, deviceData))
        report.fail(path, difference(apiData, deviceData))
    }
    return { outcome: { kind: 'served' }, data: apiData }
  }
  report.count(reportKey(read), result.reason)
  if (result.reason !== expected)
    report.fail(
      path,
      `fell through with ${result.reason}; the Known holes say ${expected ?? 'served'}`,
    )
  return {
    outcome: { kind: 'fell-through', reason: result.reason },
    data: apiData,
  }
}
