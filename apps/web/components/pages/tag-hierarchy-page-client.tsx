'use client'

import { ReadButton } from '@/components/read-button'
import { useDeferredValue, useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  formatTagName,
  CreateTagResultSchema,
  TagHierarchySchema,
  type Tag,
} from '@repo/schemas/tags'
import { Notice, Skeleton } from '@repo/ui/components/ds/feedback'
import { Status } from '@repo/ui/components/ds/status'
import {
  PageHead,
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import { Button, mutationFeedback } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { Label } from '@repo/ui/components/ui/label'
import {
  TableCell,
  TableHead,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { useTagDetailParam } from '@/hooks/useTagDetailParam'
import { useConfig } from '@/components/providers'
import { DetailLink } from '@/components/detail-link'
import { replaceWorkspaceUrl } from '@/components/detail-inspector-context'
import { errorMessage } from '@/components/lastfm-sync'
import { useMediaScope } from '@/components/media-scope'
import {
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  useTableColumns,
} from '@/components/secondary-table'
import { TagPicker } from '@/components/tag-picker'
import { fetchApiData } from '@/utils/api'
import { tagDetailId } from '@/utils/detail-inspector'
import { scopedHref } from '@/utils/media-scope'
import { clientQueryDefaults } from '@/utils/query-cache'
import { invalidateTags } from '@/utils/tag-actions'
import { flattenTagHierarchy, type TagTreeSortKey } from '@/utils/tag-hierarchy'

const TAGS = { one: 'tag', other: 'tags' }
/** Rows rendered at once; a search narrows the rest. */
const ROW_LIMIT = 500
const NO_KEYS: ReadonlySet<string> = new Set()
/** The tag column leaves room for a few levels of subtags. */
const treeColumns = [
  { key: 'name', label: 'Tag', width: 360, required: true, fill: true },
  { key: 'mediaCount', label: 'Items', width: 90 },
  { key: 'totalCount', label: 'With subtags', width: 120 },
  { key: 'subtags', label: 'Subtags', width: 90 },
]

function NewTagForm({
  mediaType,
  onCancel,
  onCreated,
}: {
  mediaType: 'album' | 'film'
  onCancel: () => void
  onCreated: (name: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const nameId = useId()
  const [name, setName] = useState('')
  const [parent, setParent] = useState<Tag | null>(null)
  const create = useMutation({
    mutationFn: () =>
      fetchApiData(apiBaseUrl, '/api/v1/tags', CreateTagResultSchema, {
        method: 'POST',
        body: JSON.stringify({
          mediaType,
          name,
          parentIds: parent ? [parent.id] : [],
        }),
      }),
    onSuccess: async (created) => {
      await invalidateTags(client)
      onCreated(formatTagName(created.name))
    },
  })
  return (
    <form
      className="ds-panelpad sec-form"
      aria-label="New tag"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() && !create.isPending) create.mutate()
      }}
    >
      <div className="ds-field">
        <Label htmlFor={nameId}>Name</Label>
        <Input
          id={nameId}
          value={name}
          maxLength={200}
          disabled={create.isPending}
          onChange={(event) => {
            setName(event.target.value)
            create.reset()
          }}
        />
      </div>
      {parent ? (
        <p className="ds-actions">
          <span>
            Parent tag: <strong>{formatTagName(parent.name)}</strong>
          </span>
          <Button
            type="button"
            variant="link"
            size="xs"
            disabled={create.isPending}
            onClick={() => setParent(null)}
          >
            Remove
          </Button>
        </p>
      ) : (
        <TagPicker
          mediaType={mediaType}
          label="Parent tag (optional)"
          inputLabel="Find parent tag"
          listLabel="Tags to choose as parent"
          disabled={create.isPending}
          onPick={(tag) => {
            setParent(tag)
            create.reset()
          }}
        />
      )}
      <div className="ds-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!name.trim() || create.isPending}
          feedback={mutationFeedback(create, {
            pending: 'Creating tag…',
            success: 'Tag created',
            error: 'Could not create tag',
          })}
        >
          Create tag
        </Button>
        <Button type="button" disabled={create.isPending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {create.isError && (
        <Notice tone="danger">
          {errorMessage(create.error, 'Could not create the tag.')}
        </Notice>
      )}
    </form>
  )
}

export default function TagHierarchyPageClient() {
  const columns = useTableColumns('tag-hierarchy', treeColumns)
  const layout = columns.layout(
    treeColumns
      .filter((column) => columns.visible(column.key))
      .map((column) => column.key),
  )
  const [sortBy, setSortBy] = useState<TagTreeSortKey>('name')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  function sort(key: TagTreeSortKey) {
    setSortBy(key)
    setDirection(sortBy === key && direction === 'asc' ? 'desc' : 'asc')
  }
  const { apiBaseUrl } = useConfig()
  const params = useSearchParams()
  const mediaType = useMediaScope()
  const tagScope = mediaType === 'film' ? 'film' : 'album'
  useTagDetailParam(tagScope)
  const search = params.get('q') ?? ''
  const query = useDeferredValue(search.trim())
  // Rows shown or hidden by hand; a new search or library starts over.
  const scope = `${tagScope}:${query}`
  const [toggled, setToggled] = useState<{
    scope: string
    keys: ReadonlySet<string>
  }>({ scope, keys: NO_KEYS })
  const expanded = toggled.scope === scope ? toggled.keys : NO_KEYS
  function toggle(key: string) {
    const keys = new Set(expanded)
    if (keys.has(key)) keys.delete(key)
    else keys.add(key)
    setToggled({ scope, keys })
  }
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const hierarchy = useQuery({
    queryKey: ['tags', 'hierarchy', tagScope],
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags/hierarchy?${new URLSearchParams({ mediaType: tagScope })}`,
        TagHierarchySchema,
        { signal },
      ),
    ...clientQueryDefaults,
  })
  const nodes = hierarchy.data?.nodes
  const tree = useMemo(
    () =>
      nodes
        ? flattenTagHierarchy(nodes, {
            expanded,
            search: query,
            sortBy,
            direction,
            limit: ROW_LIMIT,
          })
        : null,
    [nodes, expanded, query, sortBy, direction],
  )
  const unplaced = hierarchy.data?.unplacedCount ?? 0
  function updateSearch(value: string) {
    const next = new URLSearchParams(window.location.search)
    next.set('mediaType', tagScope)
    if (value) next.set('q', value)
    else next.delete('q')
    replaceWorkspaceUrl(
      `${window.location.pathname}${next.size ? `?${next}` : ''}${window.location.hash}`,
      true,
    )
  }
  return (
    <section className="sec-page">
      <PageHead title="Tag hierarchy" />
      <Toolbar>
        <Button
          aria-expanded={creating}
          feedback={
            created ? { phase: 'done', label: 'Tag created' } : undefined
          }
          aria-label="New tag"
          title={created ? `Tag created · ${created}` : undefined}
          onClick={() => {
            setCreating(!creating)
            setCreated(null)
          }}
        >
          New tag
        </Button>
        <SecondaryTableSearch
          label="Search tags"
          placeholder="Search tags..."
          maxLength={200}
          value={search}
          onChange={updateSearch}
        />
        <ToolbarCount>
          {nodes && tree ? (
            query ? (
              formatItemCount(tree.matches, TAGS, nodes.length)
            ) : (
              formatItemCount(nodes.length, TAGS)
            )
          ) : (
            <Skeleton width={56} height={12} />
          )}
        </ToolbarCount>
        {unplaced > 0 && (
          <Link href={scopedHref('/tags/all?placement=unplaced', tagScope)}>
            {formatItemCount(unplaced, TAGS)} outside the hierarchy
          </Link>
        )}
        {columns.controls && <ToolbarEnd>{columns.controls}</ToolbarEnd>}
      </Toolbar>
      {creating && (
        <NewTagForm
          key={tagScope}
          mediaType={tagScope}
          onCancel={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false)
            setCreated(name)
          }}
        />
      )}
      {tree?.capped && (
        <p className="ds-help sec-pad">
          Showing the first {formatCount(ROW_LIMIT)} rows. Search or hide
          subtags to see the rest.
        </p>
      )}
      <SecondaryTableScroll
        role="region"
        aria-label="Tag hierarchy table"
        aria-busy={hierarchy.isFetching}
      >
        <table
          className="ds-table"
          aria-label="Tag hierarchy"
          {...layout.table}
        >
          {layout.colgroup}
          <thead>
            <tr>
              <SecondaryTableHead
                sortKey="name"
                label="Tag"
                sortBy={sortBy}
                direction={direction}
                onSort={sort}
                sticky={0}
                stickyEdge
                resizer={columns.resizer('name')}
              />
              {columns.visible('mediaCount') && (
                <SecondaryTableHead
                  sortKey="mediaCount"
                  label="Items"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  align="end"
                  resizer={columns.resizer('mediaCount')}
                />
              )}
              {columns.visible('totalCount') && (
                <SecondaryTableHead
                  sortKey="totalCount"
                  label="With subtags"
                  sortBy={sortBy}
                  direction={direction}
                  onSort={sort}
                  align="end"
                  resizer={columns.resizer('totalCount')}
                />
              )}
              {columns.visible('subtags') && (
                <TableHead align="end" resizer={columns.resizer('subtags')}>
                  Subtags
                </TableHead>
              )}
            </tr>
          </thead>
          <tbody>
            {hierarchy.isError && !nodes && (
              <TableState colSpan={columns.count} error>
                Could not load tags.{' '}
                <ReadButton size="xs" read={() => hierarchy.refetch()}>
                  Retry
                </ReadButton>
              </TableState>
            )}
            {hierarchy.isPending && (
              <TableState colSpan={columns.count}>
                <Skeleton width={120} height={12} />
              </TableState>
            )}
            {nodes && nodes.length === 0 && (
              <TableState colSpan={columns.count}>
                No tag has a parent yet. Select tags in All and choose Add
                parent, or add one under Parent tags in a tag&apos;s details.
              </TableState>
            )}
            {nodes && nodes.length > 0 && tree?.rows.length === 0 && (
              <TableState colSpan={columns.count}>No tags match.</TableState>
            )}
            {tree?.rows.map((row) => (
              <TableRow key={row.key} depth={row.depth}>
                <TableCell sticky={0} stickyEdge>
                  <span className="ds-cell-id">
                    {row.expandable ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        icon
                        aria-expanded={row.expanded}
                        aria-label={`${row.expanded ? 'Hide' : 'Show'} subtags of ${formatTagName(row.node.name)}`}
                        onClick={() => toggle(row.key)}
                      >
                        {row.expanded ? (
                          <ChevronDown className="ds-i" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="ds-i" aria-hidden="true" />
                        )}
                      </Button>
                    ) : (
                      <span className="sec-tree-spacer" aria-hidden="true" />
                    )}
                    <DetailLink
                      className="ds-cell-title"
                      kind="tag"
                      id={tagDetailId(tagScope, row.node.id)}
                      title={formatTagName(row.node.name)}
                    >
                      {formatTagName(row.node.name)}
                    </DetailLink>
                    {row.node.hidden && <Status state="paused">Hidden</Status>}
                  </span>
                </TableCell>
                {columns.visible('mediaCount') && (
                  <TableCell align="end">
                    {formatCount(row.node.mediaCount)}
                  </TableCell>
                )}
                {columns.visible('totalCount') && (
                  <TableCell align="end">
                    {formatCount(row.node.totalCount)}
                  </TableCell>
                )}
                {columns.visible('subtags') && (
                  <TableCell align="end">{formatCount(row.subtags)}</TableCell>
                )}
              </TableRow>
            ))}
          </tbody>
        </table>
      </SecondaryTableScroll>
    </section>
  )
}
