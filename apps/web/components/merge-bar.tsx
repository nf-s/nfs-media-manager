'use client'

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type {
  LibraryChange,
  LibraryChangeAction,
} from '@repo/schemas/library-changes'
import { Notice } from '@repo/ui/components/ds/feedback'
import {
  Button,
  mutationFeedback,
  type ButtonFeedback,
} from '@repo/ui/components/ui/button'
import { TableSelectionResult } from '@repo/ui/components/ui/table'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import {
  describeRowSelection,
  emptyRowSelection,
  replaceRows,
  rowSelectionFor,
  selectMatchingRows,
  setLoadedRows,
  toggleRow,
  type SelectionRows,
} from '@/utils/row-selection'
import {
  invalidateLibraryRecords,
  libraryChangeBlock,
  toggleLibraryChange,
} from '@/utils/library-changes'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'
import { SecondaryTableSelectionBar } from './secondary-table'

/** The width of a table's selection column. */
export const rowSelectionWidth = 36

/**
 * Row selection for a table, by record ID. `orderedIds` are the rows the
 * table has, in display order; a shift-click selects the range between.
 * With `result`, the whole result of the view can be selected (Select all
 * matching): its rows are ticked as they load and unticking one excludes it.
 * With `identity`, the selection is cleared when the view changes.
 */
export function useRowSelection(
  orderedIds: readonly string[],
  {
    identity = '',
    result,
    outside,
  }: Pick<SelectionRows, 'result' | 'outside'> & { identity?: string } = {},
) {
  const [stored, setStored] = useState(() => emptyRowSelection(identity))
  const state = rowSelectionFor(stored, identity)
  const rows: SelectionRows = { ordered: orderedIds, result, outside }
  return {
    ...describeRowSelection(state, rows),
    toggle(id: string, checked: boolean, shift: boolean) {
      setStored(toggleRow(state, rows, id, checked, shift))
    },
    setAll(checked: boolean) {
      setStored(setLoadedRows(state, rows, checked))
    },
    selectMatching() {
      setStored(selectMatchingRows(state, rows))
    },
    replace(next: string[]) {
      setStored(replaceRows(state, next))
    },
    clear() {
      setStored(emptyRowSelection(identity))
    },
  }
}
export type RowSelection = ReturnType<typeof useRowSelection>

/**
 * PL-30: Select all matching, after the Browse toolbar's count in Table view,
 * while there is a result that is not wholly selected.
 */
export function SelectAllMatching({
  selection,
  noun,
}: {
  selection: RowSelection
  /** The rows' noun, as in "128 tracks". */
  noun: { one: string; other: string }
}) {
  if (!selection.canSelectMatching || selection.total === undefined) return null
  return (
    <Button
      type="button"
      variant="link"
      title={`Select all ${formatItemCount(selection.total, noun)} that match, including rows not loaded yet`}
      onClick={selection.selectMatching}
    >
      Select all matching
    </Button>
  )
}

/** The tri-state checkbox of the selection column's header. */
export function RowSelectAll({
  selection,
  label,
  matchingLabel = label,
  disabled = false,
}: {
  selection: RowSelection
  /** States the scope, such as "Select loaded tracks". */
  label: string
  /** The scope while the whole result is selected: "Select all matching tracks". */
  matchingLabel?: string
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (input.current) input.current.indeterminate = selection.some
  }, [selection.some])
  return (
    <input
      ref={input}
      type="checkbox"
      className="ds-check"
      aria-label={selection.everyMatch ? matchingLabel : label}
      checked={selection.all}
      disabled={disabled}
      onChange={(event) => selection.setAll(event.target.checked)}
    />
  )
}

/** The checkbox of one row. A click on it never opens the row. */
export function RowSelectRow({
  selection,
  id,
  title,
  disabled = false,
}: {
  selection: RowSelection
  id: string
  /** The row's name, read as "Select {title}". */
  title: string
  disabled?: boolean
}) {
  return (
    <input
      type="checkbox"
      className="ds-check"
      aria-label={`Select ${title}`}
      checked={selection.has(id)}
      disabled={disabled || !selection.selectable(id)}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) =>
        selection.toggle(
          id,
          event.target.checked,
          'shiftKey' in event.nativeEvent &&
            event.nativeEvent.shiftKey === true,
        )
      }
    />
  )
}

