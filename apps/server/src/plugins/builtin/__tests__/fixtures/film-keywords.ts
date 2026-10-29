import type { JsonRecord } from '@/lib/provider-normalizers'

// Reduced maintainer documentation example (not a live API capture):
// https://github.com/linaspurinis/api.mdblist.com/blob/8aa0843ec6166dead8475a0c086d43bbec3a7b19/apiary.apib#L1389
export const mdblistDocumentedFixture = {
  id: 128773,
  title: 'The Phantom of the Convent',
  ids: { imdb: 'tt0025100', tmdb: 184940, mdblist: '2rd1' },
  type: 'movie',
  keywords: [
    { id: 96, name: 'monk' },
    { id: 6325, name: 'convent-nunnery' },
    { id: 51341, name: 'mexican-horror' },
    { id: 80325, name: 'lost-in-woods' },
  ],
} satisfies JsonRecord

// Synthetic fixtures, not responses captured from a live account.
export const mdblistMovieFixture = {
  ids: { imdb: 'tt0133093', tmdb: 603 },
  title: 'Aggregator title must not overwrite the library',
  poster: 'https://images.example/aggregator.jpg',
  type: 'movie',
  keywords: [
    'imdb.cyber-punk',
    'tmdb.virtual-reality',
    'trakt.space-opera',
    'mdblist.has-trailer',
    'imdb-tv-movie',
    '4k-blu-ray',
    '  IMDb.artificial-intelligence  ',
    'unknown.namespace.some-token',
    'unknown:other-token',
    'unknown-prefix-token',
    'imdbish.not-a-prefix',
    'imdb.cyber-punk',
    'tmdb.cyber-punk',
    '',
    '  ',
    'imdb.',
    '---',
    'N/A',
  ].map((name, index) => ({ id: index + 1, name })),
  lists: [{ id: 1, name: 'Not a documented per-film field' }],
  extra: { retained: true },
} satisfies JsonRecord

export const tmdbMovieFixture: JsonRecord = {
  id: 603,
  imdb_id: 'tt0133093',
  title: 'The Matrix',
  genres: [{ id: 878, name: 'Science Fiction' }],
  credits: { cast: [{ name: 'Keanu Reeves' }], crew: [] },
  keywords: {
    keywords: [
      { id: 310, name: 'artificial intelligence' },
      { id: 456, name: 'science-fiction' },
      { id: 789, name: '  Mixed Case  ' },
      { id: 111, name: 'tmdb.keep-prefix' },
      { id: 0, name: 'invalid zero' },
      { id: -1, name: 'invalid negative' },
      { id: 1.5, name: 'invalid fraction' },
      { id: '123', name: 'invalid string id' },
      { id: 2, name: 42 },
      { id: 3, name: '' },
      { id: 4, name: '  ' },
      { name: 'missing id' },
      { id: 5 },
      null,
      'unknown',
      42,
    ],
  },
}
