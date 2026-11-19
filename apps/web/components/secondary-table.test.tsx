import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  formatTableValue,
  SecondaryCell,
  SecondaryDataTable,
  SecondaryTableSelectionBar,
  SecondaryTableToolbar,
} from './secondary-table'

test('secondary tables share a labelled scroll region, sortable data headers and optional columns', () => {
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="test"
      label="Example rows"
      rows={[
        { id: 1, title: 'Item 12', count: 12 },
        { id: 2, title: '<Item 2>', count: 2 },
      ]}
      rowKey={(row) => row.id}
      defaultSort={{ key: 'count', direction: 'asc' }}
      columns={[
        { key: 'title', label: 'Title', value: (row) => row.title },
        { key: 'count', label: 'Count', value: (row) => row.count },
        {
          key: 'id',
          label: 'ID',
          defaultVisible: false,
          value: (row) => row.id,
        },
        {
          key: 'source',
          label: 'Source',
          defaultVisible: false,
          value: () => 'Fixture',
        },
      ]}
    />,
  )
  assert.match(html, /table-scroll secondary-table-scroll/)
  assert.match(html, /role="region" aria-label="Example rows"/)
  assert.match(html, /aria-sort="ascending"/)
  assert.match(html, /title="Sort by Title"/)
  assert.match(html, /Visible columns/)
  assert.match(html, /Reset columns/)
  assert.doesNotMatch(html, /title="Sort by ID"/)
  assert.ok(html.indexOf('&lt;Item 2&gt;') < html.indexOf('Item 12'))
  // The picker moves columns; the first, identity column stays first.
  assert.match(html, /aria-label="Title stays first"/)
  for (const label of ['Count', 'ID', 'Source'])
    assert.match(html, new RegExp(`aria-label="Move ${label}"`))
  assert.match(html, /Press the up and down arrow keys to move the column\./)
})

test('secondary tables have set column widths and a width handle on each data column', () => {
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="test-widths"
      label="Example rows"
      rows={[{ id: 1, title: 'Item 1', count: 12, note: 'Synthetic' }]}
      rowKey={(row) => row.id}
      defaultSort={{ key: 'title', direction: 'asc' }}
      columns={[
        {
          key: 'title',
          label: 'Title',
          width: 300,
          value: (row) => row.title,
        },
        {
          key: 'count',
          label: 'Count',
          width: 90,
          align: 'end',
          value: (row) => row.count,
        },
        { key: 'note', label: 'Note', value: (row) => row.note },
      ]}
    />,
  )
  // Fixed layout: loading rows cannot move the columns.
  assert.match(html, /<table class="ds-table"[^>]*data-layout="fixed"/)
  assert.match(html, /<table class="ds-table"[^>]*style="min-width:530px"/)
  // Every column keeps its width; the last one takes the room that is left.
  assert.match(
    html,
    /<colgroup><col style="width:300px"\/><col style="width:90px"\/><col[^>]*\/><\/colgroup>/,
  )
  assert.doesNotMatch(html, /<colgroup>.*width:140px.*<\/colgroup>/)
  assert.equal((html.match(/class="ds-th-resizer"/g) ?? []).length, 3)
  for (const label of ['Title', 'Count', 'Note'])
    assert.match(
      html,
      new RegExp(
        `<span class="ds-th-resizer" role="separator"[^>]*aria-label="Resize ${label}"`,
      ),
    )
  assert.match(
    html,
    /aria-valuenow="90" aria-valuemin="40" aria-valuemax="1200"/,
  )
})

test('a column of row actions keeps its width and has no handle', () => {
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="test-actions-width"
      label="Example rows"
      rows={[{ id: 1, title: 'Item 1', note: 'Synthetic' }]}
      rowKey={(row) => row.id}
      defaultSort={{ key: 'title', direction: 'asc' }}
      columns={[
        { key: 'title', label: 'Title', width: 300, value: (row) => row.title },
        { key: 'note', label: 'Note', width: 200, value: (row) => row.note },
        {
          key: 'actions',
          label: 'Actions',
          width: 84,
          resizable: false,
          sortable: false,
          value: () => null,
        },
      ]}
    />,
  )
  // The last data column takes the room that is left, not the actions.
  assert.match(
    html,
    /<colgroup><col style="width:300px"\/><col\/><col style="width:84px"\/><\/colgroup>/,
  )
  assert.match(html, /style="min-width:584px"/)
  assert.match(html, /<th[^>]*>Actions<\/th>/)
  assert.equal((html.match(/class="ds-th-resizer"/g) ?? []).length, 2)
})

