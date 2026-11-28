import '@hono/zod-openapi'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  apiRequest,
  apiSend,
  buildFeed,
  readDevice,
  openParityStore,
  parityCollation,
  parityPool,
  renderMarks,
  setUpParityDatabase,
  syncParityStore,
  tearDownParityDatabase,
  type ParityStore,
} from './device-parity/harness'
import {
  apiPath,
  directions,
  libraries,
  listeningPeriods,
  tagLocations,
  type LibraryRoutes,
  type Params,
} from './device-parity/matrix'
import {
  ParityRunner,
  runLibraryMatrix,
  unresolved,
  unresolvedPaths,
} from './device-parity/runner'
import { PARITY_NOW } from './fixtures/device-parity-library'

/**
 * Device parity (docs/requirements/device-store.md, DEVICE-32 and 33): the
 * synthetic library through the real feed into a SQLite store, and for a
 * generated matrix of queries per library the API route's answer against
 * the device's answer for the same path, with one fixed clock on both
 * sides. Then edits through the services, a sync of the changes and a
 * reduced matrix again.
 */

const fixture = vi.hoisted(() => ({
  ownerId: 'fixture-owner',
  ownerEmail: 'owner@example.test',
  origin: 'https://media.example.test',
  /** A plugin field the API lists after the store synced its field list. */
  lateField: false,
}))

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
vi.mock('@/lib/db', async () => {
  const { parityDatabase } = await import('./device-parity/harness')
  return { db: parityDatabase }
})
vi.mock('@/plugins/registry', async (importOriginal) => {
  const { parityPluginFields: browseFields } =
    await import('./fixtures/device-parity-library')
  return {
    ...(await importOriginal<typeof import('@/plugins/registry')>()),
    listLoadedScrapePlugins: async () => [
      {
        manifest: {
          id: 'fixture-fields',
          displayName: 'Fixture fields',
          mediaTypes: ['album', 'film'],
          browseFields: fixture.lateField
            ? [
                ...browseFields,
                { key: 'fixtureLate', label: 'Fixture late', type: 'text' },
              ]
            : browseFields,
        },
      },
    ],
  }
})

const network = vi.fn(() => {
  throw new Error('Outbound requests are blocked in the parity suite')
})

let store: ParityStore | undefined
const started = performance.now()

function currentStore(): ParityStore {
  if (store === undefined) throw new Error('The store is not open')
  return store
}

beforeAll(async () => {
  vi.stubGlobal('fetch', network)
  // One clock for the API and the device: services read `new Date()`, the
  // device source its `now` option, which reads the same faked Date.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(PARITY_NOW)
  await setUpParityDatabase()
  await buildFeed()
  store = openParityStore()
  const synced = await syncParityStore(store)
  if (synced.status !== 'synced') throw new Error('The store did not fill')
  process.stdout.write(
    `device parity: ${parityCollation}, ${synced.rowsApplied} rows synced\n`,
  )
})

afterAll(async () => {
  await store?.driver.close()
  await tearDownParityDatabase()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.stdout.write(
    `device parity: ${Math.round((performance.now() - started) / 1000)} s\n`,
  )
})

const extraValues: Record<string, string[]> = {
  title: ['Aurora', 'aurora', 'Échelle', 'İstanbul Night', 'Harbor', 'Orbit'],
  name: ['Aster Vale', 'ivy lane', 'İris Hollow'],
  album: ['Loose Single', 'quiet Fields', 'Drift EP'],
  artist: ['Aster Vale', 'birch unit', 'IVY LANE', 'Fern Ålund'],
  musicalKey: ['8A', '8a', '11B'],
  fixtureMood: ['Blue', 'blue', 'Red'],
  fixtureCode: ['12', 'B7', '9', 'alpha'],
}

function expectParity(run: ParityRunner, label: string) {
  for (const line of run.report.summary())
    process.stdout.write(`device parity, ${label}, ${line}\n`)
  process.stdout.write(
    `device parity, ${label}: ${run.report.compared} reads compared\n`,
  )
  expect(
    {
      failures: run.report.failures,
      moreOnRoute: Object.fromEntries(run.report.dropped),
    },
    label,
  ).toEqual({ failures: [], moreOnRoute: {} })
}

