'use client'

import { useLayoutEffect, useRef } from 'react'
import {
  slowBrowseDocumentMs,
  slowTracksChangeMs,
  type BrowserBrowseTiming,
} from '@repo/schemas/performance'

export type BrowsePerformanceScreen = BrowserBrowseTiming['screen']
type Outcome = BrowserBrowseTiming['outcome']
type Action = BrowserBrowseTiming['action']

let documentTimingAvailable = true

/** The persistent app provider calls this on every committed pathname. */
export function observeDocumentBrowsePath() {
  if (!navigationStartedHere()) documentTimingAvailable = false
}

export function navigationMatchesPath(
  navigationUrl: string,
  current: Pick<Location, 'origin' | 'pathname'>,
) {
  const initial = new URL(navigationUrl)
  return (
    initial.origin === current.origin && initial.pathname === current.pathname
  )
}

function navigationStartedHere() {
  const navigation = performance.getEntriesByType('navigation')[0]
  return navigation && navigationMatchesPath(navigation.name, window.location)
    ? navigation
    : undefined
}

function claimDocumentStart() {
  if (!documentTimingAvailable) return undefined
  documentTimingAvailable = false
  const navigation = navigationStartedHere()
  if (!navigation || document.visibilityState !== 'visible') return undefined
  // Browsers without historical visibility can still report mount timing.
  if (
    !globalThis.PerformanceObserver?.supportedEntryTypes.includes(
      'visibility-state',
    )
  )
    return undefined
  const visibility = performance.getEntriesByType('visibility-state')
  if (
    visibility[0]?.name !== 'visible' ||
    visibility.some(({ name }) => name === 'hidden')
  )
    return undefined
  return navigation.startTime
}

type View = {
  identity: string
  enabled: boolean
  page: number
  scrollTop: number
  outcome?: Outcome
}

type Measurement = {
  action: Action
  startedAt: number
}

export type BrowsePageTiming = {
  requestedAt: number
  readyAt: number
  /** Where the page's rows came from: the copy in this browser or the API (DEVICE-46). */
  source?: BrowserBrowseTiming['rowSource']
}

type CommittedOutcome = {
  measurement: Measurement
  committedAt: number
  pageTiming?: BrowsePageTiming
}

export function tracksChangePhases(
  { measurement, committedAt, pageTiming }: CommittedOutcome,
  durationMs: number,
): BrowserBrowseTiming['phases'] {
  if (!pageTiming || durationMs < slowTracksChangeMs) return
  const elapsed = (at: number) =>
    Math.max(0, Math.min(durationMs, Math.round(at - measurement.startedAt)))
  const commit = elapsed(committedAt)
  const paintMs = durationMs - commit
  // A cached page was ready when the query committed, even if it is refreshing.
  if (pageTiming.readyAt <= measurement.startedAt)
    return { source: 'cache', commitMs: commit, paintMs }
  const ready = Math.min(commit, elapsed(pageTiming.readyAt))
  const requested = Math.min(ready, elapsed(pageTiming.requestedAt))
  return {
    source: 'request',
    waitMs: requested,
    loadMs: ready - requested,
    commitMs: commit - ready,
    paintMs,
  }
}

export function browseDocumentPhases(
  { measurement, committedAt, pageTiming }: CommittedOutcome,
  durationMs: number,
  responseStart: number,
  firstContentfulPaint?: number,
): BrowserBrowseTiming['documentPhases'] {
  if (!pageTiming || durationMs < slowBrowseDocumentMs) return

  const elapsed = (at: number) => Math.round(at - measurement.startedAt)
  const { requestedAt, readyAt } = pageTiming
  // Report a breakdown only if the visible page was loaded during this document.
  if (
    !(
      measurement.startedAt < responseStart &&
      responseStart <= requestedAt &&
      requestedAt <= readyAt &&
      readyAt <= committedAt &&
      elapsed(committedAt) <= durationMs
    )
  )
    return

  const firstByteMs = elapsed(responseStart)
  const requestStartMs = elapsed(requestedAt)
  const readyMs = elapsed(readyAt)
  const committedMs = elapsed(committedAt)
  const firstContentfulPaintMs =
    firstContentfulPaint === undefined
      ? undefined
      : elapsed(firstContentfulPaint)
  return {
    firstByteMs,
    beforePageRequestMs: requestStartMs - firstByteMs,
    pageLoadMs: readyMs - requestStartMs,
    commitMs: committedMs - readyMs,
    paintMs: durationMs - committedMs,
    firstContentfulPaintMs:
      firstContentfulPaintMs !== undefined &&
      firstContentfulPaintMs >= firstByteMs &&
      firstContentfulPaintMs <= durationMs
        ? firstContentfulPaintMs
        : undefined,
  }
}

function readBrowseDocumentPhases(
  settled: CommittedOutcome,
  durationMs: number,
) {
  if (!settled.pageTiming || durationMs < slowBrowseDocumentMs) return
  const navigation = navigationStartedHere()
  if (
    typeof PerformanceNavigationTiming === 'undefined' ||
    !(navigation instanceof PerformanceNavigationTiming)
  )
    return
  const firstContentfulPaint = performance.getEntriesByName(
    'first-contentful-paint',
    'paint',
  )[0]?.startTime
  return browseDocumentPhases(
    settled,
    durationMs,
    navigation.responseStart,
    firstContentfulPaint,
  )
}

