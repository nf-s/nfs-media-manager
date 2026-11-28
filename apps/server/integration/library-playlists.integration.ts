import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CreateLibraryPlaylistSchema,
  LibraryPlaylistSelectionSchema,
  parseLibraryBrowseView,
  type LibraryPlaylistLibrary,
  type LibraryPlaylistSelection,
} from '@repo/schemas/library-playlists'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import { SubscriptionItemQuerySchema } from '@repo/schemas/subscriptions'
import { TrackQuerySchema } from '@repo/schemas/tracks'
import { createTrackPerformanceFixture } from './fixtures/track-performance'

// 20,000 synthetic tracks and 1,000 albums from the shared fixture, with three
// films, three videos and two mixes added below. Every name is invented.
const { database, pool, logQuery } = createTrackPerformanceFixture()
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

beforeAll(async () => {
  await pool.query(`
    insert into "user" (id, name, email) values ('owner', 'Owner', 'owner@example.test');
    insert into media_item (id, slug, media_type, title, release_date)
    select 'film-' || n, 'film-' || n, 'film', 'Synthetic film ' || n,
      timestamp '2001-01-01' + n * interval '1 year'
    from generate_series(1, 3) n;
    insert into film (media_item_id) select id from media_item where media_type = 'film';
    insert into media_credit (media_item_id, artist_id, role) values ('film-1', 'artist-7', 'director');
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
    insert into playlist (id, name, kind, source, spotify_id)
    values ('imported-1', 'Morning Commute', 'playlist', 'spotify', 'imported1');
  `)
})

async function service() {
  return import('@/services/library-playlists')
}

async function create(
  library: LibraryPlaylistLibrary,
  name: string,
  selection?: LibraryPlaylistSelection,
) {
  const { createLibraryPlaylist } = await service()
  return createLibraryPlaylist(
    CreateLibraryPlaylistSchema.parse({
      type: 'playlist',
      library,
      name,
      ...(selection ? { selection } : {}),
    }),
    'owner',
  )
}

const ids = (...values: string[]) =>
  LibraryPlaylistSelectionSchema.parse({ ids: values })
const matching = (query: Record<string, string>, excludeIds: string[] = []) =>
  LibraryPlaylistSelectionSchema.parse({ query, excludeIds })

async function add(
  id: string,
  selection: LibraryPlaylistSelection,
  duplicates: 'skip' | 'again' = 'skip',
) {
  const { addLibraryPlaylistEntries } = await service()
  return addLibraryPlaylistEntries(id, selection, duplicates)
}

async function entryIds(id: string, size = 100) {
  const { listLibraryPlaylistEntries } = await service()
  const page = await listLibraryPlaylistEntries(id, { page: 1, size })
  return page.items.map((entry) => entry.item.id)
}

const status = (code: number) =>
  expect.objectContaining({
    response: expect.objectContaining({ statusCode: code }),
  })

