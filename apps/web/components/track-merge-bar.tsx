'use client'

import type { ReactNode } from 'react'
import { MergeBar, type RowSelection } from './merge-bar'
import { interactiveTrackMergeAdapter } from './track-merge-review'

/**
 * The bar under a table of tracks: the selection with Merge, then the result
 * of the last merge with Undo. A merge is made at once unless something
 * speaks against it; then the review opens first.
 */
export function TrackMergeBar({
  selection,
  total,
  actions,
}: {
  selection: RowSelection
  /** How many tracks the table lists. */
  total?: number
  /** Other actions on the selection, before Merge. */
  actions?: ReactNode
}) {
  return (
    <MergeBar
      selection={selection}
      total={total}
      adapter={interactiveTrackMergeAdapter}
      actions={actions}
    />
  )
}
