import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BrowseField } from '@repo/schemas/browse'
import { albumBrowseFields, filmBrowseFields } from '@repo/schemas/browse'
import {
  getProviderRating,
  getProviderRatings,
  getDetailProviderLinks,
  safeRatingHref,
  metascoreTone,
  ratingDescription,
  providerIconUrl,
  compactRatingStripWidth,
} from './provider-ratings'

const field: BrowseField = {
  key: 'score',
  label: 'Example provider',
  type: 'number',
  filterable: true,
  rating: { provider: 'example', scale: 10, votesKey: 'votes' },
}

test('compact strip width counts only selected public and opted-in runtime ratings', () => {
  const plugin: BrowseField = {
    ...field,
    key: 'plugin.fixture.rating',
    rating: { provider: 'fixture', scale: 100, compact: true },
  }
  assert.equal(compactRatingStripWidth(filmBrowseFields), 150)
  assert.equal(compactRatingStripWidth([...filmBrowseFields, plugin]), 196)
  assert.equal(
    compactRatingStripWidth([...filmBrowseFields, plugin, field]),
    196,
  )
  assert.equal(compactRatingStripWidth(albumBrowseFields), 150)
  assert.equal(compactRatingStripWidth([]), 110)
})

test('trailers are validated separately and not repeated as service links', () => {
  const result = getDetailProviderLinks([], {}, [
    {
      provider: 'youtube-trailer',
      label: 'Trailer',
      url: 'javascript:alert(1)',
    },
    {
      provider: 'youtube-trailer',
      label: 'Trailer',
      url: 'https://youtu.be/Abc_123-xyz',
    },
    {
      provider: 'youtube-trailer',
      label: 'Trailer',
      url: 'https://www.youtube.com/watch?v=Abc_123-xyz',
    },
  ])
  assert.equal(result.trailerUrl, 'https://www.youtube.com/watch?v=Abc_123-xyz')
  assert.deepEqual(result.links, [])
  assert.deepEqual(result.ratings, [])
  assert.equal(
    getDetailProviderLinks([], {}, [
      {
        provider: 'other',
        label: 'Unrelated video',
        url: 'https://youtu.be/Abc_123-xyz',
      },
    ]).trailerUrl,
    undefined,
  )
})

test('shared provider icon resolution allows only local public or embedded runtime marks', () => {
  assert.equal(providerIconUrl('imdb'), '/icons/ratings/imdb.svg')
  assert.equal(
    providerIconUrl('fixture', 'data:image/png;base64,AAAA'),
    'data:image/png;base64,AAAA',
  )
  for (const icon of [
    'https://example.com/icon.png',
    'data:image/svg+xml;base64,AAAA',
    'javascript:alert(1)',
  ])
    assert.equal(providerIconUrl('fixture', icon), undefined)
})

test('uses explicit metadata, never guesses ratings from field names', () => {
  const unrelated: BrowseField = {
    key: 'ratingPersonal',
    label: 'My rating',
    type: 'number',
    filterable: true,
  }
  assert.deepEqual(getProviderRatings([unrelated], { ratingPersonal: 9 }), [])
  assert.equal(getProviderRatings([field], { score: 8.5 }).length, 1)
})

test('detail ratings link to stored destinations, not importer identities', () => {
  const fields: BrowseField[] = [
    { ...field, key: 'imdbScore', rating: { provider: 'imdb', scale: 10 } },
    {
      ...field,
      key: 'metaScore',
      rating: { provider: 'metacritic', scale: 100 },
    },
    { ...field, key: 'rymScore', rating: { provider: 'rym', scale: 5 } },
  ]
  const result = getDetailProviderLinks(
    fields,
    { imdbScore: 8, metaScore: 80, rymScore: 4 },
    [
      {
        provider: 'nfo',
        label: 'IMDb',
        url: 'https://www.imdb.com/title/tt123/',
      },
      {
        provider: 'omdb',
        label: 'IMDb',
        url: 'https://www.imdb.com/title/tt123',
      },
      {
        provider: 'google-custom-search',
        label: 'Metacritic',
        url: 'https://www.metacritic.com/movie/example/',
      },
      {
        provider: 'google-custom-search',
        label: 'RYM / Sonemic',
        url: 'https://rateyourmusic.com/release/album/example/',
      },
    ],
  )
  assert.equal(result.ratings[0]?.href, 'https://www.imdb.com/title/tt123')
  assert.equal(
    result.ratings[1]?.href,
    'https://www.metacritic.com/movie/example/',
  )
  assert.equal(
    result.ratings[2]?.href,
    'https://rateyourmusic.com/release/album/example/',
  )
  assert.deepEqual(result.links, [])
})

