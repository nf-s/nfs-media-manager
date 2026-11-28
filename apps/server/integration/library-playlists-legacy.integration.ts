import { beforeAll, expect, it, vi } from 'vitest'
import { CreateLibraryPlaylistSchema } from '@repo/schemas/library-playlists'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

const { database, pool } = createTrackPerformanceFixture()
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

// Invented saved views in the legacy smart-playlist format. The older
// snapshot must be ignored; the last view does not convert.
const views = [
  {
    name: 'Quiet evenings',
    filters: [
      { field: 'genres', value: 'Ambient', intersection: true },
      { field: 'artists', value: 'Fixture artist 1', exclude: true },
      { field: 'dateReleased', min: 0, max: 100, includeUndefined: true },
    ],
    sort: ['title', 'ASC'],
    limit: 50,
  },
  { name: 'Taken name', filters: [], sort: ['dateAdded', 'DESC'] },
  { name: 'Morning Commute', filters: [], sort: ['dateAdded', 'DESC'] },
  { name: 'Broken', filters: 'not a list' },
]

beforeAll(async () => {
  await pool.query(
    `insert into provider_snapshot (id, provider, checksum, payload, source, created_at)
    values ('older', 'legacy-smart-playlists', 'older', $1, 'legacy-import:smart-playlists.json', now() - interval '1 day'),
      ('newer', 'legacy-smart-playlists', 'newer', $2, 'legacy-import:smart-playlists.json', now());
    `,
    [
      JSON.stringify([
        { name: 'Older view', filters: [], sort: ['title', 'ASC'] },
      ]),
      JSON.stringify(views),
    ],
  )
  await pool.query(`insert into playlist (id, name, kind, source, spotify_id)
    values ('imported-1', 'Morning Commute', 'playlist', 'spotify', 'imported1')`)
})

it('inserts legacy saved views once as Albums smart playlists', async () => {
  const {
    createLibraryPlaylist,
    deleteLibraryPlaylist,
    listLibraryPlaylists,
    restoreLibraryPlaylist,
  } = await import('@/services/library-playlists')
  const { insertLegacySavedViews } =
    await import('@/services/library-playlist-legacy-views')
  await createLibraryPlaylist(
    CreateLibraryPlaylistSchema.parse({
      type: 'playlist',
      library: 'albums',
      name: 'taken NAME',
    }),
    null,
  )
  // Tracks playlists are not read as smart playlists and insert nothing.
  await listLibraryPlaylists({ library: 'tracks', page: 1, size: 25 })
  expect(
    (
      await pool.query(
        `select count(*)::int as count from library_playlist where legacy_key is not null`,
      )
    ).rows[0],
  ).toEqual({ count: 0 })

  const first = await listLibraryPlaylists({
    library: 'albums',
    type: 'smart',
    page: 1,
    size: 25,
  })
  expect(first.items.map((row) => [row.name, row.view])).toEqual([
    ['Morning Commute 2', { sortBy: 'dateAdded', direction: 'desc' }],
    [
      'Quiet evenings',
      {
        filters: JSON.stringify([
          { field: 'genre', value: 'Ambient', mode: 'required' },
          { field: 'artist', value: 'Fixture artist 1', mode: 'exclude' },
        ]),
        ranges: JSON.stringify([
          { field: 'releaseDate', min: 0, max: 100, includeMissing: true },
        ]),
        sortBy: 'title',
        direction: 'asc',
        limitResults: '50',
      },
    ],
    ['Taken name 2', { sortBy: 'dateAdded', direction: 'desc' }],
  ])
  const legacyKeys = await pool.query<{ name: string; legacy_key: string }>(
    `select name, legacy_key from library_playlist where legacy_key is not null order by name`,
  )
  expect(legacyKeys.rows).toEqual([
    { name: 'Morning Commute 2', legacy_key: 'Morning Commute' },
    { name: 'Quiet evenings', legacy_key: 'Quiet evenings' },
    { name: 'Taken name 2', legacy_key: 'Taken name' },
  ])

  expect(await insertLegacySavedViews()).toBe(0)
  const quiet = first.items.find((row) => row.name === 'Quiet evenings')
  if (!quiet) throw new Error('Quiet evenings was not inserted')
  await deleteLibraryPlaylist(quiet.id)
  expect(await insertLegacySavedViews()).toBe(0)
  // Kept as a record of the deletion after the 24-hour purge.
  await pool.query(
    `update library_playlist set deleted_at = now() - interval '25 hours' where id = $1`,
    [quiet.id],
  )
  await createLibraryPlaylist(
    CreateLibraryPlaylistSchema.parse({
      type: 'playlist',
      library: 'albums',
      name: 'Another',
    }),
    null,
  )
  expect(await insertLegacySavedViews()).toBe(0)
  const smart = await listLibraryPlaylists({
    library: 'albums',
    type: 'smart',
    page: 1,
    size: 25,
  })
  expect(smart.items.map((row) => row.name)).toEqual([
    'Morning Commute 2',
    'Taken name 2',
  ])
  expect((await restoreLibraryPlaylist(quiet.id)).name).toBe('Quiet evenings')
})
