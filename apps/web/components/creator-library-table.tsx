'use client'

import {
  useDeferredValue,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import type { z } from 'zod'
import { Button } from '@repo/ui/components/ui/button'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { formatCount, formatDate, formatDateTime } from '@repo/ui/lib/format'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import type { DetailTarget } from '@/utils/detail-inspector'
import { parseBrowseView, type BrowseView } from '@/utils/media-grid'
import { useDetailInspector, useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import BrowseToolbar, { BrowseColumnsSection } from './browse-toolbar'
import {
  NestedMediaCard,
  NestedMediaCards,
  useNestedMediaView,
} from './nested-media-view'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
  type ColumnLayout,
  type TableColumn,
} from './secondary-table'

export type CreatorLibraryColumn<Row> = TableColumn &
  Pick<ColumnLayout, 'align'> & {
    render: (row: Row) => ReactNode
    className?: string
    sortable?: false
    filter?: ReactNode
  }

type CreatorLibraryPage<Row> = {
  items: Row[]
  totalCount: number
  page: number
  pageCount: number
}

type CreatorLibraryCard = Pick<
  ComponentProps<typeof NestedMediaCard>,
  'title' | 'artworkUrl' | 'subtitle' | 'metadata' | 'actions'
>

export function CreatorLibraryTable<Row extends { id: string }>({
  kind,
  queryKey,
  path,
  schema,
  columns,
  label,
  defaultSort,
  workspace = false,
  filters,
  filterPanel,
  card,
}: {
  kind: DetailTarget['kind']
  queryKey: string[]
  path: string
  schema: z.ZodType<CreatorLibraryPage<Row>>
  columns: CreatorLibraryColumn<Row>[]
  label: string
  defaultSort: { key: string; direction: 'asc' | 'desc' }
  workspace?: boolean
  filters?: Record<string, string>
  filterPanel?: { controls: ReactNode; count: number }
  card?: (row: Row) => CreatorLibraryCard
}) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const scope = `creator-library-${kind}`
  const table = useTableColumns(scope, columns, { reorder: true })
  const [savedPresentation, setSavedPresentation] = useNestedMediaView(scope)
  const urlPresentation = view.params.get('view')
  const presentation = parseBrowseView(urlPresentation, savedPresentation)
  // Keep restored card layouts in the copied detail URL as well as explicit changes.
  useEffect(() => {
    if (!card || presentation === 'table' || urlPresentation === presentation)
      return
    const params = new URLSearchParams(view.params)
    params.set('view', presentation)
    view.replace(params)
  }, [card, presentation, urlPresentation, view])
  const mediaType = kind === 'film' || kind === 'subscription' ? kind : 'album'
  const q = view.params.get('q')?.slice(0, 200) ?? ''
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  const search = useDeferredValue(q.trim())
  const activeSort = view.params.get('sortBy')
  const sortable = columns.filter((column) => column.sortable !== false)
  const sortBy =
    sortable.find((column) => column.key === activeSort)?.key ?? defaultSort.key
  const paramDirection = view.params.get('direction')
  const direction =
    paramDirection === 'asc' || paramDirection === 'desc'
      ? paramDirection
      : defaultSort.direction
  const params = new URLSearchParams({
    size: '50',
    sortBy,
    direction,
    ...(search ? { q: search } : {}),
    ...filters,
  })
  const query = useVirtualTable({
    queryKey: [...queryKey, params.toString()],
    pageSize: 50,
    presentation: card ? { view: presentation, mediaType } : undefined,
    loadPage: (index, _size, signal) => {
      const page = new URLSearchParams(params)
      page.set('page', String(index))
      return fetchApiData(apiBaseUrl, `${path}?${page}`, schema, { signal })
    },
  })
  const inspector = useDetailInspector()
  const selectedId =
    workspace && inspector?.root?.kind === kind ? inspector.root.id : undefined
  const total = query.hasTotal ? query.total : undefined
  const visible = table
    .order(columns)
    .filter((column) => table.visible(column.key))
  const narrowed = Boolean(search || (filters && Object.keys(filters).length))
  const empty = narrowed ? `No matching ${label}.` : `No ${label} stored.`

  function setSort(key: string, nextDirection: 'asc' | 'desc') {
    view.params.set('sortBy', key)
    view.params.set('direction', nextDirection)
    view.replace(view.params)
  }

  function setPresentation(next: BrowseView) {
    setSavedPresentation(next)
    const params = new URLSearchParams(view.params)
    params.set('view', next)
    view.replace(params)
  }

  const searchControl = (
    <SecondaryTableSearch
      label={`Search ${label}`}
      value={draft}
      maxLength={200}
      onChange={(next) => {
        setDraft(next)
        if (next) view.params.set('q', next)
        else view.params.delete('q')
        view.replace(view.params)
      }}
    />
  )
  const count =
    total === undefined
      ? undefined
      : `${formatCount(total)} ${total === 1 ? 'result' : 'results'}`
  const columnOptions = presentation === 'table' ? table.options : null

  return (
    <>
      {card ? (
        <BrowseToolbar
          search={searchControl}
          sort={{
            key: sortBy,
            direction,
            options: sortable,
            onChange: (key) => setSort(key, direction),
            onDirectionChange: (value) => setSort(sortBy, value),
          }}
          view={presentation}
          onViewChange={setPresentation}
          filterCount={filterPanel?.count}
          filters={
            (columnOptions || filterPanel) && (
              <>
                {filterPanel?.controls}
                <BrowseColumnsSection>{columnOptions}</BrowseColumnsSection>
              </>
            )
          }
          count={count}
        />
      ) : (
        <SecondaryTableToolbar
          search={searchControl}
          count={count}
          columns={table.controls}
        />
      )}
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button type="button" size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load {label}.
        </Notice>
      )}
      {card && presentation !== 'table' ? (
        <NestedMediaCards
          window={query}
          view={presentation}
          mediaType={mediaType}
          label={label}
          className={workspace ? 'min-h-0 flex-1' : 'max-h-[min(420px,50dvh)]'}
          empty={empty}
          busy={query.isFetching}
          renderItem={(row) => (
            <NestedMediaCard
              {...card(row)}
              view={presentation}
              kind={kind}
              id={row.id}
              mediaType={mediaType}
            />
          )}
        />
      ) : (
        <SecondaryTableScroll
          ref={query.scroller}
          onScroll={query.onScroll}
          data-inspector-scroll={!workspace || undefined}
          className={workspace ? 'min-h-0 flex-1' : 'max-h-[min(420px,50dvh)]'}
          role="region"
          aria-label={label}
          aria-busy={query.isFetching}
        >
          <table
            className="ds-table"
            aria-label={label}
            aria-rowcount={total === undefined ? undefined : total + 1}
          >
            <TableHeader>
              <TableRow>
                {visible.map((column, index) =>
                  column.sortable === false ? (
                    <TableHead
                      key={column.key}
                      className={column.className}
                      align={column.align}
                      sticky={index === 0 ? 0 : undefined}
                      stickyEdge={index === 0}
                    >
                      <span className="sr-only">{column.label}</span>
                    </TableHead>
                  ) : (
                    <SecondaryTableHead
                      key={column.key}
                      sortKey={column.key}
                      label={column.label}
                      sortBy={sortBy}
                      direction={direction}
                      onSort={(key) =>
                        setSort(
                          key,
                          sortBy === key
                            ? direction === 'asc'
                              ? 'desc'
                              : 'asc'
                            : column.align === 'end'
                              ? 'desc'
                              : 'asc',
                        )
                      }
                      className={column.className}
                      align={column.align}
                      sticky={index === 0 ? 0 : undefined}
                      stickyEdge={index === 0}
                      filter={column.filter}
                    />
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {total === 0 && (
                <TableState colSpan={visible.length}>{empty}</TableState>
              )}
              <SecondaryVirtualRows
                window={query}
                colSpan={visible.length}
                renderRow={(row, index) => (
                  <TableRow
                    key={row.id}
                    data-selected={row.id === selectedId || undefined}
                    selected={row.id === selectedId}
                    aria-rowindex={index + 2}
                  >
                    {visible.map((column, columnIndex) => (
                      <TableCell
                        key={column.key}
                        className={column.className}
                        align={column.align}
                        sticky={columnIndex === 0 ? 0 : undefined}
                        stickyEdge={columnIndex === 0}
                      >
                        {column.render(row)}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              />
            </TableBody>
          </table>
        </SecondaryTableScroll>
      )}
    </>
  )
}

export function CreatorLibraryTitle({
  kind,
  id,
  title,
  context,
  action,
}: DetailTarget & { title: string; context?: string; action?: ReactNode }) {
  const text = (
    <SecondaryCell text={context ? `${title} · ${context}` : title}>
      <DetailLink className="ds-cell-title" kind={kind} id={id}>
        {title}
      </DetailLink>
      {context && <span className="ds-muted"> · {context}</span>}
    </SecondaryCell>
  )
  return action ? (
    <span className="ds-cell-id">
      {text}
      {action}
    </span>
  ) : (
    text
  )
}

export function CreatorLibraryDate({
  value,
  withTime = false,
}: {
  value?: string | null
  withTime?: boolean
}) {
  if (!value) return <EmptyValue />
  return (
    <time dateTime={value}>
      {value.length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : withTime
          ? formatDateTime(value)
          : formatDate(value)}
    </time>
  )
}