const routesOf = (library: LibraryRoutes['library']): LibraryRoutes => {
  const routes = libraries.find((entry) => entry.library === library)
  if (routes === undefined) throw new Error(`No routes for ${library}`)
  return routes
}

const artistIds = [
  'artist-aster',
  'artist-birch',
  'artist-cedar',
  'artist-delta',
  'artist-echo',
  'artist-fern',
  'artist-gale',
  'artist-jade',
  'artist-kite',
  'artist-lumen',
  'artist-missing',
]
const recordingTrackIds = [
  'track-aurora',
  'track-aurora-live',
  'track-hum-a',
  'track-hum-lastfm',
  'track-drift-a',
  'track-drift-c',
  'track-orbit-a',
  'track-bright',
  'track-delta',
  'track-outside',
  'track-missing',
]

/** Grouped Tracks, recordings lists, positions and creator scopes. */
async function trackSpecifics(run: ParityRunner, reduced: boolean) {
  const routes = routesOf('track')
  const sorts = [
    'title',
    'artist',
    'dateAdded',
    'releaseDate',
    'scrobbles',
    'lastListenedAt',
    'durationSec',
    'genre',
    'listeningScrobbles',
  ]
  for (const sortBy of reduced ? sorts.slice(0, 3) : sorts)
    for (const direction of directions) {
      await run.pages(
        routes.page,
        { groupRecordings: true, sortBy, direction },
        3,
      )
      await run.pages(
        routes.list ?? routes.page,
        { groupRecordings: 'true', sortBy, direction },
        4,
      )
    }
  const groupedFilters: Params[] = [
    { filters: [{ field: 'artist', value: 'Kite' }] },
    { filters: [{ field: 'title', value: 'drift', mode: 'exclude' }] },
    { q: 'aurora' },
    { ranges: [{ field: 'durationSec', min: 200, includeMissing: true }] },
    { ranges: [{ field: 'scrobbles', min: 1 }] },
    { ranges: [{ field: 'dateAdded', max: Date.UTC(2023, 6, 2) }] },
    {
      listening: { match: 'all', rules: [{ period: { kind: 'all' }, min: 2 }] },
    },
    {
      sortBy: 'listeningScrobbles',
      listeningSort: { kind: 'rolling', amount: 1, unit: 'years' },
    },
    { filters: [{ field: 'genre', value: 'Rock' }], tagLevels: ['track'] },
    { limitResults: 3 },
  ]
  for (const params of groupedFilters) {
    await run.query(routes, { ...params, groupRecordings: true })
    await run.read(
      apiPath('tracks/listening-histogram', {
        ...params,
        groupRecordings: true,
        period: { kind: 'all' },
      }),
    )
  }

  // Positions: plain, grouped, filtered, capped, past the end, repeated.
  const positionQueries: Params[] = [
    {},
    { groupRecordings: true },
    { sortBy: 'title', direction: 'asc' },
    { sortBy: 'genre', tagLevels: ['album'] },
    { filters: [{ field: 'artist', value: 'Aster Vale', mode: 'exclude' }] },
    { limitResults: 4 },
    { q: 'drift', groupRecordings: true },
    { creatorId: 'artist-kite' },
    { creatorId: 'artist-kite', groupRecordings: true },
    { filters: [{ field: 'provider', value: 'musicbrainz' }] },
  ]
  for (const params of reduced ? positionQueries.slice(0, 3) : positionQueries)
    for (const positions of ['0', '0,1,2', '9,3,0,3', '5,100,1000', '19,18,17'])
      await run.read(apiPath('tracks/positions', { ...params, positions }))

  // Recordings lists of tracks in and out of groups.
  const recordingQueries: Params[] = [
    {},
    { sortBy: 'title', direction: 'asc' },
    { sortBy: 'releaseDate', direction: 'desc' },
    { sortBy: 'genre' },
    { sortBy: 'genre', tagLevels: ['track', 'album'] },
    { q: 'live' },
    { filters: [{ field: 'provider', value: 'discogs' }] },
    { creatorId: 'artist-kite' },
  ]
  for (const id of recordingTrackIds)
    for (const params of reduced
      ? recordingQueries.slice(0, 2)
      : recordingQueries)
      await run.read(apiPath(`tracks/${id}/recordings`, { ...params, size: 2 }))

  // Creator scopes.
  for (const creatorId of reduced ? artistIds.slice(0, 4) : artistIds) {
    await run.pages(routes.page, { creatorId }, 2)
    await run.query(routes, { creatorId, sortBy: 'title', direction: 'asc' })
    await run.query(routes, { creatorId, sortBy: 'genre' })
    await run.query(routes, {
      creatorId,
      sortBy: 'genre',
      tagLevels: ['album'],
    })
    await run.query(routes, { creatorId, groupRecordings: true })
    await run.query(routes, { creatorId, q: 'drift' })
    await run.read(
      apiPath('tracks/listening-histogram', {
        creatorId,
        period: { kind: 'rolling', amount: 1, unit: 'years' },
      }),
    )
  }

  // The Last.fm placeholder rule: Last.fm sources and required playlists show them.
  for (const params of [
    { filters: [{ field: 'source', value: 'Last.fm' }] },
    { filters: [{ field: 'source', value: 'last.FM', mode: 'required' }] },
    { filters: [{ field: 'source', value: 'Last.fm', mode: 'exclude' }] },
    {
      filters: [{ field: 'playlist', value: 'Hourly Picks', mode: 'required' }],
    },
    { filters: [{ field: 'playlist', value: 'Hourly Picks' }] },
    { q: 'hum' },
  ])
    await run.query(routes, params)
}

