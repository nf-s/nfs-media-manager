import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FileImportFormatSchema } from '@repo/schemas/imports'
import {
  csvImportHref,
  importDestinations,
  resolveCsvFormat,
} from './import-navigation'

const formats = FileImportFormatSchema.array().parse([
  { id: 'ratings', label: 'Ratings CSV', kind: 'csv' },
  { id: 'local:bookmarks & lists', label: 'Local bookmarks CSV', kind: 'csv' },
  { id: 'nfo', label: 'NFO files', kind: 'nfo' },
])

test('monitoring comes first, then dynamic CSV formats, NFO and legacy', () => {
  const items = importDestinations(formats)
  assert.deepEqual(
    items.map((item) => item.label),
    [
      'Recent imports',
      'Ratings CSV',
      'Local bookmarks CSV',
      'Find new NFO films',
      'Legacy JSON library',
    ],
  )
  assert.equal(items[0]?.href, '/imports')
  assert.equal(items.at(-1)?.href, '/imports/legacy')
  assert.equal(items.filter((item) => item.href === '/imports/nfo').length, 1)
})

test('format deep links safely encode arbitrary plugin identifiers', () => {
  const href = csvImportHref('local:bookmarks & lists')
  const url = new URL(href, 'http://localhost')
  assert.equal(url.pathname, '/imports/csv')
  assert.equal(url.searchParams.get('format'), 'local:bookmarks & lists')
  assert.equal([...url.searchParams].length, 1)
})

test('missing format uses catalog order, not a hardcoded provider', () => {
  assert.equal(resolveCsvFormat(formats, null)?.id, 'ratings')
  assert.equal(
    resolveCsvFormat(formats.slice(1), null)?.id,
    'local:bookmarks & lists',
  )
})

test('unknown, removed and non-CSV formats do not silently choose another parser', () => {
  assert.equal(resolveCsvFormat(formats, 'removed'), undefined)
  assert.equal(resolveCsvFormat(formats, 'nfo'), undefined)
  assert.equal(resolveCsvFormat(formats, ''), undefined)
  assert.equal(resolveCsvFormat([], null), undefined)
})

test('empty or unavailable catalogs still expose the CSV loading/retry destination', () => {
  assert.deepEqual(
    importDestinations([]).map((item) => item.href),
    ['/imports', '/imports/csv', '/imports/nfo', '/imports/legacy'],
  )
  assert.equal(
    importDestinations(formats).some((item) => item.href === '/imports/csv'),
    false,
  )
})
