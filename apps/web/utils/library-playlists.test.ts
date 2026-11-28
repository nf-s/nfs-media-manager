import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  additionResultText,
  createdPlaylistText,
  deletedPlaylistText,
  filterItemsLabel,
  libraryCreatorLabels,
  libraryItemsTitle,
  libraryPlaylistChipValue,
  libraryPlaylistFacts,
  libraryPlaylistFilterHref,
  matchingBlocked,
  matchingCount,
  listsImportedPlaylists,
  matchingSubject,
  playableLibrary,
  playlistLibraryForView,
  playlistNotFound,
  removedRepeatsText,
  removedResultText,
  repeatsNoticeText,
  selectionRejection,
  selectionSubject,
  smartPlaylistHref,
  allPresent,
  createButtonLabel,
  createdResultText,
  duplicateEvidence,
  fetchAllLibraryPlaylists,
  duplicatesLine,
  duplicatesMore,
  itemSubject,
  libraryItemCount,
  pickerHeading,
  playlistNameTaken,
  singleItemId,
  suggestedPlaylistName,
  undoneResultText,
  type PlaylistSubject,
} from './library-playlists'

const ids = Array.from({ length: 40 }, (_, index) => `track-${index + 1}`)
const forty: PlaylistSubject = {
  library: 'tracks',
  selection: { ids },
  count: 40,
  title: null,
}
const one = itemSubject('tracks', { id: 'track-1', title: 'Harbour Lights' })
const sample = [
  { id: 'track-1', title: 'Harbour Lights', creator: 'Mira Kestrel' },
  { id: 'track-2', title: 'Paper Moons', creator: 'Mira Kestrel' },
  { id: 'track-3', title: 'Slow Weather', creator: null },
  { id: 'track-4', title: 'Copper Wire', creator: 'Ada Lune' },
  { id: 'track-5', title: 'Salt Station', creator: 'Ada Lune' },
]

test('the picker names many items by count and one item by its title', () => {
  assert.equal(pickerHeading(forty), 'Add 40 tracks to a playlist')
  assert.equal(pickerHeading(one), 'Add “Harbour Lights” to a playlist')
  assert.equal(
    pickerHeading({ ...forty, library: 'albums', count: 2 }),
    'Add 2 albums to a playlist',
  )
  assert.equal(createButtonLabel(forty), 'Create and add 40')
  assert.equal(createButtonLabel(one), 'Create and add')
  assert.equal(singleItemId(one), 'track-1')
  assert.equal(singleItemId(forty), undefined)
})

test('every library has its noun for counts', () => {
  assert.equal(libraryItemCount('tracks', 1), '1 track')
  assert.equal(libraryItemCount('albums', 12), '12 albums')
  assert.equal(libraryItemCount('films', 2), '2 films')
  assert.equal(libraryItemCount('subscriptions', 3), '3 items')
  assert.equal(libraryItemCount('mixes', 1_200), '1,200 mixes')
  assert.equal(libraryItemCount('tracks', 6, 40), '6 of 40 tracks')
})

test('the duplicates step says how much is there, with five as evidence and the rest counted', () => {
  const some = { total: 40, present: 6, sample }
  assert.equal(
    duplicatesLine(forty, some),
    '6 of 40 tracks are already in this playlist.',
  )
  assert.equal(allPresent(forty, some), false)
  assert.deepEqual(sample.map(duplicateEvidence), [
    'Harbour Lights · Mira Kestrel',
    'Paper Moons · Mira Kestrel',
    'Slow Weather',
    'Copper Wire · Ada Lune',
    'Salt Station · Ada Lune',
  ])
  assert.equal(duplicatesMore(some), '+1 more')
  assert.equal(duplicatesMore({ total: 40, present: 5, sample }), null)
  const every = { total: 40, present: 40, sample }
  assert.equal(
    duplicatesLine(forty, every),
    'All 40 tracks are already in this playlist.',
  )
  assert.equal(allPresent(forty, every), true)
  assert.equal(
    duplicatesLine(one, null),
    '“Harbour Lights” is already in this playlist.',
  )
  assert.equal(allPresent(one, null), true)
})

