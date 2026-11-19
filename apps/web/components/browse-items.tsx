'use client'

import { type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Filter, RefreshCw } from 'lucide-react'
import type { BrowseField } from '@repo/schemas/browse'
import { Button } from '@repo/ui/components/ui/button'
import { TableHead, TableSortButton } from '@repo/ui/components/ui/table'
import { Art, Thumb, type ArtRatio } from '@repo/ui/components/ds/artwork'
import { CardGrid } from '@repo/ui/components/ds/card'
import { Notice, Skeleton, State } from '@repo/ui/components/ds/feedback'
import { List } from '@repo/ui/components/ds/list-row'
import { formatItemCount } from '@repo/ui/lib/format'
import type { DetailTarget } from '@/utils/detail-inspector'
import { itemGridHeight } from '@/utils/browse-items'
import { DetailLink } from './detail-link'
import { FilterPanelSection } from './browse-filter-panel'
import { MediaArt, MediaThumb, type ArtworkKind } from './media-artwork'
import { ColumnOrderList } from './column-order'

/**
 * A browse table header: the sort control and a resize handle. The identity
 * column is pinned; number columns are right-aligned.
 */
export function BrowseItemsHead({
  field,
  identity = false,
  sortable = true,
  sortBy,
  direction,
  onSort,
  resizer,
}: {
  field: BrowseField
  identity?: boolean
  sortable?: boolean
  sortBy: string
  direction?: 'asc' | 'desc'
  onSort: (key: string) => void
  resizer: HTMLAttributes<HTMLSpanElement>
}) {
  const active = sortable && sortBy === field.key && direction !== undefined
  return (
    <TableHead
      align={field.type === 'number' ? 'end' : undefined}
      sticky={identity ? 0 : undefined}
      stickyEdge={identity}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
      }
      resizer={resizer}
    >
      {sortable ? (
        <TableSortButton
          direction={active ? direction : undefined}
          title={`Sort by ${field.label}`}
          onClick={() => onSort(field.key)}
        >
          {field.label}
        </TableSortButton>
      ) : (
        field.label
      )}
    </TableHead>
  )
}

/**
 * The Columns checkboxes, in column order, each with a handle that moves it.
 * `required` is the identity column: it stays first and cannot be hidden.
 * Reset order appears while the order is not the default one.
 */
export function ColumnChoices({
  fields,
  selected,
  required,
  onChange,
  onOrderChange,
  onResetOrder,
}: {
  fields: readonly BrowseField[]
  selected: readonly string[]
  required: string
  onChange: (keys: string[]) => void
  onOrderChange: (keys: string[]) => void
  onResetOrder?: () => void
}) {
  return (
    <>
      <ColumnOrderList
        columns={fields}
        pinned={required}
        onMove={onOrderChange}
      >
        {(field) => (
          <label className="ds-checkrow">
            <input
              type="checkbox"
              className="ds-check"
              checked={field.key === required || selected.includes(field.key)}
              disabled={field.key === required}
              onChange={() =>
                onChange(
                  selected.includes(field.key)
                    ? selected.filter((key) => key !== field.key)
                    : [...selected, field.key],
                )
              }
            />
            {field.label}
          </label>
        )}
      </ColumnOrderList>
      {onResetOrder && (
        <div>
          <Button variant="link" size="xs" onClick={onResetOrder}>
            Reset order
          </Button>
        </div>
      )}
    </>
  )
}

/** Active filter pills followed by Clear all. */
export function ActiveFilters({
  children,
  onClear,
  className,
}: {
  children: ReactNode
  onClear: () => void
  className?: string
}) {
  return (
    <div className={`ds-rail-chips ${className ?? ''}`}>
      {children}
      <Button variant="link" size="xs" onClick={onClear}>
        Clear all
      </Button>
    </div>
  )
}

/** Active filters in the rail beside the page, or in a row above the results on phones. */
export function PlacedFilters({
  railSlot,
  children,
  onClear,
}: {
  railSlot: HTMLElement | null
  children: ReactNode
  onClear: () => void
}) {
  if (!railSlot)
    return (
      <ActiveFilters className="bi-filter-row" onClear={onClear}>
        {children}
      </ActiveFilters>
    )
  return createPortal(
    <>
      <h2 className="ds-rail-label">Filters</h2>
      <ActiveFilters onClear={onClear}>{children}</ActiveFilters>
    </>,
    railSlot,
  )
}

/** Active filters as the first section of the Filters drawer. */
export function ActiveFiltersSection({
  count,
  children,
  onClear,
}: {
  count: number
  children: ReactNode
  onClear: () => void
}) {
  return (
    <FilterPanelSection
      title="Active filters"
      icon={<Filter className="ds-i" data-size="sm" aria-hidden />}
      count={count}
      defaultOpen
    >
      <ActiveFilters onClear={onClear}>{children}</ActiveFilters>
    </FilterPanelSection>
  )
}

type CountQuery = {
  countError: boolean
  isCounting: boolean
  retryCount: () => void
}

/**
 * The toolbar count: a skeleton while counting and Retry count when it fails.
 * With `unfiltered`, a filtered count reads `12 of 128 albums`.
 */
