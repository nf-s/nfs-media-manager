import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CreateLibraryPlaylistSchema,
  LibraryPlaylistSelectionSchema,
  type LibraryPlaylistLibrary,
} from '@repo/schemas/library-playlists'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { SubscriptionItemQuerySchema } from '@repo/schemas/subscriptions'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

// PL-18 on the shared fixture of 20,000 synthetic tracks and 1,000 albums,
// with three films, three videos and two mixes added below. Tracks 18001 to
// 19000 are second releases of tracks 1 to 1000. Every name is invented.
const { database, pool } = createTrackPerformanceFixture()
vi.mock('@/lib/db', () => ({
  get db() {
    return database
  },
}))
vi.mock('@/plugins/registry', () => ({
  listLoadedScrapePlugins: async () => [],
}))

const CHANNEL = `UC${'synthetic'.padEnd(22, '0')}`
const SHOW = 'nts.synthetic-show'

type Mode = 'any' | 'required' | 'exclude'
type Filter = { field: string; value: string; mode?: Mode }

const inPlaylist = (value: string, mode: Mode = 'any'): Filter => ({
  field: 'libraryPlaylist',
  value,
  mode,
})

const playlists: Record<string, string> = {}

async function create(
  library: LibraryPlaylistLibrary,
  name: string,
  ids: string[],
  duplicates: 'skip' | 'again' = 'again',
) {
  const { createLibraryPlaylist, addLibraryPlaylistEntries } =
    await import('@/services/library-playlists')
  const { playlist } = await createLibraryPlaylist(
    CreateLibraryPlaylistSchema.parse({ type: 'playlist', library, name }),
    'owner',
  )
  // One item at a time, so a repeated ID adds a second entry.
  for (const id of ids)
    await addLibraryPlaylistEntries(
      playlist.id,
      LibraryPlaylistSelectionSchema.parse({ ids: [id] }),
      duplicates,
    )
  return playlist.id
}

/** A Browse page of up to 100 rows and the exact count of the same query. */
async function browse(
  library: LibraryPlaylistLibrary,
  input: Record<string, unknown> & { filters?: Filter[] },
) {
  const query = {
    ...input,
    size: 100,
    filters: JSON.stringify(input.filters ?? []),
  }
  if (library === 'subscriptions' || library === 'mixes') {
    const { countSubscriptionBrowseItems, listSubscriptionBrowsePage } =
      await import('@/services/subscription-library')
    const parsed = SubscriptionItemQuerySchema.parse({ ...query, library })
    const page = await listSubscriptionBrowsePage(parsed)
    const { totalCount } = await countSubscriptionBrowseItems(parsed)
    return { ids: page.items.map((item) => item.id), count: totalCount }
  }
  const { queryBrowseCount, queryBrowsePageIds } =
    await import('@/services/browse')
  const [mediaType, parsed] =
    library === 'tracks'
      ? (['track', TrackQuerySchema.parse(query)] as const)
      : library === 'albums'
        ? (['album', AlbumQuerySchema.parse(query)] as const)
        : (['film', FilmQuerySchema.parse(query)] as const)
  const page = await queryBrowsePageIds(mediaType, parsed)
  const { totalCount } = await queryBrowseCount(mediaType, parsed)
  return { ids: page.ids, count: totalCount }
}

const sorted = (ids: string[]) => [...ids].sort()

