import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  RatingsObservation,
  RatingsSource,
} from '@repo/schemas/ratings-explorer'
import { RatingDifference } from '@repo/ui/components/ds/ratings-explorer'
import {
  furthestRating,
  rankingSourceColumns,
} from './ratings-explorer-ranking'

test('available native rating columns precede registry additions and preserve their full sort labels', () => {
  const sources = [
    { key: 'fixturePanel', label: 'Fixture panel', shortLabel: 'Panel' },
    { key: 'ratingLetterboxd', label: 'Letterboxd' },
    { key: 'ratingTmdbValue', label: 'TMDb rating' },
    { key: 'fixtureAudience', label: 'Fixture audience' },
  ].map(
    (source): RatingsSource => ({
      ...source,
      group: 'audience',
      scale: 10,
      hasVotes: false,
    }),
  )
  assert.deepEqual(
    rankingSourceColumns(sources, 'film').map(({ label, sortLabel }) => [
      label,
      sortLabel,
    ]),
    [
      ['TMDb', 'TMDb rating'],
      ['Lbxd', 'Letterboxd'],
      ['Panel', 'Fixture panel'],
      ['Fixture audience', 'Fixture audience'],
    ],
  )
})

function observation(
  key: string,
  adjusted: number,
  status: RatingsObservation['status'] = 'counted',
): RatingsObservation {
  return { key, adjusted, raw: adjusted, center: 50, votes: null, status }
}

test('Furthest uses three qualified ratings, the mean of the others and a ten-point threshold', () => {
  const ratings = [
    observation('first', 20),
    observation('second', 30),
    observation('third', 30, 'trimmed'),
    observation('disabled', 100, 'disabled'),
  ]
  assert.deepEqual(furthestRating({ ratings }), {
    key: 'first',
    difference: -10,
  })
  assert.equal(furthestRating({ ratings: ratings.slice(0, 2) }), null)
  assert.equal(
    furthestRating({ ratings: [observation('a', 21), ...ratings.slice(1)] }),
    null,
  )
  assert.deepEqual(
    furthestRating({
      ratings: [
        observation('a', 0),
        observation('b', 50),
        observation('c', 100),
      ],
    }),
    { key: 'a', difference: -75 },
  )
})

test('source cells distinguish qualified ratings, zero weights and exclusions while keeping their calculation button', () => {
  const cell = (difference: number, status: RatingsObservation['status']) =>
    renderToStaticMarkup(
      <RatingDifference
        compact
        value="8.0"
        label="Rating"
        difference={difference}
        status={status}
        onClick={() => {}}
      />,
    )
  const qualifiedStates: RatingsObservation['status'][] = ['counted', 'trimmed']
  const excludedStates: RatingsObservation['status'][] = ['votes', 'outlier']
  const evidenceStates: RatingsObservation['status'][] = [
    'disabled',
    ...excludedStates,
  ]
  for (const status of qualifiedStates) {
    assert.match(cell(20, status), /data-direction="high"/)
    assert.match(cell(-20, status), /data-direction="low"/)
    assert.doesNotMatch(cell(19.99, status), /data-direction/)
    assert.doesNotMatch(cell(20, status), /<s>/)
  }
  const zeroWeight = cell(25, 'disabled')
  assert.match(zeroWeight, /data-status="disabled"/)
  assert.doesNotMatch(zeroWeight, /data-direction|<s>/)
  for (const status of excludedStates) {
    const excluded = cell(25, status)
    assert.match(excluded, /<s>8.0<\/s>/)
    assert.doesNotMatch(excluded, /data-direction/)
  }
  for (const status of evidenceStates) {
    const evidence = cell(25, status)
    assert.match(evidence, /<button type="button"/)
    assert.doesNotMatch(evidence, / disabled(?:=| |>)/)
    assert.match(evidence, /aria-label="Rating, 8.0 \(\+25.0\)"/)
  }
})
