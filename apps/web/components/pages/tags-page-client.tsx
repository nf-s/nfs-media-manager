'use client'

import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useInfiniteQuery } from '@tanstack/react-query'
import { TagPageSchema, type TagSortKey } from '@repo/schemas/tags'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import { updateJobSelection } from '@/utils/job-selection'
import MetadataSourceControl from '@/components/metadata-source-control'
import TagDetailModal from '@/components/tag-detail-modal'
import TagActions from '@/components/tag-actions'
import { useMediaScope } from '@/components/media-scope'
import {
  SecondaryTableScroll,
  SecondaryTableHead,
  useTableColumns,
} from '@/components/secondary-table'

export default function TagsPageClient({
  hidden = false,
}: {
  hidden?: boolean
}) {
  const columns = useTableColumns('tags', [
    { key: 'name', label: 'Tag' },
    { key: 'mediaCount', label: 'Items' },
    { key: 'sourceCount', label: 'Sources' },
    { key: 'mergedNames', label: 'Merged names', defaultVisible: false },
    { key: 'actions', label: 'Actions' },
  ])
  const [sortBy, setSortBy] = useState<TagSortKey>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  function sort(key: TagSortKey) {
    setSortBy(key)
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
  }
  const { apiBaseUrl } = useConfig()
  const params = useSearchParams()
  const mediaType = useMediaScope()
  const search = params.get('q') ?? ''
  const query = useDeferredValue(search.trim())
  const selectedTagId = params.get('tag')
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<{
    message: string
    interrupted: boolean
  } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const sentinel = useRef<HTMLDivElement>(null)
  const selectAll = useRef<HTMLInputElement>(null)
  const shift = useRef(false)
  const tags = useInfiniteQuery({
    queryKey: ['tags', 'infinite', mediaType, hidden, query, sortBy, direction],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags?${new URLSearchParams({ mediaType, q: query, sortBy, direction, visibility: hidden ? 'hidden' : 'visible', page: String(pageParam), size: '100' })}`,
        TagPageSchema,
        { signal },
      ),
    getNextPageParam: (page) =>
      page.page < page.pageCount ? page.page + 1 : undefined,
  })
  const items = [
    ...new Map(
      tags.data?.pages
        .flatMap((page) => page.items)
        .map((tag) => [tag.id, tag]),
    ).values(),
  ]
  const selectedTags = items.filter((tag) => selected.includes(tag.id))
  const orderedIds = items.map((tag) => tag.id)
  const allSelected =
    items.length > 0 && items.every((tag) => selected.includes(tag.id))
  const { hasNextPage, isFetching, isError, fetchNextPage } = tags
  useEffect(() => {
    if (
      !sentinel.current ||
      !scroller.current ||
      !hasNextPage ||
      isFetching ||
      isError
    )
      return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void fetchNextPage({ cancelRefetch: false })
      },
      { root: scroller.current, rootMargin: '300px' },
    )
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [hasNextPage, isFetching, isError, fetchNextPage])
  useEffect(() => {
    setSelected([])
    setAnchor(null)
    setOutcome(null)
    scroller.current?.scrollTo({ top: 0 })
  }, [mediaType, hidden, query, sortBy, direction])
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = selectedTags.length > 0 && !allSelected
  }, [selectedTags.length, allSelected])
  function updateParams(key: string, value: string) {
    const next = new URLSearchParams(window.location.search)
    next.set('mediaType', mediaType)
    if (key === 'mediaType') next.delete('tag')
    if (value) next.set(key, value)
    else next.delete(key)
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${next.size ? `?${next}` : ''}`,
    )
  }
  return (
    <section className="admin-page tags-page table-workspace">
      <div className="tags-toolbar">
        <h1>{hidden ? 'Hidden tags' : 'Tags'}</h1>
        {columns.controls}
        <Input
          aria-label="Search tags"
          placeholder="Search tags or original names..."
          maxLength={200}
          value={search}
          disabled={pending}
          onChange={(event) => updateParams('q', event.target.value)}
        />
        <span className="quiet text-xs" aria-live="polite">
          {tags.data?.pages[0]?.totalCount.toLocaleString() ?? '...'} tags
        </span>
      </div>
      <div
        className="tags-bulk"
        data-active={selectedTags.length > 0 || undefined}
      >
        <span className="quiet">
          {selectedTags.length
            ? `${selectedTags.length} selected`
            : 'Shift-click to select a range.'}
        </span>
        {selectedTags.length > 0 && (
          <>
            <TagActions
              key={selectedTags.map((tag) => tag.id).join(',')}
              tags={selectedTags}
              onPendingChange={setPending}
              onComplete={(ids, message, interrupted) => {
                setSelected((current) =>
                  current.filter((id) => !ids.includes(id)),
                )
                setOutcome({ message, interrupted })
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setSelected([])
                setAnchor(null)
              }}
            >
              Clear selection
            </Button>
          </>
        )}
      </div>
      {outcome && (
        <p
          className="tags-outcome"
          role={outcome.interrupted ? 'alert' : 'status'}
        >
          {outcome.message}
        </p>
      )}
      <SecondaryTableScroll
        ref={scroller}
        className="tags-scroll"
        role="region"
        aria-label="Tags table"
      >
        <table className="compact-table w-full">
          <thead>
            <tr>
              <th scope="col" className="table-selection-cell">
                <input
                  ref={selectAll}
                  type="checkbox"
                  aria-label={`Select all ${items.length} loaded tags`}
                  title="Select all loaded tags"
                  checked={allSelected}
                  disabled={pending || !items.length}
                  onChange={(event) => {
                    setSelected(event.target.checked ? orderedIds : [])
                    setAnchor(null)
                  }}
                />
              </th>
              {columns.visible('name') && (
                <SecondaryTableHead
                  sortKey="name"
                  label="Tag"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  disabled={pending}
                />
              )}
              {columns.visible('mediaCount') && (
                <SecondaryTableHead
                  sortKey="mediaCount"
                  label="Items"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  className="numeric"
                  disabled={pending}
                />
              )}
              {columns.visible('sourceCount') && (
                <SecondaryTableHead
                  sortKey="sourceCount"
                  label="Sources"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  className="numeric"
                  disabled={pending}
                />
              )}
              {columns.visible('mergedNames') && (
                <SecondaryTableHead
                  sortKey="mergedNames"
                  label="Merged names"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  disabled={pending}
                />
              )}
              {columns.visible('actions') && (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((tag) => (
              <tr
                key={tag.id}
                data-selected={selected.includes(tag.id) || undefined}
              >
                <td className="table-selection-cell">
                  <input
                    type="checkbox"
                    aria-label={`Select ${tag.name}`}
                    checked={selected.includes(tag.id)}
                    disabled={pending}
                    onClick={(event) => {
                      shift.current = event.shiftKey
                    }}
                    onKeyDown={(event) => {
                      shift.current = event.shiftKey
                    }}
                    onChange={(event) => {
                      setSelected(
                        updateJobSelection(
                          selected,
                          orderedIds,
                          tag.id,
                          anchor,
                          shift.current,
                          event.target.checked,
                        ),
                      )
                      setAnchor(tag.id)
                      shift.current = false
                    }}
                  />
                </td>
                {columns.visible('name') && (
                  <td>
                    <button
                      type="button"
                      className="tag-name"
                      onClick={() => updateParams('tag', tag.id)}
                    >
                      {tag.name}
                    </button>
                  </td>
                )}
                {columns.visible('mediaCount') && (
                  <td className="numeric">{tag.mediaCount.toLocaleString()}</td>
                )}
                {columns.visible('sourceCount') && (
                  <td className="numeric">
                    <span className="inline-flex items-center gap-1">
                      {tag.sourceCount.toLocaleString()}
                      <MetadataSourceControl
                        field="genre"
                        name={tag.name}
                        tagId={tag.id}
                        mediaType={mediaType}
                        onManage={() => updateParams('tag', tag.id)}
                      />
                    </span>
                  </td>
                )}
                {columns.visible('mergedNames') && (
                  <td>{tag.mergedNames.join(', ') || '-'}</td>
                )}
                {columns.visible('actions') && (
                  <td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => updateParams('tag', tag.id)}
                      aria-label={`Manage tag ${tag.name}`}
                    >
                      Manage tag
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {tags.isPending && (
          <p className="p-3" role="status">
            Loading tags...
          </p>
        )}
        {tags.isError && (
          <p className="p-3" role="alert">
            Could not load tags.{' '}
            <button
              className="underline"
              onClick={() =>
                tags.isFetchNextPageError
                  ? tags.fetchNextPage()
                  : tags.refetch()
              }
            >
              Retry
            </button>
          </p>
        )}
        {tags.data && items.length === 0 && (
          <p className="p-3">
            {hidden ? 'No hidden tags match this search.' : 'No matching tags.'}
          </p>
        )}
        <div ref={sentinel} className="load-more" role="status">
          {tags.isFetchingNextPage
            ? 'Loading more tags...'
            : tags.hasNextPage
              ? 'Scroll for more tags'
              : `${items.length.toLocaleString()} tags loaded`}
        </div>
      </SecondaryTableScroll>
      {selectedTagId && (
        <TagDetailModal
          id={selectedTagId}
          mediaType={mediaType}
          onClose={() => updateParams('tag', '')}
        />
      )}
    </section>
  )
}
