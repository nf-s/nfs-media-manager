'use client'

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type { LibraryChange } from '@repo/schemas/library-changes'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { TableSelectionResult } from '@repo/ui/components/ui/table'
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
  /** The records a plan merges and the one it keeps. */
  request: (plan: Plan) => MergeRequest
  /** Something speaks against the merge, or part of it cannot be made. */
  needsReview: (plan: Plan) => boolean
  /** The merge cannot be made as planned. */
  blocked: (plan: Plan) => boolean
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
          <div className="ds-actions">
            <Button
              variant="primary"
              disabled={pending || adapter.blocked(plan)}
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
  }: {
    /** The records the latest plan merges. */
    onPlan?: (ids: string[]) => void
    onMerge?: (change: LibraryChange) => void
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
        if (adapter.needsReview(next)) return { status: 'review', plan: next }
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
          {adapter.describe(change)}
          {error ? ` · ${error}` : ''}
        </TableSelectionResult>
        <span className="ds-actions ds-toolbar-end">
          <LibraryChangeUndo
            change={change}
            redoVariant="default"
            onChanged={(next) => {
              setError(null)
              setChange(next)
            }}
            onError={setError}
          />
          <Button icon aria-label="Dismiss" onClick={dismiss}>
            <X className="ds-i" aria-hidden="true" />
          </Button>
        </span>
      </>
    ) : null,
  }
}

/**
 * The bar under a table: the selection with Merge, then the result of the
 * last merge with Undo.
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
  const merge = useMerge(adapter, {
    onPlan: (ids) => selection.replace(ids),
    onMerge: () => selection.clear(),
  })
  return (
    <>
      <SecondaryTableSelectionBar
        selectedCount={selection.count}
        total={total}
        hideWhenEmpty
      >
        {selection.count > 0 ? (
          <>
            {merge.error && !merge.review && (
              <span role="alert">{merge.error}</span>
            )}
            <span className="ds-actions ds-toolbar-end">
              <Button
                variant="primary"
                disabled={merge.pending || selection.count < 2}
                title={
                  selection.count < 2 ? adapter.wording.selectMore : undefined
                }
                onClick={() => merge.merge(selection.ids)}
              >
                {merge.merging ? 'Merging...' : 'Merge'}
              </Button>
              <Button
                icon
                aria-label="Clear selection"
                disabled={merge.pending}
                onClick={() => {
                  selection.clear()
                  merge.clearError()
                }}
              >
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          </>
        ) : (
          merge.result
        )}
      </SecondaryTableSelectionBar>
      {merge.dialog}
    </>
  )
}
