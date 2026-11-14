import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  browseSuggestions,
  matchingTitleFilters,
  matchTier,
  matchTiers,
  suggestionKey,
  titleSuggestions,
  type FilterSuggestion,
  type TitleSuggestion,
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
  const items = titleSuggestions([
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
  ])
  assert.match(items[0]?.label ?? '', /1972.*Andrei Tarkovsky/)
  assert.match(items[1]?.label ?? '', /2002.*Steven Soderbergh/)
  const options = browseSuggestions(facets, items, 'solaris')
  assert.deepEqual(options.map(suggestionKey), [
    'item:film-1972',
    'item:film-2002',
  ])
})

test('album titles show artists, and otherwise identical results retain ID disambiguation', () => {
  const album = {
    title: 'Same',
    releaseDate: null,
    credits: [{ name: 'Artist', role: 'artist', billingOrder: 0 }],
  }
  const items = titleSuggestions([
    { ...album, id: 'a', mediaType: 'album' },
    { ...album, id: 'b', mediaType: 'album' },
  ])
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
})

test('highlight identity remains stable when async titles join the list', () => {
  const before = browseSuggestions(facets, [], 'exam')
  const highlighted = before[0]
  assert.ok(highlighted)
  const after = browseSuggestions(
    facets,
    [{ id: 'a', title: 'Exam', label: 'Exam' }],
    'exam',
  )
  assert.deepEqual(after.map(suggestionKey), [
    'item:a',
    'filter:provider:example',
  ])
  const active = after.findIndex(
    (option) => suggestionKey(option) === suggestionKey(highlighted),
  )
  assert.equal(active, 1)
  assert.deepEqual(after[active], highlighted)
})

test('titles at the same match tier keep a stable order whatever order they arrive in', () => {
  const first = { id: 'a', title: 'Solaris', label: 'Solaris 1972' }
  const second = { id: 'b', title: 'Solaris', label: 'Solaris 2002' }
  assert.deepEqual(
    browseSuggestions(facets, [second, first], 'solaris').map(suggestionKey),
    browseSuggestions(facets, [first, second], 'solaris').map(suggestionKey),
  )
  assert.deepEqual(
    browseSuggestions(facets, [second, first], 'solaris').map(suggestionKey),
    ['item:a', 'item:b'],
  )
})

test('match tiers: exact, whole-text prefix, word prefix, then substring', () => {
  assert.equal(matchTier('Rock', 'ROCK'), matchTiers.exact)
  assert.equal(matchTier('Rock and roll', 'rock'), matchTiers.prefix)
  assert.equal(matchTier('Indie rock', 'rock'), matchTiers.wordPrefix)
  assert.equal(matchTier('Post-rock', 'rock'), matchTiers.wordPrefix)
  assert.equal(matchTier('Krautrock', 'rock'), matchTiers.substring)
  assert.equal(
    matchTier('Science fiction', 'science fiction'),
    matchTiers.exact,
  )
  assert.equal(
    matchTier('Hard science fiction', 'fiction sci'),
    matchTiers.wordPrefix,
  )
  assert.equal(matchTier('Science fiction', 'tags science'), matchTiers.prefix)
  assert.equal(matchTier('Science fiction', 'tags'), matchTiers.substring)
})

const tags = (values: [string, number][]): FilterSuggestion[] =>
  values.map(([value, count]) => ({
    field: 'genre',
    value,
    label: `Tags: ${value}`,
    count,
  }))

test('ranking mixes filters and titles by match tier, ignoring the order they arrive in', () => {
  const options = tags([
    ['Krautrock', 900],
    ['Indie rock', 40],
    ['Rock and roll', 5],
    ['Rock', 30],
  ])
  const items: TitleSuggestion[] = [
    { id: 'bedrock', title: 'Bedrock', label: 'Bedrock' },
    { id: 'rock-on', title: 'Rock On', label: 'Rock On' },
  ]
  assert.deepEqual(
    browseSuggestions(options, items, 'rock').map(suggestionKey),
    [
      'filter:genre:Rock',
      'filter:genre:Rock and roll',
      'item:rock-on',
      'filter:genre:Indie rock',
      'filter:genre:Krautrock',
      'item:bedrock',
    ],
  )
})

test('within a tier, broader filters rank first and a large substring match never beats an exact one', () => {
  const options = tags([
    ['Bluegrass', 1],
    ['Blues rock', 300],
    ['Blues', 2],
    ['Delta blues', 20],
    ['Bluesy', 80],
    ['Nublues', 5000],
  ])
  assert.deepEqual(
    browseSuggestions(options, [], 'blues').map(
      (option) => option.kind === 'filter' && option.filter.value,
    ),
    ['Blues', 'Blues rock', 'Bluesy', 'Delta blues', 'Nublues'],
  )
})

test('at equal match quality filters precede titles', () => {
  const options = tags([['Jazz', 3]])
  const items: TitleSuggestion[] = [
    { id: 'jazz', title: 'Jazz', label: 'Jazz' },
  ]
  assert.deepEqual(
    browseSuggestions(options, items, 'jazz').map(suggestionKey),
    ['filter:genre:Jazz', 'item:jazz'],
  )
})

test('neither kind fills the first screen while the other has a word-prefix match', () => {
  const options = tags(
    [
      'Ambient',
      'Ambient pop',
      'Ambient techno',
      'Ambient house',
      'Ambient dub',
    ].map((value, index): [string, number] => [value, 100 - index]),
  )
  const items: TitleSuggestion[] = [
    { id: 'a', title: 'Ambient 1', label: 'Ambient 1' },
    { id: 'b', title: 'Ambient 2', label: 'Ambient 2' },
    { id: 'c', title: 'Dark ambient', label: 'Dark ambient' },
  ]
  assert.deepEqual(
    browseSuggestions(options, items, 'ambient').map(suggestionKey),
    [
      'filter:genre:Ambient',
      'filter:genre:Ambient pop',
      'filter:genre:Ambient techno',
      'item:a',
      'filter:genre:Ambient house',
      'filter:genre:Ambient dub',
      'item:b',
      'item:c',
    ],
  )
  const exactTitles: TitleSuggestion[] = ['1', '2', '3', '4'].map((id) => ({
    id,
    title: 'Ambient',
    label: `Ambient ${id}`,
  }))
  assert.deepEqual(
    browseSuggestions(tags([['Dark ambient', 50]]), exactTitles, 'ambient').map(
      suggestionKey,
    ),
    ['item:1', 'item:2', 'item:3', 'filter:genre:Dark ambient', 'item:4'],
  )
  assert.deepEqual(
    browseSuggestions(tags([['Darkambient', 50]]), exactTitles, 'ambient').map(
      suggestionKey,
    ),
    ['item:1', 'item:2', 'item:3', 'item:4', 'filter:genre:Darkambient'],
  )
})

test('ranking is deterministic and keeps the 100-suggestion cap', () => {
  const options = tags(
    Array.from({ length: 120 }, (_, index): [string, number] => [
      `Tag ${String(index).padStart(3, '0')}`,
      (index % 3) + 1,
    ]),
  )
  const items: TitleSuggestion[] = Array.from({ length: 30 }, (_, index) => ({
    id: `item-${index}`,
    title: `Tag title ${index}`,
    label: `Tag title ${index}`,
  }))
  const ranked = browseSuggestions(options, items, 'tag').map(suggestionKey)
  assert.equal(ranked.length, 100)
  assert.deepEqual(
    browseSuggestions([...options].reverse(), [...items].reverse(), 'tag').map(
      suggestionKey,
    ),
    ranked,
  )
})
