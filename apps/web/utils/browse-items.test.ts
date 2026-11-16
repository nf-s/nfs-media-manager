import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trackBrowseFields, type BrowseField } from '@repo/schemas/browse'
import { artistBrowseFields } from '@repo/schemas/artist-browse'
import { subscriptionBrowseFields } from '@repo/schemas/subscriptions'
import {
  columnOrderParam,
  formatFieldValue,
  hasCustomColumnOrder,
  isBrowseCounting,
  itemGridGeometry,
  itemGridHeight,
  nextSortDirection,
  orderColumns,
  orderFields,
  parseColumnOrder,
  sortedValueLabel,
} from './browse-items'
import { defaultTrackColumns, trackFieldOrder } from './track-browse'
import { artistFieldOrder, defaultArtistColumns } from './artist-browse'
import {
  defaultSubscriptionColumns,
  subscriptionFieldOrder,
} from './subscriptions'

const labels = (fields: BrowseField[], keys: string[]) =>
  fields.filter((field) => keys.includes(field.key)).map(({ label }) => label)

test('default columns follow the drawn order for each resource', () => {
  assert.deepEqual(
    labels(
      orderFields(trackBrowseFields, trackFieldOrder),
      defaultTrackColumns,
    ),
    [
      'Title',
      'Artists',
      'Album',
      'Duration',
      'Added',
      'Scrobbles',
      'Playlists',
      'Tags',
    ],
  )
  assert.deepEqual(
    labels(
      orderFields(artistBrowseFields, artistFieldOrder),
      defaultArtistColumns,
    ),
    ['Artist', 'Country', 'Added', 'Albums', 'Tracks', 'Scrobbles', 'Tags'],
  )
  assert.deepEqual(
    labels(
      orderFields(subscriptionBrowseFields, subscriptionFieldOrder),
      defaultSubscriptionColumns,
    ),
    ['Title', 'Channel', 'Published', 'Duration', 'Watched'],
  )
})

test('fields the order does not name keep their own order at the end', () => {
  const plugin: BrowseField[] = [
    { key: 'zeta', label: 'Zeta', type: 'number', filterable: true },
    { key: 'alpha', label: 'Alpha', type: 'text', filterable: true },
  ]
  const ordered = orderFields(
    [...plugin, ...trackBrowseFields],
    trackFieldOrder,
  )
  assert.equal(ordered[0]?.key, 'title')
  assert.deepEqual(
    ordered.slice(-2).map(({ key }) => key),
    ['zeta', 'alpha'],
  )
  assert.equal(ordered.length, plugin.length + trackBrowseFields.length)
})

test('a saved column order applies with the identity first and new fields in their default place', () => {
  const columns = ['title', 'artist', 'album', 'durationSec', 'genre'].map(
    (key) => ({ key }),
  )
  const keys = (saved: string[] | null) =>
    orderColumns(columns, saved, 'title').map(({ key }) => key)
  assert.deepEqual(keys(null), [
    'title',
    'artist',
    'album',
    'durationSec',
    'genre',
  ])
  assert.deepEqual(keys(['genre', 'title', 'artist', 'album', 'durationSec']), [
    'title',
    'genre',
    'artist',
    'album',
    'durationSec',
  ])
  // `album` is new since the order was saved: it follows `artist`, as by default.
  assert.deepEqual(keys(['durationSec', 'artist', 'retired', 'genre']), [
    'title',
    'durationSec',
    'artist',
    'album',
    'genre',
  ])
  assert.deepEqual(parseColumnOrder('tag,title,,tag'), ['genre', 'title'])
  assert.equal(parseColumnOrder(''), null)
  assert.equal(parseColumnOrder(null), null)
  assert.equal(
    columnOrderParam(
      columns.map(({ key }) => key),
      columns,
    ),
    null,
  )
  assert.equal(
    columnOrderParam(
      ['title', 'genre', 'artist', 'album', 'durationSec'],
      columns,
    ),
    'title,genre,artist,album,durationSec',
  )
})

