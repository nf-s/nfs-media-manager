'use client'

import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { TagPageSchema, type TagSortKey } from '@repo/schemas/tags'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableHead,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { Skeleton } from '@repo/ui/components/ds/feedback'
import {
  PageHead,
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import { EMPTY_VALUE, formatCount, formatItemCount } from '@repo/ui/lib/format'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import { updateJobSelection } from '@/utils/job-selection'
import MetadataSourceControl from '@/components/metadata-source-control'
import { DetailLink } from '@/components/detail-link'
import {
  replaceWorkspaceUrl,
  useDetailInspector,
} from '@/components/detail-inspector-context'
import { tagDetailId } from '@/utils/detail-inspector'
import TagActions from '@/components/tag-actions'
import { useMediaScope } from '@/components/media-scope'
import {
  SecondaryCell,
  SecondaryVirtualRows,
  SecondaryTableFrame,
  SecondaryTableScroll,
  SecondaryTableHead,
  SecondaryTableSearch,
  SecondaryTableSelectionBar,
  useTableColumns,
} from '@/components/secondary-table'

const TAGS = { one: 'tag', other: 'tags' }
/** Width of the selection column; the tag name is pinned after it. */
const CHECK_WIDTH = 36

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
  const inspector = useDetailInspector()
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
  const selectAll = useRef<HTMLInputElement>(null)
  const shift = useRef(false)
  const tags = useVirtualTable({
    queryKey: ['tags', 'virtual', mediaType, hidden, query, sortBy, direction],
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags?${new URLSearchParams({ mediaType, q: query, sortBy, direction, visibility: hidden ? 'hidden' : 'visible', page: String(page), size: String(size) })}`,
        TagPageSchema,
        { signal },
      ),
  })
  const items = tags.loadedSlots.map(({ item }) => item)
  const selectedTags = items.filter((tag) => selected.includes(tag.id))
  const orderedIds = items.map((tag) => tag.id)
  const allSelected =
    items.length > 0 && items.every((tag) => selected.includes(tag.id))
  useEffect(() => {
    setSelected([])
    setAnchor(null)
    setOutcome(null)
  }, [mediaType, hidden, query, sortBy, direction])
  useEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate = selectedTags.length > 0 && !allSelected
  }, [selectedTags.length, allSelected])
  function updateParams(key: string, value: string) {
    const next = new URLSearchParams(window.location.search)
    next.set('mediaType', mediaType)
    if (value) next.set(key, value)
    else next.delete(key)
    replaceWorkspaceUrl(
      `${window.location.pathname}${next.size ? `?${next}` : ''}${window.location.hash}`,
      true,
    )
  }
  const tagScope = mediaType === 'film' ? 'film' : 'album'
  function openTag(id: string) {
    inspector?.open({ kind: 'tag', id: tagDetailId(tagScope, id) })
  }
  useEffect(() => {
    if (!selectedTagId || !inspector) return
    const next = new URLSearchParams(window.location.search)
    next.delete('tag')
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${next.size ? `?${next}` : ''}`,
    )
    inspector.open({ kind: 'tag', id: tagDetailId(tagScope, selectedTagId) })
  }, [selectedTagId, inspector, tagScope])
  return (
    <section className="sec-page">
      <PageHead title={hidden ? 'Hidden tags' : 'Tags'} />
      <Toolbar>
        <SecondaryTableSearch
          label="Search tags"
          placeholder="Search tags or original names..."
          maxLength={200}
          value={search}
          disabled={pending}
          onChange={(value) => {
            setSelected([])
            setAnchor(null)
            setOutcome(null)
            updateParams('q', value)
          }}
        />
        <ToolbarCount>
          {tags.hasTotal ? (
            formatItemCount(tags.total, TAGS)
          ) : (
            <Skeleton width={56} height={12} />
          )}
        </ToolbarCount>
        {columns.controls && <ToolbarEnd>{columns.controls}</ToolbarEnd>}
      </Toolbar>
      <SecondaryTableFrame>
        <SecondaryTableScroll
          ref={tags.scroller}
          onScroll={tags.onScroll}
          aria-busy={tags.isFetching}
          role="region"
          aria-label="Tags table"
        >
          <table className="ds-table" aria-label="Tags">
            <thead>
              <tr>
                <TableHead className="sec-check-cell" sticky={0}>
                  <input
                    ref={selectAll}
                    type="checkbox"
                    className="ds-check"
                    aria-label={`Select all ${items.length} loaded tags`}
                    title="Select all loaded tags"
                    checked={allSelected}
                    disabled={pending || !items.length}
                    onChange={(event) => {
                      setSelected(event.target.checked ? orderedIds : [])
                      setAnchor(null)
                    }}
                  />
                </TableHead>
                {columns.visible('name') && (
                  <SecondaryTableHead
                    sortKey="name"
                    label="Tag"
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    disabled={pending}
                    sticky={CHECK_WIDTH}
                    stickyEdge
                  />
                )}
                {columns.visible('mediaCount') && (
                  <SecondaryTableHead
                    sortKey="mediaCount"
                    label="Items"
                    sortBy={sortBy}
                    direction={direction}
                    onSort={sort}
                    align="end"
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
                    align="end"
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
              </tr>
            </thead>
            <tbody>
              {tags.isError && (
                <TableState colSpan={1 + columns.count} error>
                  Could not load tags.{' '}
                  <Button size="xs" onClick={tags.retry}>
                    Retry
                  </Button>
                </TableState>
              )}
              {tags.hasTotal && tags.total === 0 && (
                <TableState colSpan={1 + columns.count}>
                  {query
                    ? hidden
                      ? 'No hidden tags match this search.'
                      : 'No tags match.'
                    : hidden
                      ? 'No hidden tags.'
                      : 'No tags yet.'}
                </TableState>
              )}
              <SecondaryVirtualRows
                window={tags}
                colSpan={1 + columns.count}
                renderRow={(tag) => (
                  <TableRow key={tag.id} selected={selected.includes(tag.id)}>
                    <TableCell className="sec-check-cell" sticky={0}>
                      <input
                        type="checkbox"
                        className="ds-check"
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
                    </TableCell>
                    {columns.visible('name') && (
                      <TableCell sticky={CHECK_WIDTH} stickyEdge>
                        <SecondaryCell text={tag.name}>
                          <DetailLink
                            className="ds-cell-title"
                            kind="tag"
                            id={tagDetailId(tagScope, tag.id)}
                          >
                            {tag.name}
                          </DetailLink>
                        </SecondaryCell>
                      </TableCell>
                    )}
                    {columns.visible('mediaCount') && (
                      <TableCell align="end">
                        {formatCount(tag.mediaCount)}
                      </TableCell>
                    )}
                    {columns.visible('sourceCount') && (
                      <TableCell align="end">
                        <span className="ds-actions">
                          {formatCount(tag.sourceCount)}
                          <MetadataSourceControl
                            field="genre"
                            name={tag.name}
                            tagId={tag.id}
                            mediaType={mediaType}
                            onManage={() => openTag(tag.id)}
                          />
                        </span>
                      </TableCell>
                    )}
                    {columns.visible('mergedNames') && (
                      <TableCell>
                        <SecondaryCell
                          text={tag.mergedNames.join(', ')}
                          details={
                            tag.mergedNames.length
                              ? tag.mergedNames.join(', ')
                              : undefined
                          }
                          label={`Merged names for ${tag.name}`}
                        >
                          {tag.mergedNames.join(', ') || EMPTY_VALUE}
                        </SecondaryCell>
                      </TableCell>
                    )}
                  </TableRow>
                )}
              />
            </tbody>
          </table>
        </SecondaryTableScroll>
        {(selectedTags.length > 0 || outcome) && (
          <SecondaryTableSelectionBar
            selectedCount={selectedTags.length}
            total={items.length}
          >
            {selectedTags.length > 0 && (
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
            )}
            {outcome && (
              <span role={outcome.interrupted ? 'alert' : 'status'}>
                {outcome.message}
              </span>
            )}
          </SecondaryTableSelectionBar>
        )}
      </SecondaryTableFrame>
    </section>
  )
}