/** Archived and edition toggles and creator scopes of Albums and Films. */
async function mediaSpecifics(run: ParityRunner, reduced: boolean) {
  const albums = routesOf('album')
  for (const includeArchived of [undefined, 'true', 'false'])
    for (const editions of [undefined, 'true', 'false']) {
      await run.pages(
        albums.page,
        { includeArchived, editions, sortBy: 'title' },
        3,
      )
      await run.query(albums, { includeArchived, editions, q: 'orbit' })
      await run.read(
        apiPath('albums/listening-histogram', {
          includeArchived,
          editions,
          period: { kind: 'all' },
        }),
      )
    }
  for (const creatorId of reduced ? artistIds.slice(0, 3) : artistIds) {
    await run.query(albums, { creatorId })
    await run.query(albums, {
      creatorId,
      includeArchived: 'true',
      editions: 'true',
    })
  }
  for (const tag of ['Ambient', 'pop', 'Electronica', 'Hidden Noise'])
    await run.query(albums, { tag })

  const films = routesOf('film')
  for (const includeArchived of [undefined, 'true', 'false']) {
    await run.pages(films.page, { includeArchived, sortBy: 'title' }, 2)
    await run.query(films, { includeArchived, q: 'noir' })
  }
  for (const creatorId of ['artist-delta', 'artist-jade', 'artist-echo'])
    for (const creatorRole of [undefined, 'director', 'actor', 'writer'])
      await run.query(films, { creatorId, creatorRole })
  for (const tag of ['Noir', 'Drama', 'Hidden Film'])
    await run.query(films, { tag })
  for (const sourceKind of ['plex', 'none'])
    await run.query(films, { sourceKind })
  // The API rejects listening controls on Films.
  await run.query(films, {
    listening: { match: 'all', rules: [{ period: { kind: 'all' }, min: 1 }] },
  })
}

async function artistSpecifics(run: ParityRunner) {
  const artists = routesOf('artist')
  for (const playlistIds of [
    ['playlist-morning'],
    ['playlist-picks', 'playlist-weekly'],
    ['playlist-missing'],
  ]) {
    await run.query(artists, { playlistIds })
    await run.read(
      apiPath('artists/listening-histogram', {
        playlistIds,
        period: { kind: 'all' },
      }),
    )
  }
  // A Provider filter other than exclude adds per-request links to items.
  for (const mode of [undefined, 'required', 'exclude'])
    await run.query(artists, {
      filters: [{ field: 'provider', value: 'lastfm', mode }],
    })
}

const playlistSorts = [
  'name',
  'source',
  'owner',
  'tracks',
  'linkedTracks',
  'albums',
  'duration',
  'imported',
  'schedule',
  'checked',
  'added',
  'description',
  'nextSync',
]

