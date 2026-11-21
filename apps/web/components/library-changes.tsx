'use client'

import type { ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  LibraryChangeActorSchema,
  type LibraryChange,
  type LibraryChangeActor,
} from '@repo/schemas/library-changes'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { Status } from '@repo/ui/components/ds/status'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  formatCount,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import {
  describeLibraryChange,
  libraryChangeBlock,
  libraryChangesKey,
  loadLibraryChanges,
} from '@/utils/library-changes'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from './detail-inspector-context'
import { useConfig } from './providers'
import {
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'
import { LibraryChangeUndo } from './merge-bar'

const path = '/tracks/changes'
const title = 'History'
const pageSize = 50
/** The one table's two-line rows (`.ds-table[data-rows='two'] td`). */
const twoLineRowHeight = 44
/** Room for Undo or Redo. */
const actionsWidth = 76

export const libraryChangeColumns: readonly TableColumn[] = [
  { key: 'when', label: 'When', width: 148 },
  { key: 'change', label: 'Change', width: 280, fill: true, required: true },
  { key: 'by', label: 'By', width: 104 },
  { key: 'scrobbles', label: 'Scrobbles moved', width: 124 },
]

type ActorFilter = 'all' | LibraryChangeActor
const actorOptions: readonly { value: ActorFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'owner', label: 'You' },
  { value: 'automatic', label: 'Automatic' },
]

/** Who made a change, or that it was undone. */
export function LibraryChangeBy({ change }: { change: LibraryChange }) {
  if (change.undoneAt) return <Status state="cancelled">Undone</Status>
  return (
    <Status state="done">
      {change.actor === 'owner' ? 'You' : 'Automatic'}
    </Status>
  )
}

/** The scrobbled names the change moved, then the rule and why Undo is not offered. */
function changeNote(change: LibraryChange) {
  const [first] = change.names
  const names = first
    ? `${first.artistName} · ${first.trackName}${
        change.nameCount > 1
          ? ` and ${formatCount(change.nameCount - 1)} more`
          : ''
      }`
    : null
  const block = libraryChangeBlock(change)
  return [names, change.rule, block?.replace(/\.$/, '')]
    .filter(Boolean)
    .join('. ')
}

function changeCell(column: string, change: LibraryChange): ReactNode {
  if (column === 'when')
    return <span className="ds-num">{formatDateTime(change.createdAt)}</span>
  if (column === 'by') return <LibraryChangeBy change={change} />
  if (column === 'scrobbles')
    return change.scrobbles ? formatCount(change.scrobbles) : <EmptyValue />
  const text = describeLibraryChange(change)
  const note = changeNote(change)
  return (
    <span className="ds-cell-two">
      <span className="ds-cell-title" title={text}>
        {text}
      </span>
      <span className="ds-cell-sub" title={note || undefined}>
        {note || '\u00a0'}
      </span>
    </span>
  )
}

/** One change in the History table: its shown columns, then Undo or Redo. */
export function LibraryChangeRow({
  change,
  columns,
  index,
}: {
  change: LibraryChange
  columns: readonly string[]
  index: number
}) {
  return (
    <TableRow aria-rowindex={index + 2}>
      {columns.map((column) => (
        <TableCell
          key={column}
          align={column === 'scrobbles' ? 'end' : undefined}
        >
          {changeCell(column, change)}
        </TableCell>
      ))}
      <TableCell align="end">
        <LibraryChangeUndo change={change} size="xs" />
      </TableCell>
    </TableRow>
  )
}

export default function LibraryChanges() {
  const { apiBaseUrl } = useConfig()
  const inspector = useDetailInspector()
  const params = useSearchParams()
  const parsedActor = LibraryChangeActorSchema.safeParse(params.get('actor'))
  const actor = parsedActor.success ? parsedActor.data : undefined
  const query = useVirtualTable({
    queryKey: libraryChangesKey({ actor, size: pageSize }),
    pageSize,
    rowHeight: twoLineRowHeight,
    loadPage: (page, size, signal) =>
      loadLibraryChanges(apiBaseUrl, { page, size, actor }, signal),
  })
  const table = useTableColumns('library-changes', libraryChangeColumns)
  const shown = libraryChangeColumns
    .filter((column) => table.visible(column.key))
    .map((column) => column.key)
  const layout = table.layout([...shown, actionsWidth])
  const colSpan = shown.length + 1

  function changeActor(value: ActorFilter) {
    const next = new URLSearchParams(window.location.search)
    if (value === 'all') next.delete('actor')
    else next.set('actor', value)
    replaceWorkspaceUrl(
      `${path}${next.size ? `?${next}` : ''}${window.location.hash}`,
      Boolean(inspector?.active),
    )
  }

  return (
    <section className="browse-workspace" aria-label={title}>
      <PageHead title={title} />
      <SecondaryTableToolbar
        filters={
          <Segmented
            label="Changed by"
            value={actor ?? 'all'}
            options={actorOptions}
            onChange={changeActor}
          />
        }
        count={
          query.hasTotal
            ? formatItemCount(query.total, { one: 'change', other: 'changes' })
            : undefined
        }
        columns={table.controls}
      />
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load changes.
        </Notice>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        role="region"
        aria-label={title}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          data-rows="two"
          aria-label={title}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {libraryChangeColumns
                .filter((column) => shown.includes(column.key))
                .map((column) => (
                  <TableHead
                    key={column.key}
                    align={column.key === 'scrobbles' ? 'end' : undefined}
                    resizer={table.resizer(column.key)}
                  >
                    {column.label}
                  </TableHead>
                ))}
              <TableHead align="end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && !query.total && (
              <TableState colSpan={colSpan}>No changes</TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={colSpan}
              renderRow={(change, index) => (
                <LibraryChangeRow
                  key={change.id}
                  change={change}
                  columns={shown}
                  index={index}
                />
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
