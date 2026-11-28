import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import type { JsonValue } from '@repo/schemas/common'
import {
  DEVICE_ROW_VERSION,
  DeviceChangesResponseSchema,
  DeviceFeedStateSchema,
  DeviceSnapshotResponseSchema,
  type DeviceEntity,
  type DeviceRow,
} from '@repo/schemas/device'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createApiKey, createDeviceApiKey } from '@/services/api-keys'
import {
  pruneDeviceTombstones,
  readDeviceChanges,
  refreshDeviceFeedForMaintenance,
  renderDirtyDeviceRows,
  setDeviceFeedRenderer,
  sweepDeviceFeed,
  type DeviceFeedRenderer,
} from '@/services/device-feed'

const fixture = vi.hoisted(() => ({
  ownerId: 'fixture-owner',
  ownerEmail: 'owner@example.test',
  origin: 'https://media.example.test',
}))
const { ownerId, ownerEmail, origin } = fixture
const password = 'fixture-owner-password'

vi.mock('@/lib/load-workspace-env', () => ({
  loadWorkspaceEnv: () => {},
  findWorkspaceRootPath: () => null,
}))
vi.mock('@/env', async (importOriginal) => {
  const { env } = await importOriginal<typeof import('@/env')>()
  return {
    env: {
      ...env,
      NODE_ENV: 'production',
      RUNTIME_KIND: 'node',
      APP_URL: fixture.origin,
      AUTH_BASE_URL: fixture.origin,
      TRUSTED_ORIGINS: [fixture.origin],
      OWNER_USER_ID: fixture.ownerId,
      OWNER_EMAIL: fixture.ownerEmail,
    },
  }
})
vi.mock('@/lib/db', () => ({
  get db() {
    return databaseClient
  },
}))

const suffix = randomUUID().replaceAll('-', '')
const database = `media_device_feed_test_${suffix}`
const writerRole = `device_feed_writer_${suffix}`
const connection = {
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  connectionTimeoutMillis: 5000,
}
const admin = new pg.Client({ ...connection, database: 'postgres' })
const pool = new pg.Pool({
  ...connection,
  database,
  max: 8,
  statement_timeout: 20_000,
})
const databaseClient = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Outbound requests are blocked in device feed tests')
})
let created = false
let roleCreated = false
let cookie = ''
let apiKey = ''
let deviceKey = ''

/**
 * A renderer over an in-memory library: the IDs of each entity it publishes
 * and their payloads. Hooks let a test act while a render is running.
 */
function stubRenderer() {
  const rows = new Map<DeviceEntity, Map<string, JsonValue>>()
  const hooks: { beforeRender?: () => Promise<void> } = {}
  // IDs whose render throws, as a payload its schema rejects does.
  const failing = new Set<string>()
  const renderer: DeviceFeedRenderer = {
    async render(entity, ids) {
      await hooks.beforeRender?.()
      if (ids.some((id) => failing.has(id)))
        throw new Error('A fixture row cannot be rendered')
      const published = rows.get(entity) ?? new Map<string, JsonValue>()
      return new Map(
        ids.flatMap((id) => {
          const payload = published.get(id)
          return payload === undefined ? [] : [[id, payload] as const]
        }),
      )
    },
    async listIds(entity, afterId, limit) {
      return [...(rows.get(entity)?.keys() ?? [])]
        .filter((id) => afterId === null || id > afterId)
        .sort()
        .slice(0, limit)
    },
  }
  function set(entity: DeviceEntity, id: string, payload: JsonValue) {
    const published = rows.get(entity) ?? new Map<string, JsonValue>()
    published.set(id, payload)
    rows.set(entity, published)
  }
  function remove(entity: DeviceEntity, id: string) {
    rows.get(entity)?.delete(id)
  }
  return { renderer, hooks, failing, set, remove }
}

const plays = (...times: number[]) => ({ plays: times })
const fixtureId = (n: number) => `album-${String(n).padStart(3, '0')}`
const later = () => Date.now() + 15_000

async function request(path: string, headers: Record<string, string> = {}) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, origin), { headers })
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

async function feedState(headers = bearer(deviceKey)) {
  const response = await request('/api/v1/device/state', headers)
  expect(response.status).toBe(200)
  return z.object({ data: DeviceFeedStateSchema }).parse(await response.json())
    .data
}

async function snapshotPage(query: Record<string, string | number>) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  )
  const response = await request(
    `/api/v1/device/snapshot?${params}`,
    bearer(deviceKey),
  )
  expect(response.status).toBe(200)
  return z
    .object({ data: DeviceSnapshotResponseSchema })
    .parse(await response.json()).data
}

async function changesPage(query: Record<string, string | number>) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  )
  const response = await request(
    `/api/v1/device/changes?${params}`,
    bearer(deviceKey),
  )
  expect(response.status).toBe(200)
  return z
    .object({ data: DeviceChangesResponseSchema })
    .parse(await response.json()).data
}

const StoredRowsSchema = z.array(
  z.object({
    entity: z.string(),
    id: z.string(),
    seq: z.coerce.number(),
    deleted: z.boolean(),
  }),
)

async function storedRows() {
  const result = await pool.query(
    'select entity, id, seq, deleted from device_row order by entity, id',
  )
  return StoredRowsSchema.parse(result.rows)
}

async function storedSeq(entity: DeviceEntity, id: string) {
  return (await storedRows()).find(
    (row) => row.entity === entity && row.id === id,
  )
}

async function mark(entity: DeviceEntity, ...ids: string[]) {
  for (const id of ids)
    await pool.query('insert into device_dirty (entity, id) values ($1, $2)', [
      entity,
      id,
    ])
}

async function markCount() {
  const result = await pool.query(
    'select count(*)::int as count from device_dirty',
  )
  return z.object({ count: z.number() }).parse(result.rows[0]).count
}

async function resetFeed() {
  await pool.query(`delete from device_row; delete from device_dirty;
    update device_feed_state set epoch = 'fixture-epoch', row_version = ${DEVICE_ROW_VERSION},
      min_seq = 0, ready = false, sweep_entity = null, sweep_after = null, swept_at = null`)
}

async function sweepAll(renderer: DeviceFeedRenderer) {
  const sweep = await sweepDeviceFeed(renderer, {
    wait: true,
    deadline: later(),
  })
  expect(sweep.complete).toBe(true)
  return sweep
}

/** Applies feed rows to a device copy, keyed by entity and ID. */
function apply(copy: Map<string, DeviceRow>, rows: readonly DeviceRow[]) {
  for (const row of rows) {
    const key = `${row.entity}:${row.id}`
    if (row.deleted) copy.delete(key)
    else copy.set(key, row)
  }
}

