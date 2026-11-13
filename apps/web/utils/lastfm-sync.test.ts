import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LastfmLinkReasonSchema,
  LastfmLinkStrategySchema,
  LastfmLinkGroupSchema,
  type LastfmSyncStatus,
} from '@repo/schemas/lastfm'
import {
  LASTFM_SYNC_POLL_MS,
  albumPickerPath,
  lastfmLinkFilter,
  lastfmLinkFilters,
  lastfmLinkKey,
  lastfmLinkSort,
  lastfmLinkSortDirection,
  lastfmSpotifySearchLabel,
  canSearchLastfmGroup,
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
    '/api/v1/lastfm/links?page=1&size=100',
  )
  assert.equal(
    lastfmLinksPath({ reason: 'unlinked', q: 'Artist fixture & co', page: 3 }),
    '/api/v1/lastfm/links?page=3&size=100&reason=unlinked&q=Artist+fixture+%26+co',
  )
})

test('link sorting validates URL state and sends sorting with every page', () => {
  assert.equal(lastfmLinkSort('artistName'), 'artistName')
  assert.equal(lastfmLinkSort('unknown'), 'scrobbles')
  assert.equal(lastfmLinkSort(null), 'scrobbles')
  assert.equal(lastfmLinkSortDirection('asc'), 'asc')
  assert.equal(lastfmLinkSortDirection('unknown'), 'desc')
  assert.equal(lastfmLinkSortDirection(null), 'desc')
  const path = lastfmLinksPath({
    reason: 'unlinked',
    q: '',
    page: 2,
    sortBy: 'lastListenedAt',
    sortDirection: 'asc',
  })
  assert.equal(
    path,
    '/api/v1/lastfm/links?page=2&size=100&reason=unlinked&sortBy=lastListenedAt&sortDirection=asc',
  )
})

test('search selection excludes linked and unnamed groups without conflating group keys', () => {
  const group = LastfmLinkGroupSchema.parse({
    artistName: 'Artist fixture',
    albumName: 'Album fixture',
    scrobbles: 3,
    lastListenedAt: '2026-01-01T00:00:00Z',
    reason: 'unmatched',
    album: null,
    candidates: [],
  })
  assert.equal(canSearchLastfmGroup(group), true)
  assert.equal(canSearchLastfmGroup({ ...group, reason: 'ambiguous' }), true)
  assert.equal(canSearchLastfmGroup({ ...group, reason: 'excluded' }), true)
  assert.equal(canSearchLastfmGroup({ ...group, reason: 'linked' }), false)
  assert.equal(canSearchLastfmGroup({ ...group, reason: 'manual' }), false)
  assert.equal(canSearchLastfmGroup({ ...group, albumName: null }), false)
  const updated = { ...group, scrobbles: 7 }
  assert.equal(lastfmLinkKey(group), lastfmLinkKey(updated))
  assert.notEqual(
    lastfmLinkKey({ artistName: 'A — B', albumName: 'C' }),
    lastfmLinkKey({ artistName: 'A', albumName: 'B — C' }),
  )
  assert.notEqual(
    lastfmLinkKey({ artistName: 'A', albumName: null }),
    lastfmLinkKey({ artistName: 'A', albumName: '' }),
  )
})

test('stored search status distinguishes missing, active, empty and failed searches', () => {
  assert.equal(lastfmSpotifySearchLabel(null), 'Not searched')
  const summary = {
    jobId: 'job-fixture',
    resultCount: null,
    errorMessage: null,
  }
  assert.equal(
    lastfmSpotifySearchLabel({ ...summary, status: 'queued' }),
    'Queued',
  )
  assert.equal(
    lastfmSpotifySearchLabel({ ...summary, status: 'running' }),
    'Searching...',
  )
  assert.equal(
    lastfmSpotifySearchLabel({ ...summary, status: 'failed' }),
    'Failed',
  )
  assert.equal(
    lastfmSpotifySearchLabel({ ...summary, status: 'cancelled' }),
    'Cancelled',
  )
  assert.equal(
    lastfmSpotifySearchLabel({ ...summary, status: 'succeeded' }),
    'No stored results',
  )
  assert.equal(
    lastfmSpotifySearchLabel({
      ...summary,
      status: 'succeeded',
      resultCount: 0,
    }),
    '0 matches',
  )
  assert.equal(
    lastfmSpotifySearchLabel({
      ...summary,
      status: 'succeeded',
      resultCount: 1,
    }),
    '1 match',
  )
  assert.equal(
    lastfmSpotifySearchLabel({
      ...summary,
      status: 'succeeded',
      resultCount: 2,
    }),
    '2 matches',
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