beforeAll(async () => {
  await pool.query(`
    insert into "user" (id, name, email) values ('owner', 'Owner', 'owner@example.test');
    insert into media_item (id, slug, media_type, title, release_date)
    select 'film-' || n, 'film-' || n, 'film', 'Synthetic film ' || n,
      timestamp '2001-01-01' + n * interval '1 year'
    from generate_series(1, 3) n;
    insert into film (media_item_id) select id from media_item where media_type = 'film';
    insert into subscription_source (id, type, title) values
      ('${CHANNEL}', 'youtube', 'Synthetic channel'),
      ('${SHOW}', 'nts', 'Synthetic show');
    insert into subscription_item (id, source_id, type, title, artists, published_at, duration_sec, search)
    select v.id, v.source_id, v.type, v.title, v.artists::jsonb, v.published_at::timestamp, 600,
      to_tsvector('simple', v.title)
    from (values
      ('synthvid001', '${CHANNEL}', 'youtube', 'Synthetic video one', '[]', '2026-01-01'),
      ('synthvid002', '${CHANNEL}', 'youtube', 'Synthetic video two', '[]', '2026-01-02'),
      ('synthvid003', '${CHANNEL}', 'youtube', 'Synthetic video three', '[]', '2026-01-03'),
      ('${SHOW}-1', '${SHOW}', 'nts', 'Synthetic mix one', '["Synthetic DJ"]', '2026-02-01'),
      ('${SHOW}-2', '${SHOW}', 'nts', 'Synthetic mix two', '["Synthetic DJ"]', '2026-02-02')
    ) v(id, source_id, type, title, artists, published_at);
    insert into playlist (id, name, kind, added_to_library) values
      ('imported-same', 'Imported same', 'playlist', true),
      ('imported-other', 'Imported other', 'playlist', true);
    insert into playlist_item (playlist_id, media_item_id, position) values
      ('imported-same', 'track-3', 1), ('imported-same', 'track-5', 2),
      ('imported-same', 'track-18005', 3), ('imported-same', 'track-19995', 4),
      ('imported-other', 'track-9', 1);
  `)
  // track-5 twice, a removed entry, and a second release of track-5's recording.
  playlists.tracks = await create('tracks', 'Night', [
    'track-5',
    'track-3',
    'track-5',
    'track-7',
    'track-18005',
    'track-19995',
  ])
  const { removeLibraryPlaylistEntries, listLibraryPlaylistEntries } =
    await import('@/services/library-playlists')
  const entries = await listLibraryPlaylistEntries(playlists.tracks, {
    page: 1,
    size: 100,
  })
  const removed = entries.items.find((entry) => entry.item.id === 'track-7')
  if (!removed) throw new Error('The fixture entry is missing')
  await removeLibraryPlaylistEntries(playlists.tracks, {
    entryIds: [removed.id],
  })
  playlists.albums = await create('albums', 'Albums', [
    'album-2',
    'album-1',
    'album-2',
  ])
  playlists.films = await create('films', 'Films', ['film-1', 'film-3'])
  playlists.subscriptions = await create('subscriptions', 'Videos', [
    'synthvid001',
    'synthvid003',
    'synthvid001',
  ])
  playlists.mixes = await create('mixes', 'Mixes', [`${SHOW}-2`])
  const { createLibraryPlaylist, deleteLibraryPlaylist } =
    await import('@/services/library-playlists')
  playlists.deleted = await create('tracks', 'Gone', ['track-9'])
  await deleteLibraryPlaylist(playlists.deleted)
  playlists.smart = (
    await createLibraryPlaylist(
      CreateLibraryPlaylistSchema.parse({
        type: 'smart',
        library: 'tracks',
        name: 'Smart',
        view: { q: 'Quicksilver' },
      }),
      'owner',
    )
  ).playlist.id
}, 120_000)

const id = (key: string) => {
  const value = playlists[key]
  if (value === undefined) throw new Error(`No ${key} playlist`)
  return value
}

const members: Record<LibraryPlaylistLibrary, string[]> = {
  tracks: ['track-3', 'track-5', 'track-18005', 'track-19995'],
  albums: ['album-1', 'album-2'],
  films: ['film-1', 'film-3'],
  subscriptions: ['synthvid001', 'synthvid003'],
  mixes: [`${SHOW}-2`],
}
const libraries = Object.keys(members).filter(
  (library): library is LibraryPlaylistLibrary => library in members,
)

