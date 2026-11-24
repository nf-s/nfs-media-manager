'use client'

import {
  useEffect,
  useId,
  useMemo,
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
import { Button } from '@repo/ui/components/ui/button'
import { TableSelectionResult } from '@repo/ui/components/ui/table'
import { formatItemCount } from '@repo/ui/lib/format'
import { updateJobSelection } from '@/utils/job-selection'
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
 */
export function useRowSelection(orderedIds: readonly string[]) {
  const [ids, setIds] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const picked = useMemo(() => new Set(ids), [ids])
  const shown = orderedIds.filter((id) => picked.has(id)).length
  return {
    ids,
    count: ids.length,
    has: (id: string) => picked.has(id),
    /** Every row the table has is selected. */
    all: orderedIds.length > 0 && shown === orderedIds.length,
    /** Some of the table's rows are selected. */
    some: shown > 0 && shown < orderedIds.length,
    toggle(id: string, checked: boolean, shift: boolean) {
      setIds(
        updateJobSelection(ids, [...orderedIds], id, anchor, shift, checked),
      )
      setAnchor(id)
    },
    setAll(checked: boolean) {
      const rows = new Set(orderedIds)
      setIds(
        checked
          ? [...new Set([...ids, ...orderedIds])]
          : ids.filter((id) => !rows.has(id)),
      )
      setAnchor(null)
    },
    replace(next: string[]) {
      setIds(next)
      setAnchor(null)
    },
    clear() {
      setIds([])
      setAnchor(null)
    },
  }
}
export type RowSelection = ReturnType<typeof useRowSelection>

/** The tri-state checkbox of the selection column's header. */
export function RowSelectAll({
  selection,
  label,
  disabled = false,
}: {
  selection: RowSelection
  /** States the scope, such as "Select loaded tracks". */
  label: string
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
      aria-label={label}
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
      disabled={disabled}
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
    mutationFn: () => toggleLibraryChange(apiBaseUrl, change),
    onSuccess: async (next) => {
      onChanged?.(next)
      const removed = [...next.sources, ...(next.target ? [next.target] : [])]
        .filter((record) => !record.exists)
        .map((record) => record.id)
      await (next.kind === 'track'
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
      onClick={() => toggle.mutate()}
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
            >
              {pending ? 'Merging...' : 'Merge'}
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
        const next = await adapter.plan(apiBaseUrl, chosen)
        if (requireReview || adapter.needsReview(next))
          return { status: 'review', plan: next }
      }
      return {
        status: 'merged',
        change: await adapter.merge(apiBaseUrl, { ...chosen, reviewed }),
      }
    },
    onMutate: () => setError(null),
    onSuccess: async (outcome) => {
      if (outcome.status === 'review') {
        setFollow(true)
        setReview(outcome.plan)
        return
      }
      setReview(null)
      setChange(outcome.change)
      onMerge?.(outcome.change)
      await adapter.invalidate(client, outcome.change)
    },
    onError: (failure) =>
      setError(errorMessage(failure, adapter.wording.failed)),
  })
  const pending = plan.isPending || make.isPending
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
    /** A merge is being checked or made with no review open. */
    merging: make.isPending && !review,
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
  | { status: 'queued' | 'running' | 'review'; action: LibraryChangeAction }
  | { status: 'done'; action: LibraryChangeAction; change: LibraryChange }
  | { status: 'failed'; action: LibraryChangeAction; message: string }

export type MergeQueueSnapshot<Plan> = {
  items: ReadonlyMap<string, MergeQueueItem>
  /** Queued or running, in the order pressed; the first is running. */
  waiting: readonly { key: string; action: LibraryChangeAction }[]
  /** Merges waiting for the owner's review; the first one is shown. */
  reviews: readonly { key: string; plan: Plan }[]
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
          const plan = await adapter.plan(apiBaseUrl, request)
          if (!adapter.needsReview(plan))
            return adapter.merge(apiBaseUrl, { ...request, reviewed: false })
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
          review.key === key ? { key, plan } : review,
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
        run: () => adapter.merge(apiBaseUrl, { ...request, reviewed: true }),
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
  const [follow, setFollow] = useState(true)
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
  function close() {
    setFollow(true)
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
        error={
          replan.isError
            ? errorMessage(replan.error, 'The merge could not be planned.')
            : null
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

/**
 * The bar under a table: the selection with Merge, then the result of the
 * last merge with Undo. Merge returns at once: the selection clears and the
 * merge is made in the background while another selection can be merged.
 */
export function MergeBar<Plan>({
  selection,
  total,
  adapter,
}: {
  selection: RowSelection
  /** How many rows the table lists. */
  total?: number
  adapter: MergeAdapter<Plan>
}) {
  const client = useQueryClient()
  const [change, setChange] = useState<LibraryChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A merge that failed or was not confirmed comes back as the selection.
  const restore = (ids: readonly string[]) => {
    if (selection.count === 0) selection.replace([...ids])
  }
  const merges = useMergeQueue(adapter, {
    onDone: setChange,
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
  const dismiss = () => {
    setChange(null)
    setError(null)
  }
  return (
    <>
      <SecondaryTableSelectionBar
        selectedCount={selection.count}
        total={total}
        hideWhenEmpty
      >
        {selection.count > 0 ? (
          <>
            {progress && <span role="status">{progress}</span>}
            {error && <span role="alert">{error}</span>}
            <span className="ds-actions ds-toolbar-end">
              <Button
                variant="primary"
                disabled={selection.count < 2}
                title={
                  selection.count < 2 ? adapter.wording.selectMore : undefined
                }
                onClick={() => {
                  setError(null)
                  void merges.queue.merge(selection.ids.join(' '), {
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
          <LibraryChangeReport
            progress={progress}
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
        )}
      </SecondaryTableSelectionBar>
      {merges.dialog}
    </>
  )
}