async function playlistMatrix(run: ParityRunner, reduced: boolean) {
  const sourceSets = [
    undefined,
    ['library'],
    ['spotify'],
    ['spotify-liked'],
    ['library', 'spotify-liked'],
    ['library', 'spotify', 'spotify-liked'],
  ]
  for (const sortBy of playlistSorts)
    for (const direction of reduced ? ['asc' as const] : directions)
      for (const sources of reduced ? sourceSets.slice(0, 3) : sourceSets) {
        await run.pages(
          'playlists/browse-page',
          { sortBy, direction, sources },
          2,
        )
        await run.read(apiPath('playlists/browse-count', { sortBy, sources }))
      }
  const filters: Params[] = [
    { q: 'mix' },
    { q: 'MIX' },
    { q: 'owner' },
    { q: 'found' },
    { q: '%' },
    { q: '_' },
    { q: 'ëmpty' },
    { name: 'picks' },
    { name: 'weekly', q: 'found' },
    { ids: ['playlist-morning', 'playlist-weekly'] },
    { ids: ['playlist-missing'] },
    { acceptsAdditions: 'true' },
    { acceptsAdditions: 'false' },
    { acceptsAdditions: 'true', sources: ['spotify'] },
    { size: 1 },
    { libraryScope: 'all' },
  ]
  for (const params of filters) {
    await run.read(apiPath('playlists/browse-page', params))
    await run.read(apiPath('playlists/browse-count', params))
  }
}

