import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RatingsObservation } from '@repo/schemas/ratings-explorer'
import { RatingDifference } from '@repo/ui/components/ds/ratings-explorer'
import { furthestRating } from './ratings-explorer-ranking'

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

test('compact source cells highlight twenty-point distances and strike excluded observations', () => {
  const cell = (difference: number, excluded = false) =>
    renderToStaticMarkup(
      <RatingDifference
        compact
        value="8.0"
        label="Rating"
        difference={difference}
        excluded={excluded}
        onClick={() => {}}
      />,
    )
  assert.match(cell(20), /data-direction="high"/)
  assert.match(cell(-20), /data-direction="low"/)
  assert.doesNotMatch(cell(19.99), /data-direction/)
  const missing = cell(25, true)
  assert.match(missing, /<s>8.0<\/s>/)
  assert.doesNotMatch(missing, /data-direction/)
})
