import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BrowsePerformanceTracker,
  browseDocumentPhases,
  navigationMatchesPath,
  tracksChangePhases,
} from './useBrowsePerformance'

const initial = {
  identity: 'initial',
  enabled: false,
  page: 1,
  scrollTop: 0,
}

test('keeps document start through initial Browse preference restoration', () => {
  const tracker = new BrowsePerformanceTracker()
  assert.equal(tracker.observe(initial, 100, 0), undefined)
  const restored = { ...initial, identity: 'restored', enabled: true }
  assert.equal(tracker.observe(restored, 120), undefined)
  const settled = { ...restored, outcome: 'rows' } satisfies Parameters<
    typeof tracker.observe
  >[0]
  const pending = tracker.observe(settled, 200)
  assert.ok(pending)
  assert.deepEqual(tracker.finish(pending, 216), {
    action: 'document',
    durationMs: 216,
  })
  assert.equal(tracker.observe(settled, 225), undefined)
})

test('starts once at mount and replaces an abandoned change with the latest query', () => {
  const tracker = new BrowsePerformanceTracker()
  const view = { ...initial, enabled: true }
  const opened = tracker.observe({ ...view, outcome: 'empty' }, 100)
  assert.ok(opened)
  assert.deepEqual(tracker.finish(opened, 117), {
    action: 'open',
    durationMs: 17,
  })
  tracker.observe({ ...view, identity: 'filter A' }, 200)
  const abandoned = tracker.observe(
    { ...view, identity: 'filter A', outcome: 'rows' },
    215,
  )
  assert.ok(abandoned)
  tracker.observe({ ...view, identity: 'filter B' }, 220)
  assert.equal(tracker.finish(abandoned, 225), undefined)
  const current = tracker.observe(
    { ...view, identity: 'filter B', outcome: 'error' },
    250,
  )
  assert.ok(current)
  assert.deepEqual(tracker.finish(current, 265), {
    action: 'change',
    durationMs: 45,
  })
})

test('records a new viewport page only when scrolling waits for results', () => {
  const tracker = new BrowsePerformanceTracker()
  const view = { ...initial, enabled: true }
  const first = tracker.observe({ ...view, outcome: 'rows' }, 10)
  assert.ok(first)
  tracker.finish(first, 30)
  assert.equal(
    tracker.observe({ ...view, page: 2, scrollTop: 4000, outcome: 'rows' }, 50),
    undefined,
  )
  const unloaded = { ...view, page: 3, scrollTop: 8000 }
  tracker.observe(unloaded, 60)
  const third = tracker.observe({ ...unloaded, outcome: 'rows' }, 75)
  assert.ok(third)
  assert.deepEqual(tracker.finish(third, 90), {
    action: 'page',
    durationMs: 30,
  })
})

test('drops hidden and expired measurements', () => {
  const tracker = new BrowsePerformanceTracker()
  const view = { ...initial, enabled: true }
  const first = tracker.observe({ ...view, outcome: 'rows' }, 10, 0)
  assert.ok(first)
  tracker.discard()
  assert.equal(tracker.finish(first, 20), undefined)
  const change = tracker.observe(
    { ...view, identity: 'next', outcome: 'empty' },
    30,
  )
  assert.ok(change)
  assert.equal(tracker.finish(change, 300_031), undefined)
})

test('splits a slow Tracks change at request, validated page and commit boundaries', () => {
  const tracker = new BrowsePerformanceTracker()
  const view = { ...initial, enabled: true }
  tracker.observe(view, 0)
  tracker.observe({ ...view, identity: 'filter' }, 99.6)
  const measurement = tracker.observe(
    { ...view, identity: 'filter', outcome: 'rows' },
    2_300.2,
  )
  assert.ok(measurement)
  assert.deepEqual(
    tracksChangePhases(
      {
        measurement,
        committedAt: 2_300.2,
        pageTiming: { requestedAt: 2_100.1, readyAt: 2_240 },
      },
      2_230,
    ),
    {
      source: 'request',
      waitMs: 2_001,
      loadMs: 139,
      commitMs: 61,
      paintMs: 29,
    },
  )
})

