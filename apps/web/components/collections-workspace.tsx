'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useDeferredValue, useState } from 'react'
import { BrowseCountSchema } from '@repo/schemas/browse'
import {
  AlbumCollectionBrowsePageSchema,
  type AlbumCollectionBrowseSort,
} from '@repo/schemas/album-collections'
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
import { useDetailInspector, useDetailView } from './detail-inspector-context'
import {
  readLibraryScope,
  libraryScopeQuery,
  libraryScopeUpdates,
  type LibraryScopeState,
} from '@/utils/library-scope'
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
import { collectionItemsHref } from '@/utils/playlist-links'
import { mediaScope, type MediaScope } from '@/utils/media-scope'

type CollectionBrowseSort = FilmCollectionBrowseSort | AlbumCollectionBrowseSort

export default function CollectionsWorkspace() {
  const mediaType = mediaScope(useSearchParams().get('mediaType'))
  return <CollectionDirectory key={mediaType} mediaType={mediaType} />
}

function CollectionDirectory({ mediaType }: { mediaType: MediaScope }) {
  const { apiBaseUrl } = useConfig()
  const view = useDetailView()
  const scope = readLibraryScope(view.params)
  const scopeParams = libraryScopeQuery(scope)
  function changeScope(next: LibraryScopeState) {
    const params = new URLSearchParams(view.params)
    for (const [key, value] of Object.entries(libraryScopeUpdates(next))) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    view.replace(params)
  }
  const album = mediaType === 'album'
  const endpoint = album ? '/api/v1/album-collections' : '/api/v1/collections'
  const collectionLabel = album ? 'Album collections' : 'Film collections'
  const countKey = album ? 'albumCount' : 'filmCount'
  const columns: Array<{
    key: CollectionBrowseSort | 'source'
    label: string
    width: number
    required?: boolean
    defaultVisible?: boolean
    fill?: boolean
  }> = [
    {
      key: 'name',
      label: 'Collection',
      width: 320,
      required: true,
      fill: true,
    },
    { key: countKey, label: album ? 'Albums' : 'Films', width: 90 },
    { key: 'source', label: 'Source', width: 140, defaultVisible: false },
    { key: 'createdAt', label: 'Added', width: 110, defaultVisible: false },
  ]
  const [search, setSearch] = useState('')
  const q = useDeferredValue(search.trim())
  const [sortBy, setSortBy] = useState<CollectionBrowseSort>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const directoryKey = `${mediaType}-collections`
  const table = useTableColumns(directoryKey, columns)
  const includeSources = table.visible('source')
  const shown = columns.filter((column) => table.visible(column.key))
  const layout = table.layout(shown.map((column) => column.key))
  const inspector = useDetailInspector()
  const selectedId =
    inspector?.root?.kind === 'collection' &&
    (inspector.root.mediaType ?? 'film') === mediaType
      ? inspector.root.id
      : null
  const viewportKey = [
    directoryKey,
    'browse',
    q,
    sortBy,
    direction,
    scopeParams,
  ]
  const {
    window: query,
    isCounting,
    countError,
    retryCount,
  } = useCountedVirtualTable({
    performanceScreen: 'collections',
    viewportKey,
    queryKey: [...viewportKey, includeSources],
    countKey: [directoryKey, 'browse-count', q, scopeParams],
    loadCount: (signal) =>
      fetchApiData(
        apiBaseUrl,
        `${endpoint}/browse-count?${new URLSearchParams({ q, ...scopeParams })}`,
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
        ...scopeParams,
      })
      return fetchApiData(
        apiBaseUrl,
        `${endpoint}/browse-page?${params}`,
        album
          ? AlbumCollectionBrowsePageSchema
          : FilmCollectionBrowsePageSchema,
        { signal },
      )
    },
  })
  /** A new sort starts ascending for names and descending for counts and dates. */
  function onSort(key: CollectionBrowseSort) {
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
        libraryScope={{ value: scope, onChange: changeScope }}
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
        aria-label={collectionLabel}
        aria-busy={query.isFetching}
      >
        <table
          className="ds-table"
          aria-label={collectionLabel}
          aria-rowcount={query.hasTotal ? query.total + 1 : undefined}
          {...layout.table}
        >
          {layout.colgroup}
          <TableHeader>
            <TableRow>
              {shown.map((column) =>
                column.key === 'source' ? (
                  <TableHead
                    key={column.key}
                    resizer={table.resizer(column.key)}
                  >
                    {column.label}
                  </TableHead>
                ) : (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sortBy}
                    direction={direction}
                    onSort={onSort}
                    align={column.key === countKey ? 'end' : undefined}
                    sticky={column.key === 'name' ? 0 : undefined}
                    stickyEdge={column.key === 'name'}
                    resizer={table.resizer(column.key)}
                  />
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.hasTotal && !query.total && (
              <TableState colSpan={table.count}>
                {q
                  ? 'No matching collections.'
                  : `No stored ${mediaType} collections.`}
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
                          mediaType={mediaType}
                          id={row.id}
                          className="ds-cell-title"
                        >
                          {row.name}
                        </DetailLink>
                      </SecondaryCell>
                    </TableCell>
                  )}
                  {table.visible(countKey) && (
                    <TableCell align="end">
                      <Link
                        href={collectionItemsHref(mediaType, row.name)}
                        title={`Filter ${mediaType}s by ${row.name}`}
                      >
                        {formatCount(
                          'albumCount' in row ? row.albumCount : row.filmCount,
                        )}
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
