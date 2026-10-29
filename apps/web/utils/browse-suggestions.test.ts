import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  browseSuggestions,
  enterSuggestion,
  matchingTitleFilters,
  suggestionKey,
  titleSuggestions,
  type FilterSuggestion,
} from './browse-suggestions'

const facets: FilterSuggestion[] = [
  { field: 'title', value: 'Solaris', label: 'Title: Solaris', count: 2 },
  {
    field: 'genre',
    value: 'Science fiction',
    label: 'Tags: Science fiction',
    count: 8,
  },
  { field: 'provider', value: 'example', label: 'Provider: example', count: 2 },
]

test('title lookup uses whole-library facets without browse filters or a free-text query', () => {
  assert.deepEqual(matchingTitleFilters(facets, 'SOLARIS'), [
    { field: 'title', value: 'Solaris' },
  ])
  assert.deepEqual(matchingTitleFilters(facets, ' '), [])
  assert.deepEqual(matchingTitleFilters(facets, 'science'), [])
  assert.equal(facets[0]?.count, 2)
})

test('multi-word title matching and exact-title priority are preserved', () => {
  const options = ['The Long Goodbye', 'Goodbye', 'Goodbye Again'].map(
    (value) => ({ field: 'title', value, label: value, count: 1 }),
  )
  assert.deepEqual(matchingTitleFilters(options, 'long goodbye'), [
    { field: 'title', value: 'The Long Goodbye' },
  ])
  assert.equal(matchingTitleFilters(options, 'goodbye')[0]?.value, 'Goodbye')
})

test('duplicate film titles navigate by distinct IDs with year and director context', () => {
  const items = titleSuggestions(
    [
      {
        id: 'film-1972',
        mediaType: 'film',
        title: 'Solaris',
        releaseDate: '1972-01-01',
        credits: [
          { name: 'Andrei Tarkovsky', role: 'director', billingOrder: 0 },
        ],
      },
      {
        id: 'film-2002',
        mediaType: 'film',
        title: 'Solaris',
        releaseDate: '2002-01-01',
        credits: [
          { name: 'Steven Soderbergh', role: 'director', billingOrder: 0 },
        ],
      },
    ],
    'solaris',
  )
  assert.match(items[0]?.label ?? '', /1972.*Andrei Tarkovsky/)
  assert.match(items[1]?.label ?? '', /2002.*Steven Soderbergh/)
  const options = browseSuggestions(facets, items, 'solaris')
  assert.deepEqual(options.map(suggestionKey), [
    'item:film-1972',
    'item:film-2002',
  ])
  assert.deepEqual(enterSuggestion(options, -1), {
    kind: 'item',
    item: items[0],
  })
  assert.deepEqual(enterSuggestion(options, 1), {
    kind: 'item',
    item: items[1],
  })
})

test('album titles show artists, and otherwise identical results retain ID disambiguation', () => {
  const album = {
    title: 'Same',
    releaseDate: null,
    credits: [{ name: 'Artist', role: 'artist', billingOrder: 0 }],
  }
  const items = titleSuggestions(
    [
      { ...album, id: 'a', mediaType: 'album' },
      { ...album, id: 'b', mediaType: 'album' },
    ],
    'same',
  )
  assert.deepEqual(
    items.map((item) => item.label),
    ['Same · Artist · a', 'Same · Artist · b'],
  )
})

test('title facets never become filters, while metadata suggestions still do', () => {
  const options = browseSuggestions(facets, [], '')
  assert.deepEqual(options.map(suggestionKey), [
    'filter:genre:Science fiction',
    'filter:provider:example',
  ])
  assert.equal(enterSuggestion(options, -1), undefined)
  assert.deepEqual(enterSuggestion(options, 0), {
    kind: 'filter',
    filter: facets[1],
  })
  assert.equal(enterSuggestion(options, 99), undefined)
})

test('highlight identity remains stable when async titles precede metadata suggestions', () => {
  const before = browseSuggestions(facets, [], '')
  const highlighted = before[0]
  assert.ok(highlighted)
  const key = suggestionKey(highlighted)
  const after = browseSuggestions(
    facets,
    [{ id: 'a', title: 'Solaris', label: 'Solaris' }],
    '',
  )
  const active = after.findIndex((option) => suggestionKey(option) === key)
  assert.equal(active, 1)
  assert.deepEqual(enterSuggestion(after, active), highlighted)
})

test('async title reordering keeps Enter on the highlighted item rather than its old index', () => {
  const first = { id: 'a', title: 'Solaris', label: 'Solaris 1972' }
  const second = { id: 'b', title: 'Solaris', label: 'Solaris 2002' }
  const before = browseSuggestions(facets, [first, second], '')
  const highlighted = before[1]
  assert.ok(highlighted)
  const after = browseSuggestions(facets, [second, first], '')
  const active = after.findIndex(
    (option) => suggestionKey(option) === suggestionKey(highlighted),
  )
  assert.equal(active, 0)
  assert.deepEqual(enterSuggestion(after, active), {
    kind: 'item',
    item: second,
  })
})

test('removed async highlights do not select a metadata filter at the old index', () => {
  const before = browseSuggestions(
    facets,
    [{ id: 'a', title: 'Solaris', label: 'Solaris' }],
    '',
  )
  const highlighted = before[0]
  assert.ok(highlighted)
  const after = browseSuggestions(facets, [], '')
  const active = after.findIndex(
    (option) => suggestionKey(option) === suggestionKey(highlighted),
  )
  assert.equal(active, -1)
  assert.equal(enterSuggestion(after, active), undefined)
})

test('item matches precede metadata filters and unhighlighted Enter only opens items', () => {
  const item = { id: 'a', title: 'Science', label: 'Science' }
  const suggestions = browseSuggestions(facets, [item], 'science')
  assert.deepEqual(suggestions.map(suggestionKey), [
    'item:a',
    'filter:genre:Science fiction',
  ])
  assert.deepEqual(enterSuggestion(suggestions, -1), { kind: 'item', item })
  assert.equal(enterSuggestion(suggestions, 1)?.kind, 'filter')
  assert.equal(enterSuggestion(suggestions, 2), undefined)
})
