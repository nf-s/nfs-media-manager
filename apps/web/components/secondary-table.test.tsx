import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  SecondaryCell,
  SecondaryDataTable,
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
  assert.doesNotMatch(html, /class="secondary-table-toolbar"/)
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
  assert.doesNotMatch(html, /class="secondary-table-toolbar"/)
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
  const columns = html.indexOf('class="secondary-table-toolbar-columns"')
  assert.ok(search > -1)
  assert.ok(search < filters && filters < count && count < columns)
  assert.match(html, /<\/div><div class="secondary-table-toolbar-columns">/)
  assert.match(html, /role="status">12 items<\/span>/)
})

test('secondary toolbars omit empty controls and retain a zero result count', () => {
  assert.equal(renderToStaticMarkup(<SecondaryTableToolbar />), '')
  const html = renderToStaticMarkup(<SecondaryTableToolbar count={0} />)
  assert.match(html, /role="status">0<\/span>/)
  assert.doesNotMatch(
    html,
    /secondary-table-toolbar-search|secondary-table-toolbar-filters|secondary-table-toolbar-columns/,
  )
})