/** Undo for a change, or Redo once it is undone. Disabled while a later change stands in the way. */
export function LibraryChangeUndo({
  change,
  size,
  redoVariant = 'ghost',
  onChanged,
  onError,
}: {
  change: LibraryChange
  size?: 'xs'
  /** The selection bar has no ghost button; Redo is a default button there. */
  redoVariant?: 'ghost' | 'default'
  onChanged?: (change: LibraryChange) => void
  onError?: (message: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const toggle = useMutation({
    retry: false,
    mutationFn: (current: LibraryChange) =>
      toggleLibraryChange(apiBaseUrl, current),
    onSuccess: (next) => {
      onChanged?.(next)
      const removed = [...next.sources, ...(next.target ? [next.target] : [])]
        .filter((record) => !record.exists)
        .map((record) => record.id)
      void (next.kind === 'track'
        ? invalidateScrobbleLinks(client, removed)
        : invalidateLibraryRecords(client, next.kind, removed))
    },
    onError: (failure) =>
      onError?.(errorMessage(failure, 'The change could not be undone.')),
  })
  const block = libraryChangeBlock(change)
  return (
    <Button
      size={size}
      variant={change.undoneAt ? redoVariant : 'default'}
      disabled={toggle.isPending || block !== null}
      title={block ?? undefined}
      onClick={() => toggle.mutate(change)}
      feedback={
        toggle.variables?.id === change.id
          ? mutationFeedback(toggle, {
              pending: toggle.variables.undoneAt ? 'Redoing…' : 'Undoing…',
              success: toggle.variables.undoneAt ? 'Redone · Undo' : 'Redo',
              error: toggle.variables.undoneAt
                ? 'Could not redo'
                : 'Could not undo',
            })
          : undefined
      }
    >
      {change.undoneAt ? 'Redo' : 'Undo'}
    </Button>
  )
}

/**
 * The records to merge and, when chosen, the one to keep. `follow` says
 * whether what follows the merge is merged with it; the server does when it
 * is omitted.
 */
export type MergeRequest = { ids: string[]; keepId?: string; follow?: boolean }

/** Props of a kind's review content, placed in the review dialog above Merge and Cancel. */
export type MergeReviewProps<Plan> = {
  plan: Plan
  pending: boolean
  /** Plans the merge again, with other records or another one to keep. */
  replan: (request: MergeRequest) => void
  /** What follows the merge is merged with it. On until the owner turns it off. */
  follow: boolean
  setFollow: (follow: boolean) => void
  /** The merge's error notice, to place after the plan's own notices. */
  error: ReactNode
}

/** What differs between merging tracks, albums or artists. */
export type MergeAdapter<Plan> = {
  plan: (apiBaseUrl: string, request: MergeRequest) => Promise<Plan>
  merge: (
    apiBaseUrl: string,
    request: MergeRequest & { reviewed: boolean },
  ) => Promise<LibraryChange>
  /** The server confirmed that this request did not apply a change. */
  canRetry?: (failure: unknown) => boolean
  /** The records a plan merges and the one it keeps. */
  request: (plan: Plan) => MergeRequest
  /** Something speaks against the merge, or part of it cannot be made. */
  needsReview: (plan: Plan) => boolean
  /** The merge cannot be made as planned. */
  blocked: (plan: Plan) => boolean
  /** The owner must acknowledge this evidence before confirming the plan. */
  acknowledgement?: (plan: Plan) => string | null
  Review: ComponentType<MergeReviewProps<Plan>>
  wording: {
    /** The review dialog's title. */
    title: (plan: Plan) => string
    /** Why Merge is off while fewer than two rows are selected. */
    selectMore: string
    /** The error when the merge fails. */
    failed: string
  }
  /** One line saying what a finished change did. */
  describe: (change: LibraryChange) => string
  /** Refreshes the queries a finished merge affects. */
  invalidate: (client: QueryClient, change: LibraryChange) => Promise<void>
}

export type MergeOutcome<Plan> =
  | { status: 'review'; plan: Plan }
  | { status: 'merged'; change: LibraryChange }

/** The review dialog: the kind's content with Merge and Cancel. */
function MergeReviewDialog<Plan>({
  adapter,
  plan,
  pending,
  reviewing,
  error,
  follow,
  onFollow,
  onPlan,
  onMerge,
  onClose,
}: {
  adapter: MergeAdapter<Plan>
  plan: Plan
  pending: boolean
  reviewing: boolean
  error: string | null
  follow: boolean
  onFollow: (follow: boolean) => void
  onPlan: (request: MergeRequest) => void
  onMerge: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [acknowledged, setAcknowledged] = useState<Plan | null>(null)
  useEffect(() => {
    const element = dialog.current
    const previous = document.activeElement
    if (!element?.open) element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true })
    }
  }, [])
  const { Review } = adapter
  const acknowledgement = adapter.acknowledgement?.(plan)
  return (
    <dialog
      ref={dialog}
      className="dtl-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!pending) onClose()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (!pending && event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="dtl-dialog-inner">
        <div className="ds-inspector-bar">
          <div className="ds-crumbs">
            <b id={titleId}>{adapter.wording.title(plan)}</b>
          </div>
          <Button
            variant="ghost"
            icon
            aria-label="Close"
            disabled={pending}
            onClick={onClose}
          >
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </div>
        <div className="dtl-dialog-body">
          <Review
            plan={plan}
            pending={pending}
            replan={onPlan}
            follow={follow}
            setFollow={onFollow}
            error={error ? <Notice tone="danger">{error}</Notice> : null}
          />
          {acknowledgement && (
            <label className="ds-checkrow">
              <input
                type="checkbox"
                className="ds-check"
                disabled={pending}
                checked={acknowledged === plan}
                onChange={(event) =>
                  setAcknowledged(event.target.checked ? plan : null)
                }
              />
              <span>{acknowledgement}</span>
            </label>
          )}
          <div className="ds-actions">
            <Button
              variant="primary"
              disabled={
                pending ||
                adapter.blocked(plan) ||
                Boolean(acknowledgement && acknowledged !== plan)
              }
              onClick={onMerge}
              feedback={
                pending
                  ? {
                      phase: 'pending',
                      label: reviewing ? 'Rechecking plan…' : 'Merging…',
                    }
                  : undefined
              }
            >
              Merge
            </Button>
            <Button disabled={pending} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </dialog>
  )
}

