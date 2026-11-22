'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, History, X } from 'lucide-react'
import type {
  LibraryChange,
  LibraryChangeAction,
} from '@repo/schemas/library-changes'
import type { TrackDuplicateGroup } from '@repo/schemas/track-duplicates'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableGroupActions,
  TableRow,
} from '@repo/ui/components/ui/table'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { describeLibraryChange } from '@/utils/library-changes'
import { clientQueryDefaults } from '@/utils/query-cache'
import {
  describeTrackDuplicateCautions,
  describeTrackDuplicateDetails,
  describeTrackDuplicateNotice,
  keepTracksSeparate,
  loadTrackDuplicates,
  trackDuplicatesKey,
} from '@/utils/track-duplicates'
import {
  combineLibraryChanges,
  LibraryChangeReport,
  LibraryChangeUndo,
  useMergeQueue,
  type MergeQueueItem,
} from './merge-bar'
import { useConfig } from './providers'
import {
  SecondaryCellDetails,
  SecondaryTableSelectionBar,
} from './secondary-table'
import { trackMergeAdapter } from './track-merge-review'

type DuplicateMembers = Pick<TrackDuplicateGroup, 'memberIds'>

const groupKey = (group: DuplicateMembers) => group.memberIds.join(' ')

/** How many groups are still to be merged or kept separate, in words. */
export function describeTrackDuplicateProgress(
  waiting: readonly { action: LibraryChangeAction }[],
) {
  const merges = waiting.filter((entry) => entry.action === 'merge').length
  const separations = waiting.length - merges
  const groups = (count: number) =>
    formatItemCount(count, { one: 'group', other: 'groups' })
  if (merges && separations)
    return `Merging ${groups(merges)}, keeping ${formatCount(separations)} separate…`
  if (merges) return `Merging ${groups(merges)}…`
  if (separations) return `Keeping ${groups(separations)} separate…`
  return null
}

/** What is happening to one group, in its row. */
export function describeTrackDuplicateStatus(item: MergeQueueItem) {
  const merge = item.action === 'merge'
  switch (item.status) {
    case 'queued':
    case 'running':
      return merge ? 'Merging…' : 'Keeping separate…'
    case 'review':
      return 'Needs review'
    case 'done':
      return merge ? 'Merged' : 'Kept separate'
    case 'failed':
      return item.message
  }
}

/**
 * Merge and Keep separate for groups of possible duplicates, and the last
 * change either made. Merge is the normal track merge of the whole group,
 * keeping its first member; it opens the review when something speaks
 * against it. Render `dialog` for that review.
 *
 * Both return at once: the requests are sent one after another in the order
 * pressed, only the pressed group's actions are off meanwhile, and the
 * tables refresh once when none is left.
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
  const work = useMergeQueue(trackMergeAdapter, {
    onDone: (next) => {
      setChange(next)
      onChange?.(next)
    },
    onFail: (message) => setError(message),
    // The track merge refresh also covers what Keep separate changes.
    onDrain: async (changes) => {
      const combined = combineLibraryChanges(changes)
      if (combined) await trackMergeAdapter.invalidate(client, combined)
    },
  })
  return {
    /** Queues the group's merge; resolves when it is made or its review opens. */
    merge: (group: DuplicateMembers) => {
      const [keep] = group.memberIds
      return work.queue.merge(groupKey(group), {
        ids: [...group.memberIds],
        keepId: keep,
      })
    },
    /** Queues Keep separate for the group; resolves when it is made. */
    keepSeparate: (group: DuplicateMembers) =>
      work.queue.add({
        key: groupKey(group),
        ids: group.memberIds,
        action: 'keep-separate',
        failed: 'The tracks could not be kept separate.',
        run: () => keepTracksSeparate(apiBaseUrl, [...group.memberIds]),
      }),
    /** Where the group stands in the queue; undefined while untouched. */
    status: (group: DuplicateMembers) => work.status(groupKey(group)),
    /** A merge or Keep separate is queued or being made. */
    pending: work.snapshot.waiting.length > 0,
    /** How many are still to go, in words; null when none is. */
    progress: describeTrackDuplicateProgress(work.snapshot.waiting),
    /** The last finished change. */
    change,
    setChange,
    /** Why the last action failed; its row says so too. */
    error,
    setError,
    /** Hides the last change and any error. */
    dismiss: () => {
      setChange(null)
      setError(null)
    },
    dialog: work.dialog,
  }
}
export type TrackDuplicateActions = ReturnType<typeof useTrackDuplicateActions>

/** Whether a group's own Merge and Keep separate are off. */
function groupBusy(item: MergeQueueItem | undefined) {
  return item !== undefined && item.status !== 'failed'
}

function ChangeIcon({ change }: { change: LibraryChange }) {
  return change.undoneAt ? (
    <History className="ds-i" data-size="sm" aria-hidden="true" />
  ) : (
    <Check className="ds-i" data-size="sm" aria-hidden="true" />
  )
}

/**
 * The group row above a group's first shown track: Merge, Keep separate, the
 * details behind an icon and, when something speaks against merging, what.
 */
export function TrackDuplicateGroupRow({
  group,
  colSpan,
  rowIndex,
  actions,
}: {
  group: Pick<
    TrackDuplicateGroup,
    'memberIds' | 'evidence' | 'merge' | 'cautions'
  >
  colSpan: number
  rowIndex?: number
  actions: Pick<TrackDuplicateActions, 'merge' | 'keepSeparate' | 'status'>
}) {
  const item = actions.status(group)
  const busy = groupBusy(item)
  return (
    <TableRow group aria-rowindex={rowIndex}>
      <TableCell colSpan={colSpan}>
        <TableGroupActions
          evidence={
            item
              ? describeTrackDuplicateStatus(item)
              : describeTrackDuplicateCautions(group)
          }
        >
          <Button
            size="xs"
            disabled={busy}
            onClick={() => void actions.merge(group)}
          >
            Merge
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void actions.keepSeparate(group)}
          >
            Keep separate
          </Button>
          <SecondaryCellDetails label="What Merge does">
            {describeTrackDuplicateDetails(group).map((line) => (
              <div key={line}>{line}</div>
            ))}
          </SecondaryCellDetails>
        </TableGroupActions>
      </TableCell>
    </TableRow>
  )
}

/**
 * The bar under a table with group rows: how many groups are still to go,
 * then the result of the last Merge or Keep separate from a group row with
 * Undo, or why it failed. Hidden while there is nothing to report.
 */
export function TrackDuplicateResultBar({
  actions,
}: {
  actions: Pick<
    TrackDuplicateActions,
    'change' | 'error' | 'setChange' | 'setError' | 'dismiss'
  > &
    Partial<Pick<TrackDuplicateActions, 'progress'>>
}) {
  return (
    <SecondaryTableSelectionBar selectedCount={0} hideWhenEmpty>
      <LibraryChangeReport
        progress={actions.progress ?? null}
        change={actions.change}
        describe={describeLibraryChange}
        error={actions.error}
        onChanged={(next) => {
          actions.setError(null)
          actions.setChange(next)
        }}
        onError={actions.setError}
        onDismiss={actions.dismiss}
      />
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
                disabled={groupBusy(actions.status(group))}
                onClick={() => {
                  actions.setError(null)
                  void actions.merge(group)
                }}
              >
                Merge
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={groupBusy(actions.status(group))}
                onClick={() => {
                  actions.setError(null)
                  void actions.keepSeparate(group)
                }}
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
