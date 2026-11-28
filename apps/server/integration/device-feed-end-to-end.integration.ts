import '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import type { JsonValue } from '@repo/schemas/common'
import {
  DeviceAlbumItemSchema,
  DeviceArtistItemSchema,
  DeviceChangesResponseSchema,
  DeviceEntitySchema,
  DeviceFeedStateSchema,
  DeviceFilmItemSchema,
  DevicePlaylistItemSchema,
  DevicePlaylistJobRowSchema,
  DevicePlaylistRowSchema,
  DeviceTagRowSchema,
  DeviceTrackItemSchema,
  DeviceTrackRowSchema,
  type DeviceEntity,
  type DeviceRow,
} from '@repo/schemas/device'
import { SPOTIFY_PLAYLIST_IMPORT_TASK } from '@repo/schemas/tracks'
import { env } from '@/env'
import * as schema from '@/schemas/db'
import { createApiKey } from '@/services/api-keys'
import { canonicalJson } from '@/services/device-feed-batch'
import { seedDeviceLibrary } from './fixtures/device-library'

/**
 * The device feed against real edits (docs/requirements/device-store.md,
 * stage 1): the real renderer and the real triggers on the synthetic
 * library. Each step makes one change, through the application's service or
 * route where one exists, renders the marks without a sweep, and checks
 * that `changes` returns exactly the rows whose payload differs, each equal
 * to a fresh render, and that a full sweep afterwards writes nothing.
 */

const fixture = vi.hoisted(() => ({
  ownerId: 'fixture-owner',
  ownerEmail: 'owner@example.test',
  origin: 'https://media.example.test',
}))
const { ownerId, ownerEmail, origin } = fixture

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
vi.mock('@/plugins/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/plugins/registry')>()),
  listLoadedScrapePlugins: async () => [],
}))
// Queueing an import checks the Spotify account; the job never runs here.
vi.mock('@/services/spotify-playlist-state', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/spotify-playlist-state')
  >()),
  requirePlaylistAccess: async () => {},
}))

const suffix = randomUUID().replaceAll('-', '')
const database = `media_device_end_to_end_test_${suffix}`
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
  options: '-c timezone=UTC',
})
const databaseClient = drizzle(pool, { schema })
const network = vi.fn(() => {
  throw new Error('Outbound requests are blocked in device feed tests')
})
let created = false
let apiKey = ''
let epoch = ''

const later = () => Date.now() + 60_000

async function renderer() {
  return (await import('@/services/device-rows')).deviceRowRenderer
}