test('a column order is custom only when it changes the shown order', () => {
  const columns = ['title', 'artist', 'album'].map((key) => ({ key }))
  const custom = (value: string | null) =>
    hasCustomColumnOrder(
      orderColumns(columns, parseColumnOrder(value), 'title'),
      columns,
      'title',
    )
  assert.equal(custom(null), false)
  assert.equal(custom('title'), false)
  assert.equal(custom('retired,unknown'), false)
  assert.equal(custom('title,artist,album'), false)
  assert.equal(custom('artist,title,album'), false, 'the title stays first')
  assert.equal(custom('album'), false, 'unnamed columns keep their place')
  assert.equal(custom('album,artist'), true)
  assert.equal(custom('title,album,artist'), true)
  assert.equal(
    hasCustomColumnOrder(
      orderColumns([{ key: 'artist' }, { key: 'title' }], null, 'title'),
      [{ key: 'artist' }, { key: 'title' }],
      'title',
    ),
    false,
    'the default order is compared with the identity column leading',
  )
})

test('a new sort starts ascending for text and descending otherwise; the same key flips', () => {
  const current: { sortBy: string; direction: 'asc' | 'desc' } = {
    sortBy: 'dateAdded',
    direction: 'desc',
  }
  assert.equal(nextSortDirection(trackBrowseFields, 'title', current), 'asc')
  assert.equal(
    nextSortDirection(trackBrowseFields, 'scrobbles', current),
    'desc',
  )
  assert.equal(
    nextSortDirection(trackBrowseFields, 'dateAdded', current),
    'asc',
  )
  assert.equal(
    nextSortDirection(trackBrowseFields, 'dateAdded', {
      sortBy: 'dateAdded',
      direction: 'asc',
    }),
    'desc',
  )
})

test('values use ISO dates, separated counts, track lengths and an en dash', () => {
  const field = (key: string) => {
    const found = trackBrowseFields.find((item) => item.key === key)
    assert.ok(found)
    return found
  }
  assert.equal(formatFieldValue(field('scrobbles'), 12480), '12,480')
  assert.equal(formatFieldValue(field('durationSec'), 250), '4:10')
  assert.match(
    formatFieldValue(field('dateAdded'), Date.parse('2026-03-04T12:00:00Z')),
    /^2026-03-0[45]$/,
  )
  assert.equal(formatFieldValue(field('album'), null), '–')
  assert.equal(formatFieldValue(field('artist'), []), '–')
  assert.equal(formatFieldValue(field('artist'), ['A', 'B']), 'A, B')
  assert.equal(sortedValueLabel(field('scrobbles'), 3), 'Scrobbles 3')
  assert.equal(sortedValueLabel(field('title'), 'Song'), null)
  assert.equal(sortedValueLabel(field('dateAdded'), null), null)
})

test('card grids keep two columns on phones and reserve the tags line', () => {
  const phone = itemGridGeometry({ width: 375, min: 164 })
  assert.equal(phone.columns, 2)
  const desktop = itemGridGeometry({ width: 1000, min: 164 })
  assert.equal(desktop.columns, 5)
  const card = (1000 - 24 - 4 * 16) / 5
  assert.equal(desktop.cardHeight, Math.round(card + 86))
  assert.equal(desktop.rowHeight, desktop.cardHeight + 20)
  const video = itemGridGeometry({ width: 1000, min: 200, ratio: 9 / 16 })
  assert.equal(video.columns, 4)
  assert.ok(video.cardHeight < desktop.cardHeight)
  const untagged = itemGridGeometry({ width: 1000, min: 164, tags: false })
  assert.equal(desktop.cardHeight - untagged.cardHeight, 22)
  assert.equal(itemGridHeight(0), 0)
  assert.equal(itemGridHeight(400), 408)
})

test('the count waits for the count query even when page one gives the total', () => {
  assert.equal(
    isBrowseCounting({ hasTotal: true, conflict: false, countSettled: false }),
    true,
    'a filtered first page does not read 3 albums before 3 of 128 albums',
  )
  assert.equal(
    isBrowseCounting({ hasTotal: true, conflict: false, countSettled: true }),
    false,
  )
  assert.equal(
    isBrowseCounting({ hasTotal: false, conflict: false, countSettled: true }),
    true,
  )
  assert.equal(
    isBrowseCounting({ hasTotal: true, conflict: true, countSettled: true }),
    true,
  )
})
