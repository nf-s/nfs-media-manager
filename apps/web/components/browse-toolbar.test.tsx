import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  matchSortOptions,
  SortPicker,
} from '@repo/ui/components/ds/sort-picker'
import BrowseToolbar, { BrowseViewSection } from './browse-toolbar'

const fields = [
  { key: 'title', label: 'Title' },
  { key: 'duration', label: 'Duration' },
  { key: 'rating', label: 'Rating' },
  { key: 'userRating', label: 'Your rating' },
  { key: 'released', label: 'Released (first issue)' },
] as const

type Key = (typeof fields)[number]['key']

function toolbar(props: Partial<Parameters<typeof BrowseToolbar<Key>>[0]>) {
  return renderToStaticMarkup(
    <BrowseToolbar<Key>
      search={<input type="search" aria-label="Search" />}
      sort={{
        key: 'rating',
        direction: 'desc',
        options: fields,
        onChange: () => {},
        onDirectionChange: () => {},
      }}
      view="grid"
      onViewChange={() => {}}
      density={{ value: 'standard', onChange: () => {} }}
      count="12 tracks"
      {...props}
    />,
  )
}

test('the sort picker names the chosen field and lists every field', () => {
  const html = renderToStaticMarkup(
    <SortPicker value="released" options={fields} onChange={() => {}} />,
  )
  // The button is the select's box; the full name is its title.
  assert.match(
    html,
    /<button type="button" class="ds-select ds-sort" aria-haspopup="listbox" aria-expanded="false"[^>]*aria-label="Sort by: Released \(first issue\)" title="Released \(first issue\)"[^>]*>Released \(first issue\)<\/button>/,
  )
  assert.match(
    html,
    /<input type="search" role="combobox" aria-label="Find a field"/,
  )
  assert.match(html, /role="listbox" aria-label="Sort by"/)
  assert.equal((html.match(/role="option"/g) ?? []).length, fields.length)
  // Only the chosen field is selected, and it carries the check mark.
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.match(
    html,
    /aria-selected="true" data-active="" class="ds-menu-item"><svg[^>]*lucide-check[^>]*>.*?<\/svg>Released \(first issue\)<\/button>/,
  )
  assert.match(html, /<span class="ds-menu-slot"><\/span>Title<\/button>/)
})

test('typing in the sort picker puts names that start with the text first', () => {
  const labels = (query: string) =>
    matchSortOptions(fields, query).map(({ label }) => label)
  assert.deepEqual(
    labels(''),
    fields.map(({ label }) => label),
  )
  // Duration holds "rat" too, but Rating starts with it and Your rating has a word that does.
  assert.deepEqual(labels('rat'), ['Rating', 'Your rating', 'Duration'])
  assert.deepEqual(labels('  RELEASED '), ['Released (first issue)'])
  assert.deepEqual(labels('nothing'), [])
})

test('the toolbar order is search, sort, direction, view, Filters, count', () => {
  const html = toolbar({ filterCount: 2, filters: <p>Ranges</p> })
  const order = [
    'aria-label="Search"',
    'class="ds-select ds-sort"',
    'aria-label="Sort ascending"',
    'aria-label="Browse views"',
    'data-filters="full"',
    'class="ds-toolbar-count"',
  ].map((part) => html.indexOf(part))
  assert.ok(order.every((at) => at >= 0))
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  )
  // One button for filters, columns and grid size: its name, and the count for short rows.
  assert.match(
    html,
    /aria-label="Filters, columns and grid size, 2 filters on"[^>]*>.*?<span>Filters · 2<\/span><span class="ds-count">2<\/span><\/button>/,
  )
  // Grid size and the drawer's sections are not on the toolbar.
  assert.doesNotMatch(html, /Grid size|Compact|Ranges|ds-filterline/)
})

test('one filter on reads as one filter, and none shows no count', () => {
  assert.match(
    toolbar({ filterCount: 1, filters: <p>Ranges</p> }),
    /aria-label="Filters, columns and grid size, 1 filter on"/,
  )
  const none = toolbar({ filters: <p>Ranges</p> })
  assert.match(
    none,
    /aria-label="Filters, columns and grid size"[^>]*>.*?<span>Filters<\/span><\/button>/,
  )
  assert.doesNotMatch(none, /ds-count/)
})

test('the Filters button is there for grid size alone, and absent with nothing to open', () => {
  assert.match(toolbar({}), /data-filters="full"/)
  assert.doesNotMatch(toolbar({ view: 'table' }), /data-filters/)
  assert.match(
    toolbar({ view: 'table', viewOptions: <p>Group recordings</p> }),
    /data-filters="full"/,
  )
})

test('the View section starts with grid size in the Grid view, then the list’s own options', () => {
  const grid = renderToStaticMarkup(
    <BrowseViewSection
      view="grid"
      density={{ value: 'roomy', onChange: () => {} }}
    >
      <label>Group recordings</label>
    </BrowseViewSection>,
  )
  assert.match(grid, /<span>View<\/span>/)
  assert.match(
    grid,
    /role="group" aria-label="Grid size"><button type="button" aria-pressed="false">Compact<\/button><button type="button" aria-pressed="false">Standard<\/button><button type="button" aria-pressed="true">Roomy<\/button><\/div><label>Group recordings<\/label>/,
  )
  const table = renderToStaticMarkup(
    <BrowseViewSection
      view="table"
      density={{ value: 'roomy', onChange: () => {} }}
    >
      <label>Group recordings</label>
    </BrowseViewSection>,
  )
  assert.doesNotMatch(table, /Grid size/)
  assert.match(table, /Group recordings/)
  // Nothing to show: no section.
  assert.equal(
    renderToStaticMarkup(
      <BrowseViewSection
        view="list"
        density={{ value: 'roomy', onChange: () => {} }}
      />,
    ),
    '',
  )
})

test('inside a detail the count and the link to Browse share a line with the active filters', () => {
  const html = toolbar({
    compact: true,
    filterCount: 1,
    filters: <p>Ranges</p>,
    activeFilters: <span>Search: example</span>,
    end: <b>Show in Tracks</b>,
  })
  assert.match(html, /data-filters="short"/)
  assert.match(
    html,
    /<\/div><div class="ds-filterline"><span>Search: example<\/span><span class="ds-toolbar-count" role="status">12 tracks<\/span><b>Show in Tracks<\/b><\/div>$/,
  )
  // The toolbar itself ends with the Filters button.
  assert.doesNotMatch(
    html.slice(0, html.indexOf('ds-filterline')),
    /ds-toolbar-count|ds-toolbar-end/,
  )
  // The line is there with no filter on, so the list does not move when one is added.
  assert.match(
    toolbar({
      compact: true,
      end: <b>Show in Tracks</b>,
    }),
    /<div class="ds-filterline"><span class="ds-toolbar-count" role="status">12 tracks<\/span><b>/,
  )
})

test('a list inside a detail with only a count keeps it on the toolbar', () => {
  const html = toolbar({ compact: true })
  assert.match(html, /data-filters="short"/)
  assert.doesNotMatch(html, /ds-filterline/)
  assert.match(
    html,
    /<span class="ds-toolbar-count" role="status">12 tracks<\/span><\/div>$/,
  )
})
