import * as React from 'react'
import { cn } from '../../lib/utils'

/**
 * The one table. Header 28px, rows 32px, identity column first, numbers
 * right-aligned. `align="end"` right-aligns a column; `sticky` pins it at the
 * given left offset and `stickyEdge` marks the last left-pinned column.
 * `stickyEnd` pins a trailing action column to the right.
 *
 * Column widths: `layout="fixed"` with `TableColumns` gives every column a set
 * width, so loading rows never move the columns. A header's `resizer` is the
 * handle on its right edge that changes that column's width.
 */
type CellLayout = {
  align?: 'end'
  sticky?: number
  stickyEdge?: boolean
  stickyEnd?: boolean
}

function cellLayout(
  { align, sticky, stickyEdge, stickyEnd }: CellLayout,
  style: React.CSSProperties | undefined,
) {
  const offset: Record<string, string> =
    sticky === undefined ? {} : { '--ds-sticky-left': `${sticky}px` }
  const pinned = sticky === undefined ? undefined : stickyEdge ? 'edge' : ''
  return {
    'data-align': align,
    'data-sticky': stickyEnd ? 'end' : pinned,
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

/**
 * The widths of a `layout="fixed"` table's columns, in pixels and in column
 * order. A column without a width takes the room that is left.
 */
export function TableColumns({
  widths,
}: {
  widths: readonly (number | undefined)[]
}) {
  return (
    <colgroup>
      {widths.map((width, index) => (
        <col key={index} style={{ width }} />
      ))}
    </colgroup>
  )
}

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

/**
 * A table row. `group` is a heading row over child rows. `depth` nests a
 * child row: its first cell is indented by one step per level. `child` is
 * depth 1.
 */
export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & {
    selected?: boolean
    group?: boolean
    child?: boolean
    depth?: number
  }
>(({ className, selected, group, child, depth, style, ...props }, ref) => {
  const nested = depth !== undefined && depth > 0
  const nesting: Record<string, number> = nested ? { '--ds-depth': depth } : {}
  return (
    <tr
      ref={ref}
      className={className}
      aria-selected={selected ? true : undefined}
      data-group={group ? '' : undefined}
      data-child={(depth === undefined ? child : nested) ? '' : undefined}
      style={nested ? { ...style, ...nesting } : style}
      {...props}
    />
  )
})
TableRow.displayName = 'TableRow'

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'align'> &
    CellLayout & {
      /** The width handle: a separator with pointer and arrow-key handlers. */
      resizer?: React.HTMLAttributes<HTMLSpanElement>
    }
>(
  (
    {
      className,
      align,
      sticky,
      stickyEdge,
      stickyEnd,
      style,
      resizer,
      children,
      ...props
    },
    ref,
  ) => (
    <th
      ref={ref}
      scope="col"
      className={className}
      {...cellLayout({ align, sticky, stickyEdge, stickyEnd }, style)}
      {...props}
    >
      {children}
      {resizer && <span className="ds-th-resizer" {...resizer} />}
    </th>
  ),
)
TableHead.displayName = 'TableHead'

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  Omit<React.TdHTMLAttributes<HTMLTableCellElement>, 'align'> & CellLayout
>(
  (
    { className, align, sticky, stickyEdge, stickyEnd, style, ...props },
    ref,
  ) => (
    <td
      ref={ref}
      className={className}
      {...cellLayout({ align, sticky, stickyEdge, stickyEnd }, style)}
      {...props}
    />
  ),
)
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