async function request(
  path: string,
  init: { method?: string; body?: JsonValue } = {},
) {
  const { default: app } = await import('@/app')
  return app.request(new URL(path, origin), {
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

async function send(method: string, path: string, body: JsonValue) {
  const response = await request(path, { method, body })
  expect(response.status, `${method} ${path}`).toBe(200)
}

const keyOf = (entity: string, id: string) => `${entity}:${id}`

/** Every published row, rendered now: what the feed should hold. */
async function publishedRows() {
  const device = await renderer()
  const rows = new Map<string, JsonValue>()
  for (const entity of DeviceEntitySchema.options) {
    let after: string | null = null
    for (;;) {
      const ids: string[] = await device.listIds(entity, after, 500)
      for (const [id, payload] of await device.render(entity, ids))
        rows.set(keyOf(entity, id), payload)
      if (ids.length < 500) break
      after = ids.at(-1) ?? null
    }
  }
  return rows
}

async function feedState() {
  const response = await request('/api/v1/device/state')
  expect(response.status).toBe(200)
  return z.object({ data: DeviceFeedStateSchema }).parse(await response.json())
    .data
}

/** Every row and tombstone after `since`, through the route. */
async function changesSince(since: number) {
  const rows: DeviceRow[] = []
  let cursor = since
  for (;;) {
    const response = await request(
      `/api/v1/device/changes?epoch=${epoch}&since=${cursor}&limit=2000`,
    )
    expect(response.status).toBe(200)
    const page = z
      .object({ data: DeviceChangesResponseSchema })
      .parse(await response.json()).data
    if (page.reset) throw new Error('The changes were reset')
    expect(page.pending).toBe(false)
    rows.push(...page.rows)
    cursor = page.seq
    if (!page.hasMore) return rows
  }
}

const ItemsSchema = z.object({
  data: z.object({
    items: z.array(z.object({ id: z.string() }).passthrough()),
  }),
})

const listPaths: Partial<Record<DeviceEntity, string>> = {
  track: '/api/v1/tracks?size=100',
  album: '/api/v1/albums?includeArchived=true&editions=true&size=100',
  film: '/api/v1/films?includeArchived=true&size=100',
  artist: '/api/v1/artists/browse-page?size=100',
  playlist: '/api/v1/playlists/browse-page',
}

/** The list endpoint's item of each ID, as the device row holds it. */
async function listedItems(entity: DeviceEntity) {
  const path = listPaths[entity]
  if (!path) return undefined
  const response = await request(path)
  expect(response.status, path).toBe(200)
  const items = new Map<string, unknown>()
  for (const item of ItemsSchema.parse(await response.json()).data.items) {
    const deviceItem =
      entity === 'track'
        ? DeviceTrackItemSchema.parse(item)
        : entity === 'album'
          ? DeviceAlbumItemSchema.parse(item)
          : entity === 'film'
            ? DeviceFilmItemSchema.parse(item)
            : entity === 'artist'
              ? DeviceArtistItemSchema.parse(item)
              : DevicePlaylistItemSchema.parse(item)
    items.set(item.id, JSON.parse(JSON.stringify(deviceItem)))
  }
  return items
}

/** A playlist item as the device shows it: the job's next sync cleared until it succeeds. */
function shownItem(
  entity: DeviceEntity,
  payload: JsonValue,
  jobs: Map<string, string>,
) {
  if (entity === 'track') return DeviceTrackRowSchema.parse(payload).item
  if (entity !== 'playlist')
    return z.object({ item: z.unknown() }).parse(payload).item
  const row = DevicePlaylistRowSchema.parse(payload)
  const status =
    row.extra.syncGroupKey === null
      ? undefined
      : jobs.get(row.extra.syncGroupKey)
  const pending = status !== undefined && status !== 'succeeded'
  return JSON.parse(
    JSON.stringify({
      ...row.item,
      sync: {
        ...row.item.sync,
        nextScheduledAt: pending ? null : row.item.sync.nextScheduledAt,
      },
    }),
  )
}

async function markCount() {
  const result = await pool.query(
    'select count(*)::int as count from device_dirty',
  )
  return z.object({ count: z.number() }).parse(result.rows[0]).count
}

/**
 * Makes `change`, renders the marks without a sweep and checks the changes
 * against a fresh render of the whole library. Returns the changed rows.
 */
async function step(label: string, change: () => Promise<void>) {
  const { renderDirtyDeviceRows, sweepDeviceFeed } =
    await import('@/services/device-feed')
  const device = await renderer()
  const before = await publishedRows()
  const { seq: since } = await feedState()
  await change()
  const marks = await markCount()
  await renderDirtyDeviceRows(device, { wait: true, deadline: later() })
  expect(await markCount(), label).toBe(0)
  const changes = await changesSince(since)
  const after = await publishedRows()

  const differing = new Set<string>()
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key)
    const now = after.get(key)
    if (
      old === undefined ||
      now === undefined ||
      canonicalJson(old) !== canonicalJson(now)
    )
      differing.add(key)
  }
  expect(
    changes.map((row) => keyOf(row.entity, row.id)).sort(),
    `${label}: the rows whose payload differs`,
  ).toEqual([...differing].sort())

  const jobs = new Map(
    [...after]
      .filter(([key]) => key.startsWith('playlist_job:'))
      .map(([key, payload]) => [
        key.slice('playlist_job:'.length),
        DevicePlaylistJobRowSchema.parse(payload).status,
      ]),
  )
  const items = new Map<DeviceEntity, Map<string, unknown> | undefined>()
  for (const row of changes) {
    if (row.deleted) {
      expect(after.has(keyOf(row.entity, row.id)), label).toBe(false)
      continue
    }
    const fresh = (await device.render(row.entity, [row.id])).get(row.id)
    expect(row.payload, `${label}: ${row.entity} ${row.id}`).toEqual(fresh)
    if (!items.has(row.entity))
      items.set(row.entity, await listedItems(row.entity))
    const listed = items.get(row.entity)?.get(row.id)
    if (listed !== undefined)
      expect(
        shownItem(row.entity, row.payload, jobs),
        `${label}: the listed ${row.entity} ${row.id}`,
      ).toEqual(listed)
  }

  // A sweep finds nothing the triggers missed.
  const sweep = await sweepDeviceFeed(device, {
    wait: true,
    deadline: later(),
  })
  expect(sweep, `${label}: the sweep after it`).toEqual({
    written: 0,
    complete: true,
    failed: {},
  })
  process.stdout.write(
    `device feed end to end, ${label}: ${marks} marks, ${changes.length} rows changed\n`,
  )
  return new Map(
    changes.map((row) => [keyOf(row.entity, row.id), row.deleted] as const),
  )
}

const query = (statement: string, values: unknown[] = []) =>
  pool.query(statement, values).then(() => undefined)

/** The `scrobble_name` ID of a fixture listener's artist and track keys. */
async function scrobbleName(artistKey: string, trackKey: string) {
  const result = await pool.query(
    "select device_scrobble_name_id('fixture-listener', $1, $2) as id",
    [artistKey, trackKey],
  )
  return z.object({ id: z.string() }).parse(result.rows[0]).id
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  await admin.connect()
  await admin.query(`create database ${database}`)
  created = true
  await migrate(databaseClient, { migrationsFolder: './drizzle' })
  await seedDeviceLibrary(pool)
  await databaseClient
    .insert(schema.user)
    .values({ id: ownerId, name: 'Owner', email: ownerEmail, role: 'admin' })
  apiKey = (await createApiKey(ownerId, { name: 'Fixture', expiresIn: null }))
    .key
})