test('imported RYM scores link to the actual returned review page', () => {
  const url =
    'https://rateyourmusic.com/music-review/cyarbrough/marina-herlop/dja-dja/302502412'
  const result = getDetailProviderLinks(
    [
      {
        ...field,
        key: 'ratingRymValue',
        rating: { provider: 'rym', scale: 5, votesKey: 'ratingRymVotes' },
      },
    ],
    { ratingRymValue: 3.63, ratingRymVotes: 811 },
    [{ provider: 'imported-ratings', label: 'Rate Your Music', url }],
  )
  assert.equal(result.ratings[0]?.href, url)
  assert.equal(result.ratings[0]?.votes, 811)
  assert.deepEqual(result.links, [])
})

test('missing scores show a linked icon, and Spotify remains available', () => {
  const result = getDetailProviderLinks(
    [{ ...field, rating: { provider: 'imdb', scale: 10 } }],
    {},
    [
      { provider: 'nfo', label: 'IMDb', url: 'https://imdb.com/title/tt123/' },
      {
        provider: 'omdb',
        label: 'IMDb',
        url: 'https://www.imdb.com/title/tt123/',
      },
      {
        provider: 'spotify',
        label: 'Spotify',
        url: 'https://open.spotify.com/album/example/',
      },
    ],
    'https://open.spotify.com/album/example',
  )
  assert.equal(result.ratings.length, 1)
  assert.equal(result.ratings[0]?.score, undefined)
  assert.equal(result.ratings[0]?.href, 'https://imdb.com/title/tt123/')
  assert.equal(result.links.length, 1)
  assert.equal(result.links[0]?.provider, 'spotify')
})

test('new audience ratings preserve scales, individual counts and shared site destinations', () => {
  const result = getDetailProviderLinks(
    filmBrowseFields,
    {
      ratingMetacriticUser: 7.4,
      ratingMetacriticUserVotes: 139,
      ratingTrakt: 73,
      ratingTraktVotes: 2492,
      ratingLetterboxd: 4,
      ratingLetterboxdVotes: 349596,
      ratingRtAudience: 93,
      ratingRtAudienceVotes: 8,
    },
    [
      {
        provider: 'mdblist',
        label: 'Letterboxd',
        url: 'https://letterboxd.com/film/example/',
      },
      {
        provider: 'mdblist',
        label: 'Metacritic',
        url: 'https://www.metacritic.com/movie/example/',
      },
      {
        provider: 'mdblist',
        label: 'Rotten Tomatoes',
        url: 'https://www.rottentomatoes.com/m/example',
      },
    ],
  )
  assert.equal(
    result.ratings.find((rating) => rating.key === 'ratingMetacriticUser')
      ?.href,
    'https://www.metacritic.com/movie/example/',
  )
  assert.equal(
    result.ratings.find((rating) => rating.key === 'ratingRtAudience')?.votes,
    8,
  )
  assert.equal(
    result.ratings.find((rating) => rating.key === 'ratingLetterboxd')?.display
      .scale,
    5,
  )
  assert.equal(
    result.ratings.find((rating) => rating.key === 'ratingTrakt')?.homepageLink,
    true,
  )
  assert.equal(
    result.ratings.find((rating) => rating.key === 'ratingMetascore')?.score,
    undefined,
  )
  assert.deepEqual(result.links, [])
})

test('known references create icon-only entries but unknown providers do not', () => {
  const result = getDetailProviderLinks(filmBrowseFields, {}, [], undefined, [
    {
      provider: 'nfo',
      referenceType: 'imdb',
      externalId: 'tt123',
      isPrimary: true,
      metadata: null,
    },
  ])
  assert.equal(result.ratings.length, 1)
  assert.equal(result.ratings[0]?.display.provider, 'imdb')
  assert.equal(result.ratings[0]?.score, undefined)
  assert.equal(result.ratings[0]?.href, 'https://www.imdb.com/title/tt123/')
  assert.equal(
    ratingDescription(result.ratings[0]),
    'IMDb rating: No rating available.',
  )
  assert.deepEqual(getDetailProviderLinks(filmBrowseFields, {}, []).ratings, [])
})

test('dynamic provider IDs use supplied links and zero ratings are clickable', () => {
  const result = getDetailProviderLinks([field], { score: 0, votes: 0 }, [
    {
      provider: 'example',
      label: 'Example',
      url: 'https://example.com/film/123',
    },
  ])
  assert.equal(result.ratings[0]?.href, 'https://example.com/film/123')
  assert.equal(result.ratings[0]?.votes, 0)
  assert.deepEqual(result.links, [])
})

