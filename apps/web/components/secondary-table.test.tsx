import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SecondaryDataTable } from './secondary-table'

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

test('empty tables use the visible data column count', () => {
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
  assert.match(html, /colSpan="1" class="table-state"/)
  assert.match(html, /role="status">No items/)
})
