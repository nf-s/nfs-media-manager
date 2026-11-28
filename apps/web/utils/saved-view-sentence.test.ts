import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  describeSavedView,
  directionWords,
  singularFieldLabel,
} from './saved-view-sentence'

const names = (id: string) =>
  id === 'late' ? 'Late shift' : id === 'gone' ? null : undefined
const filters = (list: BrowseFilter[]) => JSON.stringify(list)

test('filters, then the search, the playlist and the order, joined with dots', () => {
  assert.equal(
    describeSavedView({
      library: 'tracks',
      view: {
        filters: filters([
          { field: 'genre', value: 'ambient', mode: 'any' },
          { field: 'genre', value: 'jazz', mode: 'any' },
          { field: 'libraryPlaylist', value: 'late', mode: 'required' },
        ]),
        q: 'rain',
        sortBy: 'dateAdded',
        direction: 'desc',
      },
      playlistName: names,
    }),
    'Tag: Ambient or Jazz · Search: “rain” · In playlist: Late shift · Added, newest first',
  )
})

test('with no filter the sentence starts with all of the library', () => {
  assert.equal(
    describeSavedView({ library: 'tracks', view: {}, playlistName: names }),
    'All tracks · Added, newest first',
  )
  assert.equal(
    describeSavedView({
      library: 'albums',
      view: { sortBy: 'title', direction: 'asc' },
      playlistName: names,
    }),
    'All albums · Title, A to Z',
  )
})

test('Any joins with or, Required with and, Exclude reads Not', () => {
  assert.equal(
    describeSavedView({
      library: 'tracks',
      view: {
        filters: filters([
          { field: 'artist', value: 'Mara Quill', mode: 'required' },
          { field: 'artist', value: 'Fen Static', mode: 'required' },
          { field: 'genre', value: 'rock', mode: 'exclude' },
          { field: 'genre', value: 'metal', mode: 'exclude' },
          { field: 'album', value: 'Night Index' },
        ]),
        sortBy: 'title',
        direction: 'desc',
      },
      playlistName: names,
    }),
    'Artist: Mara Quill and Fen Static · Tag: Not Rock or Metal · Album: Night Index · Title, Z to A',
  )
})

test('a playlist filter names the playlist, or says it was removed', () => {
  const view = (value: string, mode: BrowseFilter['mode']) => ({
    filters: filters([{ field: 'libraryPlaylist', value, mode }]),
  })
  assert.equal(
    describeSavedView({
      library: 'albums',
      view: view('late', 'any'),
      playlistName: names,
    }),
    'In playlist: Late shift · Added, newest first',
  )
  assert.equal(
    describeSavedView({
      library: 'albums',
      view: view('gone', 'required'),
      playlistName: names,
    }),
    'In playlist: removed · Added, newest first',
  )
  assert.equal(
    describeSavedView({
      library: 'albums',
      view: view('late', 'exclude'),
      playlistName: names,
    }),
    'In playlist: Not Late shift · Added, newest first',
  )
  assert.equal(
    describeSavedView({
      library: 'albums',
      view: view('unknown', 'any'),
      playlistName: names,
    }),
    'In playlist: … · Added, newest first',
  )
})

test('ranges and listening conditions use their chip labels', () => {
  assert.equal(
    describeSavedView({
      library: 'albums',
      view: {
        ranges: JSON.stringify([
          {
            field: 'releaseDate',
            min: Date.parse('2020-01-01T00:00:00.000Z'),
            includeMissing: false,
          },
          { field: 'scrobbles', min: 5, max: 20, includeMissing: true },
        ]),
        listening: JSON.stringify({
          match: 'all',
          rules: [{ min: 10, period: { kind: 'all' } }],
        }),
        limitResults: '25',
        sortBy: 'scrobbles',
        direction: 'desc',
      },
      playlistName: names,
    }),
    'Released: 2020-01-01 to * · Scrobbles: 5 to 20 + missing · At least 10 track plays in total · Top 25 · Scrobbles, highest first',
  )
  assert.equal(
    describeSavedView({
      library: 'tracks',
      view: {
        ranges: JSON.stringify([
          { field: 'durationSec', min: 180, includeMissing: false },
        ]),
        limitResults: '50',
      },
      playlistName: names,
    }),
    'Duration: 3:00 to * · Limit: 50 · Added, newest first',
  )
  assert.equal(
    describeSavedView({
      library: 'subscriptions',
      view: {
        ranges: JSON.stringify([
          { field: 'durationSec', max: 600, includeMissing: false },
        ]),
      },
      playlistName: names,
    }),
    'Duration: * to 10:00 · Published, newest first',
  )
})

