import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  matchSortOptions,
  SortPicker,
} from '@repo/ui/components/ds/sort-picker'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { TableSortButton } from '@repo/ui/components/ui/table'
import { BrowseFilterPill } from './browse-controls'
import { FilterPanelSection } from './browse-filter-panel'
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

test('an icon-only view toggle keeps its square sizing and original icon during an update', () => {
  const html = renderToStaticMarkup(
    <Segmented
      label="Browse views"
      value="grid"
      options={[
        {
          value: 'grid',
          label: 'Grid',
          icon: <svg aria-hidden="true" data-fixture="grid" />,
        },
      ]}
      feedbackFor={() => ({ phase: 'pending', label: 'Updating results…' })}
      onChange={() => {}}
    />,
  )
  assert.match(html, /<button[^>]*data-feedback="pending"[^>]*data-icon=""/)
  assert.match(html, /data-fixture="grid"/)
})

test('sort feedback retains the picker label and the column heading and direction arrow', () => {
  const picker =
    renderToStaticMarkup(
      <SortPicker
        value="released"
        options={fields}
        onChange={() => {}}
        feedback={{ phase: 'done', label: 'Results updated' }}
      />,
    ).split('</button>')[0] ?? ''
  assert.match(picker, />Released \(first issue\)</)
  const header = renderToStaticMarkup(
    <TableSortButton
      direction="asc"
      feedback={{ phase: 'pending', label: 'Updating results…' }}
    >
      Release date
    </TableSortButton>,
  )
  assert.match(header, />Release date</)
  assert.match(header, /M12 19V5M6 11l6-6 6 6/)
})

test('disclosure and chip feedback stay within their existing title and remove slots', () => {
  const disclosure = renderToStaticMarkup(
    <FilterPanelSection
      title="Ranges"
      icon={<svg aria-hidden="true" />}
      count={2}
      feedback={{ phase: 'pending', label: 'Updating results…' }}
    >
      Fields
    </FilterPanelSection>,
  )
  assert.doesNotMatch(disclosure, /<span class="ds-cell-id" aria-live="polite"/)
  assert.match(disclosure, />Ranges</)
  const chip = renderToStaticMarkup(
    <BrowseFilterPill
      removeLabel="Remove rating filter"
      removeFeedback={{ phase: 'pending', label: 'Removing filter…' }}
      onRemove={() => {}}
    >
      Rating above 3
    </BrowseFilterPill>,
  )
  assert.match(chip, /data-icon=""/)
  assert.match(chip, /lucide-x/)
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

test('library scope toggle sits between View and Filters in the action row', () => {
  const onChange = () => {}
  const combined = toolbar({
    compact: true,
    libraryScope: {
      value: { scope: 'all', sources: ['similar'], mode: 'any' },
      onChange,
    },
  })
  const view = combined.indexOf('aria-label="Browse views"')
  const toggle = combined.indexOf('aria-label="Include outside library"')
  const filters = combined.indexOf('data-filters="short"')
  assert.ok(view >= 0 && view < toggle && toggle < filters)
  assert.match(
    combined,
    /<button[^>]*data-icon=""[^>]*aria-pressed="true"[^>]*aria-label="Include outside library" aria-description="All known"/,
  )
  assert.match(combined, /Filters, columns and grid size, 1 filter on/)
  const outside = toolbar({
    libraryScope: {
      value: { scope: 'outside', sources: [], mode: 'any' },
      onChange,
    },
  })
  assert.match(
    outside,
    /aria-pressed="false"[^>]*aria-label="Include outside library" aria-description="Outside library"/,
  )
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
