'use client'

import Link from 'next/link'
import { useDeferredValue, useState } from 'react'
import { BrowseCountSchema } from '@repo/schemas/browse'
import {
  FilmCollectionBrowsePageSchema,
  type FilmCollectionBrowseSort,
} from '@repo/schemas/film-collections'
import { Button } from '@repo/ui/components/ui/button'
import { Notice } from '@repo/ui/components/ds/feedback'
import { EmptyValue } from '@repo/ui/components/ds/pill'
import { PageHead } from '@repo/ui/components/ds/toolbar'
import { formatCount, formatDate, formatItemCount } from '@repo/ui/lib/format'
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { useDetailInspector } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { useCountedVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { useConfig } from './providers'
import {
  SecondaryCell,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableToolbar,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'
import ServiceIconLinks from './service-icon-links'
import { collectionFilmsHref } from '@/utils/playlist-links'

const columns: Array<{
  key: FilmCollectionBrowseSort | 'source'
  label: string
  required?: boolean
  defaultVisible?: boolean
}> = [
  { key: 'name', label: 'Collection', required: true },
  { key: 'filmCount', label: 'Films' },
  { key: 'source', label: 'Source', defaultVisible: false },
  { key: 'createdAt', label: 'Added', defaultVisible: false },
]

export default function FilmCollectionsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const [sortBy, setSortBy] = useState<FilmCollectionBrowseSort>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const table = useTableColumns('film-collections', columns)
  const includeSources = table.visible('source')
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === 'collection' ? inspector.root.id : null
  const viewportKey = ['film-collections', 'browse', q, sortBy, direction]
  const {
    window: query,
    isCounting,
    countError,
    retryCount,
  } = useCountedVirtualTable({
    viewportKey,
    queryKey: [...viewportKey, includeSources],
    countKey: ['film-collections', 'browse-count', q],
    loadCount: (signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/collections/browse-count?${new URLSearchParams({ q })}`,
        BrowseCountSchema,
        { signal },
      ),
    loadPage: (page, size, signal) => {
      const params = new URLSearchParams({
        q,
        sortBy,
        direction,
        page: String(page),
        size: String(size),
        includeSources: String(includeSources),
      })
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/collections/browse-page?${params}`,
        FilmCollectionBrowsePageSchema,
        { signal },
      )
    },
  })
  /** A new sort starts ascending for names and descending for counts and dates. */
  function onSort(key: FilmCollectionBrowseSort) {
    setDirection(
      sortBy === key
        ? direction === 'asc'
          ? 'desc'
          : 'asc'
        : key === 'name'
          ? 'asc'
          : 'desc',
    )
    setSortBy(key)
  }
  return (
    <section className="browse-workspace" aria-label="Collections">
      <PageHead title="Collections" />
      <SecondaryTableToolbar
        search={
          <SecondaryTableSearch
            label="Search collections"
            value={search}
            maxLength={200}
            onChange={setSearch}
          />
        }
        count={
          countError ? (
            <Button type="button" variant="link" size="xs" onClick={retryCount}>
              Retry count
            </Button>
          ) : !isCounting ? (
            formatItemCount(query.total, {
              one: 'collection',
              other: 'collections',
            })
          ) : query.isPending ? (
            'Loading collections...'
          ) : (
            'Counting collections...'
          )
        }
        columns={table.controls}
      />
      {query.isError && (
        <Notice
          tone="danger"
          action={
            <Button type="button" size="xs" onClick={query.retry}>
              Retry
            </Button>
          }
        >
          Could not load collections.
        </Notice>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        role="region"
        aria-label="Film collections"
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          aria-label="Film collections"
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
        >
          <TableHeader>
            <TableRow>
              {columns
                .filter((column) => table.visible(column.key))
                .map((column) =>
                  column.key === 'source' ? (
                    <TableHead key={column.key}>{column.label}</TableHead>
                  ) : (
                    <SecondaryTableHead
                      key={column.key}
                      sortKey={column.key}
                      label={column.label}
                      sortBy={sortBy}
                      direction={direction}
                      onSort={onSort}
                      align={column.key === 'filmCount' ? 'end' : undefined}
                      sticky={column.key === 'name' ? 0 : undefined}
                      stickyEdge={column.key === 'name'}
                    />
                  ),
                )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && !query.total && (
              <TableState colSpan={table.count}>
                {q ? 'No matching collections.' : 'No stored film collections.'}
              </TableState>
            )}
            <SecondaryVirtualRows
              window={query}
              colSpan={table.count}
              renderRow={(row, index) => (
                <TableRow
                  key={row.id}
                  data-selected={row.id === selectedId || undefined}
                  selected={row.id === selectedId}
                  aria-rowindex={index + 2}
                >
                  {table.visible('name') && (
                    <TableCell sticky={0} stickyEdge>
                      <SecondaryCell text={row.name}>
                        <DetailLink
                          kind="collection"
                          id={row.id}
                          className="ds-cell-title"
                        >
                          {row.name}
                        </DetailLink>
                      </SecondaryCell>
                    </TableCell>
                  )}
                  {table.visible('filmCount') && (
                    <TableCell align="end">
                      <Link
                        href={collectionFilmsHref(row.name)}
                        title={`Filter films by ${row.name}`}
                      >
                        {formatCount(row.filmCount)}
                      </Link>
                    </TableCell>
                  )}
                  {includeSources && (
                    <TableCell>
                      {row.sourceLinks.length ? (
                        <ServiceIconLinks
                          links={row.sourceLinks.map((link) => ({
                            provider: link.provider,
                            label: link.providerLabel,
                            url: link.url,
                          }))}
                        />
                      ) : (
                        <EmptyValue />
                      )}
                    </TableCell>
                  )}
                  {table.visible('createdAt') && (
                    <TableCell>
                      <time dateTime={row.createdAt}>
                        {formatDate(row.createdAt)}
                      </time>
                    </TableCell>
                  )}
                </TableRow>
              )}
            />
          </TableBody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
