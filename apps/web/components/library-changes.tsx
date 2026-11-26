'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  LibraryChangeActorSchema,
  LibraryChangeParamsSchema,
  type LibraryChange,
  type LibraryChangeActor,
  type LibraryChangeKind,
} from '@repo/schemas/library-changes'
import { Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { Timeline } from '@repo/ui/components/ds/source'
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
  describeLibraryChangeNote,
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

/** Each library's History page. */
export const libraryChangesPaths: Record<LibraryChangeKind, string> = {
  track: '/tracks/changes',
  album: '/albums/changes',
  artist: '/artists/changes',
}
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

function changeCell(column: string, change: LibraryChange): ReactNode {
  if (column === 'when')
    return <span className="ds-num">{formatDateTime(change.createdAt)}</span>
  if (column === 'by') return <LibraryChangeBy change={change} />
  if (column === 'scrobbles')
    return change.scrobbles ? formatCount(change.scrobbles) : <EmptyValue />
  const text = describeLibraryChange(change)
  const note = describeLibraryChangeNote(change)
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

/**
 * The latest changes that moved something into or out of one record, each
 * with Undo or Redo. Hidden while loading and when there are none.
 */
export function LibraryRecordChanges({
  kind,
  recordId,
  onResolved,
}: {
  kind: LibraryChangeKind
  recordId: string
  /** Opens the other record when an undo or redo removes this one. */
  onResolved?: (id: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const [error, setError] = useState<string | null>(null)
  const query = { kind, recordId, size: 10 }
  const changes = useQuery({
    queryKey: libraryChangesKey(query),
    queryFn: ({ signal }) => loadLibraryChanges(apiBaseUrl, query, signal),
  })
  if (changes.isError && !changes.data)
    return (
      <Section title="Changes">
        <Notice
          tone="danger"
          action={
            <Button size="xs" onClick={() => changes.refetch()}>
              Retry
            </Button>
          }
        >
          Could not load changes.
        </Notice>
      </Section>
    )
  const items = changes.data?.items ?? []
  if (!items.length) return null
  return (
    <Section title="Changes">
      {error && <Notice tone="danger">{error}</Notice>}
      <Timeline
        wrap
        items={items.map((change) => {
          const text = describeLibraryChange(change)
          return {
            key: change.id,
            when: formatDateTime(change.createdAt),
            status: <LibraryChangeBy change={change} />,
            text: <span title={text}>{text}</span>,
            link: (
              <LibraryChangeUndo
                change={change}
                size="xs"
                onChanged={(next) => {
                  setError(null)
                  const records = [
                    ...next.sources,
                    ...(next.target ? [next.target] : []),
                  ]
                  if (
                    !records.some(
                      (record) => record.id === recordId && !record.exists,
                    )
                  )
                    return
                  const other = records.find(
                    (record) => record.id !== recordId && record.exists,
                  )
                  if (other) onResolved?.(other.id)
                }}
                onError={setError}
              />
            ),
          }
        })}
      />
    </Section>
  )
}

/** A library's History: every change of one kind, newest first, with Undo. */
export default function LibraryChanges({ kind }: { kind: LibraryChangeKind }) {
  const { apiBaseUrl } = useConfig()
  const inspector = useDetailInspector()
  const params = useSearchParams()
  const changeId = LibraryChangeParamsSchema.shape.id.safeParse(
    params.get('changeId'),
  ).data
  const parsedActor = LibraryChangeActorSchema.safeParse(params.get('actor'))
  const actor = changeId ? undefined : parsedActor.data
  const path = libraryChangesPaths[kind]
  const query = useVirtualTable({
    queryKey: libraryChangesKey({ kind, actor, changeId, size: pageSize }),
    pageSize,
    rowHeight: twoLineRowHeight,
    loadPage: (page, size, signal) =>
      loadLibraryChanges(
        apiBaseUrl,
        { page, size, kind, actor, changeId },
        signal,
      ),
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
          changeId ? (
            <Button asChild>
              <Link href={path} prefetch={false}>
                All changes
              </Link>
            </Button>
          ) : (
            <Segmented
              label="Changed by"
              value={actor ?? 'all'}
              options={actorOptions}
              onChange={changeActor}
            />
          )
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
              <TableState colSpan={colSpan}>
                {changeId ? 'Change not found.' : 'No changes'}
              </TableState>
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
