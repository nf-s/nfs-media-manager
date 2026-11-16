import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProviderOverviewItem } from '@repo/schemas/provider'
import { formatUntil } from '@repo/ui/lib/format'
import {
  activeCooldownUntil,
  connectionStatus,
  legacyProviderHref,
  parseProviderLibrary,
  parseProviderTab,
  providerHref,
  providerJobsHref,
  providerMarkText,
  queueBlocked,
  queueStatus,
  runsOnLabel,
} from './provider-overview'

const now = new Date('2026-11-16T13:40:00.000Z')
type Queue = ProviderOverviewItem['queue']

test('the library filter accepts each library and lists everything otherwise', () => {
  for (const library of ['album', 'film', 'artist', 'subscription'])
    assert.equal(parseProviderLibrary(library), library)
  assert.equal(parseProviderLibrary(null), null)
  assert.equal(parseProviderLibrary('track'), null)
})

test('connection wording follows the state and method', () => {
  const detail = 'Synthetic detail'
  assert.deepEqual(
    connectionStatus({ state: 'connected', method: 'key', detail }),
    { state: 'done', label: 'Key set', title: detail },
  )
  assert.equal(
    connectionStatus({ state: 'connected', method: 'account', detail: null })
      .label,
    'Connected',
  )
  assert.deepEqual(
    connectionStatus({
      state: 'needs-sign-in',
      method: 'account',
      detail: null,
    }),
    { state: 'attention', label: 'Needs sign-in', title: undefined },
  )
  assert.equal(
    connectionStatus({ state: 'needs-key', method: 'key', detail: null }).label,
    'Needs key',
  )
  assert.deepEqual(
    connectionStatus({ state: 'not-required', method: 'none', detail: null }),
    { state: 'never', label: 'Not required', title: undefined },
  )
  assert.equal(
    connectionStatus({ state: 'unavailable', method: 'none', detail: null })
      .label,
    'Unavailable',
  )
})

test('a waiting queue names its end time, or its reason when the end is unknown', () => {
  const until = '2026-11-16T14:20:00.000Z'
  const detail = 'Cooling down: Provider rate limit reached (HTTP 429)'
  assert.deepEqual(
    queueStatus({ state: 'waiting', reason: 'cooldown', until, detail }, now),
    {
      state: 'waiting',
      label: `Waiting until ${formatUntil(until, now)}`,
      title: detail,
    },
  )
  assert.equal(
    queueStatus(
      { state: 'waiting', reason: 'worker-offline', until: null, detail: null },
      now,
    ).label,
    'Waiting · worker offline',
  )
  const idle = { reason: null, until: null, detail: null }
  assert.equal(queueStatus({ state: 'idle', ...idle }).state, 'done')
  assert.equal(queueStatus({ state: 'running', ...idle }).label, 'Running')
  assert.equal(
    queueStatus({ state: 'paused', ...idle, reason: 'paused' }).state,
    'paused',
  )
  assert.deepEqual(
    queueStatus({ state: 'stopped', ...idle, reason: 'access-denied' }),
    { state: 'attention', label: 'Stopped · access denied', title: undefined },
  )
})

test('only blocking reasons count as a held queue', () => {
  const waiting: Queue = {
    state: 'waiting',
    reason: null,
    until: null,
    detail: null,
  }
  assert.equal(queueBlocked({ ...waiting, reason: 'budget' }), true)
  assert.equal(queueBlocked({ ...waiting, reason: 'queued' }), false)
  assert.equal(queueBlocked({ ...waiting, reason: 'concurrency' }), false)
  assert.equal(
    queueBlocked({ state: 'idle', reason: null, until: null, detail: null }),
    false,
  )
})

test('a cooldown can be cleared only while it lasts', () => {
  const queue: Queue = {
    state: 'waiting',
    reason: 'cooldown',
    until: '2026-11-16T14:20:00.000Z',
    detail: null,
  }
  assert.equal(activeCooldownUntil(queue, now), queue.until)
  assert.equal(
    activeCooldownUntil(queue, new Date('2026-11-16T15:00:00.000Z')),
    null,
  )
  assert.equal(activeCooldownUntil({ ...queue, reason: 'budget' }, now), null)
})

test('links open the provider page and the filtered jobs', () => {
  assert.equal(providerHref('fixture-ratings'), '/providers/fixture-ratings')
  assert.equal(
    providerHref('fixture ratings', 'settings'),
    '/providers/fixture%20ratings?tab=settings',
  )
  assert.equal(
    providerJobsHref('fixture-ratings', 'attention'),
    '/jobs?provider=fixture-ratings&status=attention',
  )
  assert.equal(parseProviderTab('jobs'), 'jobs')
  assert.equal(parseProviderTab('activity'), 'overview')
})

test('old provider links open the provider page on the matching tab', () => {
  const href = (query: string) => legacyProviderHref(new URLSearchParams(query))
  assert.equal(href('mediaType=album'), null)
  assert.equal(
    href('provider=fixture-ratings&mediaType=album'),
    '/providers/fixture-ratings',
  )
  assert.equal(
    href('provider=fixture-ratings&section=credentials'),
    '/providers/fixture-ratings?tab=settings',
  )
  assert.equal(
    href('provider=fixture-ratings&section=jobs'),
    '/providers/fixture-ratings?tab=jobs',
  )
})

test('marks and worker labels are short', () => {
  assert.equal(providerMarkText('Fixture Ratings'), 'FR')
  assert.equal(providerMarkText('FixtureBase'), 'FB')
  assert.equal(providerMarkText('fixture'), 'FI')
  assert.equal(runsOnLabel({ runsOn: 'server', worker: null }), 'Server')
  assert.equal(
    runsOnLabel({
      runsOn: 'local-worker',
      worker: { paired: true, online: false, blocked: false },
    }),
    'Local worker · offline',
  )
})
