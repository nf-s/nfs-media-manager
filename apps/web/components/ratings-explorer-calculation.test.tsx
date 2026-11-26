import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  defaultRatingsRankingRequest,
  type RatingsObservation,
  type RatingsSource,
  type RatingsRankingRow,
} from '@repo/schemas/ratings-explorer'
import { RatingsCalculation } from './ratings-explorer-calculation'
import { changeSource } from './ratings-explorer-scoring'

const sources: RatingsSource[] = [
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
].map((label, i) => ({
  label,
  key: 'rating' + i,
  scale: 100,
  hasVotes: false,
  group: 'other',
}))
const settings = defaultRatingsRankingRequest('album').settings
function row(
  adjusted: (number | null)[],
  statuses: RatingsObservation['status'][],
  fields: Omit<
    RatingsRankingRow,
    | 'id'
    | 'title'
    | 'year'
    | 'spread'
    | 'personalGap'
    | 'criticGap'
    | 'ratings'
    | 'artworkUrl'
    | 'credits'
    | 'album'
    | 'tags'
    | 'artistTags'
    | 'watched'
    | 'plays'
  >,
): RatingsRankingRow {
  return {
    ...fields,
    id: 'fixture',
    title: 'Glass Signals',
    artworkUrl: null,
    credits: [],
    album: null,
    tags: [],
    artistTags: [],
    watched: null,
    plays: null,
    year: null,
    spread: null,
    personalGap: null,
    criticGap: null,
    ratings: adjusted.map((value, i) => ({
      key: 'rating' + i,
      raw: value,
      adjusted: value,
      center: 50,
      votes: null,
      status: statuses[i] ?? 'missing',
    })),
  }
}
test('the mean and missing contribution reproduce the displayed combined score', () => {
  const [first] = sources
  assert.ok(first)
  const weighted = changeSource(
    { ...settings, normalization: 'scale' },
    first,
    { weight: 2 },
  )
  const html = renderToStaticMarkup(
    <RatingsCalculation
      sources={sources.slice(0, 3)}
      library="album"
      settings={weighted}
      onClose={() => {}}
      row={row([80, 20, null], ['counted', 'counted', 'missing'], {
        core: 60,
        score: 205 / 3.5,
        observedWeight: 3,
        missingWeight: 0.5,
        missingSum: 25,
        counted: 2,
      })}
    />,
  )
  assert.match(html, /\(80 × 2 \+ 20 × 1\) ÷ 3 ≈ 60/)
  assert.match(html, /50 × 0.5 ≈ 25/)
  assert.match(html, /\(60 × 3 \+ 25\) ÷ \(3 \+ 0.5\) ≈ 58.57/)
  assert.match(html, /58.57 \/ 100/)
  assert.deepEqual(changeSource(weighted, first, { weight: 1 }), {
    ...settings,
    normalization: 'scale',
  })
})

test('trimmed extremes leave the mean but retain their qualifying weight', () => {
  const html = renderToStaticMarkup(
    <RatingsCalculation
      sources={sources}
      library="album"
      settings={{ ...settings, combine: 'trimmed' }}
      onClose={() => {}}
      row={row(
        [0, 40, 60, 100, null],
        ['trimmed', 'counted', 'counted', 'trimmed', 'missing'],
        {
          core: 50,
          score: 50,
          observedWeight: 4,
          missingWeight: 0.5,
          missingSum: 25,
          counted: 4,
        },
      )}
    />,
  )
  assert.match(html, /\(40 × 1 \+ 60 × 1\) ÷ 2 ≈ 50/)
  assert.match(html, /\(50 × 4 \+ 25\) ÷ \(4 \+ 0.5\) ≈ 50.00/)
  assert.equal(html.match(/Qualified, trimmed from mean/g)?.length, 2)
})

test('an unscored item names its qualifying shortfall', () => {
  const html = renderToStaticMarkup(
    <RatingsCalculation
      sources={sources.slice(0, 2)}
      library="film"
      settings={settings}
      onClose={() => {}}
      row={row([0, null], ['counted', 'missing'], {
        core: 0,
        score: null,
        observedWeight: 1,
        missingWeight: 0.5,
        missingSum: 25,
        counted: 1,
      })}
    />,
  )
  assert.match(html, /Needs 1 more qualifying rating to reach the minimum of 2/)
  assert.match(html, /\(0 × 1\) ÷ 1 ≈ 0/)
  assert.match(html, /Unscored/)
})
