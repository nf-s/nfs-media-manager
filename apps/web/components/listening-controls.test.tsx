import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListeningControls } from './listening-controls'

test('listening filters expose editable simultaneous windows and all/any matching', () => {
  const html = renderToStaticMarkup(
    <ListeningControls
      filter={{
        match: 'all',
        rules: [
          { period: { kind: 'rolling', amount: 2, unit: 'years' }, max: 9 },
          { period: { kind: 'dates', to: '2020-12-31' }, min: 100 },
        ],
      }}
      sortPeriod={{ kind: 'rolling', amount: 6, unit: 'months' }}
      sorting={true}
      onFilterChange={() => assert.fail('Rendering must not change filters')}
      onSortChange={() => assert.fail('Rendering must not change sorting')}
    />,
  )
  assert.match(html, /Listening \(2\)/)
  assert.match(html, /aria-label="Match listening rules"/)
  assert.match(html, />All rules<\/option>/)
  assert.match(html, />Any rule<\/option>/)
  assert.match(html, /aria-label="Rule 1 maximum scrobbles"[^>]+value="9"/)
  assert.match(html, /aria-label="Rule 2 minimum scrobbles"[^>]+value="100"/)
  assert.match(html, /aria-label="Rule 2 through date"[^>]+value="2020-12-31"/)
  assert.match(html, /aria-label="Remove listening rule 1"/)
  assert.match(html, /aria-label="Remove listening rule 2"/)
  assert.match(html, />Apply rules<\/button>/)
  assert.match(html, />Clear rules<\/button>/)
  assert.match(html, /aria-label="Sort period amount"[^>]+value="6"/)
  assert.match(html, />Update sort period<\/button>/)
  assert.match(html, /dates use UTC/)
})

test('initial draft does not apply a filter before explicit submission', () => {
  const html = renderToStaticMarkup(
    <ListeningControls
      filter={undefined}
      sortPeriod={undefined}
      sorting={false}
      onFilterChange={() => assert.fail('Rendering must not change filters')}
      onSortChange={() => assert.fail('Rendering must not change sorting')}
    />,
  )
  assert.match(html, /class="toolbar-popover"/)
  assert.match(html, /aria-label="Rule 1 period amount"[^>]+value="2"/)
  assert.match(html, /aria-label="Rule 1 maximum scrobbles"[^>]+value="10"/)
  assert.match(html, />Sort by scrobbles<\/button>/)
  assert.doesNotMatch(html, />Clear rules<\/button>/)
  assert.match(html, /not full album plays/)
})

test('adding rules stops at the shared ten-rule limit', () => {
  const html = renderToStaticMarkup(
    <ListeningControls
      filter={{
        match: 'any',
        rules: Array.from({ length: 10 }, () => ({
          period: { kind: 'all' },
          min: 1,
        })),
      }}
      sortPeriod={undefined}
      sorting={false}
      onFilterChange={() => {}}
      onSortChange={() => {}}
    />,
  )
  assert.match(html, /disabled=""[^>]*>.*?Add rule<\/button>/)
})