test('ratings without stored links never invent destinations', () => {
  const result = getDetailProviderLinks([field], { score: 8 }, [])
  assert.equal(result.ratings[0]?.href, undefined)
  assert.equal(result.ratings[0]?.score, 8)
})

test('rejects unsafe destinations and does not match deceptive rating domains', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,test',
    '//example.com',
    '/relative',
    'ftp://example.com',
    'https://user:pass@example.com',
  ]) {
    assert.equal(safeRatingHref(url), undefined)
    assert.deepEqual(
      getDetailProviderLinks([], {}, [
        { provider: 'example', label: 'Example', url },
      ]).links,
      [],
    )
  }
  assert.equal(
    safeRatingHref('https://example.com/item'),
    'https://example.com/item',
  )
  const result = getDetailProviderLinks(
    [{ ...field, rating: { provider: 'imdb', scale: 10 } }],
    { score: 8 },
    [
      {
        provider: 'other',
        label: 'IMDb',
        url: 'https://imdb.com.example.com/film/1',
      },
    ],
  )
  assert.equal(result.ratings[0]?.href, undefined)
  assert.equal(result.links.length, 1)
})

test('aggregated scores without title URLs explicitly link to the provider homepage', () => {
  const result = getDetailProviderLinks(
    [{ ...field, rating: { provider: 'metacritic', scale: 100 } }],
    { score: 80 },
    [],
  )
  assert.equal(result.ratings[0]?.href, 'https://www.metacritic.com/')
  assert.equal(result.ratings[0]?.homepageLink, true)
})

test('preserves real zero scores and vote counts', () => {
  const result = getProviderRating(field, { score: 0, votes: 0 })
  assert.ok(result)
  assert.equal(result.score, 0)
  assert.equal(result.votes, 0)
  assert.equal(
    ratingDescription(result),
    'Example provider: 0 out of 10. 0 votes.',
  )
})

test('rejects absent, invalid and out-of-scale ratings', () => {
  for (const score of [null, '8.5', -1, 11, Infinity, NaN])
    assert.equal(getProviderRating(field, { score }), undefined)
  assert.equal(getProviderRating(field, {}), undefined)
})

test('unknown or invalid vote counts are not presented as zero', () => {
  for (const votes of [null, '937', -1, 2.5, Infinity, NaN]) {
    const result = getProviderRating(field, { score: 8.5, votes })
    assert.ok(result)
    assert.equal(result.votes, undefined)
    assert.match(ratingDescription(result), /Vote count unavailable/)
  }
  const result = getProviderRating(field, { score: 8.5 })
  assert.ok(result)
  assert.match(ratingDescription(result), /Vote count unavailable/)
})

test('includes provider, scale and full vote counts', () => {
  const result = getProviderRating(field, { score: 8.5, votes: 388936 })
  assert.ok(result)
  assert.equal(
    ratingDescription(result),
    'Example provider: 8.5 out of 10. 388,936 votes.',
  )
})

test('retains dynamic icons and labels for every declared provider', () => {
  const plugin: BrowseField = {
    ...field,
    key: 'plugin.score',
    rating: {
      provider: 'example-plugin',
      scale: 100,
      shortLabel: 'EX',
      iconUrl: 'data:image/png;base64,AAAA',
    },
  }
  const results = getProviderRatings([field, plugin], {
    score: 8.5,
    'plugin.score': 84,
  })
  assert.equal(results.length, 2)
  assert.equal(results[1]?.display.iconUrl, plugin.rating?.iconUrl)
  assert.equal(results[1]?.display.shortLabel, 'EX')
})

test('Metascore uses movie/music boundaries and honest review counts', () => {
  assert.equal(metascoreTone(0), 'negative')
  assert.equal(metascoreTone(39), 'negative')
  assert.equal(metascoreTone(40), 'mixed')
  assert.equal(metascoreTone(60), 'mixed')
  assert.equal(metascoreTone(61), 'positive')
  assert.equal(metascoreTone(100), 'positive')
  const result = getProviderRating(
    {
      ...field,
      label: 'Metascore',
      rating: { provider: 'metacritic', scale: 100 },
    },
    { score: 80 },
  )
  assert.ok(result)
  assert.equal(
    ratingDescription(result),
    'Metascore: 80 out of 100. Review count unavailable.',
  )
})