/**
 * A merge of any kind: `merge(ids)` makes it at once unless something speaks
 * against it; then the review opens first. Render `dialog` for the review and
 * `result` for the finished change with Undo, Redo and Dismiss.
 */
export function useMerge<Plan>(
  adapter: MergeAdapter<Plan>,
  {
    onPlan,
    onMerge,
    requireReview = false,
  }: {
    /** The records the latest plan merges. */
    onPlan?: (ids: string[]) => void
    onMerge?: (change: LibraryChange) => void
    /** Require confirmation even for a plan with no cautions. */
    requireReview?: boolean
  } = {},
) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [review, setReview] = useState<Plan | null>(null)
  const [follow, setFollow] = useState(true)
  const [change, setChange] = useState<LibraryChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const plan = useMutation({
    retry: false,
    mutationFn: (request: MergeRequest) => adapter.plan(apiBaseUrl, request),
    onMutate: () => setError(null),
    onSuccess: (next) => {
      onPlan?.(adapter.request(next).ids)
      setReview(next)
    },
    onError: (failure) =>
      setError(errorMessage(failure, 'The merge could not be planned.')),
  })
  const make = useMutation({
    retry: false,
    mutationFn: async ({
      reviewed,
      ...chosen
    }: MergeRequest & { reviewed: boolean }): Promise<MergeOutcome<Plan>> => {
      if (!reviewed) {
        setChecking(true)
        const next = await adapter
          .plan(apiBaseUrl, chosen)
          .finally(() => setChecking(false))
        if (requireReview || adapter.needsReview(next))
          return { status: 'review', plan: next }
      }
      return {
        status: 'merged',
        change: await adapter.merge(apiBaseUrl, { ...chosen, reviewed }),
      }
    },
    onMutate: () => setError(null),
    onSuccess: (outcome) => {
      if (outcome.status === 'review') {
        setFollow(true)
        setReview(outcome.plan)
        return
      }
      setReview(null)
      setChange(outcome.change)
      onMerge?.(outcome.change)
      void adapter.invalidate(client, outcome.change)
    },
    onError: (failure) =>
      setError(errorMessage(failure, adapter.wording.failed)),
  })
  const pending = plan.isPending || make.isPending
  const feedback: ButtonFeedback | undefined =
    plan.isPending || checking
      ? { phase: 'pending', label: 'Checking merge…' }
      : make.isPending
        ? { phase: 'pending', label: 'Merging…' }
        : review
          ? { phase: 'waiting', label: 'Needs review' }
          : error && make.isError
            ? { phase: 'failed', label: 'Merge failed' }
            : change
              ? { phase: 'done', label: 'Merged' }
              : undefined
  const failedRequest = make.variables
  const dismiss = () => {
    setChange(null)
    setError(null)
  }

  return {
    /** Merges these records, or opens the review. Resolves to null when it failed; `error` says why. */
    merge: (ids: readonly string[], keepId?: string) =>
      make
        .mutateAsync({ ids: [...ids], keepId, reviewed: false })
        .catch(() => null),
    pending,
    feedback,
    /** The plan the review dialog shows. */
    review,
    /** The last finished change. */
    change,
    error,
    retry:
      error && make.isError && failedRequest && adapter.canRetry?.(make.error)
        ? () => make.mutate(failedRequest)
        : undefined,
    clearError: () => setError(null),
    /** Hides the finished change. */
    dismiss,
    dialog: review ? (
      <MergeReviewDialog
        adapter={adapter}
        plan={review}
        pending={pending}
        reviewing={plan.isPending}
        error={error}
        follow={follow}
        onFollow={setFollow}
        onPlan={(request) => plan.mutate(request)}
        onMerge={() =>
          make.mutate({ ...adapter.request(review), follow, reviewed: true })
        }
        onClose={() => {
          setReview(null)
          setError(null)
        }}
      />
    ) : null,
    /** The finished change for a selection bar, with Undo or Redo and Dismiss. */
    result: change ? (
      <LibraryChangeResult
        change={change}
        describe={adapter.describe}
        error={error}
        onChanged={(next) => {
          setError(null)
          setChange(next)
        }}
        onError={setError}
        onDismiss={dismiss}
      />
    ) : null,
  }
}

