import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  columnsWidth,
  Table,
  TableBody,
  TableCell,
  TableColumns,
  TableHead,
  TableHeader,
  TableRow,
  TableScroll,
  TableState,
} from '@repo/ui/components/ui/table'

test('shared table uses compact styles and one keyboard-scrollable container', () => {
  const html = renderToStaticMarkup(
    <Table aria-label="Films" containerClassName="table-scroll-bounded">
      <TableHeader>
        <TableRow>
          <TableHead aria-sort="ascending">Title</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow data-selected="true">
          <TableCell>Example film</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  )
  assert.equal(
    (html.match(/class="ds-table-wrap table-scroll /g) ?? []).length,
    1,
  )
  assert.match(html, /tabindex="0"/)
  assert.match(html, /table-scroll-bounded/)
  assert.match(html, /<table class="ds-table" aria-label="Films"/)
  assert.match(html, /<th scope="col" aria-sort="ascending"/)
  assert.match(html, /<tr data-selected="true"><td>Example film/)
  assert.doesNotMatch(html, /p-3|uppercase/)
})

test('a fixed table states its column widths and a header can carry a width handle', () => {
  const html = renderToStaticMarkup(
    <Table aria-label="Films" layout="fixed">
      <TableColumns widths={[36, 280, undefined]} />
      <TableHeader>
        <TableRow>
          <TableHead />
          <TableHead
            resizer={{ role: 'separator', 'aria-label': 'Resize Title' }}
          >
            Title
          </TableHead>
          <TableHead>Year</TableHead>
        </TableRow>
      </TableHeader>
    </Table>,
  )
  assert.match(html, /<table class="ds-table" data-layout="fixed"/)
  // Each width gives way to the phone's column limit, when one is set.
  assert.ok(
    html.includes(
      '<colgroup><col style="width:min(36px, var(--ds-col-max, 36px))"/><col style="width:min(280px, var(--ds-col-max, 280px))"/><col/></colgroup>',
    ),
  )
  assert.equal(
    columnsWidth([36, 280]),
    'calc(min(36px, var(--ds-col-max, 36px)) + min(280px, var(--ds-col-max, 280px)))',
  )
  assert.equal(columnsWidth([]), '0px')
  assert.match(
    html,
    /<th scope="col">Title<span class="ds-th-resizer" role="separator" aria-label="Resize Title"><\/span><\/th>/,
  )
  // Only the header given a handle has one.
  assert.equal((html.match(/ds-th-resizer/g) ?? []).length, 1)
})

test('scroll wrapper supports native tables and accessible region props', () => {
  const html = renderToStaticMarkup(
    <TableScroll
      role="region"
      aria-label="History"
      aria-busy
      className="history-scroll"
    >
      <table className="ds-table">
        <tbody>
          <TableState colSpan={4}>Loading history...</TableState>
        </tbody>
      </table>
    </TableScroll>,
  )
  assert.match(html, /class="ds-table-wrap table-scroll history-scroll"/)
  assert.match(html, /role="region" aria-label="History" aria-busy="true"/)
  assert.match(
    html,
    /<td colSpan="4" class="table-state"><div role="status">Loading history/,
  )
})

test('table state preserves table structure and escapes messages', () => {
  const html = renderToStaticMarkup(
    <table>
      <tbody>
        <TableState colSpan={3}>{'No <unsafe> imports.'}</TableState>
      </tbody>
    </table>,
  )
  assert.match(html, /<tbody><tr><td colSpan="3" class="table-state">/)
  assert.match(html, /role="status">No &lt;unsafe&gt; imports/)
  assert.doesNotMatch(html, /<unsafe>/)
})

test('table errors keep explicit retry controls without firing them during render', () => {
  let retries = 0
  const html = renderToStaticMarkup(
    <table>
      <tbody>
        <TableState colSpan={2} error>
          Could not load rows.{' '}
          <button type="button" onClick={() => retries++}>
            Retry
          </button>
        </TableState>
      </tbody>
    </table>,
  )
  assert.match(html, /role="alert"/)
  assert.match(html, /<button type="button">Retry<\/button>/)
  assert.equal(retries, 0)
})

test('no column stays in place on a phone', () => {
  // Every pinned cell carries the shared table's own mark.
  const html = renderToStaticMarkup(
    <Table aria-label="Tracks" layout="fixed">
      <TableHeader>
        <TableRow>
          <TableHead sticky={0}>Select</TableHead>
          <TableHead sticky={36} stickyEdge>
            Title
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell sticky={0}>1</TableCell>
          <TableCell sticky={36} stickyEdge>
            Example track
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  )
  assert.equal((html.match(/<th[^>]*data-sticky="(edge)?"/g) ?? []).length, 2)
  assert.equal((html.match(/<td[^>]*data-sticky="(edge)?"/g) ?? []).length, 2)
  const css = readFileSync(
    new URL(
      '../../../packages/ui/src/design-system/components.css',
      import.meta.url,
    ),
    'utf8',
  )
  const phone = css
    .split('@media (max-width: 700px) {')
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('\n}\n')))
    .find((block) => block.includes('--ds-col-max'))
  assert.ok(phone)
  // Body cells scroll with the rest; headings keep only their place at the top.
  assert.match(
    phone,
    /\.ds-table td\[data-sticky\] \{\s*position: static;\s*\}/,
  )
  assert.match(
    phone,
    /\.ds-table th\[data-sticky\] \{\s*right: auto;\s*left: auto;\s*\}/,
  )
  assert.match(
    phone,
    /\.ds-table\[data-scrolled\] \[data-sticky='edge'\] \{\s*box-shadow: none;\s*\}/,
  )
  assert.match(phone, /--ds-col-max: 66vw;/)
})