test('empty small tables show all columns and use their full column count', () => {
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="test"
      label="Empty"
      rows={[]}
      rowKey={() => ''}
      defaultSort={{ key: 'title', direction: 'asc' }}
      empty="No items."
      columns={[
        { key: 'title', label: 'Title', value: () => '' },
        {
          key: 'optional',
          label: 'Optional',
          defaultVisible: false,
          value: () => '',
        },
      ]}
    />,
  )
  assert.match(html, /colSpan="2" class="table-state"/)
  assert.match(html, /title="Sort by Optional"/)
  assert.doesNotMatch(html, /Visible columns|Reset columns/)
  assert.doesNotMatch(html, /class="ds-toolbar"/)
  assert.match(html, /role="status">No items/)
})

test('three-column tables keep every data column visible without a chooser', () => {
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="summary"
      label="Example summary"
      rows={[{ status: 'Linked', names: 2, plays: 7 }]}
      rowKey={(row) => row.status}
      defaultSort={{ key: 'status', direction: 'asc' }}
      columns={[
        { key: 'status', label: 'Status', value: (row) => row.status },
        { key: 'names', label: 'Names', value: (row) => row.names },
        {
          key: 'plays',
          label: 'Plays',
          defaultVisible: false,
          value: (row) => row.plays,
        },
      ]}
    />,
  )
  assert.match(html, /title="Sort by Plays"/)
  for (const value of ['Linked', '2', '7'])
    assert.ok(html.includes(`title="${value}">${value}</div>`))
  assert.doesNotMatch(html, /Visible columns|Reset columns/)
  assert.doesNotMatch(html, /class="ds-toolbar"/)
})

test('a controlled table passes its filtered and ordered rows to playback renderers', () => {
  const captured: string[][] = []
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="controlled"
      label="Controlled rows"
      rows={[
        { title: 'Song A' },
        { title: 'Instrumental' },
        { title: 'Song Z' },
      ]}
      rowKey={(row) => row.title}
      defaultSort={{ key: 'title', direction: 'asc' }}
      search={{ label: 'Search rows', value: (row) => row.title }}
      view={{
        sort: { key: 'title', direction: 'desc' },
        query: 'Song ',
        onChange: () => {
          throw new Error('Unexpected change during render')
        },
      }}
      columns={[
        {
          key: 'title',
          label: 'Title',
          value: (row) => row.title,
          render: (row, ordered) => {
            captured.push(ordered.map((item) => item.title))
            return row.title
          },
        },
      ]}
    />,
  )
  assert.deepEqual(captured, [
    ['Song Z', 'Song A'],
    ['Song Z', 'Song A'],
  ])
  assert.match(html, /value="Song "/)
  assert.match(html, /aria-sort="descending"/)
  assert.doesNotMatch(html, /Instrumental/)
})

test('bounded cells retain full text and rich details behind a labelled disclosure', () => {
  const html = renderToStaticMarkup(
    <SecondaryCell
      text="Full result title"
      label="Import result details"
      lines={2}
      details={
        <p>
          Complete diagnostic message <a href="/jobs?jobId=fixture">View job</a>
        </p>
      }
    >
      Failed
    </SecondaryCell>,
  )
  assert.match(html, /data-lines="2"/)
  assert.match(html, /title="Full result title">Failed/)
  assert.match(
    html,
    /<button[^>]+aria-label="Import result details"[^>]+aria-haspopup="dialog"/,
  )
  assert.match(
    html,
    /popover="auto" role="dialog" aria-label="Import result details"/,
  )
  assert.match(html, /Complete diagnostic message/)
  assert.match(html, /href="\/jobs\?jobId=fixture">View job/)
})

