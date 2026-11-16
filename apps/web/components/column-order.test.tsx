import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ColumnOrderList, moveColumnKey } from './column-order'

test('moving a column key places it at the index, within bounds', () => {
  const keys = ['title', 'artist', 'album', 'genre']
  assert.deepEqual(moveColumnKey(keys, 'genre', 1), [
    'title',
    'genre',
    'artist',
    'album',
  ])
  assert.deepEqual(moveColumnKey(keys, 'artist', 2), [
    'title',
    'album',
    'artist',
    'genre',
  ])
  assert.deepEqual(moveColumnKey(keys, 'album', 99), [
    'title',
    'artist',
    'genre',
    'album',
  ])
  assert.deepEqual(moveColumnKey(keys, 'album', -1), [
    'album',
    'title',
    'artist',
    'genre',
  ])
})

test('each entry has a named handle in a ghost icon button; the pinned one is disabled', () => {
  const html = renderToStaticMarkup(
    <ColumnOrderList
      columns={[
        { key: 'title', label: 'Title' },
        { key: 'artist', label: 'Artists' },
        { key: 'genre', label: 'Tags' },
      ]}
      pinned="title"
      onMove={() => undefined}
    >
      {(column) => <span>{column.label}</span>}
    </ColumnOrderList>,
  )
  assert.match(html, /<ol class="column-order">/)
  assert.equal(
    (html.match(/class="ds-menu-item column-order-item"/g) ?? []).length,
    3,
  )
  assert.match(
    html,
    /data-variant="ghost" data-size="xs" data-icon=""[^>]*disabled=""[^>]*aria-label="Title stays first"/,
  )
  assert.match(html, /aria-label="Move Artists" aria-describedby="[^"]+"/)
  assert.match(html, /aria-label="Move Tags"/)
  assert.ok(html.indexOf('Title') < html.indexOf('Artists'))
  assert.ok(html.indexOf('Artists') < html.indexOf('Tags'))
  assert.match(html, /<span class="sr-only" role="status"><\/span>/)
})
