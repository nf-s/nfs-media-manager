'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type { LibraryChange } from '@repo/schemas/library-changes'
import type { TrackDuplicateGroup } from '@repo/schemas/track-duplicates'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableGroupActions,
  TableRow,
} from '@repo/ui/components/ui/table'
import { describeLibraryChange } from '@/utils/library-changes'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  describeTrackDuplicateGroup,
  describeTrackDuplicateNotice,
  keepTracksSeparate,
  loadTrackDuplicates,
  trackDuplicatesKey,
} from '@/utils/track-duplicates'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import { LibraryChangeResult, LibraryChangeUndo, useMerge } from './merge-bar'
import { useConfig } from './providers'
import { SecondaryTableSelectionBar } from './secondary-table'
import { trackMergeAdapter } from './track-merge-review'

type DuplicateMembers = Pick<TrackDuplicateGroup, 'memberIds'>

/**
 * Merge and Keep separate for groups of possible duplicates, and the last
 * change either made. Merge is the normal track merge of the whole group,
 * keeping its first member; it opens the review when something speaks
 * against it. Render `dialog` for that review.
 */
export function useTrackDuplicateActions({
  onChange,
}: {
  /** A merge or Keep separate finished. */
  onChange?: (change: LibraryChange) => void
} = {}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [change, setChange] = useState<LibraryChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  function finish(next: LibraryChange) {
    setError(null)
    setChange(next)
    onChange?.(next)
  }
  const merging = useMerge(trackMergeAdapter, { onMerge: finish })
  const separating = useMutation({
    retry: false,
    mutationFn: (trackIds: string[]) =>
      keepTracksSeparate(apiBaseUrl, trackIds),
    onMutate: () => {
      setError(null)
      merging.clearError()
    },
    onSuccess: async (next) => {
      finish(next)
      await invalidateScrobbleLinks(client)
    },
    onError: (failure) =>
      setError(errorMessage(failure, 'The tracks could not be kept separate.')),
  })
  return {
    merge: (group: DuplicateMembers) => {
      setError(null)
      const [keep] = group.memberIds
      return merging.merge(group.memberIds, keep)
    },
    keepSeparate: (group: DuplicateMembers) =>
      separating.mutate([...group.memberIds]),
    /** A merge or Keep separate is being made. */
    pending: merging.pending || separating.isPending,
    /** The last finished change. */
    change,
    setChange,
    /** Why the last action failed; a failed merge under review says so in its dialog. */
    error: error ?? (merging.review ? null : merging.error),
    setError,
    /** Hides the last change and any error. */
    dismiss: () => {
      setChange(null)
      setError(null)
      merging.dismiss()
    },
    dialog: merging.dialog,
  }
}
export type TrackDuplicateActions = ReturnType<typeof useTrackDuplicateActions>

function ChangeIcon({ change }: { change: LibraryChange }) {
  return change.undoneAt ? (
    <History className="ds-i" data-size="sm" aria-hidden="true" />
  ) : (
    <Check className="ds-i" data-size="sm" aria-hidden="true" />
  )
}

/** The group row above a group's first shown track: Merge, Keep separate, what Merge does and the evidence. */
export function TrackDuplicateGroupRow({
  group,
  colSpan,
  rowIndex,
  actions,
}: {
  group: Pick<TrackDuplicateGroup, 'memberIds' | 'evidence' | 'merge'>
  colSpan: number
  rowIndex?: number
  actions: TrackDuplicateActions
}) {
  return (
    <TableRow group aria-rowindex={rowIndex}>
      <TableCell colSpan={colSpan}>
        <TableGroupActions evidence={describeTrackDuplicateGroup(group)}>
          <Button
            size="xs"
            disabled={actions.pending}
            onClick={() => void actions.merge(group)}
          >
            Merge
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={actions.pending}
            onClick={() => actions.keepSeparate(group)}
          >
            Keep separate
          </Button>
        </TableGroupActions>
      </TableCell>
    </TableRow>
  )
}

/**
 * The bar under a table with group rows: the result of the last Merge or
 * Keep separate from a group row with Undo, or why it failed. Hidden while
 * there is nothing to report.
 */
export function TrackDuplicateResultBar({
  actions,
}: {
  actions: Pick<
    TrackDuplicateActions,
    'change' | 'error' | 'setChange' | 'setError' | 'dismiss'
  >
}) {
  const { change, error, dismiss } = actions
  return (
    <SecondaryTableSelectionBar selectedCount={0} hideWhenEmpty>
      {change ? (
        <LibraryChangeResult
          change={change}
          describe={describeLibraryChange}
          error={error}
          onChanged={(next) => {
            actions.setError(null)
            actions.setChange(next)
          }}
          onError={actions.setError}
          onDismiss={dismiss}
        />
      ) : (
        error !== null && (
          <>
            <span role="alert">{error}</span>
            <span className="ds-actions ds-toolbar-end">
              <Button icon aria-label="Dismiss" onClick={dismiss}>
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          </>
        )
      )}
    </SecondaryTableSelectionBar>
  )
}

/**
 * The notice on an open track that is in a group of possible duplicates:
 * the other tracks and the evidence, with Merge and Keep separate. After
 * either, the change shows in its place with Undo.
 */
export function TrackDuplicateNotice({
  trackId,
  onResolved,
}: {
  trackId: string
  /** Opens the kept track when a merge removes this one. */
  onResolved?: (targetId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const duplicates = useQuery({
    queryKey: trackDuplicatesKey(trackId),
    queryFn: ({ signal }) => loadTrackDuplicates(apiBaseUrl, trackId, signal),
    ...clientQueryDefaults,
    retry: false,
  })
  const actions = useTrackDuplicateActions({
    onChange: (change) => {
      if (
        change.action === 'merge' &&
        change.target &&
        change.target.id !== trackId
      )
        onResolved?.(change.target.id)
    },
  })
  const [group] = duplicates.data?.items ?? []
  const { change, error } = actions
  return (
    <>
      {change && (
        <Notice
          icon={<ChangeIcon change={change} />}
          action={
            <span className="ds-actions">
              <LibraryChangeUndo
                change={change}
                size="xs"
                onChanged={(next) => {
                  actions.setError(null)
                  actions.setChange(next)
                }}
                onError={actions.setError}
              />
              <Button
                size="xs"
                icon
                aria-label="Dismiss"
                onClick={actions.dismiss}
              >
                <X className="ds-i" aria-hidden="true" />
              </Button>
            </span>
          }
        >
          {change.undoneAt ? 'Undone: ' : ''}
          {describeLibraryChange(change)}
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {group && (!change || change.undoneAt !== null) && (
        <Notice
          action={
            <span className="ds-actions">
              <Button
                size="xs"
                disabled={actions.pending}
                onClick={() => void actions.merge(group)}
              >
                Merge
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={actions.pending}
                onClick={() => actions.keepSeparate(group)}
              >
                Keep separate
              </Button>
            </span>
          }
        >
          {describeTrackDuplicateNotice(group)}
        </Notice>
      )}
      {actions.dialog}
    </>
  )
}