test('unclipped cells omit duplicate details and use warning icons for extra warning information', () => {
  const plain = renderToStaticMarkup(
    <SecondaryCell details="Not imported">Not imported</SecondaryCell>,
  )
  assert.doesNotMatch(plain, /aria-haspopup|lucide-info|lucide-eye/)
  const warning = renderToStaticMarkup(
    <SecondaryCell
      tone="warning"
      details="The historical report does not identify its library scope."
    >
      Scope unknown
    </SecondaryCell>,
  )
  assert.match(warning, /lucide-triangle-alert/)
  assert.doesNotMatch(warning, /lucide-eye/)
})

test('secondary toolbars order search, filters, count and a separate columns slot', () => {
  const html = renderToStaticMarkup(
    <SecondaryTableToolbar
      search={<input aria-label="Search example" />}
      filters={
        <select aria-label="Example status">
          <option>All statuses</option>
        </select>
      }
      count="12 items"
      columns={<button>Columns</button>}
    />,
  )
  const search = html.indexOf('aria-label="Search example"')
  const filters = html.indexOf('aria-label="Example status"')
  const count = html.indexOf('12 items')
  const columns = html.indexOf('class="ds-toolbar-end ds-actions"')
  assert.ok(search > -1)
  assert.ok(search < filters && filters < count && count < columns)
  assert.match(html, /^<div class="ds-toolbar">/)
  assert.match(html, /role="status">12 items<\/span>/)
})

test('secondary toolbars omit empty controls and retain a zero result count', () => {
  assert.equal(renderToStaticMarkup(<SecondaryTableToolbar />), '')
  const html = renderToStaticMarkup(<SecondaryTableToolbar count={0} />)
  assert.match(html, /role="status">0<\/span>/)
  assert.doesNotMatch(html, /ds-search|ds-toolbar-end/)
})

test('data tables right-align numbers, pin the identity column and format plain values', () => {
  const html = renderToStaticMarkup(
    <SecondaryDataTable
      id="layout"
      label="Layout rows"
      rows={[{ id: 'a', name: 'Fixture', count: 12480, note: null }]}
      rowKey={(row) => row.id}
      defaultSort={{ key: 'name', direction: 'asc' }}
      countLabel="rows"
      search={{ label: 'Search rows', value: (row) => row.name }}
      columns={[
        {
          key: 'name',
          label: 'Name',
          sticky: 0,
          stickyEdge: true,
          value: (row) => row.name,
        },
        {
          key: 'count',
          label: 'Count',
          align: 'end',
          value: (row) => row.count,
        },
        { key: 'note', label: 'Note', value: (row) => row.note },
      ]}
    />,
  )
  assert.match(html, /<div class="ds-toolbar">/)
  assert.match(html, /<label class="ds-search">/)
  assert.match(html, /class="ds-toolbar-count" role="status">1 rows</)
  assert.match(
    html,
    /<th scope="col" data-sticky="edge" style="--ds-sticky-left:0px"/,
  )
  assert.match(html, /<th scope="col" data-align="end"/)
  assert.match(html, /<td data-align="end">.*12,480/)
  assert.match(html, /title="–">–<\/div>/)
})

test('the selection bar shows the count and the selectable total', () => {
  const html = renderToStaticMarkup(
    <SecondaryTableSelectionBar selectedCount={2} total={128}>
      <button type="button">Act</button>
    </SecondaryTableSelectionBar>,
  )
  assert.match(
    html,
    /^<div class="ds-selectbar sec-selectbar"><span role="status"><b>2 selected<\/b><span class="ds-muted"> of 128<\/span><\/span><button/,
  )
})

test('plain values use the shared formats', () => {
  assert.equal(formatTableValue(1234), '1,234')
  assert.equal(formatTableValue(null), '–')
  assert.equal(formatTableValue(''), '–')
  assert.equal(formatTableValue(Number.NaN), '–')
  assert.equal(formatTableValue('Text'), 'Text')
})