describe('device parity', () => {
  it('maps no read for paths outside LibrarySource', () => {
    for (const path of unresolvedPaths)
      expect(unresolved(path), path).toBe(true)
  })

  it('serves the field lists as the API lists them', async () => {
    const run = new ParityRunner(currentStore())
    for (const routes of libraries) await run.read(apiPath(routes.fields))
    expectParity(run, 'fields')
    const fields = z
      .array(z.object({ key: z.string() }))
      .parse(await apiFieldKeys('albums/fields'))
      .map((field) => field.key)
    expect(fields).toEqual(
      expect.arrayContaining(['fixtureMood', 'fixtureScore', 'fixtureCode']),
    )
  })

  it('facets from the live query, before a vocabulary is built', async () => {
    const ready = async () =>
      z.object({ ready: z.boolean() }).parse(
        (
          await parityPool.query(`select coalesce((select bool_or(ready) from track_facet_state), false)
              or coalesce((select bool_or(ready) from album_facet_state), false) as ready`)
        ).rows[0],
      ).ready
    expect(await ready()).toBe(false)
    const run = new ParityRunner(currentStore())
    // Words of three or more letters are selective: the service reads live rows.
    for (const routes of libraries)
      for (const q of [
        'pop',
        'dream pop',
        'rock',
        'aster vale',
        'orbit',
        'noir',
      ])
        for (const tagLevels of routes.tagLevels
          ? [undefined, ['album'], ['track', 'artist']]
          : [undefined])
          await run.read(
            apiPath(routes.facets, { q, tagLevels, limitPerField: 5 }),
          )
    expect(await ready()).toBe(false)
    expectParity(run, 'live facets')
  })

  it('reads the clock once per read', async () => {
    const { createDeviceLibrarySource, resolveLibraryRead } =
      await import('@repo/library-source')
    let reads = 0
    const source = createDeviceLibrarySource(currentStore().driver, {
      now: () => {
        reads += 1
        return new Date()
      },
    })
    const period = { kind: 'rolling', amount: 1, unit: 'years' }
    for (const path of [
      apiPath('tracks/browse-page', {
        listening: { match: 'all', rules: [{ period, min: 1 }] },
        sortBy: 'listeningScrobbles',
        listeningSort: period,
        groupRecordings: true,
      }),
      apiPath('albums/listening-histogram', { period }),
      apiPath('artists/browse-page', {
        listening: { match: 'any', rules: [{ period, min: 1 }] },
      }),
    ]) {
      const read = resolveLibraryRead(path)
      if (read === undefined) throw new Error(`${path} maps no read`)
      reads = 0
      const result = await readDevice(source, read)
      expect(result.served, path).toBe(true)
      expect(reads, path).toBe(1)
    }
  })

  it('Tracks', { timeout: 900_000 }, async () => {
    const run = new ParityRunner(currentStore())
    await runLibraryMatrix(run, routesOf('track'), {
      reduced: false,
      extraValues,
    })
    await trackSpecifics(run, false)
    const ids = (params: Params) => trackIds(run, params)
    // The fixture holds a redundant Last.fm placeholder: hidden by default,
    // listed under the Last.fm source.
    expect(await ids({ q: 'hum' })).not.toContain('track-hum-lastfm')
    expect(
      await ids({ filters: [{ field: 'source', value: 'Last.fm' }] }),
    ).toContain('track-hum-lastfm')
    // Only a track outside the library holds Shoegaze from Sonovault, so
    // Drift C, with a tag of its own, does not inherit it from its artist
    // at Auto. The device serves that from the tag row.
    const holders =
      await parityPool.query(`select tt.media_item_id, mi.in_library
      from track_tag tt join media_item mi on mi.id = tt.media_item_id
      where tt.tag_id = 'tag-shoegaze' and tt.in_browse and tt.sonovault`)
    expect(holders.rows).toEqual([
      { media_item_id: 'track-outside', in_library: false },
    ])
    const shoegaze = [{ field: 'genre', value: 'Shoegaze' }]
    expect(await ids({ filters: shoegaze })).not.toContain('track-drift-c')
    expect(await ids({ filters: shoegaze, tagLevels: ['artist'] })).toContain(
      'track-drift-c',
    )
    for (const params of [
      { filters: shoegaze },
      { filters: shoegaze, tagLevels: ['artist'] },
    ])
      expect(
        (await run.read(apiPath('tracks/browse-count', params)))?.outcome,
      ).toEqual({ kind: 'served' })
    for (const q of [undefined, 'shoegaze', 'rock', 'drone'])
      expect(
        (await run.read(apiPath('tracks/facets', { q })))?.outcome,
        q,
      ).toEqual({ kind: 'served' })
    expectParity(run, 'Tracks')
  })

  it('Albums and Films', { timeout: 900_000 }, async () => {
    const run = new ParityRunner(currentStore())
    await runLibraryMatrix(run, routesOf('album'), {
      reduced: false,
      extraValues,
    })
    await runLibraryMatrix(run, routesOf('film'), {
      reduced: false,
      extraValues,
    })
    await mediaSpecifics(run, false)
    expectParity(run, 'Albums and Films')
  })

  it('Artists and Playlists', { timeout: 900_000 }, async () => {
    const run = new ParityRunner(currentStore())
    await runLibraryMatrix(run, routesOf('artist'), {
      reduced: false,
      extraValues,
    })
    await artistSpecifics(run)
    await playlistMatrix(run, false)
    expectParity(run, 'Artists and Playlists')
  })

  it('facets from the stored vocabularies', { timeout: 300_000 }, async () => {
    const {
      refreshAlbumFacetVocabularyForMaintenance,
      refreshTrackFacetVocabularyForMaintenance,
    } = await import('@/services/browse')
    await refreshTrackFacetVocabularyForMaintenance()
    await refreshAlbumFacetVocabularyForMaintenance()
    const run = new ParityRunner(currentStore())
    for (const routes of libraries)
      for (const q of [undefined, 'a', 'pop', 'dream pop'])
        for (const limitPerField of [1, 25])
          for (const tagLevels of routes.tagLevels ? tagLocations : [undefined])
            await run.read(
              apiPath(routes.facets, { q, limitPerField, tagLevels }),
            )
    expectParity(run, 'stored facet vocabularies')
  })

  it('leaves a field the store has not synced to the API', async () => {
    const { resolveLibraryRead } = await import('@repo/library-source')
    fixture.lateField = true
    try {
      for (const path of [
        apiPath('albums/browse-page', {
          filters: [{ field: 'fixtureLate', value: 'x' }],
        }),
        apiPath('films/browse-count', { sortBy: 'fixtureLate' }),
      ]) {
        const read = resolveLibraryRead(path)
        if (read === undefined) throw new Error(`${path} maps no read`)
        const result = await readDevice(currentStore().source, read)
        // The device judges a query by the field list it synced, which
        // does not have the field yet: as the API would reject it there.
        expect(result, path).toEqual({ served: false, reason: 'invalid-query' })
        expect((await apiRequest(path)).status, path).toBe(200)
      }
    } finally {
      fixture.lateField = false
    }
  })

  it(
    'still holds after edits and a sync of the changes',
    { timeout: 900_000 },
    async () => {
      await applyEdits()
      await renderMarks()
      const synced = await syncParityStore(currentStore())
      expect(synced).toMatchObject({ status: 'synced', refilled: false })
      const run = new ParityRunner(currentStore())
      await run.refreshFacts()
      for (const routes of libraries)
        await runLibraryMatrix(run, routes, { reduced: true, extraValues })
      await trackSpecifics(run, true)
      await mediaSpecifics(run, true)
      await playlistMatrix(run, true)
      for (const period of listeningPeriods.slice(0, 4))
        await run.read(apiPath('artists/listening-histogram', { period }))
      // Only Liked One, now outside the library, holds Dream Pop from
      // Sonovault: Orbit Song, with tags of its own, no longer inherits it
      // from its album at Auto.
      const dreamPop = [{ field: 'genre', value: 'Dream Pop' }]
      expect(await trackIds(run, { filters: dreamPop })).not.toContain(
        'track-orbit-a',
      )
      expect(
        await trackIds(run, { filters: dreamPop, tagLevels: ['album'] }),
      ).toContain('track-orbit-a')
      for (const q of [undefined, 'dream', 'shoegaze'])
        expect(
          (await run.read(apiPath('tracks/facets', { q })))?.outcome,
          q,
        ).toEqual({ kind: 'served' })
      expectParity(run, 'after edits')
    },
  )
})

