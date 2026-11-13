import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LastfmLinkReasonSchema,
  LastfmLinkStrategySchema,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
import {
  LASTFM_SYNC_POLL_MS,
  albumPickerPath,
  lastfmLinkFilter,
  lastfmLinkFilters,
  lastfmLinkReasonLabels,
  lastfmLinkStrategyLabels,
  lastfmLinkSummaryRows,
  lastfmLinksPath,
  lastfmSyncPollInterval,
} from './lastfm-sync'

test('status is polled only while a sync job is queued or running', () => {
  assert.equal(lastfmSyncPollInterval('running'), LASTFM_SYNC_POLL_MS)
  const idle: LastfmSyncStatus['state'][] = [
    'never',
    'stopped',
    'failed',
    'complete',
  ]
  for (const state of idle)
    assert.equal(lastfmSyncPollInterval(state), false, state)
  assert.equal(lastfmSyncPollInterval(null), false)
})

test('link filter accepts reasons and unlinked, ignoring anything else', () => {
  assert.equal(lastfmLinkFilter('unlinked'), 'unlinked')
  assert.equal(lastfmLinkFilter('excluded'), 'excluded')
  assert.equal(lastfmLinkFilter('unknown'), '')
  assert.equal(lastfmLinkFilter(''), '')
  assert.equal(lastfmLinkFilter(null), '')
})

test('link filters list All, Unlinked, then every reason with its label', () => {
  assert.deepEqual(
    lastfmLinkFilters.map((option) => option.value),
    ['', 'unlinked', ...LastfmLinkReasonSchema.options],
  )
  assert.deepEqual(
    lastfmLinkFilters.slice(2).map((option) => option.label),
    [
      'Linked',
      'Linked manually',
      'Several albums match',
      'No matching album',
      'Kept unlinked',
      'Scrobbled without an album',
    ],
  )
})

test('links path includes only the filters in use', () => {
  assert.equal(
    lastfmLinksPath({ reason: '', q: '', page: 1 }),
    '/api/v1/lastfm/links?page=1&size=50',
  )
  assert.equal(
    lastfmLinksPath({ reason: 'unlinked', q: 'Artist fixture & co', page: 3 }),
    '/api/v1/lastfm/links?page=3&size=50&reason=unlinked&q=Artist+fixture+%26+co',
  )
})

test('pickers request a short page of names or albums', () => {
  assert.equal(
    lastfmLinksPath({ reason: '', q: 'fixture', page: 1, size: 8 }),
    '/api/v1/lastfm/links?page=1&size=8&q=fixture',
  )
  assert.equal(
    albumPickerPath('Album & fixture', 8),
    '/api/v1/albums?q=Album+%26+fixture&size=8',
  )
  assert.deepEqual(
    Object.keys(lastfmLinkStrategyLabels),
    LastfmLinkStrategySchema.options,
  )
})

test('summary rows keep reason order and fill missing reasons with zero', () => {
  const rows = lastfmLinkSummaryRows([
    { reason: 'no-album', groups: 2, scrobbles: 9 },
    { reason: 'linked', groups: 5, scrobbles: 120 },
  ])
  assert.deepEqual(
    rows.map((row) => row.reason),
    LastfmLinkReasonSchema.options,
  )
  assert.deepEqual(rows[0], { reason: 'linked', groups: 5, scrobbles: 120 })
  assert.deepEqual(rows[1], { reason: 'manual', groups: 0, scrobbles: 0 })
  assert.deepEqual(rows[5], { reason: 'no-album', groups: 2, scrobbles: 9 })
  assert.equal(lastfmLinkReasonLabels.excluded, 'Kept unlinked')
})
