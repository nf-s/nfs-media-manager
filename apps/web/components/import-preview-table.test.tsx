import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ImportPreviewTable from './import-preview-table'

const items = [
  { row: 0, title: 'New album', action: 'new' },
  { row: 1, title: 'Existing album', action: 'unchanged' },
]

test('shared preview starts unselected, disables unchanged rows and never calls actions on render', () => {
  let changed = false
  const html = renderToStaticMarkup(
    <ImportPreviewTable
      items={items}
      selected={[]}
      onChange={() => {
        changed = true
      }}
      disabled={false}
      actionable={(item) => item.action === 'new'}
      headings={<th scope="col">Album</th>}
      cells={(item) => <td>{item.title}</td>}
    />,
  )
  assert.match(html, /aria-label="Import New album"/)
  assert.match(html, /aria-label="Import Existing album" disabled=""/)
  assert.doesNotMatch(html, /checked=""/)
  assert.equal(changed, false)
})

test('shared preview preserves selected rows, bounded scrolling and escapes imported titles', () => {
  const html = renderToStaticMarkup(
    <ImportPreviewTable
      items={[
        ...items,
        { row: 2, title: '<script>title</script>', action: 'new' },
      ]}
      selected={[0]}
      onChange={() => {
        throw new Error('Unexpected action')
      }}
      disabled={true}
      actionable={(item) => item.action === 'new'}
      headings={<th scope="col">Film</th>}
      cells={(item) => <td>{item.title}</td>}
    />,
  )
  assert.match(html, /class="table-scroll import-preview-scroll"/)
  assert.match(html, /aria-label="Import New album" disabled="" checked=""/)
  assert.match(html, /&lt;script&gt;title&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})

test('large previews initially render fifty rows and expose manual load more', () => {
  const html = renderToStaticMarkup(
    <ImportPreviewTable
      items={Array.from({ length: 101 }, (_, row) => ({
        row,
        title: `Album ${row}`,
      }))}
      selected={[]}
      onChange={() => {}}
      disabled={false}
      actionable={() => true}
      headings={<th>Album</th>}
      cells={(item) => <td>{item.title}</td>}
    />,
  )
  assert.equal((html.match(/aria-label="Import Album/g) ?? []).length, 50)
  assert.match(html, /50 of 101 items/)
  assert.match(html, /Load more/)
})
