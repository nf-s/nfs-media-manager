import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Table,
  TableBody,
  TableCell,
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
  assert.equal((html.match(/class="table-scroll /g) ?? []).length, 1)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /table-scroll-bounded/)
  assert.match(html, /<table class="compact-table" aria-label="Films"/)
  assert.match(html, /<th scope="col" aria-sort="ascending"/)
  assert.match(html, /<tr data-selected="true"><td>Example film/)
  assert.doesNotMatch(html, /p-3|uppercase/)
})

test('scroll wrapper supports native tables and accessible region props', () => {
  const html = renderToStaticMarkup(
    <TableScroll
      role="region"
      aria-label="History"
      aria-busy
      className="history-scroll"
    >
      <table className="compact-table">
        <tbody>
          <TableState colSpan={4}>Loading history...</TableState>
        </tbody>
      </table>
    </TableScroll>,
  )
  assert.match(html, /class="table-scroll history-scroll"/)
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
