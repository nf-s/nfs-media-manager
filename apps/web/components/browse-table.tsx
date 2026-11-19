'use client'

import { useRef, type ReactNode } from 'react'
import { Skeleton } from '@repo/ui/components/ds/feedback'
import {
  TableCell,
  TableHead,
  TableRow,
  TableSortButton,
} from '@repo/ui/components/ui/table'

export const minColumnWidth = 70
export const maxColumnWidth = 650

function clampWidth(width: number) {
  return Math.max(minColumnWidth, Math.min(maxColumnWidth, width))
}

/**
 * A sortable browse column header with a width handle. Arrow keys on the
 * handle change the width in 10px steps; dragging changes it freely.
 */
export function BrowseSortHead({
  label,
  active,
  direction,
  onSort,
  width,
  onWidthChange,
  onWidthCommit,
  align,
  sticky,
  stickyEdge,
}: {
  label: string
  active: boolean
  direction: 'asc' | 'desc'
  onSort: () => void
  width: number
  onWidthChange: (width: number) => void
  onWidthCommit: (width: number) => void
  align?: 'end'
  sticky?: number
  stickyEdge?: boolean
}) {
  const drag = useRef<{ x: number; width: number; next: number } | null>(null)
  return (
    <TableHead
      align={align}
      sticky={sticky}
      stickyEdge={stickyEdge}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
      resizer={{
        role: 'separator',
        'aria-label': `Resize ${label}`,
        'aria-orientation': 'vertical',
        'aria-valuenow': width,
        'aria-valuemin': minColumnWidth,
        'aria-valuemax': maxColumnWidth,
        tabIndex: 0,
        onKeyDown: (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          onWidthCommit(
            clampWidth(width + (event.key === 'ArrowRight' ? 10 : -10)),
          )
        },
        onPointerDown: (event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.clientX, width, next: width }
        },
        onPointerMove: (event) => {
          if (!drag.current) return
          drag.current.next = clampWidth(
            drag.current.width + event.clientX - drag.current.x,
          )
          onWidthChange(drag.current.next)
        },
        onPointerUp: () => {
          if (drag.current) onWidthCommit(drag.current.next)
          drag.current = null
        },
      }}
    >
      <TableSortButton
        direction={active ? direction : undefined}
        onClick={onSort}
      >
        {label}
      </TableSortButton>
    </TableHead>
  )
}

/** A placeholder row while a page of the table loads. */
export function BrowsePlaceholderRow({
  columns,
  sticky,
}: {
  columns: number
  sticky?: boolean
}) {
  return (
    <TableRow aria-hidden="true">
      {Array.from({ length: columns }, (_, column) => (
        <TableCell
          key={column}
          sticky={sticky && column === 0 ? 0 : undefined}
          stickyEdge={sticky && column === 0}
        >
          <Skeleton height={10} width={column === 0 ? '70%' : '50%'} />
        </TableCell>
      ))}
    </TableRow>
  )
}

/** Spacer rows above and below the rendered window of a virtual table. */
export function BrowseSpacerRow({
  columns,
  height,
}: {
  columns: number
  height: number
}): ReactNode {
  if (height <= 0) return null
  return (
    <tr aria-hidden="true" className="browse-spacer">
      <td colSpan={columns} style={{ height }} />
    </tr>
  )
}