async function liveFeed() {
  return new Map(
    (await storedRows())
      .filter((row) => !row.deleted)
      .map((row) => [`${row.entity}:${row.id}`, row.seq]),
  )
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await databaseClient
    .insert(schema.user)
    .values({ id: ownerId, name: 'Owner', email: ownerEmail, role: 'admin' })
  await databaseClient.insert(schema.account).values({
    id: 'fixture-owner-account',
    userId: ownerId,
    providerId: 'credential',
    accountId: ownerId,
    password: await hashPassword(password),
    updatedAt: new Date(),
  })
  const { default: app } = await import('@/app')
  const login = await app.request(new URL('/api/auth/sign-in/email', origin), {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password }),
  })
  expect(login.status).toBe(200)
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  apiKey = (await createApiKey(ownerId, { name: 'Fixture', expiresIn: null }))
    .key
  deviceKey = (await createDeviceApiKey(databaseClient, ownerId, 'Phone')).key
  await pool.query(`create role ${writerRole}`)
  roleCreated = true
  await pool.query(
    `grant update (title), select (id) on media_item to ${writerRole}`,
  )
})

afterEach(() => {
  setDeviceFeedRenderer(undefined)
  expect(network).not.toHaveBeenCalled()
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  if (roleCreated) await admin.query(`drop role ${writerRole}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('device feed', () => {
  beforeEach(resetFeed)

  it('builds the feed from a first sweep, then reports it ready', async () => {
    await pool.query('update device_feed_state set row_version = 0')
    const before = await feedState()
    expect(before).toMatchObject({
      ready: false,
      rowVersion: DEVICE_ROW_VERSION,
    })
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1, 2))
    stub.set('album_plays', 'album-2', plays(3))
    stub.set('tag_key', 'album:rock', {
      mediaType: 'album',
      key: 'rock',
      ancestorKeys: ['music'],
    })

    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(true)

    const after = await feedState()
    expect(after.ready).toBe(true)
    expect(after.epoch).not.toBe(before.epoch)
    const rows = await storedRows()
    expect(rows.map((row) => `${row.entity}:${row.id}`)).toEqual([
      'album_plays:album-1',
      'album_plays:album-2',
      'tag_key:album:rock',
    ])
    expect(after.seq).toBe(Math.max(...rows.map((row) => row.seq)))
    // A second run finds nothing to change.
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(false)
    expect(await storedRows()).toEqual(rows)
  })

  it('numbers a changed payload again and keeps the number of an unchanged one', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    stub.set('album_plays', 'album-2', plays(2))
    stub.set('tag_key', 'album:rock', {
      mediaType: 'album',
      key: 'rock',
      ancestorKeys: ['music'],
    })
    await sweepAll(stub.renderer)
    const before = await storedRows()

    // The same payload with its keys in another order hashes the same.
    stub.set('tag_key', 'album:rock', {
      ancestorKeys: ['music'],
      key: 'rock',
      mediaType: 'album',
    })
    stub.set('album_plays', 'album-2', plays(2, 5))
    await mark('album_plays', 'album-1', 'album-2', 'album-2')
    await mark('tag_key', 'album:rock')
    const render = await renderDirtyDeviceRows(stub.renderer, {
      wait: true,
      deadline: later(),
    })
    expect(render).toEqual({ written: 1, busy: false, failed: {} })
    const after = await storedRows()
    expect(after.filter((row) => row.id !== 'album-2')).toEqual(
      before.filter((row) => row.id !== 'album-2'),
    )
    expect((await storedSeq('album_plays', 'album-2'))?.seq).toBeGreaterThan(
      Math.max(...before.map((row) => row.seq)),
    )
    expect(await markCount()).toBe(0)
  })

  it('turns an unpublished row into a tombstone and back into a live row', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    await sweepAll(stub.renderer)
    const live = await storedSeq('album_plays', 'album-1')

    stub.remove('album_plays', 'album-1')
    await mark('album_plays', 'album-1', 'album-never-published')
    await renderDirtyDeviceRows(stub.renderer, {
      wait: true,
      deadline: later(),
    })
    const tombstone = await storedSeq('album_plays', 'album-1')
    expect(tombstone?.deleted).toBe(true)
    expect(tombstone?.seq).toBeGreaterThan(live?.seq ?? Infinity)
    expect(await storedSeq('album_plays', 'album-never-published')).toBe(
      undefined,
    )

    stub.set('album_plays', 'album-1', plays(1))
    await mark('album_plays', 'album-1')
    await renderDirtyDeviceRows(stub.renderer, {
      wait: true,
      deadline: later(),
    })
    const back = await storedSeq('album_plays', 'album-1')
    expect(back?.deleted).toBe(false)
    expect(back?.seq).toBeGreaterThan(tombstone?.seq ?? Infinity)
  })

  it('tombstones rows the sweep no longer lists', async () => {
    const stub = stubRenderer()
    for (const n of [1, 2, 3, 4, 5])
      stub.set('album_plays', fixtureId(n), plays(n))
    await sweepAll(stub.renderer)
    stub.remove('album_plays', fixtureId(2))
    stub.remove('album_plays', fixtureId(5))
    // Two IDs per batch: the removed IDs fall inside and after a listed range.
    await sweepDeviceFeed(stub.renderer, {
      wait: true,
      deadline: later(),
      limit: 2,
    })
    expect(
      (await storedRows()).filter((row) => row.deleted).map((row) => row.id),
    ).toEqual([fixtureId(2), fixtureId(5)])
  })

  it('pages a snapshot by sequence while rows change, then catches up from changes', async () => {
    const stub = stubRenderer()
    for (let n = 1; n <= 30; n += 1)
      stub.set('album_plays', fixtureId(n), plays(n))
    stub.set('scrobble_name', 'name-1', plays(1))
    await sweepAll(stub.renderer)
    setDeviceFeedRenderer(stub.renderer)
    const start = await feedState()

    const copy = new Map<string, DeviceRow>()
    const seen = new Map<string, number>()
    let after = 0
    let page = 0
    let hasMore = true
    while (hasMore) {
      const result = await snapshotPage({
        epoch: start.epoch,
        entity: 'album_plays',
        after,
        limit: 7,
      })
      if (result.reset) throw new Error('The snapshot was reset')
      apply(copy, result.rows)
      for (const row of result.rows)
        seen.set(row.id, (seen.get(row.id) ?? 0) + 1)
      ;({ seq: after, hasMore } = result)
      page += 1
      if (page === 1) {
        // A row already read, a row not yet read, a removal and an addition.
        stub.set('album_plays', fixtureId(2), plays(2, 20))
        stub.set('album_plays', fixtureId(25), plays(25, 250))
        stub.remove('album_plays', fixtureId(28))
        stub.set('album_plays', fixtureId(31), plays(31))
        await mark(
          'album_plays',
          fixtureId(2),
          fixtureId(25),
          fixtureId(28),
          fixtureId(31),
        )
        await renderDirtyDeviceRows(stub.renderer, {
          wait: true,
          deadline: later(),
        })
      }
    }
    expect(page).toBeGreaterThan(4)
    for (let n = 1; n <= 30; n += 1)
      if (![2, 25, 28].includes(n)) expect(seen.get(fixtureId(n))).toBe(1)
    expect(seen.get(fixtureId(28))).toBe(undefined)
    const other = await snapshotPage({
      epoch: start.epoch,
      entity: 'scrobble_name',
    })
    if (other.reset) throw new Error('The snapshot was reset')
    apply(copy, other.rows)

    let since = start.seq
    hasMore = true
    while (hasMore) {
      const result = await changesPage({ epoch: start.epoch, since, limit: 3 })
      if (result.reset) throw new Error('The changes were reset')
      apply(copy, result.rows)
      ;({ seq: since, hasMore } = result)
    }
    expect(new Map([...copy].map(([key, row]) => [key, row.seq]))).toEqual(
      await liveFeed(),
    )
    expect(copy.get(`album_plays:${fixtureId(2)}`)?.payload).toEqual(
      plays(2, 20),
    )
  })

  it('pages changes, renders marks first and says when marks remain', async () => {
    const stub = stubRenderer()
    setDeviceFeedRenderer(stub.renderer)
    for (let n = 1; n <= 10; n += 1)
      stub.set('album_plays', fixtureId(n), plays(n))
    await sweepAll(stub.renderer)
    const { epoch } = await feedState()

    const first = await changesPage({ epoch, since: 0, limit: 4 })
    expect(first).toMatchObject({ reset: false, hasMore: true, pending: false })
    if (first.reset) throw new Error('The changes were reset')
    expect(first.rows).toHaveLength(4)
    expect(first.seq).toBe(first.rows.at(-1)?.seq)
    const rest = await changesPage({ epoch, since: first.seq, limit: 6 })
    expect(rest).toMatchObject({ hasMore: false, pending: false })
    if (rest.reset) throw new Error('The changes were reset')
    expect(rest.rows).toHaveLength(6)
    const empty = await changesPage({ epoch, since: rest.seq })
    expect(empty).toEqual({
      reset: false,
      rows: [],
      seq: rest.seq,
      hasMore: false,
      pending: false,
    })

    // While another writer holds the lock the request does not wait for it.
    stub.set('album_plays', fixtureId(3), plays(3, 30))
    await mark('album_plays', fixtureId(3))
    const holder = await pool.connect()
    try {
      await holder.query('begin')
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended(current_schema() || ':device_row', 0))",
      )
      expect(await changesPage({ epoch, since: rest.seq })).toMatchObject({
        rows: [],
        pending: true,
      })
    } finally {
      await holder.query('rollback')
      holder.release()
    }

    const rendered = await changesPage({ epoch, since: rest.seq })
    expect(rendered).toMatchObject({ pending: false, hasMore: false })
    if (rendered.reset) throw new Error('The changes were reset')
    expect(rendered.rows.map((row) => [row.id, row.payload])).toEqual([
      [fixtureId(3), plays(3, 30)],
    ])
  })

  it('bounds a page by payload bytes', async () => {
    const stub = stubRenderer()
    const times = Array.from({ length: 60_000 }, (_, n) => 1_600_000_000 + n)
    for (let n = 1; n <= 8; n += 1)
      stub.set('album_plays', fixtureId(n), plays(...times))
    await sweepAll(stub.renderer)
    const { epoch } = await feedState()
    const page = await readDeviceChanges(
      { epoch, since: 0, limit: 8 },
      stub.renderer,
    )
    if (page.reset) throw new Error('The changes were reset')
    // Each payload is about 0.7 MB; a page stops before 4 MB.
    expect(page.rows.length).toBeGreaterThan(1)
    expect(page.rows.length).toBeLessThan(8)
    expect(page.hasMore).toBe(true)
  })

  it('tells a device to reset for another epoch or a sequence older than the tombstones held', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    stub.set('album_plays', 'album-2', plays(2))
    await sweepAll(stub.renderer)
    stub.remove('album_plays', 'album-1')
    await mark('album_plays', 'album-1')
    await renderDirtyDeviceRows(stub.renderer, {
      wait: true,
      deadline: later(),
    })
    const tombstone = await storedSeq('album_plays', 'album-1')
    const { epoch } = await feedState()

    expect(await changesPage({ epoch: 'other', since: 0 })).toEqual({
      reset: true,
    })
    expect(
      await snapshotPage({ epoch: 'other', entity: 'album_plays' }),
    ).toEqual({ reset: true })

    // A recent tombstone is kept.
    expect(await pruneDeviceTombstones(later())).toBe(0)
    await pool.query(
      "update device_row set rendered_at = now() - interval '91 days' where deleted",
    )
    expect(await pruneDeviceTombstones(later())).toBe(1)
    const state = await feedState()
    expect(state.minSeq).toBe(tombstone?.seq)
    expect(await storedSeq('album_plays', 'album-1')).toBe(undefined)
    expect(await changesPage({ epoch, since: state.minSeq - 1 })).toEqual({
      reset: true,
    })
    expect(await changesPage({ epoch, since: state.minSeq })).toMatchObject({
      reset: false,
    })
  })

  it('tells a device to reset when the feed restarts after the state a request read', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    stub.set('album_plays', 'album-2', plays(2))
    await sweepAll(stub.renderer)
    const before = await feedState()
    // While the request renders a mark, the feed starts again from nothing
    // and its new rows are numbered after the device's sequence.
    stub.set('album_plays', 'album-2', plays(2, 20))
    await mark('album_plays', 'album-2')
    stub.hooks.beforeRender = async () => {
      stub.hooks.beforeRender = undefined
      await pool.query(`update device_feed_state set epoch = 'fixture-restarted',
          min_seq = (select max(seq) from device_row);
        delete from device_row`)
    }
    expect(
      await readDeviceChanges(
        { epoch: before.epoch, since: before.seq, limit: 100 },
        stub.renderer,
      ),
    ).toEqual({ reset: true })
  })

  it('tells a device to reset when tombstones past its sequence are pruned after the state a request read', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    stub.set('album_plays', 'album-2', plays(2))
    await sweepAll(stub.renderer)
    const { epoch, seq: since } = await feedState()
    stub.remove('album_plays', 'album-1')
    await mark('album_plays', 'album-1')
    await renderDirtyDeviceRows(stub.renderer, {
      wait: true,
      deadline: later(),
    })
    // While the request renders a mark, the tombstone the device has not
    // read is pruned and `minSeq` passes its sequence.
    stub.set('album_plays', 'album-2', plays(2, 20))
    await mark('album_plays', 'album-2')
    stub.hooks.beforeRender = async () => {
      stub.hooks.beforeRender = undefined
      await pool.query(`update device_feed_state
          set min_seq = (select max(seq) from device_row where deleted);
        delete from device_row where deleted`)
    }
    expect(
      await readDeviceChanges({ epoch, since, limit: 100 }, stub.renderer),
    ).toEqual({ reset: true })
    expect((await feedState()).minSeq).toBeGreaterThan(since)
  })

  it('sets aside a row that cannot be rendered and renders the rest', async () => {
    const stub = stubRenderer()
    setDeviceFeedRenderer(stub.renderer)
    const ids = [1, 2, 3, 4, 5].map(fixtureId)
    for (const [n, id] of ids.entries()) stub.set('album_plays', id, plays(n))
    await sweepAll(stub.renderer)
    const { epoch, seq } = await feedState()
    const stored = await storedSeq('album_plays', fixtureId(3))

    // Every row changes; one of them cannot be rendered now.
    for (const [n, id] of ids.entries())
      stub.set('album_plays', id, plays(n, 100))
    stub.failing.add(fixtureId(3))
    await mark('album_plays', ...ids)
    const page = await changesPage({ epoch, since: seq })
    expect(page).toMatchObject({ reset: false, pending: false })
    if (page.reset) throw new Error('The changes were reset')
    expect(page.rows.map((row) => row.id).sort()).toEqual(
      ids.filter((id) => id !== fixtureId(3)),
    )
    // Its stored row stays and its mark is consumed.
    expect(await storedSeq('album_plays', fixtureId(3))).toEqual(stored)
    expect(await markCount()).toBe(0)

    // Maintenance and the sweep count it and carry on.
    await mark('album_plays', fixtureId(3))
    expect(await refreshDeviceFeedForMaintenance(stub.renderer)).toEqual({
      published: false,
      renderFailures: { album_plays: 1 },
    })
    expect(
      await sweepDeviceFeed(stub.renderer, { wait: true, deadline: later() }),
    ).toEqual({ written: 0, complete: true, failed: { album_plays: 1 } })
    expect(await storedSeq('album_plays', fixtureId(3))).toEqual(stored)

    // The next sweep renders it.
    stub.failing.clear()
    expect(
      await sweepDeviceFeed(stub.renderer, { wait: true, deadline: later() }),
    ).toEqual({ written: 1, complete: true, failed: {} })
  })

  it('starts a new epoch when the row version changes', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    await sweepAll(stub.renderer)
    const before = await feedState()
    expect(before.ready).toBe(true)

    await pool.query('update device_feed_state set row_version = $1', [
      DEVICE_ROW_VERSION + 1,
    ])
    expect(await feedState()).toMatchObject({
      ready: false,
      epoch: before.epoch,
    })
    expect(
      await changesPage({ epoch: before.epoch, since: before.seq }),
    ).toEqual({
      reset: true,
    })

    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(true)
    const after = await feedState()
    expect(after).toMatchObject({ ready: true, rowVersion: DEVICE_ROW_VERSION })
    expect(after.epoch).not.toBe(before.epoch)
    expect(after.minSeq).toBeGreaterThanOrEqual(before.seq)
    expect(after.seq).toBeGreaterThan(before.seq)
    expect(
      await changesPage({ epoch: before.epoch, since: before.seq }),
    ).toEqual({ reset: true })
  })

  it('rests a day after a completed sweep and continues one under way in every run', async () => {
    const stub = stubRenderer()
    for (const n of [1, 2, 3]) stub.set('album_plays', fixtureId(n), plays(n))
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(true)
    expect((await feedState()).ready).toBe(true)

    // A change no trigger marked waits for the next sweep.
    stub.set('album_plays', fixtureId(1), plays(1, 10))
    const before = await storedSeq('album_plays', fixtureId(1))
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(false)
    expect(await storedSeq('album_plays', fixtureId(1))).toEqual(before)

    // A sweep under way continues, though the last one completed just now.
    await pool.query(
      `update device_feed_state set sweep_entity = 'album_plays',
      sweep_after = $1, swept_at = now()`,
      [fixtureId(1)],
    )
    stub.set('album_plays', fixtureId(3), plays(3, 30))
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(true)
    expect((await storedSeq('album_plays', fixtureId(3)))?.seq).toBeGreaterThan(
      before?.seq ?? Infinity,
    )
    expect(await storedSeq('album_plays', fixtureId(1))).toEqual(before)

    // The next sweep starts once the last one has rested a day.
    await pool.query(
      `update device_feed_state set swept_at = now() - interval '23 hours'`,
    )
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(false)
    await pool.query(
      `update device_feed_state set swept_at = now() - interval '24 hours'`,
    )
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(true)
    expect((await storedSeq('album_plays', fixtureId(1)))?.seq).toBeGreaterThan(
      before?.seq ?? Infinity,
    )
    // Marks are rendered in every run, resting or not.
    stub.set('album_plays', fixtureId(2), plays(2, 20))
    await mark('album_plays', fixtureId(2))
    expect(
      (await refreshDeviceFeedForMaintenance(stub.renderer)).published,
    ).toBe(true)
    expect(await markCount()).toBe(0)
  })

  it('keeps a mark made while its row renders', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    await mark('album_plays', 'album-1')
    stub.hooks.beforeRender = async () => {
      stub.hooks.beforeRender = undefined
      stub.set('album_plays', 'album-1', plays(1, 2))
      await mark('album_plays', 'album-1')
    }
    await renderDirtyDeviceRows(stub.renderer, {
      wait: true,
      deadline: later(),
    })
    const result = await pool.query('select entity, id from device_dirty')
    expect(result.rows).toEqual([{ entity: 'album_plays', id: 'album-1' }])
  })

  it('renders the IDs a renderer adds to a mark', async () => {
    const stub = stubRenderer()
    stub.set('album_plays', 'album-1', plays(1))
    stub.set('album_plays', 'album-2', plays(2))
    const expanded: string[][] = []
    const renderer: DeviceFeedRenderer = {
      ...stub.renderer,
      async expand(entity, ids) {
        expanded.push([entity, ...ids])
        return ids.includes('album-1') ? ['album-2'] : []
      },
    }
    await mark('album_plays', 'album-1')
    await renderDirtyDeviceRows(renderer, { wait: true, deadline: later() })
    expect(expanded).toEqual([['album_plays', 'album-1']])
    expect((await storedRows()).map((row) => row.id)).toEqual([
      'album-1',
      'album-2',
    ])
  })

  it('commits concurrent writes in sequence order, so a reader misses none', async () => {
    const stub = stubRenderer()
    for (let n = 1; n <= 60; n += 1)
      stub.set('album_plays', fixtureId(n), plays(n))
    const pause = () => new Promise((resolve) => setTimeout(resolve, 2))
    stub.hooks.beforeRender = pause
    await sweepAll(stub.renderer)
    const { epoch, seq } = await feedState()
    const copy = new Map<string, DeviceRow>()
    let since = seq
    let writing = true

    async function reader() {
      while (writing) {
        const page = await readDeviceChanges(
          { epoch, since, limit: 50 },
          stub.renderer,
        )
        if (page.reset) throw new Error('The changes were reset')
        apply(copy, page.rows)
        since = page.seq
      }
    }
    async function writer(round: number) {
      for (let step = 0; step < 6; step += 1) {
        const n = 1 + ((round * 7 + step * 11) % 60)
        stub.set('album_plays', fixtureId(n), plays(n, round, step))
        await mark('album_plays', fixtureId(n))
        await renderDirtyDeviceRows(stub.renderer, {
          wait: true,
          deadline: later(),
          limit: 1,
        })
      }
    }
    const reading = reader()
    await Promise.all([
      writer(1),
      writer(2),
      writer(3),
      sweepDeviceFeed(stub.renderer, {
        wait: true,
        deadline: later(),
        limit: 5,
      }),
    ])
    writing = false
    await reading
    for (;;) {
      const page = await readDeviceChanges(
        { epoch, since, limit: 500 },
        stub.renderer,
      )
      if (page.reset) throw new Error('The changes were reset')
      apply(copy, page.rows)
      since = page.seq
      if (!page.hasMore) break
    }
    const live = await liveFeed()
    for (const [key, liveSeq] of live)
      if (liveSeq > seq) expect(copy.get(key)?.seq, key).toBe(liveSeq)
  })
})

describe('device feed access', () => {
  it('serves the feed to a session, an API key and a device key, and to nobody signed out', async () => {
    await resetFeed()
    for (const headers of [{ cookie }, bearer(apiKey), bearer(deviceKey)]) {
      expect(await feedState(headers)).toMatchObject({ epoch: 'fixture-epoch' })
      const changes = await request(
        '/api/v1/device/changes?epoch=fixture-epoch&since=0',
        headers,
      )
      expect(changes.status).toBe(200)
      expect(changes.headers.get('cache-control')).toContain('no-store')
      const snapshot = await request(
        '/api/v1/device/snapshot?epoch=fixture-epoch&entity=track',
        headers,
      )
      expect(snapshot.status).toBe(200)
    }
    for (const path of [
      '/api/v1/device/state',
      '/api/v1/device/changes?epoch=fixture-epoch&since=0',
      '/api/v1/device/snapshot?epoch=fixture-epoch&entity=track',
    ]) {
      expect((await request(path)).status).toBe(401)
      expect((await request(path, bearer('mm_not-a-key'))).status).toBe(401)
    }
  })

  it('rejects a query outside the schema', async () => {
    for (const path of [
      '/api/v1/device/changes?epoch=fixture-epoch',
      '/api/v1/device/changes?epoch=fixture-epoch&since=0&limit=5000',
      '/api/v1/device/snapshot?epoch=fixture-epoch&entity=subscription',
    ])
      expect((await request(path, bearer(deviceKey))).status).toBe(422)
  })
})

describe('device feed marks', () => {
  const MarkRowsSchema = z.array(
    z.object({ entity: z.string(), id: z.string() }),
  )

  async function marksOf(statement: string, role?: string) {
    await pool.query('delete from device_dirty')
    if (role) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query(`set local role ${role}`)
        await client.query(statement)
        await client.query('commit')
      } finally {
        client.release()
      }
    } else await pool.query(statement)
    const result = await pool.query('select entity, id from device_dirty')
    const rows = MarkRowsSchema.parse(result.rows)
    return {
      marks: [...new Set(rows.map((row) => `${row.entity}:${row.id}`))].sort(),
      rows: rows.length,
    }
  }

  async function nameId(artistKey: string, trackKey: string) {
    const result = await pool.query(
      'select device_scrobble_name_id($1, $2, $3) as id',
      ['listener', artistKey, trackKey],
    )
    return z.object({ id: z.string() }).parse(result.rows[0]).id
  }

  beforeEach(async () => {
    await pool.query(`
      truncate media_item, playlist, artist, tag, tag_parent, tag_ancestor,
        lastfm_scrobble, lastfm_track_link, lastfm_track_source, scrape_job,
        catalog_observation cascade;
      insert into artist (id, name) values
        ('artist-a', 'Fixture artist A'), ('artist-b', 'Fixture artist B');
      insert into media_item (id, slug, media_type, title) values
        ('album-1', 'album-1', 'album', 'Fixture album 1'),
        ('album-2', 'album-2', 'album', 'Fixture album 2'),
        ('track-1', 'track-1', 'track', 'Fixture track 1'),
        ('track-2', 'track-2', 'track', 'Fixture track 2'),
        ('track-3', 'track-3', 'track', 'Fixture track 3'),
        ('film-1', 'film-1', 'film', 'Fixture film 1'),
        ('film-2', 'film-2', 'film', 'Fixture film 2');
      insert into album (media_item_id) values ('album-1'), ('album-2');
      insert into film (media_item_id) values ('film-1'), ('film-2');
      insert into library_track (media_item_id, album_media_item_id) values
        ('track-1', 'album-1'), ('track-2', 'album-1'), ('track-3', null);
      insert into track (id, album_media_item_id, track_media_item_id, title, position)
      values ('entry-1', 'album-2', 'track-3', 'Fixture track 3', 1);
      insert into media_credit (media_item_id, artist_id, role) values
        ('album-1', 'artist-a', 'artist'), ('track-1', 'artist-a', 'artist'),
        ('track-3', 'artist-b', 'artist'), ('film-1', 'artist-b', 'director');
      insert into tag (id, media_type, name, kind) values
        ('tag-rock', 'album', 'Rock', 'genre'), ('tag-pop', 'album', 'Pop', 'genre'),
        ('tag-jazz', 'album', 'Jazz', 'genre'), ('tag-drama', 'film', 'Drama', 'genre');
      insert into tag_identity (media_type, normalized_name, kind, tag_id) values
        ('album', 'rock music', 'genre', 'tag-rock'),
        ('album', 'jazz music', 'genre', 'tag-jazz');
      insert into media_item_tag values ('album-1', 'tag-rock'), ('film-1', 'tag-drama');
      insert into track_tag (media_item_id, tag_id, owner) values
        ('track-3', 'tag-pop', 'added'), ('track-1', 'tag-rock', 'added');
      insert into tag_parent (media_type, child_key, parent_key) values ('album', 'pop', 'rock');
      insert into tag_ancestor (media_type, descendant_key, ancestor_key) values ('album', 'pop', 'rock');
      insert into tag_occurrence (id, media_item_id, tag_id, raw_name, kind)
      values ('occurrence-1', 'album-1', 'tag-rock', 'Rock', 'genre');
      insert into playlist (id, name, kind) values
        ('list-1', 'Fixture playlist 1', 'playlist'), ('list-2', 'Fixture playlist 2', 'playlist');
      insert into playlist_item (playlist_id, media_item_id, position) values
        ('list-1', 'track-2', 1), ('list-1', 'album-2', 2);
      insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data) values
        ('snapshot-a', 'artist-a', 'lastfm', '{}', '{"tags": ["Pop"]}'),
        ('snapshot-b', 'artist-b', 'lastfm', '{}', '{"tags": ["Rock"]}');
      insert into artist_provider_current_state (artist_id, provider, latest_snapshot_id) values
        ('artist-a', 'lastfm', 'snapshot-a'), ('artist-b', 'lastfm', 'snapshot-b');
      insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values
        ('reference-1', 'album-1', 'spotify', 'album', 'fixture-album'),
        ('reference-2', 'film-1', 'tmdb', 'movie', 'fixture-film');
      insert into track_fact (media_item_id, provider, bpm, verified, fetched_at)
      values ('track-1', 'fixture', 120, true, now());
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
        ('listener', 'artist a', 'track 1', 'track-1', 'exact'),
        ('listener', 'artist b', 'track 3', 'track-3', 'exact');
      insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
      values ('listener', 'artist a', 'track 1', 'track-1');
      insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
      values ('listen-1', 'listener', timestamp '2025-01-01', 'Fixture artist A', 'Fixture track 1', 'artist a', 'track 1', 'album-1');
      insert into scrape_job (id, provider, status, scope, options) values
        ('job-1', 'spotify', 'queued', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify:fixture"}');
    `)
  })

  it.each([
    [
      'media_item',
      "update media_item set title = 'Renamed album' where id = 'album-1'",
      [
        'album:album-1',
        'artist:artist-a',
        'artist_plays:artist-a',
        'playlist:list-1',
        'track:track-1',
        'track:track-2',
      ],
    ],
    [
      'media_item without a shown change',
      "update media_item set summary = 'A summary' where id = 'track-3'",
      ['track:track-3'],
    ],
    [
      'library_track',
      "update library_track set album_media_item_id = 'album-2' where media_item_id = 'track-2'",
      [
        'album:album-1',
        'album:album-2',
        'artist:artist-a',
        'playlist:list-1',
        'track:track-2',
      ],
    ],
    [
      'album',
      "update album set track_count = 5 where media_item_id = 'album-1'",
      [
        'album:album-1',
        'artist:artist-a',
        'playlist:list-1',
        'track:track-1',
        'track:track-2',
      ],
    ],
    [
      'film',
      "update film set watched = true where media_item_id = 'film-1'",
      ['film:film-1'],
    ],
    [
      'track',
      "update track set position = 2 where id = 'entry-1'",
      ['album:album-2', 'artist:artist-b', 'playlist:list-1', 'track:track-3'],
    ],
    [
      'media_credit',
      "insert into media_credit (media_item_id, artist_id, role) values ('track-2', 'artist-b', 'artist')",
      ['artist:artist-b', 'artist_plays:artist-b', 'track:track-2'],
    ],
    [
      'artist',
      "update artist set name = 'Renamed artist' where id = 'artist-a'",
      [
        'album:album-1',
        'artist:artist-a',
        'artist_plays:artist-a',
        'track:track-1',
        'track:track-2',
      ],
    ],
    [
      'artist without a shown change',
      "update artist set scrobble_count = 3 where id = 'artist-a'",
      ['artist:artist-a'],
    ],
    [
      'artist_provider_current_state',
      "update artist_provider_current_state set latest_snapshot_id = 'snapshot-b' where artist_id = 'artist-a'",
      ['album:album-1', 'artist:artist-a', 'track:track-1'],
    ],
    [
      'artist_provider_current_state without a change',
      'update artist_provider_current_state set updated_at = now()',
      [],
    ],
    [
      'artist_provider_snapshot',
      `update artist_provider_snapshot set normalized_data = '{"tags": ["Jazz"]}' where id = 'snapshot-a'`,
      ['album:album-1', 'artist:artist-a', 'track:track-1'],
    ],
    [
      'tag',
      "update tag set name = 'Rock and roll' where id = 'tag-rock'",
      [
        'album:album-1',
        'tag:tag-rock',
        'track:track-1',
        'track:track-2',
        'track:track-3',
      ],
    ],
    [
      'tag_alias',
      "insert into tag_alias (source_tag_id, target_tag_id) values ('tag-jazz', 'tag-rock')",
      ['tag:tag-jazz', 'tag:tag-rock', 'track:track-3'],
    ],
    [
      'tag_identity',
      "insert into tag_identity (media_type, normalized_name, kind, tag_id) values ('album', 'pop music', 'genre', 'tag-pop')",
      ['album:album-1', 'tag:tag-pop', 'track:track-1'],
    ],
    [
      'tag_parent',
      "insert into tag_parent (media_type, child_key, parent_key) values ('album', 'jazz', 'rock')",
      ['tag_key:album:jazz'],
    ],
    [
      'tag_ancestor',
      "delete from tag_ancestor where descendant_key = 'pop'",
      ['tag_key:album:pop'],
    ],
    [
      'media_item_tag',
      "insert into media_item_tag values ('album-1', 'tag-pop')",
      ['album:album-1', 'track:track-1', 'track:track-2'],
    ],
    [
      'track_tag',
      "insert into track_tag (media_item_id, tag_id, owner) values ('track-2', 'tag-pop', 'added')",
      ['album:album-1', 'track:track-2'],
    ],
    [
      'tag_occurrence',
      "update tag_occurrence set kind = 'style' where id = 'occurrence-1'",
      ['album:album-1'],
    ],
    [
      'playlist',
      "update playlist set name = 'Renamed playlist' where id = 'list-1'",
      [
        'album:album-1',
        'album:album-2',
        'artist:artist-a',
        'playlist:list-1',
        'track:track-2',
      ],
    ],
    [
      'playlist without a shown change',
      "update playlist set checked_at = now() where id = 'list-1'",
      ['playlist:list-1'],
    ],
    [
      'playlist_item',
      "insert into playlist_item (playlist_id, media_item_id) values ('list-2', 'track-3')",
      ['album:album-2', 'artist:artist-b', 'playlist:list-2', 'track:track-3'],
    ],
    [
      'provider_reference',
      "insert into provider_reference (id, media_item_id, provider, reference_type, external_id) values ('reference-3', 'track-1', 'spotify', 'track', 'fixture-track')",
      ['track:track-1'],
    ],
    [
      'provider_reference_override',
      "insert into provider_reference_override (id, media_item_id, provider, reference_type, external_id) values ('override-1', 'album-1', 'spotify', 'album', 'fixture-album')",
      ['album:album-1'],
    ],
    [
      'external_link',
      "insert into external_link (id, media_item_id, provider, label, url) values ('link-1', 'film-1', 'fixture', 'Fixture', 'https://example.test/film')",
      ['film:film-1'],
    ],
    [
      'media_override',
      `insert into media_override (id, media_item_id, field, value) values ('override-1', 'album-1', 'summary', '"A summary"')`,
      ['album:album-1'],
    ],
    [
      'track_fact',
      "update track_fact set bpm = 121 where media_item_id = 'track-1'",
      ['track:track-1'],
    ],
    [
      'lastfm_track_source',
      'update lastfm_track_source set manually_matched = true',
      ['track:track-1'],
    ],
    [
      'catalog_observation',
      "insert into catalog_observation (id, target_kind, target_id, provider, operation) values ('observation-1', 'artist', 'artist-a', 'fixture', 'artist')",
      ['artist:artist-a', 'artist_plays:artist-a'],
    ],
    [
      'artist added to the library',
      "update artist set added_to_library = true where id = 'artist-a'",
      ['artist:artist-a', 'artist_plays:artist-a'],
    ],
    [
      'scrape_job',
      "update scrape_job set status = 'succeeded', finished_at = now() where id = 'job-1'",
      ['playlist_job:spotify:fixture'],
    ],
    [
      'scrape_job progress',
      `update scrape_job set options = options || '{"progress": {"pagesRead": 1, "totalPages": 2}}' where id = 'job-1'`,
      [],
    ],
  ])(
    'marks the rows a one-row %s write shows',
    async (_, statement, expected) => {
      expect((await marksOf(statement)).marks).toEqual(expected)
    },
  )

  it.each([
    [
      'media_item',
      "update media_item set title = title || ' (remastered)'",
      [
        'album:album-1',
        'album:album-2',
        'artist:artist-a',
        'artist:artist-b',
        'artist_plays:artist-a',
        'artist_plays:artist-b',
        'film:film-1',
        'film:film-2',
        'playlist:list-1',
        'track:track-1',
        'track:track-2',
        'track:track-3',
      ],
    ],
    [
      'library_track',
      'update library_track set scrobble_count = scrobble_count + 1',
      ['track:track-1', 'track:track-2', 'track:track-3'],
    ],
    [
      'album',
      'update album set duration_sec = 100',
      ['album:album-1', 'album:album-2'],
    ],
    [
      'film',
      'update film set runtime_minutes = 90',
      ['film:film-1', 'film:film-2'],
    ],
    [
      'track',
      "insert into track (id, album_media_item_id, track_media_item_id, title, position) values ('entry-2', 'album-1', 'track-1', 'Fixture track 1', 1), ('entry-3', 'album-1', 'track-2', 'Fixture track 2', 2)",
      [
        'album:album-1',
        'artist:artist-a',
        'playlist:list-1',
        'track:track-1',
        'track:track-2',
      ],
    ],
    [
      'media_credit',
      'update media_credit set billing_order = 1',
      [
        'album:album-1',
        'artist:artist-a',
        'artist:artist-b',
        'artist_plays:artist-a',
        'artist_plays:artist-b',
        'film:film-1',
        'track:track-1',
        'track:track-2',
        'track:track-3',
      ],
    ],
    [
      'artist',
      'update artist set scrobble_count = 7',
      ['artist:artist-a', 'artist:artist-b'],
    ],
    [
      'artist_provider_current_state',
      'delete from artist_provider_current_state',
      [
        'album:album-1',
        'artist:artist-a',
        'artist:artist-b',
        'track:track-1',
        'track:track-3',
      ],
    ],
    [
      'artist_provider_snapshot',
      `insert into artist_provider_snapshot (id, artist_id, provider, payload, normalized_data) values
        ('snapshot-a2', 'artist-a', 'lastfm', '{}', '{"tags": []}'),
        ('snapshot-b2', 'artist-b', 'lastfm', '{}', '{"tags": []}')`,
      ['artist:artist-a', 'artist:artist-b'],
    ],
    [
      'tag',
      "update tag set hidden = true where media_type = 'album'",
      [
        'album:album-1',
        'tag:tag-jazz',
        'tag:tag-pop',
        'tag:tag-rock',
        'track:track-1',
        'track:track-2',
        'track:track-3',
      ],
    ],
    [
      'tag_alias',
      "insert into tag_alias (source_tag_id, target_tag_id) values ('tag-pop', 'tag-rock'), ('tag-jazz', 'tag-rock')",
      [
        'album:album-1',
        'tag:tag-jazz',
        'tag:tag-pop',
        'tag:tag-rock',
        'track:track-1',
        'track:track-3',
      ],
    ],
    [
      'tag_identity',
      'delete from tag_identity',
      ['tag:tag-jazz', 'tag:tag-rock', 'track:track-3'],
    ],
    [
      'tag_parent',
      "insert into tag_parent (media_type, child_key, parent_key) values ('album', 'jazz', 'rock'), ('album', 'metal', 'rock')",
      ['tag_key:album:jazz', 'tag_key:album:metal'],
    ],
    [
      'tag_ancestor',
      "insert into tag_ancestor (media_type, descendant_key, ancestor_key) values ('album', 'jazz', 'rock'), ('album', 'metal', 'rock'), ('album', 'metal', 'jazz')",
      ['tag_key:album:jazz', 'tag_key:album:metal'],
    ],
    [
      'media_item_tag',
      'delete from media_item_tag',
      ['album:album-1', 'film:film-1', 'track:track-1', 'track:track-2'],
    ],
    [
      'track_tag',
      "update track_tag set owner = 'removed'",
      ['album:album-1', 'track:track-1', 'track:track-3'],
    ],
    [
      'tag_occurrence',
      "insert into tag_occurrence (id, media_item_id, tag_id, raw_name, kind) values ('occurrence-2', 'album-2', 'tag-pop', 'Pop', 'genre'), ('occurrence-3', 'film-1', 'tag-drama', 'Drama', 'genre')",
      ['album:album-2', 'film:film-1'],
    ],
    [
      'playlist',
      'update playlist set checked_at = now()',
      ['playlist:list-1', 'playlist:list-2'],
    ],
    [
      'playlist_item',
      'delete from playlist_item',
      [
        'album:album-1',
        'album:album-2',
        'artist:artist-a',
        'playlist:list-1',
        'track:track-2',
      ],
    ],
    [
      'provider_reference',
      'update provider_reference set is_primary = true',
      ['album:album-1', 'film:film-1'],
    ],
    [
      'provider_reference_override',
      "insert into provider_reference_override (id, media_item_id, provider, reference_type, external_id) values ('override-1', 'album-1', 'spotify', 'album', 'a'), ('override-2', 'film-1', 'tmdb', 'movie', 'b')",
      ['album:album-1', 'film:film-1'],
    ],
    [
      'external_link',
      "insert into external_link (id, media_item_id, provider, label, url) values ('link-1', 'album-1', 'fixture', 'Fixture', 'https://example.test/a'), ('link-2', 'film-1', 'fixture', 'Fixture', 'https://example.test/f')",
      ['album:album-1', 'film:film-1'],
    ],
    [
      'media_override',
      `insert into media_override (id, media_item_id, field, value) values ('override-1', 'album-1', 'summary', '"A"'), ('override-2', 'film-2', 'summary', '"B"')`,
      ['album:album-1', 'film:film-2'],
    ],
    [
      'track_fact',
      "insert into track_fact (media_item_id, provider, bpm, verified, fetched_at) values ('track-2', 'fixture', 90, true, now()), ('track-3', 'fixture', 100, true, now())",
      ['track:track-2', 'track:track-3'],
    ],
    [
      'lastfm_track_source',
      "insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id) values ('listener', 'artist a', 'track 2', 'track-2'), ('listener', 'artist b', 'track 3', 'track-3')",
      ['track:track-2', 'track:track-3'],
    ],
    [
      'catalog_observation',
      "insert into catalog_observation (id, target_kind, target_id, provider, operation) values ('observation-1', 'artist', 'artist-b', 'fixture', 'artist'), ('observation-2', 'album', 'album-1', 'fixture', 'album')",
      ['artist:artist-b', 'artist_plays:artist-b'],
    ],
    [
      'scrape_job',
      `insert into scrape_job (id, provider, status, scope, options) values
        ('job-2', 'spotify', 'queued', '{}', '{"task": "spotify-playlist-import", "groupKey": "spotify-liked"}'),
        ('job-3', 'spotify', 'queued', '{}', '{"task": "spotify-track-search"}')`,
      ['playlist_job:spotify-liked'],
    ],
  ])('marks the rows a bulk %s write shows', async (_, statement, expected) => {
    expect((await marksOf(statement)).marks).toEqual(expected)
  })

  it('marks the Last.fm rows a name and its scrobbles show', async () => {
    const first = await nameId('artist a', 'track 1')
    const third = await nameId('artist b', 'track 3')
    expect(
      (
        await marksOf(
          "insert into lastfm_track_link values ('listener', 'artist a', 'track 1', 'track-2', 'exact')",
        )
      ).marks,
    ).toEqual(
      [`scrobble_name:${first}`, 'track:track-1', 'track:track-2'].sort(),
    )
    expect((await marksOf('delete from lastfm_track_link')).marks).toEqual(
      [
        'artist_plays:artist-a',
        'artist_plays:artist-b',
        `scrobble_name:${first}`,
        `scrobble_name:${third}`,
        'track:track-1',
        'track:track-2',
        'track:track-3',
      ].sort(),
    )
    expect(
      (
        await marksOf(
          "insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id) values ('listen-2', 'listener', timestamp '2025-02-01', 'A', 'T', 'artist a', 'track 1', 'album-1')",
        )
      ).marks,
    ).toEqual(
      [
        'album:album-1',
        'album_plays:album-1',
        'artist_plays:artist-a',
        'meta:listening',
        `scrobble_name:${first}`,
      ].sort(),
    )
  })

  it('marks the rows whose publication follows a library change', async () => {
    const first = await nameId('artist a', 'track 1')
    // An album counts for its artists' scope and plays; its scrobbles lose it.
    expect(
      (await marksOf("delete from album where media_item_id = 'album-1'"))
        .marks,
    ).toEqual(
      [
        'album:album-1',
        'album_plays:album-1',
        'artist:artist-a',
        'artist_plays:artist-a',
        'meta:listening',
        'playlist:list-1',
        `scrobble_name:${first}`,
        'track:track-1',
        'track:track-2',
      ].sort(),
    )
    // A name is published while a linked track is a library track in the
    // library. (Removing the album unlinked Fixture track 1 from it.)
    const linkedTrack = [
      'artist:artist-a',
      'artist_plays:artist-a',
      `scrobble_name:${first}`,
      'track:track-1',
    ].sort()
    expect(
      (
        await marksOf(
          "update media_item set in_library = false where id = 'track-1'",
        )
      ).marks,
    ).toEqual(linkedTrack)
    expect(
      (
        await marksOf(
          "delete from library_track where media_item_id = 'track-1'",
        )
      ).marks,
    ).toEqual(linkedTrack)
    // An observed name keeps the artist it is merged into in scope.
    await pool.query(
      "update artist set merged_into_id = 'artist-a' where id = 'artist-b'",
    )
    expect(
      (
        await marksOf(
          "insert into catalog_observation (id, target_kind, target_id, provider, operation) values ('observation-merged', 'artist', 'artist-b', 'fixture', 'artist')",
        )
      ).marks,
    ).toEqual([
      'artist:artist-a',
      'artist:artist-b',
      'artist_plays:artist-a',
      'artist_plays:artist-b',
    ])
    // A playlist's presentation reads the length of each album listing a member.
    await pool.query(
      "insert into playlist_item (playlist_id, media_item_id) values ('list-2', 'track-3')",
    )
    expect(
      (
        await marksOf(
          "insert into track (id, album_media_item_id, track_media_item_id, title, position) values ('entry-2', 'album-2', 'track-2', 'Fixture track 2', 2)",
        )
      ).marks,
    ).toEqual([
      'album:album-2',
      'playlist:list-1',
      'playlist:list-2',
      'track:track-2',
    ])
  })

  it('inserts each mark of a bulk statement once', async () => {
    const third = await nameId('artist b', 'track 3')
    const scrobbles = await marksOf(`
      insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
      select 'bulk-' || n, 'listener', timestamp '2025-03-01' + n * interval '1 minute',
        'B', 'T3', 'artist b', 'track 3'
      from generate_series(1, 500) n`)
    expect(scrobbles).toEqual({
      marks: [
        'artist_plays:artist-b',
        'meta:listening',
        `scrobble_name:${third}`,
      ],
      rows: 3,
    })
    const credits = await marksOf('update media_credit set billing_order = 2')
    expect(credits.rows).toBe(credits.marks.length)
  })

  it('marks writes by a role that cannot read or write the feed tables', async () => {
    expect(
      await marksOf(
        "update media_item set title = 'Renamed film' where id = 'film-2'",
        writerRole,
      ),
    ).toEqual({ marks: ['film:film-2'], rows: 1 })
  })

  it('keeps marking a bulk write after a one-row write on the same connection', async () => {
    const client = await pool.connect()
    try {
      await client.query('delete from device_dirty')
      await client.query(
        "update library_track set album_name = 'One' where media_item_id = 'track-1'",
      )
      await client.query("update library_track set album_name = 'All'")
    } finally {
      client.release()
    }
    const result = await pool.query(
      "select distinct id from device_dirty where entity = 'track' order by id",
    )
    expect(
      result.rows.map((row) => z.object({ id: z.string() }).parse(row).id),
    ).toEqual(['track-1', 'track-2', 'track-3'])
  })
})