export function BrowseItemsCount({
  query,
  total,
  unfiltered,
  noun,
}: {
  query: CountQuery
  total: number
  unfiltered?: number
  noun: { one: string; other: string }
}) {
  if (query.countError)
    return (
      <Button variant="link" size="xs" onClick={query.retryCount}>
        Retry count
      </Button>
    )
  if (query.isCounting)
    return <Skeleton className="bi-count-skeleton" width={64} height={10} />
  return formatItemCount(total, noun, unfiltered)
}

export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="xs" onClick={onClick}>
      <RefreshCw className="ds-i" data-size="sm" aria-hidden />
      Retry
    </Button>
  )
}

/**
 * Loading status, load error, and the empty and no-match states. They sit in
 * the flow above the results; loaded rows stay in place.
 */
export function BrowseItemsStates({
  query,
  total,
  noun,
  filtered,
  onClear,
  empty,
}: {
  query: {
    isError: boolean
    isFetching: boolean
    hasTotal: boolean
    retry: () => void
  }
  total: number
  noun: string
  filtered: boolean
  onClear: () => void
  /** The state shown when nothing is stored, replacing the default. */
  empty?: ReactNode
}) {
  return (
    <>
      <span className="sr-only" role="status">
        {query.isFetching ? 'Loading items' : ''}
      </span>
      {query.isError && (
        <Notice
          tone="danger"
          className="bi-notice"
          action={<RetryButton onClick={query.retry} />}
        >
          Could not load {noun}.
        </Notice>
      )}
      {query.hasTotal &&
        !query.isError &&
        total === 0 &&
        (filtered ? (
          <State
            title={`No ${noun} match`}
            action={<Button onClick={onClear}>Clear filters</Button>}
          >
            Remove a filter or clear the search.
          </State>
        ) : (
          (empty ?? <State title={`No ${noun} yet`} />)
        ))}
    </>
  )
}

/** Card artwork that opens the item; the play pair and a badge sit on top. */
export function ItemArt({
  kind,
  src,
  title,
  target,
  overlay,
  badge,
  contain = false,
}: {
  kind: ArtworkKind
  src: string | null | undefined
  title: string
  target: DetailTarget
  overlay?: ReactNode
  badge?: ReactNode
  /** Keep square artwork whole inside a wider frame. */
  contain?: boolean
}) {
  return (
    <MediaArt kind={kind} src={src} overlay={overlay} badge={badge}>
      {(image) => (
        <DetailLink
          {...target}
          className="bi-art-link"
          data-fit={contain ? 'contain' : undefined}
          aria-label={`Open details for ${title}`}
          tabIndex={-1}
        >
          {image}
        </DetailLink>
      )}
    </MediaArt>
  )
}

/** Row and table artwork that opens the item. */
export function ItemThumb({
  kind,
  src,
  title,
  target,
  contain = false,
}: {
  kind: ArtworkKind
  src: string | null | undefined
  title: string
  target: DetailTarget
  contain?: boolean
}) {
  return (
    <DetailLink
      {...target}
      className="bi-thumb-link"
      data-fit={contain ? 'contain' : undefined}
      aria-label={`Open details for ${title}`}
      tabIndex={-1}
    >
      <MediaThumb kind={kind} src={src} />
    </DetailLink>
  )
}

/** The virtual card grid: only the cards near the viewport are mounted. */
export function VirtualCards({
  height,
  padTop,
  columns,
  cardHeight,
  rowTemplate,
  children,
}: {
  height: number
  padTop: number
  columns: number
  cardHeight: number
  rowTemplate?: string
  children: ReactNode
}) {
  const layout: CSSProperties = {
    top: padTop,
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gridAutoRows: cardHeight,
    gridTemplateRows: rowTemplate,
  }
  return (
    <div className="bi-virtual" style={{ height: itemGridHeight(height) }}>
      <CardGrid className="bi-window" style={layout}>
        {children}
      </CardGrid>
    </div>
  )
}

/** The virtual list: rows near the viewport, offset by the rows above them. */
export function VirtualRows({
  height,
  padTop,
  head,
  compact = false,
  children,
}: {
  height: number
  padTop: number
  head?: ReactNode
  /** Phones: artwork, title and the play pair only. */
  compact?: boolean
  children: ReactNode
}) {
  return (
    <>
      {head && !compact && <div className="bi-listhead">{head}</div>}
      <div className="bi-virtual" style={{ height }}>
        <List className="bi-window" compact={compact} style={{ top: padTop }}>
          {children}
        </List>
      </div>
    </>
  )
}

/** A card-sized placeholder for an item still loading. */
export function CardSkeleton({ ratio }: { ratio?: ArtRatio }) {
  return (
    <div className="ds-card" aria-hidden="true" data-placeholder="">
      <Art ratio={ratio}>{null}</Art>
      <Skeleton height={12} width="80%" />
      <Skeleton height={10} width="55%" />
    </div>
  )
}

/** A list-row-sized placeholder for an item still loading. */
export function RowSkeleton({ ratio }: { ratio?: ArtRatio }) {
  return (
    <div className="ds-row" aria-hidden="true" data-placeholder="">
      <Thumb ratio={ratio}>{null}</Thumb>
      <div className="ds-row-main">
        <Skeleton height={12} width="60%" />
      </div>
    </div>
  )
}