test('the result line says what was added, skipped, repeated and created', () => {
  assert.equal(
    additionResultText(forty, 'Late shift', {
      added: 34,
      skipped: 6,
      repeated: 0,
    }),
    'Added 34 tracks to “Late shift”. Skipped 6 already there.',
  )
  assert.equal(
    additionResultText(forty, 'Late shift', {
      added: 40,
      skipped: 0,
      repeated: 6,
    }),
    'Added 40 tracks to “Late shift”. 6 were already there and are now in it twice.',
  )
  assert.equal(
    additionResultText(forty, 'Late shift', {
      added: 40,
      skipped: 0,
      repeated: 0,
    }),
    'Added 40 tracks to “Late shift”.',
  )
  assert.equal(
    additionResultText(one, 'Late shift', {
      added: 1,
      skipped: 0,
      repeated: 0,
    }),
    'Added “Harbour Lights” to “Late shift”.',
  )
  assert.equal(
    additionResultText(one, 'Late shift', {
      added: 1,
      skipped: 0,
      repeated: 1,
    }),
    'Added “Harbour Lights” to “Late shift”. It is now in it twice.',
  )
  assert.equal(
    createdResultText(forty, 'Night bus', 40),
    'Created “Night bus” with 40 tracks.',
  )
  assert.equal(
    createdResultText(one, 'Night bus', 1),
    'Created “Night bus” with “Harbour Lights”.',
  )
  assert.equal(
    undoneResultText(
      'Added 34 tracks to “Late shift”. Skipped 6 already there.',
    ),
    'Undone: Added 34 tracks to “Late shift”. Skipped 6 already there.',
  )
})

test('a suggested name joins the view’s tag values and search text', () => {
  assert.equal(
    suggestedPlaylistName(
      [
        { field: 'genre', value: 'ambient' },
        { field: 'genre', value: 'jazz', mode: 'any' },
        { field: 'genre', value: 'metal', mode: 'exclude' },
        { field: 'provider', value: 'tidal', mode: 'required' },
      ],
      ' rain ',
    ),
    'Ambient, Jazz, rain',
  )
  assert.equal(suggestedPlaylistName([], ''), '')
})

test('a taken name is the 409 the API sends', () => {
  assert.equal(
    playlistNameTaken({
      statusCode: 409,
      message: 'A playlist with this name exists.',
    }),
    true,
  )
  assert.equal(playlistNameTaken({ statusCode: 422 }), false)
  assert.equal(playlistNameTaken(new Error('Request failed')), false)
})

test('a playlist’s header facts, Filter action and section are in its library’s noun', () => {
  assert.deepEqual(
    libraryPlaylistFacts({
      library: 'tracks',
      entryCount: 52,
      updatedAt: '2026-11-28T09:30:00.000Z',
    }),
    ['52 tracks', 'Updated 2026-11-28', 'Library'],
  )
  assert.equal(
    libraryPlaylistFacts({
      library: 'albums',
      entryCount: 1,
      updatedAt: '2026-11-28T09:30:00.000Z',
    })[0],
    '1 album',
  )
  assert.equal(filterItemsLabel('tracks'), 'Filter tracks')
  assert.equal(filterItemsLabel('mixes'), 'Filter mixes')
  assert.equal(libraryItemsTitle('subscriptions'), 'Items')
  assert.deepEqual(libraryCreatorLabels, {
    albums: 'Artists',
    tracks: 'Artists',
    films: 'Directors',
    subscriptions: 'Channel',
    mixes: 'Show',
  })
})

test('repeats, removals, creation and deletion are reported in PL-53 and PL-51 words', () => {
  assert.equal(
    repeatsNoticeText('tracks', 3),
    '3 tracks are in this playlist more than once.',
  )
  assert.equal(
    repeatsNoticeText('albums', 1),
    '1 album is in this playlist more than once.',
  )
  assert.equal(
    removedRepeatsText(3, 'Late shift'),
    'Removed 3 repeats from “Late shift”.',
  )
  assert.equal(
    removedRepeatsText(1, 'Late shift'),
    'Removed 1 repeat from “Late shift”.',
  )
  assert.equal(
    removedResultText('Harbour Lights', 'Late shift'),
    'Removed “Harbour Lights” from “Late shift”.',
  )
  assert.equal(createdPlaylistText('Late shift'), 'Created “Late shift”.')
  assert.equal(deletedPlaylistText('Late shift'), 'Deleted “Late shift”.')
})

