'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { FilmCollectionSummarySchema } from '@repo/schemas/film-collections'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { usePlaylistDrawer } from '@/hooks/usePlaylistDrawer'
import { fetchApiData } from '@/utils/api'
import { sortTableRows } from '@/utils/secondary-table'
import { useConfig } from './providers'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  useTableColumns,
} from './secondary-table'
import FilmCollectionDrawer from './film-collection-detail'

type CollectionSort = 'name' | 'filmCount' | 'createdAt'
const columns: Array<{
  key: CollectionSort
  label: string
  required?: boolean
  defaultVisible?: boolean
}> = [
  { key: 'name', label: 'Collection', required: true },
  { key: 'filmCount', label: 'Films' },
  { key: 'createdAt', label: 'Added', defaultVisible: false },
]

export default function FilmCollectionsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<CollectionSort>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const table = useTableColumns('film-collections', columns)
  const drawer = usePlaylistDrawer({ parameter: 'collection' })
  const query = useQuery({
    queryKey: ['film-collections'],
    staleTime: 0,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/collections',
        z.array(FilmCollectionSummarySchema),
        { signal },
      ),
  })
  const rows = sortTableRows(
    (query.data ?? []).filter((row) =>
      row.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
    ),
    { key: sortBy, direction },
    (row, key) =>
      key === 'filmCount'
        ? row.filmCount
        : key === 'createdAt'
          ? Date.parse(row.createdAt)
          : row.name,
  )
  function onSort(key: CollectionSort) {
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
    setSortBy(key)
  }
  return (
    <section className="admin-page table-workspace">
      <div className="tags-toolbar">
        <h1>Collections</h1>
        <Input
          aria-label="Search collections"
          placeholder="Search collections"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
        <span className="quiet text-xs" aria-live="polite">
          {query.data
            ? `${rows.length.toLocaleString()} ${rows.length === 1 ? 'collection' : 'collections'}`
            : ''}
        </span>
        {table.controls}
      </div>
      <SecondaryTableScroll
        className="tags-scroll"
        role="region"
        aria-label="Film collections"
        aria-busy={query.isFetching}
      >
        <table className="compact-table" aria-label="Film collections">
          <TableHeader>
            <TableRow>
              {columns
                .filter((column) => table.visible(column.key))
                .map((column) => (
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
                ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!rows.length && (
              <TableState colSpan={table.count} error={query.isError}>
                {query.isPending ? (
                  'Loading collections...'
                ) : query.isError ? (
                  <>
                    Could not load collections.{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => query.refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : search ? (
                  'No matching collections.'
                ) : (
                  'No stored film collections.'
                )}
              </TableState>
            )}
            {rows.map((row) => (
              <TableRow
                key={row.id}
                data-selected={row.id === drawer.playlistId || undefined}
              >
                {table.visible('name') && (
                  <TableCell>
                    <button
                      type="button"
                      className="table-title hover:underline"
                      onClick={(event) =>
                        drawer.open(row.id, event.currentTarget)
                      }
                    >
                      {row.name}
                    </button>
                  </TableCell>
                )}
                {table.visible('filmCount') && (
                  <TableCell className="numeric">
                    {row.filmCount.toLocaleString()}
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
            ))}
          </TableBody>
        </table>
      </SecondaryTableScroll>
      {drawer.playlistId && (
        <FilmCollectionDrawer
          key={drawer.playlistId}
          id={drawer.playlistId}
          onClose={drawer.close}
        />
      )}
    </section>
  )
}
