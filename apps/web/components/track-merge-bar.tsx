'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type {
  LibraryChange,
  TrackMergePlan,
} from '@repo/schemas/library-changes'
import { KeyValues, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSelectionResult,
} from '@repo/ui/components/ui/table'
import { formatCount, formatTrackLength } from '@repo/ui/lib/format'
import { updateJobSelection } from '@/utils/job-selection'
import {
  describeLibraryChange,
  describeMergeCaution,
  libraryChangeBlock,
  mergeBlockLabels,
  mergeTracks,
  planTrackMerge,
  toggleLibraryChange,
  type TrackMergeSelection,
} from '@/utils/library-changes'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryTableSelectionBar,
  useTableWidths,
} from './secondary-table'

/** The width of a table's selection column. */
export const trackSelectionWidth = 36

/**
 * Row selection for a table of tracks, by track ID. `orderedIds` are the rows
 * the table has, in display order; a shift-click selects the range between.
 */
export function useTrackSelection(orderedIds: readonly string[]) {
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
export type TrackSelection = ReturnType<typeof useTrackSelection>

/** The tri-state checkbox of the selection column's header. */
export function TrackSelectAll({
  selection,
  label,
  disabled = false,
}: {
  selection: TrackSelection
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
export function TrackSelectRow({
  selection,
  id,
  title,
  disabled = false,
}: {
  selection: TrackSelection
  id: string
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

const reviewColumns = [
  { key: 'track', label: 'Track', width: 200, fill: true },
  { key: 'album', label: 'Album', width: 130 },
  { key: 'length', label: 'Length', width: 68 },
  { key: 'scrobbles', label: 'Scrobbles', width: 84 },
]

/** Shown only when something speaks against the merge, or part of it cannot be made. */
function TrackMergeReview({
  plan,
  pending,
  error,
  onPlan,
  onMerge,
  onClose,
}: {
  plan: TrackMergePlan
  pending: boolean
  error: string | null
  onPlan: (selection: TrackMergeSelection) => void
  onMerge: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const widths = useTableWidths('track-merge-review', reviewColumns)
  const layout = widths.layout(reviewColumns.map((column) => column.key))
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

  const trackIds = plan.tracks.map((track) => track.id)
  const kept = plan.tracks.find((track) => track.id === plan.targetId)
  const blocked = plan.tracks.filter((track) => track.blocked)
  const mergeable = plan.tracks.filter((track) => !track.blocked)
  // Any track made only of scrobbled names can be the one that is kept.
  const choosable = plan.tracks.every((track) => track.identity === null)
  const { target, added, total } = plan.scrobbles
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
            <b id={titleId}>
              {mergeable.length > 1
                ? `Merge ${formatCount(mergeable.length)} tracks`
                : 'Merge tracks'}
            </b>
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
          {plan.cautions.length > 0 && (
            <Notice tone="attention">
              Check before merging.{' '}
              {plan.cautions.map(describeMergeCaution).join(' ')}
            </Notice>
          )}
          {blocked.length > 0 && (
            <Notice
              tone="attention"
              action={
                mergeable.length > 1 ? (
                  <Button
                    size="xs"
                    disabled={pending}
                    onClick={() =>
                      onPlan({
                        trackIds: mergeable.map((track) => track.id),
                        targetId: plan.targetId,
                      })
                    }
                  >
                    Leave {blocked.length === 1 ? 'it' : 'them'} out
                  </Button>
                ) : undefined
              }
            >
              {blocked.length === 1
                ? '1 track stays a track of its own.'
                : `${formatCount(blocked.length)} tracks stay tracks of their own.`}{' '}
              Only a track made of scrobbled names can be merged into another.
            </Notice>
          )}
          {error && <Notice tone="danger">{error}</Notice>}
          <Section title="Result" flush>
            <KeyValues
              items={[
                {
                  label: 'Kept',
                  value: choosable ? (
                    <Select
                      aria-label="Track to keep"
                      value={plan.targetId}
                      disabled={pending}
                      onChange={(event) =>
                        onPlan({ trackIds, targetId: event.target.value })
                      }
                    >
                      {plan.tracks.map((track) => (
                        <option key={track.id} value={track.id}>
                          {track.title}
                          {track.by ? ` · ${track.by}` : ''}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <b>{kept?.title}</b>
                  ),
                },
                {
                  label: 'Scrobbles',
                  value: added ? (
                    <span className="ds-num">
                      {formatCount(target)} + {formatCount(added)} ={' '}
                      <b>{formatCount(total)}</b>
                    </span>
                  ) : (
                    <span className="ds-num">
                      <b>{formatCount(total)}</b> · none added
                    </span>
                  ),
                },
                {
                  label: 'Names moved',
                  value: (
                    <span className="ds-num">
                      {formatCount(plan.names.length)}
                    </span>
                  ),
                },
              ]}
            />
          </Section>
          <Section title="Tracks">
            <SecondaryTableScroll
              className="dtl-bounded"
              role="region"
              aria-label="Tracks to merge"
            >
              <table
                className="ds-table"
                aria-label="Tracks to merge"
                {...layout.table}
              >
                {layout.colgroup}
                <TableHeader>
                  <TableRow>
                    <TableHead resizer={widths.resizer('track')}>
                      Track
                    </TableHead>
                    <TableHead resizer={widths.resizer('album')}>
                      Album
                    </TableHead>
                    <TableHead align="end" resizer={widths.resizer('length')}>
                      Length
                    </TableHead>
                    <TableHead
                      align="end"
                      resizer={widths.resizer('scrobbles')}
                    >
                      Scrobbles
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.tracks.map((track) => (
                    <TableRow key={track.id}>
                      <TableCell>
                        <span className="ds-cell-two">
                          <span className="ds-cell-title" title={track.title}>
                            {track.title}
                          </span>
                          <span className="ds-cell-sub">
                            {track.id === plan.targetId ? (
                              <Status state="done">Kept</Status>
                            ) : track.blocked ? (
                              <Status state="attention">
                                {mergeBlockLabels[track.blocked]}
                              </Status>
                            ) : (
                              track.by || <EmptyValue />
                            )}
                          </span>
                        </span>
                      </TableCell>
                      <TableCell>
                        {track.albumTitle ? (
                          <SecondaryCell>{track.albumTitle}</SecondaryCell>
                        ) : (
                          <EmptyValue />
                        )}
                      </TableCell>
                      <TableCell align="end">
                        {track.durationSec ? (
                          formatTrackLength(track.durationSec * 1000)
                        ) : (
                          <EmptyValue />
                        )}
                      </TableCell>
                      <TableCell align="end">
                        {formatCount(track.scrobbles)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </table>
            </SecondaryTableScroll>
          </Section>
          <div className="ds-actions">
            <Button
              variant="primary"
              disabled={pending || plan.blocked}
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
      await invalidateScrobbleLinks(
        client,
        [...next.sources, ...(next.target ? [next.target] : [])]
          .filter((record) => !record.exists)
          .map((record) => record.id),
      )
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

type MergeOutcome =
  | { review: TrackMergePlan }
  | { review: null; change: LibraryChange }

/**
 * The bar under a table of tracks: the selection with Merge, then the result
 * of the last merge with Undo. A merge is made at once unless something
 * speaks against it; then the review opens first.
 */
export function TrackMergeBar({
  selection,
  total,
}: {
  selection: TrackSelection
  /** How many tracks the table lists. */
  total?: number
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [review, setReview] = useState<TrackMergePlan | null>(null)
  const [result, setResult] = useState<LibraryChange | null>(null)
  const [error, setError] = useState<string | null>(null)

  const plan = useMutation({
    retry: false,
    mutationFn: (request: TrackMergeSelection) =>
      planTrackMerge(apiBaseUrl, request),
    onMutate: () => setError(null),
    onSuccess: (next) => {
      selection.replace(next.tracks.map((track) => track.id))
      setReview(next)
    },
    onError: (failure) =>
      setError(errorMessage(failure, 'The merge could not be planned.')),
  })
  const merge = useMutation({
    retry: false,
    mutationFn: async ({
      reviewed,
      ...chosen
    }: TrackMergeSelection & { reviewed: boolean }): Promise<MergeOutcome> => {
      if (!reviewed) {
        const next = await planTrackMerge(apiBaseUrl, chosen)
        if (next.blocked || next.cautions.length) return { review: next }
      }
      return {
        review: null,
        change: await mergeTracks(apiBaseUrl, { ...chosen, reviewed }),
      }
    },
    onMutate: () => setError(null),
    onSuccess: async (outcome) => {
      if (outcome.review) {
        setReview(outcome.review)
        return
      }
      setReview(null)
      setResult(outcome.change)
      selection.clear()
      await invalidateScrobbleLinks(
        client,
        outcome.change.sources
          .filter((source) => !source.exists)
          .map((source) => source.id),
      )
    },
    onError: (failure) =>
      setError(errorMessage(failure, 'The tracks could not be merged.')),
  })
  const pending = plan.isPending || merge.isPending

  return (
    <>
      <SecondaryTableSelectionBar
        selectedCount={selection.count}
        total={total}
        hideWhenEmpty
      >
        {selection.count > 0 ? (
          <>
            {error && !review && <span role="alert">{error}</span>}
            <span className="ds-actions ds-toolbar-end">
              <Button
                variant="primary"
                disabled={pending || selection.count < 2}
                title={
                  selection.count < 2
                    ? 'Select two or more tracks to merge'
                    : undefined
                }
                onClick={() =>
                  merge.mutate({ trackIds: selection.ids, reviewed: false })
                }
              >
                {merge.isPending && !review ? 'Merging...' : 'Merge'}
              </Button>
              <Button
                icon
                aria-label="Clear selection"
                disabled={pending}
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
          result && (
            <>
              <TableSelectionResult
                icon={
                  result.undoneAt ? (
                    <History
                      className="ds-i"
                      data-size="sm"
                      aria-hidden="true"
                    />
                  ) : (
                    <Check className="ds-i" data-size="sm" aria-hidden="true" />
                  )
                }
              >
                {result.undoneAt ? 'Undone: ' : ''}
                {describeLibraryChange(result)}
                {error ? ` · ${error}` : ''}
              </TableSelectionResult>
              <span className="ds-actions ds-toolbar-end">
                <LibraryChangeUndo
                  change={result}
                  redoVariant="default"
                  onChanged={(next) => {
                    setError(null)
                    setResult(next)
                  }}
                  onError={setError}
                />
                <Button
                  icon
                  aria-label="Dismiss"
                  onClick={() => {
                    setResult(null)
                    setError(null)
                  }}
                >
                  <X className="ds-i" aria-hidden="true" />
                </Button>
              </span>
            </>
          )
        )}
      </SecondaryTableSelectionBar>
      {review && (
        <TrackMergeReview
          plan={review}
          pending={pending}
          error={error}
          onPlan={(request) => plan.mutate(request)}
          onMerge={() =>
            merge.mutate({
              trackIds: review.tracks.map((track) => track.id),
              targetId: review.targetId,
              reviewed: true,
            })
          }
          onClose={() => {
            setReview(null)
            setError(null)
          }}
        />
      )}
    </>
  )
}
