import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ProviderRatings, { ProviderRatingBadge } from './provider-ratings'
import type { ProviderRating } from '../utils/provider-ratings'

const rating: ProviderRating = {
  key: 'ratingLetterboxd',
  label: 'Letterboxd',
  display: { provider: 'letterboxd', scale: 5 },
  score: 4.2,
  votes: 12345,
  href: 'https://letterboxd.com/film/example/',
}

test('cards and rows only show selected public ratings and explicitly opted-in runtime ratings', () => {
  const ratings: ProviderRating[] = [
    ...[
      'imdb',
      'metacritic',
      'letterboxd',
      'tmdb',
      'metacriticuser',
      'trakt',
      'rottentomatoes',
      'rottentomatoes-audience',
    ].map((provider) => ({
      ...rating,
      key: provider,
      label: provider,
      display: { provider, scale: 100 },
    })),
    {
      ...rating,
      key: 'plugin.fixture.rating',
      label: 'Fixture rating',
      display: { provider: 'fixture', scale: 100, compact: true },
    },
    {
      ...rating,
      key: 'plugin.other.rating',
      label: 'Other rating',
      display: { provider: 'other', scale: 100 },
    },
  ]
  for (const context of ['poster', 'table'] satisfies Array<
    'poster' | 'table'
  >) {
    const html = renderToStaticMarkup(
      <ProviderRatings ratings={ratings} context={context} />,
    )
    assert.equal((html.match(/<a /g) ?? []).length, 4)
    for (const label of ['imdb', 'metacritic', 'letterboxd', 'Fixture rating'])
      assert.ok(html.includes(`aria-label="${label}:`))
    for (const label of [
      'tmdb',
      'metacriticuser',
      'trakt',
      'rottentomatoes',
      'Other rating',
    ])
      assert.ok(!html.includes(`aria-label="${label}:`))
  }
  const detail = renderToStaticMarkup(
    <ProviderRatings ratings={ratings} context="detail" />,
  )
  assert.equal((detail.match(/<a /g) ?? []).length, ratings.length)
})

test('trailer uses a local YouTube logo and safe external anchor even without ratings', () => {
  const html = renderToStaticMarkup(
    <ProviderRatings
      ratings={[]}
      context="detail"
      trailerUrl="https://youtu.be/Abc_123-xyz"
    />,
  )
  assert.match(html, /href="https:\/\/www.youtube.com\/watch\?v=Abc_123-xyz"/)
  assert.match(html, /\/icons\/ratings\/youtube.svg/)
  assert.match(html, /Watch trailer on YouTube/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /<iframe|<button/)
  assert.equal(
    renderToStaticMarkup(
      <ProviderRatings
        ratings={[]}
        context="detail"
        trailerUrl="https://youtube.com.evil.example/watch?v=Abc_123-xyz"
      />,
    ),
    '',
  )
  for (const context of ['poster', 'table'] satisfies Array<
    'poster' | 'table'
  >) {
    assert.equal(
      renderToStaticMarkup(
        <ProviderRatings
          ratings={[]}
          context={context}
          trailerUrl="https://youtu.be/Abc_123-xyz"
        />,
      ),
      '',
    )
  }
})

test('album ratings remain visible in compact strips', () => {
  const ratings = ['rym', 'discogs', 'metacritic'].map((provider) => ({
    ...rating,
    key: provider,
    display: { provider, scale: 100 },
  }))
  const html = renderToStaticMarkup(
    <ProviderRatings ratings={ratings} context="table" />,
  )
  assert.equal((html.match(/<a /g) ?? []).length, 3)
})

test('rating anchors open the source without external arrows or nested buttons', () => {
  const html = renderToStaticMarkup(<ProviderRatingBadge rating={rating} />)
  assert.match(html, /href="https:\/\/letterboxd.com\/film\/example\/"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /12,345 votes/)
  assert.doesNotMatch(html, /<button|<svg|arrow-up-right/)
})

test('missing score renders only the provider mark, not a placeholder or zero', () => {
  const html = renderToStaticMarkup(
    <ProviderRatingBadge
      rating={{ ...rating, score: undefined, votes: undefined }}
    />,
  )
  assert.match(html, /letterboxd.svg/)
  assert.match(html, /No rating available/)
  assert.doesNotMatch(html, /class="rating-score|<button|arrow-up-right/)
})

test('missing Metascore has a real icon rather than a colored zero', () => {
  const html = renderToStaticMarkup(
    <ProviderRatingBadge
      rating={{
        ...rating,
        display: { provider: 'metacritic', scale: 100 },
        score: undefined,
      }}
    />,
  )
  assert.match(html, /metacritic.svg/)
  assert.doesNotMatch(html, /rating-negative|rating-positive|rating-mixed/)
})

test('all new ratings have local marks, including audience popcorn', () => {
  for (const [provider, icon] of [
    ['metacriticuser', 'metacritic'],
    ['trakt', 'trakt'],
    ['letterboxd', 'letterboxd'],
    ['rottentomatoes-audience', 'popcorn'],
  ]) {
    if (!provider || !icon) throw new Error('Incomplete icon fixture')
    const html = renderToStaticMarkup(
      <ProviderRatingBadge
        rating={{ ...rating, display: { provider, scale: 100 } }}
      />,
    )
    assert.ok(html.includes(`/icons/ratings/${icon}.svg`))
    assert.doesNotMatch(html, /rating-label/)
  }
})
