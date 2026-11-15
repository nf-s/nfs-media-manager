'use client'

import {
  Fragment,
  useDeferredValue,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import type { z } from 'zod'
import { Input } from '@repo/ui/components/ui/input'
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
import {
  NestedMediaCard,
  NestedMediaCards,
  NestedMediaViewControls,
  useNestedMediaView,
} from './nested-media-view'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
  type TableColumn,
} from './secondary-table'

export type CreatorLibraryColumn<Row> = TableColumn & {
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
  card?: (row: Row) => CreatorLibraryCard
}) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const scope = `creator-library-${kind}`
  const table = useTableColumns(scope, columns)
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
  const visible = columns.filter((column) => table.visible(column.key))
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

  return (
    <>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label={`Search ${label}`}
            placeholder={`Search ${label}`}
            value={draft}
            maxLength={200}
            onChange={(event) => {
              const next = event.target.value
              setDraft(next)
              if (next) view.params.set('q', next)
              else view.params.delete('q')
              view.replace(view.params)
            }}
          />
        }
        filters={
          card && (
            <NestedMediaViewControls
              view={presentation}
              onViewChange={setPresentation}
              sortBy={sortBy}
              direction={direction}
              sortOptions={sortable}
              onSortChange={(key) => setSort(key, direction)}
              onDirectionChange={(value) => setSort(sortBy, value)}
              filters={columns.map((column) =>
                column.filter ? (
                  <Fragment key={column.key}>{column.filter}</Fragment>
                ) : null,
              )}
            />
          )
        }
        count={
          total === undefined
            ? undefined
            : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`
        }
        columns={!card || presentation === 'table' ? table.controls : undefined}
      />
      {query.isError && (
        <p className="quiet" role="alert">
          Could not load {label}.{' '}
          <button type="button" className="underline" onClick={query.retry}>
            Retry
          </button>
        </p>
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
            className="compact-table"
            aria-label={label}
            aria-rowcount={total === undefined ? undefined : total + 1}
          >
            <TableHeader>
              <TableRow>
                {visible.map((column) =>
                  column.sortable === false ? (
                    <TableHead key={column.key} className={column.className}>
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
                          sortBy === key && direction === 'asc'
                            ? 'desc'
                            : 'asc',
                        )
                      }
                      className={column.className}
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
                    aria-rowindex={index + 2}
                  >
                    {visible.map((column) => (
                      <TableCell key={column.key} className={column.className}>
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
      <DetailLink className="table-title hover:underline" kind={kind} id={id}>
        {title}
      </DetailLink>
      {context && <span className="quiet"> · {context}</span>}
    </SecondaryCell>
  )
  return action ? (
    <div className="secondary-cell-actions">
      {action}
      {text}
    </div>
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
  if (!value) return <>-</>
  return (
    <time dateTime={value}>
      {withTime
        ? new Date(value).toLocaleString()
        : new Date(value).toLocaleDateString(
            undefined,
            value.length === 10 ? { timeZone: 'UTC' } : undefined,
          )}
    </time>
  )
}
