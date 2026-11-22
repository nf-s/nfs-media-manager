import * as React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './button'

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
 * A column's width as CSS: its own width in pixels, and never more than
 * `--ds-col-max` where the table sets one. On a phone that keeps one column,
 * above all the pinned first one, from taking the screen.
 */
export function columnWidth(width: number) {
  return `min(${width}px, var(--ds-col-max, ${width}px))`
}

/** The width of a table whose columns are `widths` wide, as CSS. */
export function columnsWidth(widths: readonly number[]) {
  return widths.length ? `calc(${widths.map(columnWidth).join(' + ')})` : '0px'
}

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
        <col
          key={index}
          style={{
            width: width === undefined ? undefined : columnWidth(width),
          }}
        />
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
 * depth 1. `part` is one part of the record in the row above it, shown
 * while that record's `TablePartToggle` is open.
 */
export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  // The HTML `part` attribute gives way to the part row.
  Omit<React.HTMLAttributes<HTMLTableRowElement>, 'part'> & {
    selected?: boolean
    group?: boolean
    child?: boolean
    depth?: number
    part?: boolean
  }
>(
  (
    { className, selected, group, child, depth, part, style, ...props },
    ref,
  ) => {
    const nested = depth !== undefined && depth > 0
    const nesting: Record<string, number> = nested
      ? { '--ds-depth': depth }
      : {}
    return (
      <tr
        ref={ref}
        className={className}
        aria-selected={selected ? true : undefined}
        data-group={group ? '' : undefined}
        data-child={(depth === undefined ? child : nested) ? '' : undefined}
        data-part={part ? '' : undefined}
        style={nested ? { ...style, ...nesting } : style}
        {...props}
      />
    )
  },
)
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

/**
 * The chevron at the start of a record's identity cell that shows or hides
 * the rows of what the record is made of (`TableRow part`). `label` is the
 * button's accessible name for the current state.
 */
export function TablePartToggle({
  open,
  label,
  onOpenChange,
  className,
  ...props
}: Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'onClick' | 'aria-expanded' | 'aria-label'
> & {
  open: boolean
  label: string
  onOpenChange: (open: boolean) => void
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon
      className={cn('ds-part-toggle', className)}
      aria-expanded={open}
      aria-label={label}
      onClick={() => onOpenChange(!open)}
      {...props}
    >
      <Chevron className="ds-i" data-size="sm" aria-hidden />
    </Button>
  )
}

/** The chevron's space, in an identity cell that has no parts to show. */
export function TablePartSlot() {
  return <span className="ds-part-slot" aria-hidden />
}

/**
 * The identity cell of a part row: indented under the record's title, a
 * provider mark (`ProviderMark`) and the part's title, cut short.
 */
export function TablePartTitle({
  mark,
  children,
}: {
  mark: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <span className="ds-cell-id ds-part-title">
      {mark}
      <span className="ds-truncate">{children}</span>
    </span>
  )
}

/**
 * The content of a group row that carries actions (`TableRow group`, one
 * cell across the table): small buttons, then one line about the group when
 * there is something to say, cut short and shown in full on hover.
 */
export function TableGroupActions({
  evidence,
  children,
}: {
  evidence: string
  children: React.ReactNode
}) {
  return (
    <span className="ds-group-actions">
      {children}
      {evidence && (
        <span className="ds-group-evidence" title={evidence}>
          {evidence}
        </span>
      )}
    </span>
  )
}

/** The bar shown under a table while rows are selected. */
export function TableSelectionBar({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ds-selectbar', className)} {...props} />
}

/** What the last action from the selection bar changed, shown in the bar. */
export function TableSelectionResult({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <span className="ds-selectbar-result" role="status">
      {icon}
      <span>{children}</span>
    </span>
  )
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
