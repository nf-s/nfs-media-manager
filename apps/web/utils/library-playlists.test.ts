import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  additionResultText,
  allPresent,
  createButtonLabel,
  createdResultText,
  duplicateEvidence,
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
