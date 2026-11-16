import * as React from 'react'
import { cn } from '../../lib/utils'

/**
 * The one table. Header 28px, rows 32px, identity column first, numbers
 * right-aligned. `align="end"` right-aligns a column; `sticky` pins it at the
 * given left offset and `stickyEdge` marks the last pinned column.
 */
type CellLayout = {
  align?: 'end'
  sticky?: number
  stickyEdge?: boolean
}

function cellLayout(
  { align, sticky, stickyEdge }: CellLayout,
  style: React.CSSProperties | undefined,
) {
  const offset: Record<string, string> =
    sticky === undefined ? {} : { '--ds-sticky-left': `${sticky}px` }
  return {
    'data-align': align,
    'data-sticky': sticky === undefined ? undefined : stickyEdge ? 'edge' : '',
    style: sticky === undefined ? style : { ...style, ...offset },
  }
}

export const TableScroll = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    tabIndex={0}
    className={cn('ds-table-wrap table-scroll', className)}
    {...props}
  />
))
TableScroll.displayName = 'TableScroll'

export const Table = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement> & {
    containerClassName?: string
    layout?: 'fixed'
    rows?: 'two'
  }
>(({ className, containerClassName, layout, rows, ...props }, ref) => (
  <TableScroll className={containerClassName}>
    <table
      ref={ref}
      className={cn('ds-table', className)}
      data-layout={layout}
      data-rows={rows}
      {...props}
    />
  </TableScroll>
))
Table.displayName = 'Table'

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={className} {...props} />
))
TableHeader.displayName = 'TableHeader'

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={className} {...props} />
))
TableBody.displayName = 'TableBody'

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & {
    selected?: boolean
    group?: boolean
    child?: boolean
  }
>(({ className, selected, group, child, ...props }, ref) => (
  <tr
    ref={ref}
    className={className}
    aria-selected={selected ? true : undefined}
    data-group={group ? '' : undefined}
    data-child={child ? '' : undefined}
    {...props}
  />
))
TableRow.displayName = 'TableRow'

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & CellLayout
>(({ className, align, sticky, stickyEdge, style, ...props }, ref) => (
  <th
    ref={ref}
    scope="col"
    className={className}
    {...cellLayout({ align, sticky, stickyEdge }, style)}
    {...props}
  />
))
TableHead.displayName = 'TableHead'

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & CellLayout
>(({ className, align, sticky, stickyEdge, style, ...props }, ref) => (
  <td
    ref={ref}
    className={className}
    {...cellLayout({ align, sticky, stickyEdge }, style)}
    {...props}
  />
))
TableCell.displayName = 'TableCell'

/** The sort control inside a column header. Shows an arrow only when active. */
export function TableSortButton({
  children,
  direction,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  direction?: 'asc' | 'desc'
}) {
  return (
    <button type="button" className="ds-th-sort" {...props}>
      {children}
      {direction && (
        <svg className="ds-i" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d={
              direction === 'asc'
                ? 'M12 19V5M6 11l6-6 6 6'
                : 'M12 5v14M6 13l6 6 6-6'
            }
          />
        </svg>
      )}
    </button>
  )
}

/** The bar shown under a table while rows are selected. */
export function TableSelectionBar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ds-selectbar', className)} {...props} />
}

export function TableState({
  colSpan,
  children,
  error = false,
}: {
  colSpan: number
  children: React.ReactNode
  error?: boolean
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="table-state">
        <div role={error ? 'alert' : 'status'}>{children}</div>
      </td>
    </tr>
  )
}