export class BrowsePerformanceTracker {
  private previous?: View
  private pending?: Measurement

  constructor(private readonly kind: 'browse' | 'detail' = 'browse') {}

  observe(view: View, now: number, documentStart?: number) {
    const previous = this.previous
    this.previous = view
    if (this.kind === 'detail') {
      if (!view.enabled) this.discard()
      else if (!previous || previous.identity !== view.identity)
        this.pending = { action: 'detail', startedAt: now }
      return view.outcome ? this.pending : undefined
    }
    if (!previous) {
      this.pending =
        documentStart === undefined
          ? { action: 'open', startedAt: now }
          : { action: 'document', startedAt: documentStart }
    } else if (previous.identity !== view.identity) {
      if (previous.enabled || !this.isOpening()) {
        this.pending = { action: 'change', startedAt: now }
      }
    } else if (
      view.page !== previous.page &&
      view.scrollTop !== previous.scrollTop &&
      !this.isOpening() &&
      this.pending?.action !== 'change'
    ) {
      this.pending = view.outcome
        ? undefined
        : { action: 'page', startedAt: now }
    }
    return view.enabled && view.outcome ? this.pending : undefined
  }

  private isOpening() {
    return (
      this.pending?.action === 'open' || this.pending?.action === 'document'
    )
  }

  discard() {
    this.pending = undefined
  }

  finish(measurement: Measurement, now: number) {
    if (measurement !== this.pending) return undefined
    this.pending = undefined
    const durationMs = Math.round(now - measurement.startedAt)
    if (durationMs < 0 || durationMs > 300_000) return undefined
    return { action: measurement.action, durationMs }
  }
}

export function useBrowsePerformance(
  screen: BrowsePerformanceScreen | undefined,
  {
    identity,
    enabled,
    page,
    scrollTop,
    outcome,
    pageTiming,
  }: View & {
    pageTiming?: BrowsePageTiming
  },
  kind: 'browse' | 'detail' = 'browse',
) {
  const active = useRef<{
    screen: BrowsePerformanceScreen
    kind: 'browse' | 'detail'
    tracker: BrowsePerformanceTracker
  }>(null)
  const committed = useRef<CommittedOutcome | undefined>(undefined)

  useLayoutEffect(() => {
    if (!screen) return
    function discardWhenHidden() {
      if (document.visibilityState !== 'visible')
        active.current?.tracker.discard()
    }
    document.addEventListener('visibilitychange', discardWhenHidden)
    return () =>
      document.removeEventListener('visibilitychange', discardWhenHidden)
  }, [screen])

  useLayoutEffect(() => {
    if (!screen) {
      active.current = null
      committed.current = undefined
      return
    }
    let documentStart: number | undefined
    if (active.current?.screen !== screen || active.current.kind !== kind) {
      if (kind === 'browse') documentStart = claimDocumentStart()
      active.current = {
        screen,
        kind,
        tracker: new BrowsePerformanceTracker(kind),
      }
    }
    const { tracker } = active.current
    const committedAt = performance.now()
    const measurement = tracker.observe(
      { identity, enabled, page, scrollTop, outcome },
      committedAt,
      documentStart,
    )
    committed.current = measurement
      ? { measurement, committedAt, pageTiming }
      : undefined
    if (document.visibilityState !== 'visible') tracker.discard()
  }, [screen, identity, enabled, page, scrollTop, outcome, pageTiming, kind])

  useLayoutEffect(() => {
    const settled = committed.current
    const current = active.current?.tracker
    if (!screen || !current || !settled || !outcome) return
    if (typeof requestAnimationFrame !== 'function') return

    let afterPaint: number | undefined
    // Allow the committed outcome to paint before reporting it.
    const beforePaint = requestAnimationFrame(() => {
      afterPaint = requestAnimationFrame(() => {
        const sample = current.finish(settled.measurement, performance.now())
        if (!sample || document.visibilityState !== 'visible') return
        const phases =
          screen === 'tracks' &&
          sample.action === 'change' &&
          outcome === 'rows'
            ? tracksChangePhases(settled, sample.durationMs)
            : undefined
        const documentPhases =
          sample.action === 'document' && outcome === 'rows'
            ? readBrowseDocumentPhases(settled, sample.durationMs)
            : undefined
        void fetch('/api/v1/performance/browse', {
          method: 'POST',
          credentials: 'same-origin',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            screen,
            outcome,
            ...sample,
            phases,
            documentPhases,
            rowSource: settled.pageTiming?.source,
          }),
        }).catch(() => {})
      })
    })
    return () => {
      cancelAnimationFrame(beforePaint)
      if (afterPaint !== undefined) cancelAnimationFrame(afterPaint)
    }
  }, [screen, identity, enabled, page, outcome, kind])
}