test('distinguishes slow paint of cached rows and clips a request already under way', () => {
  const tracker = new BrowsePerformanceTracker()
  const view = { ...initial, enabled: true }
  tracker.observe(view, 0)
  const measurement = tracker.observe(
    { ...view, identity: 'filter', outcome: 'rows' },
    100,
  )
  assert.ok(measurement)
  const outcome = { measurement, committedAt: 140 }
  assert.deepEqual(
    tracksChangePhases(
      {
        ...outcome,
        pageTiming: { requestedAt: 1, readyAt: 99 },
      },
      1_200,
    ),
    { source: 'cache', commitMs: 40, paintMs: 1_160 },
  )
  assert.deepEqual(
    tracksChangePhases(
      {
        ...outcome,
        pageTiming: { requestedAt: 80, readyAt: 120 },
      },
      1_200,
    ),
    { source: 'request', waitMs: 0, loadMs: 20, commitMs: 20, paintMs: 1_160 },
  )
  assert.equal(tracksChangePhases(outcome, 1_200), undefined)
  assert.equal(
    tracksChangePhases(
      {
        ...outcome,
        pageTiming: { requestedAt: 1, readyAt: 99 },
      },
      999,
    ),
    undefined,
  )
})

test('the document candidate is matched by origin and pathname only', () => {
  const location = { origin: 'https://example.test', pathname: '/tracks' }
  assert.equal(
    navigationMatchesPath(
      'https://example.test/tracks?q=example#row',
      location,
    ),
    true,
  )
  assert.equal(
    navigationMatchesPath('https://example.test/albums', location),
    false,
  )
  assert.equal(
    navigationMatchesPath('https://other.test/tracks', location),
    false,
  )
})

test('splits the visible rows duration at document and page-loading milestones', () => {
  const tracker = new BrowsePerformanceTracker()
  tracker.observe(initial, 4_000, 0)
  const committedAt = 6_060.1
  const measurement = tracker.observe(
    { ...initial, enabled: true, outcome: 'rows' },
    committedAt,
  )
  assert.ok(measurement)
  const settled = {
    measurement,
    committedAt,
    pageTiming: { requestedAt: 5_400.4, readyAt: 5_950.1 },
  }
  const phases = {
    firstByteMs: 1_900,
    beforePageRequestMs: 3_500,
    pageLoadMs: 550,
    commitMs: 110,
    paintMs: 30,
    firstContentfulPaintMs: 3_250,
  }
  assert.deepEqual(
    browseDocumentPhases(settled, 6_090, 1_899.5, 3_250.2),
    phases,
  )
  assert.deepEqual(browseDocumentPhases(settled, 6_090, 1_899.5, 6_600), {
    ...phases,
    firstContentfulPaintMs: undefined,
  })
  assert.equal(browseDocumentPhases(settled, 6_090, 0), undefined)
  assert.equal(browseDocumentPhases(settled, 6_090, 5_500), undefined)
  assert.equal(browseDocumentPhases(settled, 2_499, 1_899.5), undefined)
  assert.equal(
    browseDocumentPhases({ ...settled, pageTiming: undefined }, 6_090, 1_899.5),
    undefined,
  )
})

test('detail timing follows the newly opened entity and ignores refreshed results', () => {
  const tracker = new BrowsePerformanceTracker('detail')
  const first = { ...initial, enabled: true }
  tracker.observe(first, 100)
  const abandoned = tracker.observe({ ...first, outcome: 'rows' }, 125)
  assert.ok(abandoned)
  const next = { ...first, identity: 'second' }
  tracker.observe(next, 130)
  assert.equal(tracker.finish(abandoned, 140), undefined)

  const failure = { ...next, outcome: 'error' } satisfies Parameters<
    typeof tracker.observe
  >[0]
  const shown = tracker.observe(failure, 160)
  assert.ok(shown)
  assert.deepEqual(tracker.finish(shown, 175), {
    action: 'detail',
    durationMs: 45,
  })
  assert.equal(tracker.observe({ ...next, outcome: 'rows' }, 200), undefined)
})

test('details opened or covered in the background produce no sample', () => {
  const tracker = new BrowsePerformanceTracker('detail')
  const detail = { ...initial, outcome: 'rows' } satisfies Parameters<
    typeof tracker.observe
  >[0]
  assert.equal(tracker.observe(detail, 100), undefined)
  assert.equal(tracker.observe({ ...detail, enabled: true }, 110), undefined)
  const open = { ...detail, identity: 'foreground', enabled: true }
  const waitingForPaint = tracker.observe(open, 125)
  assert.ok(waitingForPaint)
  tracker.observe({ ...open, enabled: false }, 130)
  assert.equal(tracker.finish(waitingForPaint, 145), undefined)
  assert.equal(tracker.observe(open, 150), undefined)
})
