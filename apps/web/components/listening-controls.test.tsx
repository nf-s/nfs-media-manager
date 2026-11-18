import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ListeningFilter } from '@repo/schemas/listening'
import { ListeningControls, ListeningFilterPills } from './listening-controls'

const unchanged = () =>
  assert.fail('Rendering must not change the browse query')

function render(props: Partial<ComponentProps<typeof ListeningControls>>) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ListeningControls
        apiBaseUrl=""
        library="album"
        params={new URLSearchParams()}
        filter={undefined}
        sortPeriod={undefined}
        total={undefined}
        examples={[]}
        onFilterChange={unchanged}
        onSortPeriodChange={unchanged}
        {...props}
      />
    </QueryClientProvider>,
  )
}

const twoConditions: ListeningFilter = {
  match: 'all',
  rules: [
    { period: { kind: 'all' }, max: 6 },
    { period: { kind: 'rolling', amount: 90, unit: 'days' }, min: 5 },
  ],
}

test('the section opens on the histogram with nothing chosen', () => {
  const html = render({ total: 128 })
  assert.match(html, /<h3>Show albums with<\/h3>/)
  assert.match(html, /aria-label="View"/)
  assert.match(html, /aria-pressed="true"[^>]*>Histogram<\/button>/)
  assert.match(html, /aria-pressed="false"[^>]*>Rules<\/button>/)
  assert.match(html, /aria-label="Period"/)
  assert.match(html, /aria-pressed="true"[^>]*>1y<\/button>/)
  assert.match(html, /aria-label="Number of track plays"/)
  assert.equal(html.match(/class="ds-hist-bar"/g)?.length, 8)
  assert.match(html, /aria-label="200 or more track plays"/)
  assert.match(html, /Select one bar, or a first and last bar/)
  assert.match(html, /<h3>Matching albums<\/h3>/)
  assert.match(html, /class="ds-mono">128<\/span>/)
  assert.match(html, /Period for the Scrobbles column and sort/)
  assert.match(html, /<option value="r1y" selected="">Last year<\/option>/)
  assert.match(html, /Dates use UTC/)
  // No filter yet: no sentence, no Match, nothing to clear or apply.
  assert.doesNotMatch(html, /aria-label="Match"/)
  assert.doesNotMatch(html, /Clear listening filter/)
  assert.doesNotMatch(html, /Apply/)
})

test('a stored filter is edited one condition at a time and read back as a sentence', () => {
  const html = render({
    filter: twoConditions,
    sortPeriod: { kind: 'rolling', amount: 6, unit: 'months' },
    total: 0,
  })
  assert.match(html, /<details class="browse-disclosure" open="">/)
  assert.match(html, /aria-label="Match"/)
  assert.match(html, /<option value="all" selected="">all conditions<\/option>/)
  // The first condition is on the histogram: bars inside "at most 6" are
  // selected and the bar it only partly covers is marked.
  assert.match(html, /aria-pressed="true"[^>]*>All<\/button>/)
  assert.equal(
    html.match(/class="ds-hist-bar" aria-pressed="true"/g)?.length,
    2,
  )
  assert.equal(html.match(/data-partial=""/g)?.length, 1)
  // The other folds to a line.
  assert.match(html, /At least 5 track plays · last 90 days/)
  assert.match(html, />Edit<\/button>/)
  assert.equal(html.match(/aria-label="Remove condition"/g)?.length, 2)
  assert.match(
    html,
    /At most 6 track plays in total and at least 5 track plays in the last 90 days\./,
  )
  assert.match(html, /No example albums match this filter\./)
  assert.match(html, />Clear listening filter<\/button>/)
  // A period the select does not name is entered by hand.
  assert.match(
    html,
    /<option value="custom" selected="">Other period…<\/option>/,
  )
  assert.match(html, /aria-label="Amount"[^>]+value="6"/)
  assert.match(html, /<option value="months" selected="">months<\/option>/)
})

test('matching items are listed and each library names its own plays', () => {
  const html = render({
    library: 'track',
    filter: { match: 'any', rules: [{ period: { kind: 'all' }, min: 100 }] },
    total: 2,
    examples: [
      { id: 'one', title: 'Harbour Lights', by: 'Mira Kestrel' },
      { id: 'two', title: 'Sodium Glow' },
    ],
  })
  assert.match(html, /<h3>Show tracks with<\/h3>/)
  assert.match(html, /aria-label="Number of plays"/)
  assert.match(html, /At least 100 plays in total\./)
  assert.match(html, /Harbour Lights/)
  assert.match(html, /Mira Kestrel/)
  assert.match(html, /Sodium Glow/)
  assert.doesNotMatch(html, /No example tracks match/)
  assert.match(html, /Plays are the synced Last\.fm scrobbles of each track/)
  // One condition needs no Match.
  assert.doesNotMatch(html, /aria-label="Match"/)
})

test('adding conditions stops at the shared ten-condition limit', () => {
  const html = render({
    library: 'artist',
    filter: {
      match: 'any',
      rules: Array.from({ length: 10 }, () => ({
        period: { kind: 'all' },
        min: 1,
      })),
    },
  })
  assert.match(html, /disabled=""[^>]*>.*?Add period<\/button>/)
})

test('active filter pills say what the section says', () => {
  const html = renderToStaticMarkup(
    <ListeningFilterPills filter={twoConditions} onChange={unchanged} />,
  )
  assert.match(html, /Required · At most 6 track plays · all time/)
  assert.match(html, /Required · At least 5 track plays · last 90 days/)
  assert.match(
    html,
    /aria-label="Remove listening condition: At most 6 track plays · all time"/,
  )
  assert.equal(
    renderToStaticMarkup(
      <ListeningFilterPills filter={undefined} onChange={unchanged} />,
    ),
    '',
  )
})