test('Filter tracks opens Browse with only the playlist, required', () => {
  const url = new URL(libraryPlaylistFilterHref('tracks', 'pl-1'), 'http://x')
  assert.equal(url.pathname, '/tracks')
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? ''), [
    { field: 'libraryPlaylist', value: 'pl-1', mode: 'required' },
  ])
  assert.deepEqual([...url.searchParams.keys()], ['filters'])
  assert.equal(
    new URL(libraryPlaylistFilterHref('mixes', 'pl-2'), 'http://x').pathname,
    '/mixes',
  )
})

test('a smart playlist opens its library’s Browse with its view and its ID', () => {
  const url = new URL(
    smartPlaylistHref('albums', 'smart-1', {
      q: 'rain',
      sortBy: 'title',
      direction: 'asc',
    }),
    'http://x',
  )
  assert.equal(url.pathname, '/albums')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    q: 'rain',
    sortBy: 'title',
    direction: 'asc',
    smartPlaylist: 'smart-1',
  })
})

test('the playlist chip names the playlist or says it was removed', () => {
  assert.equal(libraryPlaylistChipValue('Late shift'), 'Late shift')
  assert.equal(libraryPlaylistChipValue(null), 'removed')
  assert.equal(playlistNotFound({ statusCode: 404 }), true)
  assert.equal(playlistNotFound({ statusCode: 500 }), false)
})

test('the Playlists page takes its library from the page scope', () => {
  assert.equal(playlistLibraryForView('track'), 'tracks')
  assert.equal(playlistLibraryForView('album'), 'albums')
  assert.equal(playlistLibraryForView('film'), 'films')
  assert.equal(playlistLibraryForView('subscription'), 'subscriptions')
  assert.equal(playlistLibraryForView('mix'), 'mixes')
  assert.equal(playlistLibraryForView('artist'), null)
  assert.equal(playableLibrary('albums'), 'albums')
  assert.equal(playableLibrary('films'), null)
})

test('the bar adds only the ticked rows in the library, in selection order', () => {
  const rows = [
    { id: 'track-1', title: 'Harbour Lights' },
    { id: 'track-2', title: 'Paper Moons', inLibrary: false },
    { id: 'track-3', title: 'Slow Weather', inLibrary: true },
    null,
  ]
  assert.deepEqual(
    selectionSubject('tracks', ['track-3', 'track-2', 'track-1'], rows),
    {
      library: 'tracks',
      selection: { ids: ['track-3', 'track-1'] },
      count: 2,
      title: null,
    },
  )
  assert.deepEqual(selectionSubject('tracks', ['track-2', 'track-3'], rows), {
    library: 'tracks',
    selection: { ids: ['track-3'] },
    count: 1,
    title: 'Slow Weather',
  })
  assert.equal(selectionSubject('albums', ['track-2'], rows).count, 0)
})

test('a rejected selection reads the server’s reason', () => {
  assert.equal(
    selectionRejection({
      statusCode: 422,
      message: 'Only items in the library can be added to a playlist.',
    }),
    'Only items in the library can be added to a playlist.',
  )
  assert.equal(selectionRejection({ statusCode: 500, message: 'Failed' }), null)
  assert.equal(selectionRejection(new Error('Request failed')), null)
})