/** Where one record set stands in the background work, by its key. */
export type MergeQueueItem =
  | {
      status: 'queued' | 'running' | 'review'
      action: LibraryChangeAction
      checking?: boolean
    }
  | { status: 'done'; action: LibraryChangeAction; change: LibraryChange }
  | { status: 'failed'; action: LibraryChangeAction; message: string }

export function mergeQueueFeedback(
  item: MergeQueueItem | undefined,
  action: LibraryChangeAction,
): ButtonFeedback | undefined {
  if (!item || item.action !== action) return undefined
  const merging = action === 'merge'
  switch (item.status) {
    case 'queued':
      return {
        phase: 'waiting',
        label: merging ? 'Waiting to merge' : 'Waiting to separate',
      }
    case 'running':
      return {
        phase: 'running',
        label: item.checking
          ? 'Checking merge…'
          : merging
            ? 'Merging…'
            : 'Keeping separate…',
      }
    case 'review':
      return { phase: 'waiting', label: 'Needs review' }
    case 'done':
      return { phase: 'done', label: merging ? 'Merged' : 'Kept separate' }
    case 'failed':
      return {
        phase: 'failed',
        label: merging ? 'Merge failed' : 'Could not keep separate',
      }
  }
}

export type MergeQueueSnapshot<Plan> = {
  items: ReadonlyMap<string, MergeQueueItem>
  /** Queued or running, in the order pressed; the first is running. */
  waiting: readonly { key: string; action: LibraryChangeAction }[]
  /** Merges waiting for the owner's review; the first one is shown. */
  reviews: readonly {
    key: string
    plan: Plan
    follow?: boolean
    error?: string
  }[]
}

