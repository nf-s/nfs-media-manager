'use client'

import Link from 'next/link'
import { useDeferredValue, useState } from 'react'
import { BrowseCountSchema } from '@repo/schemas/browse'
import {
  FilmCollectionBrowsePageSchema,
  type FilmCollectionBrowseSort,
} from '@repo/schemas/film-collections'
import { Input } from '@repo/ui/components/ui/input'
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
  function onSort(key: FilmCollectionBrowseSort) {
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
    setSortBy(key)
  }
  return (
    <section className="admin-page table-workspace">
      <h1>Collections</h1>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search collections"
            placeholder="Search collections"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xs"
          />
        }
        count={
          countError ? (
            <button type="button" className="underline" onClick={retryCount}>
              Retry count
            </button>
          ) : !isCounting ? (
            `${query.total.toLocaleString()} ${query.total === 1 ? 'collection' : 'collections'}`
          ) : query.isPending ? (
            'Loading collections...'
          ) : (
            'Counting collections...'
          )
        }
        columns={table.controls}
      />
      {query.isError && (
        <p className="quiet" role="alert">
          Could not load collections.{' '}
          <button type="button" className="underline" onClick={query.retry}>
            Retry
          </button>
        </p>
      )}
      <SecondaryTableScroll
        ref={query.scroller}
        onScroll={query.onScroll}
        role="region"
        aria-label="Film collections"
        aria-busy={query.isFetching}
      >
        <table
          className="compact-table"
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
                      className={
                        column.key === 'filmCount' ? 'numeric' : undefined
                      }
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
                  aria-rowindex={index + 2}
                  style={{ height: query.rowHeight }}
                >
                  {table.visible('name') && (
                    <TableCell>
                      <SecondaryCell text={row.name}>
                        <DetailLink
                          kind="collection"
                          id={row.id}
                          className="table-title hover:underline"
                        >
                          {row.name}
                        </DetailLink>
                      </SecondaryCell>
                    </TableCell>
                  )}
                  {table.visible('filmCount') && (
                    <TableCell className="numeric">
                      <Link
                        href={collectionFilmsHref(row.name)}
                        title={`Filter films by ${row.name}`}
                      >
                        {row.filmCount.toLocaleString()}
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
                        '-'
                      )}
                    </TableCell>
                  )}
                  {table.visible('createdAt') && (
                    <TableCell className="whitespace-nowrap">
                      <time dateTime={row.createdAt}>
                        {new Date(row.createdAt).toLocaleDateString()}
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