describe('Browse filter on a library playlist', () => {
  it('matches listed entries once in every library and mode', async () => {
    for (const library of libraries) {
      const all = await browse(library, {})
      for (const mode of ['any', 'required'] as const) {
        const result = await browse(library, {
          filters: [inPlaylist(id(library), mode)],
        })
        expect(sorted(result.ids), `${library} ${mode}`).toEqual(
          sorted(members[library]),
        )
        expect(result.count, `${library} ${mode} count`).toBe(
          members[library].length,
        )
      }
      const excluded = await browse(library, {
        filters: [inPlaylist(id(library), 'exclude')],
      })
      expect(excluded.count, `${library} exclude count`).toBe(
        all.count - members[library].length,
      )
      expect(
        excluded.ids.filter((item) => members[library].includes(item)),
        `${library} exclude`,
      ).toEqual([])
    }
  })

  it('orders Track Title and Added pages and agrees with positions and selections', async () => {
    const { queryBrowsePositions } = await import('@/services/browse')
    const { resolveLibraryPlaylistSelection } =
      await import('@/services/library-playlist-selection')
    const added = await browse('tracks', {
      sortBy: 'dateAdded',
      direction: 'desc',
      filters: [inPlaylist(id('tracks'))],
    })
    expect(added.ids).toEqual([
      'track-19995',
      'track-18005',
      'track-5',
      'track-3',
    ])
    const title = await browse('tracks', {
      sortBy: 'title',
      direction: 'asc',
      filters: [inPlaylist(id('tracks'), 'required')],
    })
    expect(title.ids[0]).toBe('track-3')
    expect(title.ids.at(-1)).toBe('track-19995')
    expect(title.count).toBe(4)
    const query = TrackQuerySchema.parse({
      sortBy: 'title',
      direction: 'asc',
      filters: JSON.stringify([inPlaylist(id('tracks'), 'required')]),
    })
    expect(
      (await queryBrowsePositions('track', query, [0, 3])).map((row) => row.id),
    ).toEqual([title.ids[0], title.ids[3]])
    const excludedTitle = await browse('tracks', {
      sortBy: 'title',
      direction: 'asc',
      filters: [inPlaylist(id('tracks'), 'exclude')],
    })
    expect(excludedTitle.ids).not.toContain('track-3')
    expect(excludedTitle.ids).toHaveLength(100)
    expect(
      await resolveLibraryPlaylistSelection(
        'tracks',
        LibraryPlaylistSelectionSchema.parse({
          query: {
            sortBy: 'dateAdded',
            filters: JSON.stringify([inPlaylist(id('tracks'))]),
          },
          excludeIds: ['track-5'],
        }),
      ),
    ).toEqual(['track-19995', 'track-18005', 'track-3'])
  })

  it('groups recordings as the imported playlist filter does', async () => {
    for (const mode of ['any', 'required', 'exclude'] as const)
      for (const sortBy of ['dateAdded', 'title', 'scrobbles']) {
        const label = `${mode} ${sortBy}`
        const library = await browse('tracks', {
          groupRecordings: 'true',
          sortBy,
          filters: [inPlaylist(id('tracks'), mode)],
        })
        const imported = await browse('tracks', {
          groupRecordings: 'true',
          sortBy,
          filters: [{ field: 'playlist', value: 'Imported same', mode }],
        })
        expect(library, label).toEqual(imported)
      }
    // track-5 and track-18005 are one recording.
    const grouped = await browse('tracks', {
      groupRecordings: 'true',
      filters: [inPlaylist(id('tracks'))],
    })
    expect(grouped.count).toBe(3)
    // Not the playlist-only path: with another filter.
    const withTitle = {
      groupRecordings: 'true',
      filters: [
        inPlaylist(id('tracks'), 'required'),
        { field: 'title', value: 'Fixture track 00005', mode: 'required' },
      ],
    }
    const withImported = {
      groupRecordings: 'true',
      filters: [
        { field: 'playlist', value: 'Imported same', mode: 'required' },
        { field: 'title', value: 'Fixture track 00005', mode: 'required' },
      ],
    }
    expect(await browse('tracks', withTitle)).toEqual(
      await browse('tracks', withImported),
    )
  })

  it('combines with other filters and a search', async () => {
    const either = await browse('tracks', {
      filters: [
        inPlaylist(id('tracks')),
        { field: 'playlist', value: 'Imported other' },
      ],
    })
    expect(sorted(either.ids)).toEqual(sorted([...members.tracks, 'track-9']))
    expect(either.count).toBe(5)
    const both = await browse('tracks', {
      sortBy: 'title',
      direction: 'asc',
      filters: [
        inPlaylist(id('tracks'), 'required'),
        { field: 'title', value: 'Fixture track 00005', mode: 'required' },
      ],
    })
    expect(sorted(both.ids)).toEqual(['track-18005', 'track-5'])
    expect(both.count).toBe(2)
    const searched = await browse('tracks', {
      q: 'Quicksilver',
      filters: [inPlaylist(id('tracks'), 'required')],
    })
    expect(searched).toEqual({ ids: ['track-19995'], count: 1 })
    const searchedOut = await browse('tracks', {
      q: 'Quicksilver',
      filters: [inPlaylist(id('tracks'), 'exclude')],
    })
    expect(searchedOut.count).toBe(9)
    const albums = await browse('albums', {
      q: 'Fixture album 1',
      sortBy: 'title',
      direction: 'asc',
      filters: [inPlaylist(id('albums'), 'exclude')],
    })
    expect(albums.ids).not.toContain('album-1')
    expect(albums.ids).toContain('album-10')
    const videos = await browse('subscriptions', {
      q: 'three',
      filters: [inPlaylist(id('subscriptions'), 'required')],
    })
    expect(videos).toEqual({ ids: ['synthvid003'], count: 1 })
    const notWatched = await browse('subscriptions', {
      filters: [
        inPlaylist(id('subscriptions'), 'required'),
        { field: 'watched', value: 'No', mode: 'required' },
      ],
    })
    expect(sorted(notWatched.ids)).toEqual(members.subscriptions)
  })

  it('ignores playlists of another library, smart, deleted and unknown IDs', async () => {
    const cases: Array<[LibraryPlaylistLibrary, string]> = [
      ['tracks', 'albums'],
      ['albums', 'tracks'],
      ['films', 'tracks'],
      ['subscriptions', 'mixes'],
      ['mixes', 'subscriptions'],
      ['tracks', 'smart'],
      ['tracks', 'deleted'],
    ]
    for (const [library, key] of [
      ...cases,
      ...libraries.map((library): [LibraryPlaylistLibrary, string] => [
        library,
        'unknown',
      ]),
    ]) {
      const value = key === 'unknown' ? 'no-such-playlist' : id(key)
      const all = await browse(library, {})
      for (const mode of ['any', 'required'] as const)
        expect(
          await browse(library, { filters: [inPlaylist(value, mode)] }),
          `${library} ${key} ${mode}`,
        ).toEqual({ ids: [], count: 0 })
      expect(
        await browse(library, { filters: [inPlaylist(value, 'exclude')] }),
        `${library} ${key} exclude`,
      ).toEqual(all)
    }
  })

  it('is accepted in every library query and not as a field', () => {
    const filters = JSON.stringify([inPlaylist('any-id')])
    for (const library of ['subscriptions', 'mixes'] as const)
      expect(
        SubscriptionItemQuerySchema.parse({ library, filters }).filters,
      ).toEqual([inPlaylist('any-id')])
    expect(TrackQuerySchema.parse({ filters }).filters).toHaveLength(1)
    expect(AlbumQuerySchema.parse({ filters }).filters).toHaveLength(1)
    expect(FilmQuerySchema.parse({ filters }).filters).toHaveLength(1)
    expect(
      SubscriptionItemQuerySchema.safeParse({
        library: 'mixes',
        filters: JSON.stringify([{ field: 'live', value: 'Live' }]),
      }).success,
    ).toBe(false)
  })
})