test('Select all matching adds the view’s Browse query less the unticked rows', () => {
  const params = new URLSearchParams({
    libraryScope: 'all',
    q: 'rain',
    filters: '[]',
    ranges: '[]',
    sortBy: 'dateAdded',
    direction: 'desc',
  })
  // 128 match at the In library scope; of three unticked rows one is outside.
  const count = matchingCount(128, {
    excludeIds: ['track-1', 'track-2', 'track-3'],
    outsideExcluded: 1,
  })
  assert.equal(count, 126)
  const subject = matchingSubject(
    'tracks',
    params,
    ['track-1', 'track-2', 'track-3'],
    count,
  )
  assert.deepEqual(subject.selection, {
    query: {
      libraryScope: 'all',
      q: 'rain',
      filters: '[]',
      ranges: '[]',
      sortBy: 'dateAdded',
      direction: 'desc',
    },
    excludeIds: ['track-1', 'track-2', 'track-3'],
  })
  assert.equal(pickerHeading(subject), 'Add 126 tracks to a playlist')
  assert.equal(createButtonLabel(subject), 'Create and add 126')
  assert.equal(singleItemId(subject), undefined)
  assert.equal(
    additionResultText(subject, 'Late shift', {
      added: 120,
      skipped: 6,
      repeated: 0,
    }),
    'Added 120 tracks to “Late shift”. Skipped 6 already there.',
  )
  // One match is still a count, not a title.
  assert.equal(
    pickerHeading(matchingSubject('albums', params, [], 1)),
    'Add 1 album to a playlist',
  )
  assert.equal(
    matchingCount(2, { excludeIds: ['a', 'b', 'c'], outsideExcluded: 0 }),
    0,
  )
})

test('a whole-result selection at the Outside scope, or with a failed count, says why it cannot be added', () => {
  assert.equal(
    matchingBlocked({ outside: true, error: null }),
    'Items outside the library cannot be added to a playlist.',
  )
  assert.equal(
    matchingBlocked({ outside: false, error: 'Count timed out' }),
    'Count timed out',
  )
  assert.equal(matchingBlocked({ outside: false, error: null }), null)
})

test('every playlist of a library is read page by page until none remain', async (t) => {
  const rows = Array.from({ length: 230 }, (_, index) => ({
    id: `smart-${index + 1}`,
    library: 'albums',
    type: 'smart',
    name: `Saved view ${String(index + 1).padStart(3, '0')}`,
    entryCount: null,
    view: { sortBy: 'dateAdded', direction: 'desc' },
    updatedAt: '2026-11-28T00:00:00.000Z',
  }))
  const requests: URLSearchParams[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const params = new URL(String(input)).searchParams
    requests.push(params)
    const page = Number(params.get('page'))
    const size = Number(params.get('size'))
    const slice = rows.slice((page - 1) * size, page * size + 1)
    return Response.json({
      statusCode: 200,
      message: 'OK',
      data: {
        items: slice.slice(0, size),
        page,
        size,
        hasMore: slice.length > size,
      },
    })
  })
  const all = await fetchAllLibraryPlaylists('http://api.test', {
    library: 'albums',
    type: 'smart',
  })
  assert.deepEqual(
    all.map((row) => row.name),
    rows.map((row) => row.name),
  )
  assert.deepEqual(
    requests.map((params) => [
      params.get('library'),
      params.get('type'),
      params.get('page'),
      params.get('size'),
    ]),
    [
      ['albums', 'smart', '1', '100'],
      ['albums', 'smart', '2', '100'],
      ['albums', 'smart', '3', '100'],
    ],
  )
})

test('a Mixes whole-result selection sends the view without the library Browse adds', () => {
  const params = new URLSearchParams({
    library: 'mixes',
    filters: '[]',
    ranges: '[]',
    sortBy: 'publishedAt',
    direction: 'desc',
    libraryScope: 'all',
  })
  const subject = matchingSubject('mixes', params, ['mix-1'], 95)
  assert.deepEqual(subject.selection, {
    query: {
      filters: '[]',
      ranges: '[]',
      sortBy: 'publishedAt',
      direction: 'desc',
      libraryScope: 'all',
    },
    excludeIds: ['mix-1'],
  })
  assert.equal(pickerHeading(subject), 'Add 95 mixes to a playlist')
  assert.equal(
    pickerHeading(matchingSubject('subscriptions', params, [], 2)),
    'Add 2 items to a playlist',
  )
  assert.equal(
    pickerHeading(matchingSubject('films', new URLSearchParams(), [], 1)),
    'Add 1 film to a playlist',
  )
})

test('only Albums and Tracks list imported playlists beside their own', () => {
  assert.equal(listsImportedPlaylists('albums'), true)
  assert.equal(listsImportedPlaylists('tracks'), true)
  assert.equal(listsImportedPlaylists('films'), false)
  assert.equal(listsImportedPlaylists('subscriptions'), false)
  assert.equal(listsImportedPlaylists('mixes'), false)
})