afterEach(() => {
  expect(network).not.toHaveBeenCalled()
})

afterAll(async () => {
  await pool.end()
  if (created) await admin.query(`drop database ${database}`)
  await admin.end()
  vi.unstubAllGlobals()
})

describe('the device feed against real edits', () => {
  it('builds the feed with a full sweep', async () => {
    const { refreshDeviceFeedForMaintenance } =
      await import('@/services/device-feed')
    await query('delete from device_dirty')
    // Maintenance with the configured renderer starts and builds the feed.
    expect((await refreshDeviceFeedForMaintenance()).published).toBe(true)
    const state = await feedState()
    expect(state.ready).toBe(true)
    epoch = state.epoch
    const published = await publishedRows()
    const stored = await pool.query<{
      entity: string
      id: string
      payload: JsonValue
    }>('select entity, id, payload from device_row where not deleted')
    expect(stored.rows.length).toBe(published.size)
    for (const row of stored.rows)
      expect(row.payload, keyOf(row.entity, row.id)).toEqual(
        published.get(keyOf(row.entity, row.id)),
      )
  })

  it('a track, an album and a film edit', async () => {
    const track = await step('track title', () =>
      query(
        "update media_item set title = 'Bright Water (Remaster)' where id = 'track-bright'",
      ),
    )
    expect(track.get('track:track-bright')).toBe(false)
    const albumChanges = await step('album title', () =>
      send('PATCH', '/api/v1/albums/album-quiet', {
        title: 'Quiet Fields Revisited',
      }),
    )
    expect(albumChanges.get('album:album-quiet')).toBe(false)
    const filmChanges = await step('film title', () =>
      send('PATCH', '/api/v1/films/film-juniper', { title: 'Juniper Road' }),
    )
    expect(filmChanges.get('film:film-juniper')).toBe(false)
  })

  it('an artist rename', async () => {
    const changes = await step('artist rename', () =>
      query(
        "update artist set name = 'Birch Unit Trio' where id = 'artist-birch'",
      ),
    )
    expect(changes.get('artist:artist-birch')).toBe(false)
    expect(changes.get('track:track-bright')).toBe(false)
  })

  it('tag edits', async () => {
    const renamed = await step('tag rename', () =>
      query("update tag set name = 'Ambient Works' where id = 'tag-ambient'"),
    )
    expect(renamed.get('tag:tag-ambient')).toBe(false)
    expect(renamed.get('album:album-north')).toBe(false)
    const hidden = await step('tag hidden', () =>
      send('POST', '/api/v1/tags/visibility', {
        mediaType: 'album',
        tagIds: ['tag-downtempo'],
        hidden: true,
      }),
    )
    expect(hidden.get('tag:tag-downtempo')).toBe(false)
    await step('tag unhidden', () =>
      send('POST', '/api/v1/tags/visibility', {
        mediaType: 'album',
        tagIds: ['tag-downtempo'],
        hidden: false,
      }),
    )
    const alias = await step('tag alias added', () =>
      send('POST', '/api/v1/tags/merge', {
        mediaType: 'album',
        sourceIds: ['tag-downtempo'],
        targetId: 'tag-ambient',
      }),
    )
    expect(alias.get('tag:tag-downtempo')).toBe(false)
    const parented = await step('tag re-parented', () =>
      send('POST', '/api/v1/tags/parents', {
        mediaType: 'album',
        tagIds: ['tag-synth'],
        parentIds: ['tag-electronic'],
        mode: 'replace',
      }),
    )
    expect(parented.get('tag_key:album:synth pop')).toBe(false)
    const added = await step('track tag added', () =>
      send('POST', '/api/v1/tracks/track-cold/tags', { tagId: 'tag-pop' }),
    )
    expect(added.get('track:track-cold')).toBe(false)
    const removed = await step('track tag removed', () =>
      send('DELETE', '/api/v1/tracks/track-cold/tags', { tagId: 'tag-pop' }),
    )
    expect(removed.get('track:track-cold')).toBe(false)
  })

  it('a Sonovault tag on a track outside the library', async () => {
    const sonovault = async (id: string) =>
      DeviceTagRowSchema.parse(
        (await (await renderer()).render('tag', [id])).get(id),
      ).sonovault
    // Bright Water has a tag of its own and inherits Synth Pop from its
    // album while no track holds Synth Pop from Sonovault.
    expect(await sonovault('tag-synth')).toBe(false)
    const left = await step('track out of the library', () =>
      query("update media_item set in_library = false where id = 'track-cold'"),
    )
    expect(left.get('track:track-cold')).toBe(true)
    const gained = await step(
      'Sonovault tag on a track outside the library',
      () =>
        query(`insert into track_tag (media_item_id, tag_id, owner, sonovault, verified)
        values ('track-cold', 'tag-synth', null, true, true)`),
    )
    expect(gained.get('tag:tag-synth')).toBe(false)
    expect(await sonovault('tag-synth')).toBe(true)
    // Unverified, the tag leaves Browse.
    const lost = await step('Sonovault tag unverified', () =>
      query(`update track_tag set verified = false
        where media_item_id = 'track-cold' and tag_id = 'tag-synth'`),
    )
    expect(lost.get('tag:tag-synth')).toBe(false)
    expect(await sonovault('tag-synth')).toBe(false)
    const regained = await step('Sonovault tag verified again', () =>
      query(`update track_tag set verified = true
        where media_item_id = 'track-cold' and tag_id = 'tag-synth'`),
    )
    expect(regained.get('tag:tag-synth')).toBe(false)
    const deleted = await step('Sonovault tag deleted', () =>
      query(
        "delete from track_tag where media_item_id = 'track-cold' and tag_id = 'tag-synth'",
      ),
    )
    expect(deleted.get('tag:tag-synth')).toBe(false)
    expect(await sonovault('tag-synth')).toBe(false)
    const returned = await step('track back in the library', () =>
      query("update media_item set in_library = true where id = 'track-cold'"),
    )
    expect(returned.get('track:track-cold')).toBe(false)
  })

  it('a recording group member renamed, archived, restored and deleted', async () => {
    // The remaining member's group changes with no sweep.
    const renamed = await step('recording member renamed', () =>
      query(
        "update media_item set title = 'Aurora (Live)' where id = 'track-aurora-live'",
      ),
    )
    expect(renamed.get('track:track-aurora')).toBe(false)
    const back = await step('recording member renamed back', () =>
      query(
        "update media_item set title = 'Aurora' where id = 'track-aurora-live'",
      ),
    )
    expect(back.get('track:track-aurora')).toBe(false)
    const archived = await step('recording member archived', () =>
      query(`update media_item set metadata = metadata || '{"legacyHidden": "true"}'
        where id = 'track-aurora-live'`),
    )
    expect(archived.get('track:track-aurora')).toBe(false)
    const restored = await step('recording member restored', () =>
      query(
        "update media_item set metadata = metadata - 'legacyHidden' where id = 'track-aurora-live'",
      ),
    )
    expect(restored.get('track:track-aurora')).toBe(false)
    const deleted = await step('recording member deleted', () =>
      query(`begin;
        delete from track where track_media_item_id = 'track-aurora-live';
        delete from media_item where id = 'track-aurora-live';
        commit`),
    )
    expect(deleted.get('track:track-aurora-live')).toBe(true)
    expect(deleted.get('track:track-aurora')).toBe(false)
  })

  it('playlist edits', async () => {
    const added = await step('playlist member added', () =>
      query(`insert into playlist_item (playlist_id, media_item_id, position)
        values ('playlist-morning', 'track-echo', 3)`),
    )
    expect(added.get('playlist:playlist-morning')).toBe(false)
    const removed = await step('playlist member removed', () =>
      query(
        "delete from playlist_item where playlist_id = 'playlist-morning' and media_item_id = 'track-echo'",
      ),
    )
    expect(removed.get('playlist:playlist-morning')).toBe(false)
    const renamed = await step('playlist renamed', () =>
      query(
        "update playlist set name = 'Early Mix' where id = 'playlist-morning'",
      ),
    )
    expect(renamed.get('playlist:playlist-morning')).toBe(false)
  })

  it('a Spotify playlist import queued, running with progress and finished', async () => {
    const { createTaskJob, withRunningJob } = await import('@/services/jobs')
    let jobId = ''
    const queued = await step('import queued', async () => {
      jobId = (
        await createTaskJob(SPOTIFY_PLAYLIST_IMPORT_TASK, ownerId, {
          taskOptions: { source: 'spotify-liked' },
        })
      ).id
    })
    expect(queued.get('playlist_job:spotify-liked')).toBe(false)
    const running = await step('import running', () =>
      query(
        "update scrape_job set status = 'running', started_at = now() where id = $1",
        [jobId],
      ),
    )
    expect(running.get('playlist_job:spotify-liked')).toBe(false)
    for (const pagesRead of [1, 2]) {
      const progress = await step(`import progress ${pagesRead}`, async () => {
        const written = await withRunningJob(jobId, async (tx, job) => {
          await tx
            .update(schema.scrapeJob)
            .set({
              options: sql`${schema.scrapeJob.options} || ${JSON.stringify({
                progress: { pagesRead, totalPages: 3 },
                activity: `Page ${pagesRead}`,
              })}::jsonb`,
            })
            .where(eq(schema.scrapeJob.id, job.id))
        })
        expect(written).toBe(true)
      })
      expect(progress.size).toBe(0)
    }
    const finished = await step('import finished', () =>
      query(
        "update scrape_job set status = 'succeeded', finished_at = now() where id = $1",
        [jobId],
      ),
    )
    expect(finished.get('playlist_job:spotify-liked')).toBe(false)
  })

  it('a Last.fm placeholder whose exact-linked peer is archived and restored', async () => {
    // A placeholder is redundant while a peer linked exactly to one of its
    // names can play; the peer's own change decides its flag.
    await step('placeholder added', () =>
      query(`begin;
        insert into media_item (id, slug, media_type, title, source_label, metadata, created_at, updated_at)
        values ('track-polar', 'track-polar', 'track', 'Polar Glow', 'lastfm', '{}', '2020-02-07', '2020-02-07');
        insert into library_track (media_item_id, date_added, scrobble_count)
        values ('track-polar', '2023-07-01', 0);
        insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id)
        values ('fixture-listener', 'aster vale', 'aurora', 'track-polar');
        commit`),
    )
    const placeholderFlag = async () =>
      DeviceTrackRowSchema.parse(
        (await (await renderer()).render('track', ['track-polar'])).get(
          'track-polar',
        ),
      ).extra.redundantPlaceholder
    expect(await placeholderFlag()).toBe(true)
    const archived = await step('placeholder peer archived', () =>
      query(`update media_item set metadata = metadata || '{"legacyHidden": "true"}'
        where id = 'track-aurora'`),
    )
    expect(archived.get('track:track-polar')).toBe(false)
    expect(await placeholderFlag()).toBe(false)
    const restored = await step('placeholder peer restored', () =>
      query(
        "update media_item set metadata = metadata - 'legacyHidden' where id = 'track-aurora'",
      ),
    )
    expect(restored.get('track:track-polar')).toBe(false)
  })

  it('a playlist holding a track listed on an album', async () => {
    // Artist Aster is credited on Northern Lights, which lists Échelle only
    // in its track list.
    const added = await step('playlist of a listed track added', () =>
      query(`begin;
        insert into playlist (id, name, kind, added_to_library, sync_schedule, created_at)
        values ('playlist-listed', 'Listed Picks', 'playlist', true, 'off', '2022-08-01');
        insert into playlist_item (playlist_id, media_item_id, position)
        values ('playlist-listed', 'track-echo', 0);
        commit`),
    )
    expect(added.get('artist:artist-aster')).toBe(false)
    const renamed = await step('playlist of a listed track renamed', () =>
      query(
        "update playlist set name = 'Listed Mix' where id = 'playlist-listed'",
      ),
    )
    expect(renamed.get('artist:artist-aster')).toBe(false)
    const archived = await step('listed track archived', () =>
      query(`update media_item set metadata = metadata || '{"legacyHidden": "true"}'
        where id = 'track-echo'`),
    )
    expect(archived.get('artist:artist-aster')).toBe(false)
    await step('listed track restored', () =>
      query(
        "update media_item set metadata = metadata - 'legacyHidden' where id = 'track-echo'",
      ),
    )
    // A loose single counts for its artists while another member shows the
    // playlist, so removing that member hides the playlist from them.
    await step('loose single added to the playlist', () =>
      query(`insert into playlist_item (playlist_id, media_item_id, position)
        values ('playlist-listed', 'track-cold', 1)`),
    )
    const hidden = await step('last listed member removed', () =>
      query(
        "delete from playlist_item where playlist_id = 'playlist-listed' and media_item_id = 'track-echo'",
      ),
    )
    expect(hidden.get('artist:artist-birch')).toBe(false)
    const shown = await step('listed member added back', () =>
      query(`insert into playlist_item (playlist_id, media_item_id, position)
        values ('playlist-listed', 'track-echo', 2)`),
    )
    expect(shown.get('artist:artist-birch')).toBe(false)
  })

  it('an album and a track with plays leave the library and return', async () => {
    const name = await scrobbleName('cedar echo', 'echelle')
    const albumLeft = await step('album out of the library', () =>
      query(
        "update media_item set in_library = false where id = 'album-north'",
      ),
    )
    expect(albumLeft.get('album_plays:album-north')).toBe(true)
    // The playlist counts the album through the album's track list.
    expect(albumLeft.get('playlist:playlist-listed')).toBe(false)
    const trackLeft = await step('track out of the library', () =>
      query("update media_item set in_library = false where id = 'track-echo'"),
    )
    expect(trackLeft.get(`scrobble_name:${name}`)).toBe(true)
    // Promoting the album admits the tracks its track list holds.
    const { promoteCatalogMedia } =
      await import('@/services/catalog-discoveries')
    const returned = await step('album and its track promoted', async () => {
      await promoteCatalogMedia('album-north', ownerId)
    })
    expect(returned.get('track:track-echo')).toBe(false)
    expect(returned.get(`scrobble_name:${name}`)).toBe(false)
    expect(returned.get('album_plays:album-north')).toBe(false)
  })

  it('new scrobbles for a linked track and for an album', async () => {
    const nameId = await scrobbleName('aster vale', 'aurora')
    // As a sync stores them: the scrobbles, then the links and the
    // listening fields of tracks and artists recounted from them.
    const { refreshTrackLinks } = await import('@/services/track-links')
    const track = await step('track scrobble', async () => {
      await query(`insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
        values ('scrobble-new-track', 'fixture-listener', '2024-06-01 00:00:00', 'Aster Vale', 'Aurora', 'aster vale', 'aurora')`)
      await refreshTrackLinks('fixture-listener', 'sync')
    })
    expect(track.get(`scrobble_name:${nameId}`)).toBe(false)
    expect(track.get('artist_plays:artist-aster')).toBe(false)
    expect(track.get('track:track-aurora')).toBe(false)
    const album = await step('album scrobble', () =>
      query(`insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
        values ('scrobble-new-album', 'fixture-listener', '2024-06-02 00:00:00', 'Aster Vale', 'Unlinked Song', 'aster vale', 'unlinked song', 'album-north')`),
    )
    expect(album.get('album_plays:album-north')).toBe(false)
    expect(album.get('artist_plays:artist-aster')).toBe(false)
    // An earlier first play moves the listening start.
    const earliest = await step('earliest scrobble', () =>
      query(`insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key)
        values ('scrobble-first', 'fixture-listener', '2019-01-01 00:00:00', 'Aster Vale', 'Aurora', 'aster vale', 'aurora')`),
    )
    expect(earliest.get('meta:listening')).toBe(false)
  })

  it('an artist merge and an album merge', async () => {
    const artists = await step('artist merge', () =>
      send('POST', '/api/v1/library-changes/artist-merges', {
        artistIds: ['artist-cedar', 'artist-aster'],
        targetId: 'artist-aster',
        follow: false,
        reviewed: true,
      }),
    )
    expect(artists.get('artist:artist-cedar')).toBe(true)
    expect(artists.get('artist_plays:artist-cedar')).toBe(true)
    expect(artists.get('artist:artist-aster')).toBe(false)
    expect(artists.get('track:track-echo')).toBe(false)
    // The merged album becomes an edition of the album kept.
    const albums = await step('album merge', () =>
      send('POST', '/api/v1/library-changes/album-merges', {
        albumIds: ['album-quiet', 'album-north'],
        targetId: 'album-north',
        reviewed: true,
      }),
    )
    expect(albums.get('album:album-quiet')).toBe(false)
    expect(albums.get('album:album-north')).toBe(false)
  })

  it('an item archived, restored and deleted', async () => {
    const archived = await step('film archived', () =>
      query(`update media_item set metadata = metadata || '{"legacyHidden": "true"}'
        where id = 'film-juniper'`),
    )
    expect(archived.get('film:film-juniper')).toBe(false)
    const restored = await step('film restored', () =>
      query(
        "update media_item set metadata = metadata - 'legacyHidden' where id = 'film-juniper'",
      ),
    )
    expect(restored.get('film:film-juniper')).toBe(false)
    const deleted = await step('film deleted', () =>
      query("delete from media_item where id = 'film-juniper'"),
    )
    expect(deleted.get('film:film-juniper')).toBe(true)
  })

  it('sets aside play rows with a fractional play time and renders the rest', async () => {
    const { refreshDeviceFeedForMaintenance } =
      await import('@/services/device-feed')
    const StoredSchema = z.array(
      z.object({ entity: z.string(), id: z.string(), seq: z.string() }),
    )
    const playRows = async () =>
      StoredSchema.parse(
        (
          await pool.query(`select entity, id, seq from device_row
            where not deleted and entity in ('album_plays', 'artist_plays')
            order by entity, id`)
        ).rows,
      )
    const before = await playRows()
    const { seq: since } = await feedState()
    // Last.fm reports whole seconds; this play time cannot be published.
    await query(`insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
      values ('scrobble-fraction', 'fixture-listener', '2024-06-03 00:00:00.5', 'Aster Vale', 'Unlinked Song',
        'aster vale', 'unlinked song', 'album-north')`)
    const changes = await changesSince(since)
    expect(
      changes.filter((row) => row.entity.endsWith('_plays')),
      'no play row of the album or its artist',
    ).toEqual([])
    expect(await playRows()).toEqual(before)
    expect(await markCount()).toBe(0)

    await query(`insert into device_dirty (entity, id)
      values ('album_plays', 'album-north'), ('artist_plays', 'artist-aster')`)
    expect((await refreshDeviceFeedForMaintenance()).renderFailures).toEqual({
      album_plays: 1,
      artist_plays: 1,
    })
    expect(await playRows()).toEqual(before)

    // Without it the rows render again, unchanged.
    await query("delete from lastfm_scrobble where id = 'scrobble-fraction'")
    await query(`insert into device_dirty (entity, id)
      values ('album_plays', 'album-north'), ('artist_plays', 'artist-aster')`)
    expect(await refreshDeviceFeedForMaintenance()).toEqual({
      published: false,
      renderFailures: {},
    })
    expect(await playRows()).toEqual(before)
  })

  it('renders the rows rendered with a failing row in a later run when the deadline left them unresolved', async () => {
    const { renderDirtyDeviceRows, sweepDeviceFeed } =
      await import('@/services/device-feed')
    const device = await renderer()
    const ids = ['track-bright', 'track-cold', 'track-echo']
    const TitlesSchema = z.array(
      z.object({ id: z.string(), title: z.string() }),
    )
    const storedTitles = async () =>
      TitlesSchema.parse(
        (
          await pool.query(
            `select id, payload->'item'->>'title' as title from device_row
              where entity = 'track' and id = any($1) order by id`,
            [ids],
          )
        ).rows,
      )
    const before = await storedTitles()
    await query(
      "update media_item set title = title || ' (edit)' where id = any($1)",
      [ids],
    )
    // A slow track render that fails for any part holding one of the tracks.
    const failing = (delayMs: number) => ({
      ...device,
      async render(entity: DeviceEntity, renderIds: readonly string[]) {
        const rendered = await device.render(entity, renderIds)
        if (entity !== 'track') return rendered
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (renderIds.includes('track-cold'))
          throw new Error('A fixture row cannot be rendered')
        return rendered
      },
    })
    const trackMarks = async () =>
      z
        .array(z.object({ id: z.string() }))
        .parse(
          (
            await pool.query(
              "select distinct id from device_dirty where entity = 'track' order by id",
            )
          ).rows,
        )
        .map((row) => row.id)

    // The track render fails past the deadline: no track is set aside or
    // written, and each keeps its mark.
    const first = await renderDirtyDeviceRows(failing(300), {
      wait: false,
      deadline: Date.now() + 200,
      limit: 200,
    })
    expect(first).toMatchObject({ busy: false, failed: {} })
    expect(await storedTitles()).toEqual(before)
    expect(await trackMarks()).toEqual(expect.arrayContaining(ids))

    // A later run, without a sweep, renders the other tracks and sets aside
    // only the failing one.
    const run = await renderDirtyDeviceRows(failing(0), {
      wait: true,
      deadline: later(),
    })
    expect(run.failed).toEqual({ track: 1 })
    expect(await markCount()).toBe(0)
    expect(await storedTitles()).toEqual(
      before.map(({ id, title }) => ({
        id,
        title: id === 'track-cold' ? title : `${title} (edit)`,
      })),
    )
    // The sweep renders it; the titles are then restored.
    expect(
      await sweepDeviceFeed(device, { wait: true, deadline: later() }),
    ).toMatchObject({ complete: true, failed: {} })
    await step('titles restored', () =>
      query(
        "update media_item set title = replace(title, ' (edit)', '') where id = any($1)",
        [ids],
      ),
    )
  })
})
