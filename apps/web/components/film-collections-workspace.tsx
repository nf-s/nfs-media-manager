'use client'

import Link from 'next/link'
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
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableToolbar,
  useTableColumns,
} from './secondary-table'
import FilmCollectionDrawer from './film-collection-detail'
import ServiceIconLinks from './service-icon-links'
import { collectionFilmsHref } from '@/utils/playlist-links'

type CollectionSort = 'name' | 'filmCount' | 'createdAt' | 'source'
const columns: Array<{
  key: CollectionSort
  label: string
  required?: boolean
  defaultVisible?: boolean
}> = [
  { key: 'name', label: 'Collection', required: true },
  { key: 'filmCount', label: 'Films' },
  { key: 'source', label: 'Source' },
  { key: 'createdAt', label: 'Added', defaultVisible: false },
]

export default function FilmCollectionsWorkspace() {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const [sources, setSources] = useState<string[]>([])
  const [sortBy, setSortBy] = useState<CollectionSort>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const table = useTableColumns('film-collections', columns)
  const drawer = usePlaylistDrawer({ parameter: 'collection' })
  const query = useQuery({
    queryKey: ['film-collections'],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/collections',
        z.array(FilmCollectionSummarySchema),
        { signal },
      ),
  })
  const sourceOptions = [
    ...new Map(
      (query.data ?? []).flatMap((row) =>
        row.sourceLinks.map(
          (link) =>
            [link.provider, link.providerLabel] satisfies [string, string],
        ),
      ),
    ).entries(),
  ]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label))
  const rows = sortTableRows(
    (query.data ?? []).filter(
      (row) =>
        row.name
          .toLocaleLowerCase()
          .includes(search.trim().toLocaleLowerCase()) &&
        (!sources.length ||
          row.sourceLinks.some((link) => sources.includes(link.provider))),
    ),
    { key: sortBy, direction },
    (row, key) =>
      key === 'filmCount'
        ? row.filmCount
        : key === 'createdAt'
          ? Date.parse(row.createdAt)
          : key === 'source'
            ? row.sourceLinks.map((link) => link.providerLabel).join(', ')
            : row.name,
  )
  function onSort(key: CollectionSort) {
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
            onChange={(event) => setSearch(event.target.value)}
            className="max-w-xs"
          />
        }
        count={
          <span aria-live="polite">
            {query.data
              ? search.trim() || sources.length
                ? `${rows.length.toLocaleString()} of ${query.data.length.toLocaleString()} collections`
                : `${rows.length.toLocaleString()} ${rows.length === 1 ? 'collection' : 'collections'}`
              : ''}
          </span>
        }
        columns={table.controls}
      />
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
                    filter={
                      column.key === 'source' && sourceOptions.length > 1 ? (
                        <SecondaryColumnFilter
                          label="Source"
                          options={sourceOptions}
                          value={sources}
                          onChange={setSources}
                        />
                      ) : undefined
                    }
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
                ) : search || sources.length ? (
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
                    <SecondaryCell text={row.name}>
                      <button
                        type="button"
                        className="table-title hover:underline"
                        onClick={(event) =>
                          drawer.open(row.id, event.currentTarget)
                        }
                      >
                        {row.name}
                      </button>
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
                {table.visible('source') && (
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <SecondaryCell
                        text={row.sourceLinks
                          .map((link) => link.providerLabel)
                          .join(', ')}
                      >
                        {row.sourceLinks.length
                          ? [
                              ...new Set(
                                row.sourceLinks.map(
                                  (link) => link.providerLabel,
                                ),
                              ),
                            ].join(', ')
                          : '-'}
                      </SecondaryCell>
                      <ServiceIconLinks
                        links={row.sourceLinks.map((link) => ({
                          provider: link.provider,
                          label: link.providerLabel,
                          url: link.url,
                        }))}
                      />
                    </div>
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