describe('library playlists', () => {
  it('creates, renames, deletes, restores and purges with unique names', async () => {
    const {
      deleteLibraryPlaylist,
      getLibraryPlaylist,
      listLibraryPlaylists,
      restoreLibraryPlaylist,
      updateLibraryPlaylist,
    } = await service()
    const { playlist, addition } = await create('tracks', '  Late shift ')
    expect(addition).toBeNull()
    expect(playlist).toMatchObject({
      library: 'tracks',
      type: 'playlist',
      name: 'Late shift',
      entryCount: 0,
      view: null,
      repeatCount: 0,
    })
    await expect(create('tracks', 'LATE SHIFT')).rejects.toEqual(status(409))
    await expect(create('tracks', 'late shift')).rejects.toThrow(
      'A playlist with this name exists.',
    )
    // Another library, and imported playlists only in Albums and Tracks.
    expect((await create('albums', 'Late shift')).playlist.name).toBe(
      'Late shift',
    )
    await expect(create('tracks', 'morning commute')).rejects.toEqual(
      status(409),
    )
    await expect(create('albums', 'Morning Commute')).rejects.toEqual(
      status(409),
    )
    expect((await create('films', 'Morning Commute')).playlist.name).toBe(
      'Morning Commute',
    )

    const other = (await create('tracks', 'Early shift')).playlist
    await expect(
      updateLibraryPlaylist(other.id, { name: 'late Shift' }),
    ).rejects.toEqual(status(409))
    await pool.query(
      `update library_playlist set updated_at = updated_at - interval '1 hour' where id = $1`,
      [other.id],
    )
    const renamed = await updateLibraryPlaylist(other.id, { name: 'Dawn' })
    expect(renamed.name).toBe('Dawn')
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(
      Date.parse(other.updatedAt),
    )
    // A rename that only changes case keeps its own name.
    expect((await updateLibraryPlaylist(other.id, { name: 'DAWN' })).name).toBe(
      'DAWN',
    )
    await expect(
      updateLibraryPlaylist(other.id, { view: { q: 'x' } }),
    ).rejects.toEqual(status(422))

    const deleted = await deleteLibraryPlaylist(playlist.id)
    expect(deleted.name).toBe('Late shift')
    await expect(getLibraryPlaylist(playlist.id)).rejects.toEqual(status(404))
    const listed = await listLibraryPlaylists({
      library: 'tracks',
      page: 1,
      size: 25,
    })
    expect(listed.items.map((row) => row.name)).toEqual(['DAWN'])
    const replacement = (await create('tracks', 'Late Shift')).playlist
    await expect(restoreLibraryPlaylist(playlist.id)).rejects.toEqual(
      status(409),
    )
    await deleteLibraryPlaylist(replacement.id)
    expect((await restoreLibraryPlaylist(playlist.id)).name).toBe('Late shift')
    await expect(restoreLibraryPlaylist(playlist.id)).rejects.toEqual(
      status(404),
    )

    // A write purges what was deleted or removed more than 24 hours ago,
    // except smart playlists made from a legacy saved view.
    await add(playlist.id, ids('track-1', 'track-2'))
    await pool.query(`
      update library_playlist set deleted_at = now() - interval '25 hours' where id = '${replacement.id}';
      insert into library_playlist (id, library, type, name, view, legacy_key, deleted_at)
      values ('legacy-deleted', 'albums', 'smart', 'Old view', '{}', 'Old view', now() - interval '25 hours');
      update library_playlist_entry set removed_batch_id = 'old', removed_at = now() - interval '25 hours'
      where playlist_id = '${playlist.id}' and media_item_id = 'track-2';`)
    await create('tracks', 'Trigger')
    const { rows } = await pool.query<{ id: string }>(
      `select id from library_playlist where id in ($1, 'legacy-deleted') order by id`,
      [replacement.id],
    )
    expect(rows.map((row) => row.id)).toEqual(['legacy-deleted'])
    const entries = await pool.query<{ media_item_id: string }>(
      `select media_item_id from library_playlist_entry where playlist_id = $1`,
      [playlist.id],
    )
    expect(entries.rows.map((row) => row.media_item_id)).toEqual(['track-1'])
  })

  it('adds by IDs and by Browse query in Browse order with exclusions', async () => {
    const { queryBrowsePageIds } = await import('@/services/browse')
    const { querySubscriptionSelectionIds } =
      await import('@/services/subscription-library')
    const browse = async (
      mediaType: 'album' | 'track' | 'film',
      query: Record<string, string>,
    ) => {
      const parsed =
        mediaType === 'track'
          ? TrackQuerySchema.parse({ ...query, size: 100 })
          : mediaType === 'album'
            ? AlbumQuerySchema.parse({ ...query, size: 100 })
            : FilmQuerySchema.parse({ ...query, size: 100 })
      return (await queryBrowsePageIds(mediaType, parsed)).ids
    }

    const byIds = await create(
      'tracks',
      'By IDs',
      ids('track-5', 'track-3', 'track-5'),
    )
    expect(byIds.addition).toMatchObject({ added: 2, skipped: 0, repeated: 0 })
    expect(await entryIds(byIds.playlist.id)).toEqual(['track-5', 'track-3'])

    const ungrouped = { q: 'Quicksilver' }
    const expected = await browse('track', ungrouped)
    expect(expected).toHaveLength(10)
    const tracks = await create(
      'tracks',
      'Quicksilver',
      matching(ungrouped, [expected[1] ?? '']),
    )
    expect(tracks.addition?.added).toBe(9)
    expect(await entryIds(tracks.playlist.id)).toEqual(
      expected.filter((_, index) => index !== 1),
    )

    // Two releases of one recording: one row grouped, two ungrouped.
    const grouped = { groupRecordings: 'true', q: 'Fixture track 00010' }
    const groupedIds = await browse('track', grouped)
    expect(groupedIds).toHaveLength(1)
    expect(await browse('track', { q: 'Fixture track 00010' })).toHaveLength(2)
    const recording = await create('tracks', 'Grouped', matching(grouped))
    expect(await entryIds(recording.playlist.id)).toEqual(groupedIds)

    const albumQuery = {
      q: 'Fixture album 99',
      sortBy: 'title',
      direction: 'asc',
    }
    const albumIds = await browse('album', albumQuery)
    expect(albumIds.length).toBeGreaterThan(1)
    const albums = await create('albums', 'Nineties', matching(albumQuery))
    expect(await entryIds(albums.playlist.id)).toEqual(albumIds)

    const films = await create('films', 'Films', matching({ q: 'Synthetic' }))
    expect(await entryIds(films.playlist.id)).toEqual([
      'film-3',
      'film-2',
      'film-1',
    ])

    const videos = await create(
      'subscriptions',
      'Videos',
      matching({}, ['synthvid002']),
    )
    expect(await entryIds(videos.playlist.id)).toEqual([
      'synthvid003',
      'synthvid001',
    ])
    expect(
      await querySubscriptionSelectionIds(
        SubscriptionItemQuerySchema.parse({ library: 'subscriptions' }),
        10,
      ),
    ).toEqual(['synthvid003', 'synthvid002', 'synthvid001'])
    const mixes = await create(
      'mixes',
      'Mixes',
      matching({
        filters: JSON.stringify([
          { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
        ]),
      }),
    )
    expect(await entryIds(mixes.playlist.id)).toEqual([
      `${SHOW}-2`,
      `${SHOW}-1`,
    ])
  })

  it('resolves and adds a selection in a bounded number of statements', async () => {
    const small = (await create('tracks', 'Bounded small')).playlist
    const large = (await create('tracks', 'Bounded large')).playlist
    logQuery.mockClear()
    expect((await add(small.id, matching({ q: 'Quicksilver' }))).added).toBe(10)
    const smallStatements = logQuery.mock.calls.length
    logQuery.mockClear()
    expect(
      (await add(large.id, matching({ limitResults: '10000' }))).added,
    ).toBe(10_000)
    const largeStatements = logQuery.mock.calls.length
    expect(smallStatements).toBeLessThanOrEqual(8)
    expect(largeStatements).toBeLessThanOrEqual(8)
    logQuery.mockClear()
    const { checkLibraryPlaylistEntries } = await service()
    const check = await checkLibraryPlaylistEntries(
      large.id,
      matching({ limitResults: '10000' }),
    )
    expect(check).toMatchObject({ total: 10_000, present: 10_000 })
    expect(check.sample).toHaveLength(5)
    expect(logQuery.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('rejects a selection of more than 10,000 items', async () => {
    const playlist = (await create('tracks', 'Too many')).playlist
    await expect(add(playlist.id, matching({ q: 'Fixture' }))).rejects.toThrow(
      'The selection holds more than 10,000 items.',
    )
    await expect(
      add(playlist.id, matching({ q: 'Fixture' }), 'again'),
    ).rejects.toEqual(status(422))
    expect(
      LibraryPlaylistSelectionSchema.safeParse({
        ids: Array.from({ length: 10_001 }, (_, index) => `track-${index + 1}`),
      }).success,
    ).toBe(false)
    await expect(
      create('tracks', 'Too many too', matching({ q: 'Fixture' })),
    ).rejects.toEqual(status(422))
    const { getLibraryPlaylist } = await service()
    expect((await getLibraryPlaylist(playlist.id)).entryCount).toBe(0)
  })

  it('reports duplicates, skips or repeats them and undoes an addition', async () => {
    const {
      checkLibraryPlaylistEntries,
      getLibraryPlaylist,
      undoLibraryPlaylistAddition,
    } = await service()
    const { playlist } = await create(
      'tracks',
      'Duplicates',
      ids('track-1', 'track-2', 'track-3'),
    )
    expect(
      await checkLibraryPlaylistEntries(
        playlist.id,
        ids('track-3', 'track-4', 'track-1', 'track-5'),
      ),
    ).toEqual({
      total: 4,
      present: 2,
      sample: [
        {
          id: 'track-3',
          title: 'Fixture track 00003',
          creator: 'Fixture artist 3',
        },
        {
          id: 'track-1',
          title: 'Fixture track 00001',
          creator: 'Fixture artist 1',
        },
      ],
    })
    const skipped = await add(playlist.id, ids('track-1', 'track-6'), 'skip')
    expect(skipped).toMatchObject({ added: 1, skipped: 1, repeated: 0 })
    const again = await add(playlist.id, ids('track-2', 'track-7'), 'again')
    expect(again).toMatchObject({ added: 2, skipped: 0, repeated: 1 })
    expect(await entryIds(playlist.id)).toEqual([
      'track-1',
      'track-2',
      'track-3',
      'track-6',
      'track-2',
      'track-7',
    ])
    expect(await getLibraryPlaylist(playlist.id)).toMatchObject({
      entryCount: 6,
      repeatCount: 1,
    })
    expect(
      await undoLibraryPlaylistAddition(playlist.id, again.batchId),
    ).toEqual({ removed: 2 })
    expect(await entryIds(playlist.id)).toEqual([
      'track-1',
      'track-2',
      'track-3',
      'track-6',
    ])
    const all = await add(playlist.id, ids('track-6', 'track-1'), 'skip')
    expect(all).toMatchObject({ added: 0, skipped: 2 })
  })

  it('removes entries and repeats and restores them in place', async () => {
    const {
      getLibraryPlaylist,
      listLibraryPlaylistEntries,
      removeLibraryPlaylistEntries,
      restoreLibraryPlaylistEntries,
    } = await service()
    const { playlist } = await create(
      'tracks',
      'Repeats',
      ids('track-1', 'track-2', 'track-3'),
    )
    await add(playlist.id, ids('track-2', 'track-1', 'track-4'), 'again')
    await add(playlist.id, ids('track-2'), 'again')
    const order = [
      'track-1',
      'track-2',
      'track-3',
      'track-2',
      'track-1',
      'track-4',
      'track-2',
    ]
    expect(await entryIds(playlist.id)).toEqual(order)
    expect((await getLibraryPlaylist(playlist.id)).repeatCount).toBe(3)

    const repeats = await removeLibraryPlaylistEntries(playlist.id, {
      repeats: true,
    })
    expect(repeats.removed).toBe(3)
    expect(await entryIds(playlist.id)).toEqual([
      'track-1',
      'track-2',
      'track-3',
      'track-4',
    ])
    expect(await getLibraryPlaylist(playlist.id)).toMatchObject({
      entryCount: 4,
      repeatCount: 0,
    })
    expect(
      await restoreLibraryPlaylistEntries(playlist.id, repeats.batchId),
    ).toEqual({ restored: 3 })
    expect(await entryIds(playlist.id)).toEqual(order)

    const page = await listLibraryPlaylistEntries(playlist.id, {
      page: 1,
      size: 100,
    })
    const chosen = [page.items[0]?.id ?? '', page.items[2]?.id ?? '']
    const removal = await removeLibraryPlaylistEntries(playlist.id, {
      entryIds: chosen,
    })
    expect(removal.removed).toBe(2)
    expect(await entryIds(playlist.id)).toEqual(
      order.slice(1).filter((_, index) => index !== 1),
    )
    expect(
      await restoreLibraryPlaylistEntries(playlist.id, removal.batchId),
    ).toEqual({ restored: 2 })
    expect(await entryIds(playlist.id)).toEqual(order)
    expect(
      await restoreLibraryPlaylistEntries(playlist.id, removal.batchId),
    ).toEqual({ restored: 0 })
  })

  it('rejects items from another library and entries of a smart playlist', async () => {
    const { createLibraryPlaylist } = await service()
    const tracks = (await create('tracks', 'Tracks only')).playlist
    await expect(add(tracks.id, ids('track-1', 'album-1'))).rejects.toThrow(
      'An item is not in this playlist’s library.',
    )
    await expect(add(tracks.id, ids('missing-item'))).rejects.toEqual(
      status(422),
    )
    const albums = (await create('albums', 'Albums only')).playlist
    await expect(add(albums.id, ids('track-1'))).rejects.toEqual(status(422))
    const films = (await create('films', 'Films only')).playlist
    await expect(add(films.id, ids('album-1'))).rejects.toEqual(status(422))
    const videos = (await create('subscriptions', 'Videos only')).playlist
    await expect(add(videos.id, ids(`${SHOW}-1`))).rejects.toEqual(status(422))
    const mixes = (await create('mixes', 'Mixes only')).playlist
    await expect(add(mixes.id, ids('synthvid001'))).rejects.toEqual(status(422))
    expect((await add(mixes.id, ids(`${SHOW}-1`))).added).toBe(1)
    const { getLibraryPlaylist } = await service()
    expect((await getLibraryPlaylist(tracks.id)).entryCount).toBe(0)

    const smart = await createLibraryPlaylist(
      CreateLibraryPlaylistSchema.parse({
        type: 'smart',
        library: 'tracks',
        name: 'Smart tracks',
        view: { q: 'Quicksilver' },
      }),
      'owner',
    )
    expect(smart.playlist).toMatchObject({
      type: 'smart',
      entryCount: null,
      view: { q: 'Quicksilver' },
    })
    await expect(add(smart.playlist.id, ids('track-1'))).rejects.toEqual(
      status(422),
    )
  })

  it('lists memberships, containment and pages of entries in position order', async () => {
    const {
      listLibraryPlaylistEntries,
      listLibraryPlaylistMemberships,
      listLibraryPlaylists,
      removeLibraryPlaylistEntries,
    } = await service()
    const first = (
      await create('films', 'Membership A', ids('film-1', 'film-2'))
    ).playlist
    // A selection holds each item once; a repeat is a second addition.
    const second = (
      await create('films', 'Membership B', ids('film-2', 'film-1', 'film-1'))
    ).playlist
    expect((await add(second.id, ids('film-1'), 'again')).repeated).toBe(1)
    await create('films', 'Membership C', ids('film-3'))
    // Earlier tests made the Films playlist, which holds every film.
    expect(
      (
        await listLibraryPlaylistMemberships({
          library: 'films',
          itemId: 'film-1',
        })
      ).map((row) => [row.name, row.entryCount]),
    ).toEqual([
      ['Films', 3],
      ['Membership A', 2],
      ['Membership B', 3],
    ])
    const listed = await listLibraryPlaylists({
      library: 'films',
      q: 'membership',
      itemId: 'film-3',
      page: 1,
      size: 2,
    })
    expect(listed.items.map((row) => [row.name, row.containsItem])).toEqual([
      ['Membership A', false],
      ['Membership B', false],
    ])
    expect(listed.hasMore).toBe(true)

    const firstPage = await listLibraryPlaylistEntries(second.id, {
      page: 1,
      size: 2,
    })
    const secondPage = await listLibraryPlaylistEntries(second.id, {
      page: 2,
      size: 2,
    })
    expect(firstPage).toMatchObject({ library: 'films', hasMore: true })
    expect(
      [...firstPage.items, ...secondPage.items].map((entry) => [
        entry.position,
        entry.item.id,
      ]),
    ).toEqual([
      [1, 'film-2'],
      [2, 'film-1'],
      [3, 'film-1'],
    ])
    expect(secondPage.hasMore).toBe(false)
    expect(firstPage.items[0]?.item).toMatchObject({
      mediaType: 'film',
      title: 'Synthetic film 2',
    })

    await removeLibraryPlaylistEntries(first.id, {
      entryIds: [
        (await listLibraryPlaylistEntries(first.id, { page: 1, size: 10 }))
          .items[0]?.id ?? '',
      ],
    })
    expect(
      (
        await listLibraryPlaylistMemberships({
          library: 'films',
          itemId: 'film-1',
        })
      ).map((row) => row.name),
    ).toEqual(['Films', 'Membership B'])

    const videos = (
      await create('subscriptions', 'Video entries', ids('synthvid001'))
    ).playlist
    const page = await listLibraryPlaylistEntries(videos.id, {
      page: 1,
      size: 10,
    })
    expect(page.library).toBe('subscriptions')
    expect(page.items[0]?.item).toMatchObject({
      id: 'synthvid001',
      sourceTitle: 'Synthetic channel',
    })
  })

  it('validates views against each library’s Browse query', async () => {
    const { createLibraryPlaylist } = await service()
    const valid: Array<[LibraryPlaylistLibrary, Record<string, string>]> = [
      [
        'albums',
        {
          filters: JSON.stringify([
            { field: 'genre', value: 'Ambient', mode: 'any' },
          ]),
          sortBy: 'title',
          direction: 'asc',
          limitResults: '50',
          tagLevels: 'album',
        },
      ],
      ['tracks', { groupRecordings: 'true', q: 'rain' }],
      ['films', { q: 'rain', sortBy: 'releaseDate' }],
      ['subscriptions', { q: 'rain', sortBy: 'viewCount' }],
      [
        'mixes',
        {
          filters: JSON.stringify([
            { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
          ]),
        },
      ],
    ]
    const invalid: Array<[LibraryPlaylistLibrary, Record<string, string>]> = [
      ['albums', { view: 'grid' }],
      ['albums', { limitResults: '0' }],
      ['tracks', { density: 'compact' }],
      ['tracks', { unknown: '1' }],
      ['tracks', { page: '2' }],
      [
        'films',
        {
          listening: JSON.stringify({
            match: 'all',
            rules: [{ period: { kind: 'all' }, min: 1 }],
          }),
        },
      ],
      [
        'subscriptions',
        {
          filters: JSON.stringify([
            { field: 'artist', value: 'Synthetic DJ', mode: 'required' },
          ]),
        },
      ],
      ['subscriptions', { library: 'mixes' }],
      ['mixes', { sortBy: 'viewCount' }],
    ]
    for (const [index, [library, view]] of valid.entries()) {
      expect(parseLibraryBrowseView(library, view).success).toBe(true)
      const { playlist } = await createLibraryPlaylist(
        CreateLibraryPlaylistSchema.parse({
          type: 'smart',
          library,
          name: `Smart ${index}`,
          view,
        }),
        'owner',
      )
      expect(playlist.view).toEqual(view)
    }
    for (const [library, view] of invalid) {
      expect(parseLibraryBrowseView(library, view).success).toBe(false)
      expect(
        CreateLibraryPlaylistSchema.safeParse({
          type: 'smart',
          library,
          name: 'Invalid',
          view,
        }).success,
      ).toBe(false)
      await expect(
        createLibraryPlaylist(
          { type: 'smart', library, name: 'Invalid', view },
          'owner',
        ),
      ).rejects.toEqual(status(422))
    }
    const { updateLibraryPlaylist } = await service()
    const { playlist } = await createLibraryPlaylist(
      CreateLibraryPlaylistSchema.parse({
        type: 'smart',
        library: 'tracks',
        name: 'Smart to edit',
        view: { q: 'rain' },
      }),
      'owner',
    )
    expect(
      (await updateLibraryPlaylist(playlist.id, { view: { q: 'snow' } })).view,
    ).toEqual({ q: 'snow' })
    await expect(
      updateLibraryPlaylist(playlist.id, { view: { columns: 'title' } }),
    ).rejects.toEqual(status(422))
  })

  it('adds only items Browse lists at the In library scope', async () => {
    // A listed track, one outside the library and a Last.fm row that Browse
    // hides because its listened history is on a playable listed track.
    await pool.query(`
      insert into media_item (id, slug, media_type, title, in_library, source_label) values
        ('borrowed-in', 'borrowed-in', 'track', 'Borrowed tune one', true, null),
        ('borrowed-peer', 'borrowed-peer', 'track', 'Borrowed tune two', true, null),
        ('borrowed-out', 'borrowed-out', 'track', 'Borrowed tune three', false, null),
        ('borrowed-hidden', 'borrowed-hidden', 'track', 'Borrowed tune two', true, 'lastfm'),
        ('outside-album', 'outside-album', 'album', 'Outside album', false, null),
        ('outside-film', 'outside-film', 'film', 'Outside film', false, null);
      insert into library_track (media_item_id, spotify_track_id, duration_sec) values
        ('borrowed-in', null, 200), ('borrowed-peer', 'borrowedpeer0000000001', 200),
        ('borrowed-out', null, 200), ('borrowed-hidden', null, null);
      insert into album (media_item_id) values ('outside-album');
      insert into film (media_item_id) values ('outside-film');
      insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id) values
        ('listener', 'borrowed artist', 'borrowed tune two', 'borrowed-hidden');
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
        ('listener', 'borrowed artist', 'borrowed tune two', 'borrowed-peer', 'exact');
      insert into subscription_source (id, type, title, subscribed) values
        ('UC${'unsubscribed'.padEnd(22, '0')}', 'youtube', 'Unsubscribed channel', false);
      insert into subscription_item (id, source_id, type, title, published_at, search) values
        ('outsidevid1', 'UC${'unsubscribed'.padEnd(22, '0')}', 'youtube', 'Outside video',
          '2026-03-01', to_tsvector('simple', 'Outside video'));
    `)
    const { checkLibraryPlaylistEntries, getLibraryPlaylist } = await service()
    const onlyInLibrary =
      'Only items in the library can be added to a playlist.'
    const playlist = (await create('tracks', 'Borrowed')).playlist
    for (const id of ['borrowed-out', 'borrowed-hidden']) {
      await expect(add(playlist.id, ids('borrowed-in', id))).rejects.toThrow(
        onlyInLibrary,
      )
      await expect(add(playlist.id, ids(id), 'again')).rejects.toEqual(
        status(422),
      )
      await expect(
        checkLibraryPlaylistEntries(playlist.id, ids('borrowed-in', id)),
      ).rejects.toThrow(onlyInLibrary)
      await expect(
        create('tracks', `Borrowed ${id}`, ids('borrowed-in', id)),
      ).rejects.toThrow(onlyInLibrary)
    }
    // Another library's item keeps its own message.
    await expect(add(playlist.id, ids('album-1'))).rejects.toThrow(
      'An item is not in this playlist’s library.',
    )
    const outside: Array<[LibraryPlaylistLibrary, string]> = [
      ['albums', 'outside-album'],
      ['films', 'outside-film'],
      ['subscriptions', 'outsidevid1'],
    ]
    for (const [library, id] of outside) {
      const other = (await create(library, `Outside ${library}`)).playlist
      await expect(add(other.id, ids(id))).rejects.toThrow(onlyInLibrary)
    }
    expect((await getLibraryPlaylist(playlist.id)).entryCount).toBe(0)

    // A query at the All scope resolves at the In library scope.
    const query = { libraryScope: 'all', q: 'Borrowed tune' }
    expect(
      await checkLibraryPlaylistEntries(playlist.id, matching(query)),
    ).toMatchObject({ total: 2, present: 0 })
    expect((await add(playlist.id, matching(query))).added).toBe(2)
    expect((await add(playlist.id, ids('borrowed-in'), 'again')).added).toBe(1)
    expect((await entryIds(playlist.id)).sort()).toEqual([
      'borrowed-in',
      'borrowed-in',
      'borrowed-peer',
    ])
    // At the Outside scope the view shows no row in the library, so a query
    // selection there adds nothing and is refused on create, check and add.
    const outsideQuery = matching({ ...query, libraryScope: 'outside' })
    await expect(
      checkLibraryPlaylistEntries(playlist.id, outsideQuery),
    ).rejects.toThrow(onlyInLibrary)
    await expect(add(playlist.id, outsideQuery)).rejects.toEqual(status(422))
    await expect(
      create('tracks', 'Borrowed outside', outsideQuery),
    ).rejects.toThrow(onlyInLibrary)
    expect((await entryIds(playlist.id)).length).toBe(3)

    // Filter tracks lists every distinct item the playlist holds.
    const { queryBrowseCount } = await import('@/services/browse')
    const detail = await getLibraryPlaylist(playlist.id)
    const { totalCount } = await queryBrowseCount(
      'track',
      TrackQuerySchema.parse({
        filters: JSON.stringify([
          { field: 'libraryPlaylist', value: playlist.id, mode: 'any' },
        ]),
      }),
    )
    expect(totalCount).toBe(detail.entryCount - detail.repeatCount)
    expect(totalCount).toBe(2)
  })

  it('says in a track’s details whether Tracks Browse lists it', async () => {
    // A listed track, one outside the library, and a Last.fm row that Browse
    // hides because its recorded name is counted on a playable listed track,
    // although another name's scrobbles are counted on the row itself.
    await pool.query(`
      insert into media_item (id, slug, media_type, title, in_library, source_label) values
        ('detail-listed', 'detail-listed', 'track', 'Detail tune one', true, null),
        ('detail-peer', 'detail-peer', 'track', 'Detail tune two', true, null),
        ('detail-out', 'detail-out', 'track', 'Detail tune three', false, null),
        ('detail-hidden', 'detail-hidden', 'track', 'Detail tune two', true, 'lastfm');
      insert into library_track (media_item_id, spotify_track_id, duration_sec) values
        ('detail-listed', null, 200), ('detail-peer', 'detailpeer000000000001', 200),
        ('detail-out', null, 200), ('detail-hidden', null, null);
      insert into lastfm_track_source (username, artist_key, track_key, track_media_item_id) values
        ('listener', 'detail artist', 'detail tune two', 'detail-hidden');
      insert into lastfm_track_link (username, artist_key, track_key, track_media_item_id, strategy) values
        ('listener', 'detail artist', 'detail tune two', 'detail-peer', 'exact'),
        ('listener', 'detail artist', 'detail tune two live', 'detail-hidden', 'exact');
      insert into lastfm_scrobble (id, username, listened_at, artist_name, artist_key, track_name, track_key) values
        ('detail-live-1', 'listener', '2026-03-01', 'Detail artist', 'detail artist', 'Detail tune two live', 'detail tune two live'),
        ('detail-live-2', 'listener', '2026-03-02', 'Detail artist', 'detail artist', 'Detail tune two live', 'detail tune two live');
    `)
    const { getTrackDetail } = await import('@/services/tracks')
    const listed = async (id: string) => {
      const detail = await getTrackDetail(id)
      return {
        listed: detail?.listedInLibrary,
        scrobbles: detail?.listening.total,
      }
    }
    expect(await listed('detail-listed')).toEqual({
      listed: true,
      scrobbles: 0,
    })
    expect(await listed('detail-out')).toEqual({ listed: false, scrobbles: 0 })
    expect(await listed('detail-hidden')).toEqual({
      listed: false,
      scrobbles: 2,
    })
    // The server's own check agrees with each answer.
    const playlist = (await create('tracks', 'Detail check')).playlist
    await expect(add(playlist.id, ids('detail-hidden'))).rejects.toEqual(
      status(422),
    )
    await expect(add(playlist.id, ids('detail-out'))).rejects.toEqual(
      status(422),
    )
    expect((await add(playlist.id, ids('detail-listed'))).added).toBe(1)
  })
})