/** The IDs of the first 50 tracks of a Browse query, read through the runner. */
async function trackIds(run: ParityRunner, params: Params) {
  const result = await run.read(
    apiPath('tracks/browse-page', { ...params, size: 50 }),
  )
  return z
    .object({ items: z.array(z.object({ id: z.string() })) })
    .parse(result?.data)
    .items.map((item) => item.id)
}

async function apiFieldKeys(route: string): Promise<unknown> {
  const response = await apiRequest(apiPath(route))
  return z.object({ data: z.unknown() }).parse(await response.json()).data
}

const query = (statement: string, values: unknown[] = []) =>
  parityPool.query(statement, values).then(() => undefined)

/** The edits of device-feed-end-to-end.integration.ts, through the services and routes. */
async function applyEdits() {
  // A title edit, of a track and of an album.
  await query(
    "update media_item set title = 'Bright Water (Remaster)' where id = 'track-bright'",
  )
  await apiSend('PATCH', '/api/v1/albums/album-quiet', {
    title: 'Quiet Fields Revisited',
  })
  // A tag rename and re-parent.
  await query("update tag set name = 'Ambient Works' where id = 'tag-ambient'")
  await apiSend('POST', '/api/v1/tags/parents', {
    mediaType: 'album',
    tagIds: ['tag-synth'],
    parentIds: ['tag-electronic'],
    mode: 'replace',
  })
  await apiSend('POST', '/api/v1/tracks/track-cold/tags', { tagId: 'tag-pop' })
  // An artist merge.
  await apiSend('POST', '/api/v1/library-changes/artist-merges', {
    artistIds: ['artist-cedar', 'artist-aster'],
    targetId: 'artist-aster',
    follow: false,
    reviewed: true,
  })
  // A playlist change.
  await query(`insert into playlist_item (playlist_id, media_item_id, position)
    values ('playlist-morning', 'track-echo', 9)`)
  await query(
    "update playlist set name = 'Early Mix' where id = 'playlist-morning'",
  )
  // New scrobbles, recounted as a sync does.
  await query(`insert into lastfm_scrobble (id, username, listened_at, artist_name, track_name, artist_key, track_key, album_media_item_id)
    values ('scrobble-edit-1', 'fixture-listener', '2026-03-30 00:00:00', 'Kite', 'Drift', 'kite', 'drift', 'album-ridge'),
      ('scrobble-edit-2', 'fixture-listener', '2026-03-31 11:59:59', 'Aster Vale', 'Aurora', 'aster vale', 'aurora', null)`)
  const { refreshTrackLinks } = await import('@/services/track-links')
  await refreshTrackLinks('fixture-listener', 'sync')
  // An archive and a delete.
  await query(`update media_item set metadata = metadata || '{"legacyHidden": "true"}'
    where id in ('film-lagoon', 'track-orbit-b')`)
  await query(`begin;
    delete from track where track_media_item_id = 'track-hum-b';
    delete from media_item where id in ('track-hum-b', 'film-moth');
    commit`)
  // A track leaves the library and gains a Sonovault tag.
  await query(
    "update media_item set in_library = false where id = 'track-liked'",
  )
  await query(`insert into track_tag (media_item_id, tag_id, owner, sonovault, verified)
    values ('track-liked', 'tag-dream', null, true, true)`)
}