test('each direction is written in the words of its kind of field', () => {
  const order = (library: 'tracks' | 'films', sortBy: string) =>
    ['asc', 'desc'].map((direction) =>
      describeSavedView({
        library,
        view: { sortBy, direction },
        playlistName: names,
      }).replace(/^All \w+ · /, ''),
    )
  assert.deepEqual(order('tracks', 'dateAdded'), [
    'Added, oldest first',
    'Added, newest first',
  ])
  assert.deepEqual(order('tracks', 'title'), ['Title, A to Z', 'Title, Z to A'])
  assert.deepEqual(order('tracks', 'durationSec'), [
    'Duration, shortest first',
    'Duration, longest first',
  ])
  assert.deepEqual(order('films', 'runtimeMinutes'), [
    'Runtime, shortest first',
    'Runtime, longest first',
  ])
  assert.deepEqual(order('tracks', 'scrobbles'), [
    'Scrobbles, lowest first',
    'Scrobbles, highest first',
  ])
  assert.equal(
    directionWords({ type: 'number', format: 'bpm' }, 'desc'),
    'highest first',
  )
})

test('Subscriptions and Mixes use their own sort names and stored tag values', () => {
  assert.equal(
    describeSavedView({
      library: 'subscriptions',
      view: { q: 'radios' },
      playlistName: names,
    }),
    'Search: “radios” · Relevance',
  )
  assert.equal(
    describeSavedView({
      library: 'mixes',
      view: {
        filters: filters([
          { field: 'artist', value: 'Odd Weather', mode: 'required' },
          { field: 'genre', value: 'dub', mode: 'any' },
        ]),
        sortBy: 'source',
        direction: 'asc',
      },
      playlistName: names,
    }),
    'Artist: Odd Weather · Tag: dub · Show, A to Z',
  )
})

test('a view the library cannot read is written as all of it', () => {
  assert.equal(
    describeSavedView({
      library: 'films',
      view: { columns: 'title' },
      playlistName: names,
    }),
    'All films',
  )
})

test('the sentence names each plural field in the singular; others as labelled', () => {
  const labels: Array<[string, string]> = [
    ['Tags', 'Tag'],
    ['Artists', 'Artist'],
    ['Countries', 'Country'],
    ['Album tags', 'Album tag'],
    ['Artist tags', 'Artist tag'],
    ['Track tags', 'Track tag'],
    ['Playlists', 'Playlist'],
    ['Collections', 'Collection'],
    ['Directors', 'Director'],
    ['Actors', 'Actor'],
    ['Writers', 'Writer'],
    ['Languages', 'Language'],
    ['Production companies', 'Production company'],
    ['Album', 'Album'],
    ['Has track tags', 'Has track tags'],
  ]
  for (const [label, singular] of labels)
    assert.equal(singularFieldLabel(label), singular)
  assert.equal(
    describeSavedView({
      library: 'films',
      view: {
        filters: filters([
          { field: 'country', value: 'France', mode: 'any' },
          { field: 'director', value: 'Ada Lune', mode: 'required' },
        ]),
      },
      playlistName: names,
    }),
    'Country: France · Director: Ada Lune · Released, newest first',
  )
})

test('Films, Subscriptions and Mixes views read in their own fields and sorts', () => {
  const lookup = (id: string) => (id === 'pl-watch' ? 'Watch later' : null)
  assert.equal(
    describeSavedView({
      library: 'subscriptions',
      view: {
        filters: filters([
          { field: 'source', value: 'Example Cooking', mode: 'any' },
          { field: 'type', value: 'YouTube', mode: 'any' },
          { field: 'watched', value: 'No', mode: 'required' },
          { field: 'libraryPlaylist', value: 'pl-watch', mode: 'exclude' },
        ]),
        ranges: JSON.stringify([{ field: 'durationSec', min: 600 }]),
        sortBy: 'durationSec',
        direction: 'desc',
      },
      playlistName: lookup,
    }),
    'Channel: Example Cooking · Type: YouTube · Watched: No · In playlist: Not Watch later · Duration: 10:00 to * · Duration, longest first',
  )
  assert.equal(
    describeSavedView({
      library: 'mixes',
      view: {
        filters: filters([
          { field: 'hasRecording', value: 'Yes', mode: 'any' },
        ]),
        ranges: JSON.stringify([
          { field: 'publishedAt', min: Date.UTC(2026, 0, 1) },
        ]),
        sortBy: 'publishedAt',
        direction: 'asc',
      },
      playlistName: lookup,
    }),
    'Has recording: Yes · Broadcast: 2026-01-01 to * · Broadcast, oldest first',
  )
  assert.equal(
    describeSavedView({
      library: 'films',
      view: {
        filters: filters([
          { field: 'actor', value: 'Ada Lune', mode: 'exclude' },
        ]),
        ranges: JSON.stringify([{ field: 'runtimeMinutes', max: 100 }]),
        sortBy: 'title',
        direction: 'asc',
        libraryScope: 'all',
      },
      playlistName: lookup,
    }),
    'Actor: Not Ada Lune · Runtime: * to 100 · Title, A to Z',
  )
  // With no order saved, each library's Browse default is named.
  for (const [library, text] of [
    ['films', 'All films · Released, newest first'],
    ['subscriptions', 'All items · Published, newest first'],
    ['mixes', 'All mixes · Broadcast, newest first'],
  ] as const)
    assert.equal(
      describeSavedView({ library, view: {}, playlistName: lookup }),
      text,
    )
})