export type MergeQueueHandlers = {
  onDone?: (change: LibraryChange) => void
  /** `ids` are the records whose change failed. */
  onFail?: (message: string, ids: readonly string[]) => void
  /** The review was closed without merging these records. */
  onCancel?: (ids: readonly string[]) => void
  /** The queue is empty again; refreshes what the finished changes affect. */
  onDrain?: (changes: readonly LibraryChange[]) => Promise<unknown>
}

/**
 * One change standing for several, so one refresh covers them all: every
 * record the changes name is among its sources.
 */
export function combineLibraryChanges(
  changes: readonly LibraryChange[],
): LibraryChange | null {
  const last = changes.at(-1)
  if (!last) return null
  return {
    ...last,
    sources: changes.flatMap((change) =>
      change === last
        ? change.sources
        : [...change.sources, ...(change.target ? [change.target] : [])],
    ),
  }
}

/**
 * Merges and other library changes made in the background, one request
 * after another in the order pressed. A merge that something speaks against
 * waits for its review while the rest go on. `onDrain` runs once each time
 * the queue empties; finished items stay until it has refreshed.
 */
export function createMergeQueue<Plan>(
  adapter: MergeAdapter<Plan>,
  apiBaseUrl: string,
  handlers: () => MergeQueueHandlers,
) {
  let snapshot: MergeQueueSnapshot<Plan> = {
    items: new Map(),
    waiting: [],
    reviews: [],
  }
  const listeners = new Set<() => void>()
  let tail: Promise<void> = Promise.resolve()
  let draining: Promise<void> = Promise.resolve()
  let finished: { key: string; change: LibraryChange }[] = []

  function publish(next: Partial<MergeQueueSnapshot<Plan>>) {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  function setItem(key: string, item: MergeQueueItem | null) {
    const items = new Map(snapshot.items)
    if (item) items.set(key, item)
    else items.delete(key)
    publish({ items })
  }
  function busy(key: string) {
    const item = snapshot.items.get(key)
    return item !== undefined && item.status !== 'failed'
  }
  async function drain() {
    const changes = finished
    finished = []
    if (changes.length === 0) return
    try {
      await handlers().onDrain?.(changes.map(({ change }) => change))
    } finally {
      const items = new Map(snapshot.items)
      for (const { key, change } of changes) {
        const item = items.get(key)
        if (item?.status === 'done' && item.change.id === change.id)
          items.delete(key)
      }
      publish({ items })
    }
  }
  function enqueue({
    key,
    ids,
    action,
    failed,
    run,
  }: {
    key: string
    ids: readonly string[]
    action: LibraryChangeAction
    /** The error when the request fails without saying why. */
    failed: string
    /** Makes the change, or resolves to null when the review opened. */
    run: () => Promise<LibraryChange | null>
  }) {
    setItem(key, { status: 'queued', action })
    publish({ waiting: [...snapshot.waiting, { key, action }] })
    const job = tail.then(async () => {
      setItem(key, { status: 'running', action })
      const outcome = await run().then(
        (change) => ({ change }),
        (failure: unknown) => ({ message: errorMessage(failure, failed) }),
      )
      const at = snapshot.waiting.findIndex((entry) => entry.key === key)
      publish({ waiting: snapshot.waiting.filter((_, index) => index !== at) })
      try {
        if ('message' in outcome) {
          setItem(key, { status: 'failed', action, message: outcome.message })
          handlers().onFail?.(outcome.message, ids)
        } else if (outcome.change) {
          setItem(key, { status: 'done', action, change: outcome.change })
          finished.push({ key, change: outcome.change })
          handlers().onDone?.(outcome.change)
        }
      } finally {
        if (snapshot.waiting.length === 0) draining = drain()
      }
    })
    // A failing handler must not stop the requests queued after it.
    tail = job.then(
      () => undefined,
      () => undefined,
    )
    return job
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    /** Queued, running, under review or finished: its actions are off. */
    busy,
    /** Plans the merge in turn, then makes it or opens its review. Resolves when that is done. */
    merge(key: string, request: MergeRequest) {
      if (busy(key)) return Promise.resolve()
      return enqueue({
        key,
        ids: request.ids,
        action: 'merge',
        failed: adapter.wording.failed,
        run: async () => {
          setItem(key, { status: 'running', action: 'merge', checking: true })
          const plan = await adapter.plan(apiBaseUrl, request)
          if (!adapter.needsReview(plan)) {
            setItem(key, { status: 'running', action: 'merge' })
            return adapter.merge(apiBaseUrl, { ...request, reviewed: false })
          }
          setItem(key, { status: 'review', action: 'merge' })
          publish({ reviews: [...snapshot.reviews, { key, plan }] })
          return null
        },
      })
    },
    /** Another change made in turn, such as Keep separate. */
    add(job: {
      key: string
      ids: readonly string[]
      action: LibraryChangeAction
      failed: string
      run: () => Promise<LibraryChange>
    }) {
      if (busy(job.key)) return Promise.resolve()
      return enqueue(job)
    },
    /** The review planned again, with other records or another one to keep. */
    replan(key: string, plan: Plan) {
      publish({
        reviews: snapshot.reviews.map((review) =>
          review.key === key ? { ...review, plan } : review,
        ),
      })
    },
    /** Closes the review and queues its merge. */
    confirm(key: string, follow: boolean) {
      const review = snapshot.reviews.find((entry) => entry.key === key)
      if (!review) return Promise.resolve()
      publish({ reviews: snapshot.reviews.filter((entry) => entry !== review) })
      const request = { ...adapter.request(review.plan), follow }
      return enqueue({
        key,
        ids: request.ids,
        action: 'merge',
        failed: adapter.wording.failed,
        run: async () => {
          try {
            return await adapter.merge(apiBaseUrl, {
              ...request,
              reviewed: true,
            })
          } catch (failure) {
            if (!adapter.canRetry?.(failure)) throw failure
            setItem(key, { status: 'review', action: 'merge' })
            const error = errorMessage(failure, adapter.wording.failed)
            publish({
              reviews: [...snapshot.reviews, { ...review, follow, error }],
            })
            return null
          }
        },
      })
    },
    /** Closes the review without merging. */
    cancel(key: string) {
      const review = snapshot.reviews.find((entry) => entry.key === key)
      if (!review) return
      publish({ reviews: snapshot.reviews.filter((entry) => entry !== review) })
      setItem(key, null)
      handlers().onCancel?.(adapter.request(review.plan).ids)
    },
    /** Resolves once everything queued so far has finished and refreshed. */
    settled: () => tail.then(() => draining),
  }
}
export type MergeQueue<Plan> = ReturnType<typeof createMergeQueue<Plan>>

/**
 * A merge queue for a component, with its review dialog. Render `dialog`;
 * only one review is open at a time.
 */
export function useMergeQueue<Plan>(
  adapter: MergeAdapter<Plan>,
  handlers: MergeQueueHandlers,
) {
  const { apiBaseUrl } = useConfig()
  const latest = useRef(handlers)
  latest.current = handlers
  const [queue] = useState(() =>
    createMergeQueue(adapter, apiBaseUrl, () => latest.current),
  )
  const snapshot = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  )
  const [followChoice, setFollow] = useState<boolean>()
  const replan = useMutation({
    retry: false,
    mutationFn: async ({
      key,
      request,
    }: {
      key: string
      request: MergeRequest
    }) => ({
      key,
      plan: await adapter.plan(apiBaseUrl, request),
    }),
    onSuccess: ({ key, plan }) => queue.replan(key, plan),
  })
  const [review] = snapshot.reviews
  const follow = followChoice ?? review?.follow ?? true
  function close() {
    setFollow(undefined)
    replan.reset()
  }
  return {
    queue,
    snapshot,
    status: (key: string) => snapshot.items.get(key),
    dialog: review ? (
      <MergeReviewDialog
        key={review.key}
        adapter={adapter}
        plan={review.plan}
        pending={replan.isPending}
        reviewing={replan.isPending}
        error={
          replan.isError
            ? errorMessage(replan.error, 'The merge could not be planned.')
            : (review.error ?? null)
        }
        follow={follow}
        onFollow={setFollow}
        onPlan={(request) => replan.mutate({ key: review.key, request })}
        onMerge={() => {
          close()
          void queue.confirm(review.key, follow)
        }}
        onClose={() => {
          close()
          queue.cancel(review.key)
        }}
      />
    ) : null,
  }
}

/**
 * The report in a bar under a table: what is still being changed, then the
 * last finished change with Undo, or why the last one failed.
 */
export function LibraryChangeReport({
  progress,
  change,
  describe,
  error,
  onChanged,
  onError,
  onDismiss,
}: {
  /** Such as "Merging 3 groups…"; null when nothing is waiting. */
  progress: string | null
  change: LibraryChange | null
  describe: (change: LibraryChange) => string
  error: string | null
  onChanged: (change: LibraryChange) => void
  onError: (message: string) => void
  onDismiss: () => void
}) {
  return (
    <>
      {progress && <span role="status">{progress}</span>}
      {change ? (
        <LibraryChangeResult
          change={change}
          describe={describe}
          error={error}
          onChanged={onChanged}
          onError={onError}
          onDismiss={onDismiss}
        />
      ) : (
        error !== null && (
          <>
            <span role="alert">{error}</span>
            <span className="ds-actions ds-toolbar-end">
              <Button icon aria-label="Dismiss" onClick={onDismiss}>
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          </>
        )
      )}
    </>
  )
}

/**
 * A finished change in a selection bar: one line saying what changed, then
 * Undo or Redo and Dismiss.
 */
export function LibraryChangeResult({
  change,
  describe,
  error,
  onChanged,
  onError,
  onDismiss,
}: {
  change: LibraryChange
  describe: (change: LibraryChange) => string
  /** Why the last Undo or Redo failed. */
  error: string | null
  onChanged: (change: LibraryChange) => void
  onError: (message: string) => void
  onDismiss: () => void
}) {
  return (
    <>
      <TableSelectionResult
        icon={
          change.undoneAt ? (
            <History className="ds-i" data-size="sm" aria-hidden="true" />
          ) : (
            <Check className="ds-i" data-size="sm" aria-hidden="true" />
          )
        }
      >
        {change.undoneAt ? 'Undone: ' : ''}
        {describe(change)}
        {error ? ` · ${error}` : ''}
      </TableSelectionResult>
      <span className="ds-actions ds-toolbar-end">
        <LibraryChangeUndo
          change={change}
          redoVariant="default"
          onChanged={onChanged}
          onError={onError}
        />
        <Button icon aria-label="Dismiss" onClick={onDismiss}>
          <X className="ds-i" aria-hidden="true" />
        </Button>
      </span>
    </>
  )
}

/** How many selection merges are still to go, in words. */
export function describeMergeProgress(waiting: number) {
  if (waiting === 0) return null
  return waiting === 1
    ? 'Merging…'
    : `Merging ${formatItemCount(waiting, { one: 'selection', other: 'selections' })}…`
}

/** PL-32: Merge's title while the whole result is selected. */
export const mergeNeedsTickedRows =
  'Merge needs ticked rows. Clear the selection and tick the rows to merge.'

/**
 * The bar under a table: the selection with Merge, then the result of the
 * last merge with Undo. Merge returns at once: the selection clears and the
 * merge is made in the background while another selection can be merged.
 */
export function MergeBar<Plan>({
  selection,
  total,
  adapter,
  actions,
}: {
  selection: RowSelection
  /** How many rows the table lists. */
  total?: number
  adapter: MergeAdapter<Plan>
  /** Other actions on the selection, such as Add to playlist, before Merge. */
  actions?: ReactNode
}) {
  const client = useQueryClient()
  const [changes, setChanges] = useState<LibraryChange[]>([])
  const [error, setError] = useState<string | null>(null)
  function updateReceipt(next: LibraryChange) {
    setError(null)
    setChanges((current) =>
      current.map((entry) => (entry.id === next.id ? next : entry)),
    )
  }
  // A merge that failed or was not confirmed comes back as the selection.
  const restore = (ids: readonly string[]) => {
    if (selection.count === 0) selection.replace([...ids])
  }
  const merges = useMergeQueue(adapter, {
    onDone: (next) => setChanges((current) => [...current, next]),
    onFail: (message, ids) => {
      setError(message)
      restore(ids)
    },
    onCancel: restore,
    onDrain: async (changes) => {
      const combined = combineLibraryChanges(changes)
      if (combined) await adapter.invalidate(client, combined)
    },
  })
  const progress = describeMergeProgress(merges.snapshot.waiting.length)
  const [lastKey, setLastKey] = useState<string | null>(null)
  const lastAction = lastKey ? merges.status(lastKey) : undefined
  const lastFeedback = mergeQueueFeedback(lastAction, 'merge')
  return (
    <>
      <SecondaryTableSelectionBar
        selectedCount={selection.count}
        total={total}
        hideWhenEmpty
      >
        {selection.count > 0 ? (
          <>
            {selection.offerMatching && total !== undefined && (
              <Button
                type="button"
                className="ds-selectbar-offer"
                onClick={selection.selectMatching}
              >
                {`Select all ${formatCount(total)} matching`}
              </Button>
            )}
            {progress && <span role="status">{progress}</span>}
            {error && <span role="alert">{error}</span>}
            <span className="ds-actions ds-toolbar-end">
              {actions}
              <Button
                variant="primary"
                disabled={selection.matching || selection.count < 2}
                title={
                  selection.matching
                    ? mergeNeedsTickedRows
                    : selection.count < 2
                      ? adapter.wording.selectMore
                      : undefined
                }
                onClick={() => {
                  setError(null)
                  const key = selection.ids.join(' ')
                  setLastKey(key)
                  void merges.queue.merge(key, {
                    ids: [...selection.ids],
                  })
                  selection.clear()
                }}
              >
                Merge
              </Button>
              <Button
                icon
                aria-label="Clear selection"
                onClick={() => {
                  selection.clear()
                  setError(null)
                }}
              >
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          </>
        ) : (
          <>
            {lastFeedback && !error && lastAction?.status !== 'done' && (
              <Button disabled feedback={lastFeedback}>
                Merge
              </Button>
            )}
            <LibraryChangeReport
              progress={
                lastFeedback && merges.snapshot.waiting.length === 1
                  ? null
                  : progress
              }
              change={null}
              describe={adapter.describe}
              error={error}
              onChanged={updateReceipt}
              onError={setError}
              onDismiss={() => setError(null)}
            />
          </>
        )}
      </SecondaryTableSelectionBar>
      {changes.map((change) => (
        <SecondaryTableSelectionBar
          key={change.id}
          selectedCount={0}
          hideWhenEmpty
        >
          <LibraryChangeResult
            change={change}
            describe={adapter.describe}
            error={null}
            onChanged={updateReceipt}
            onError={setError}
            onDismiss={() =>
              setChanges((current) =>
                current.filter((entry) => entry.id !== change.id),
              )
            }
          />
        </SecondaryTableSelectionBar>
      ))}
      {merges.dialog}
    </>
  )
}
