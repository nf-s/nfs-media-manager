import * as React from 'react'
import { cn } from '../../lib/utils'

export const TableScroll = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    tabIndex={0}
    className={cn('table-scroll', className)}
    {...props}
  />
))
TableScroll.displayName = 'TableScroll'

export const Table = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement> & {
    containerClassName?: string
  }
>(({ className, containerClassName, ...props }, ref) => (
  <TableScroll className={containerClassName}>
    <table ref={ref} className={cn('compact-table', className)} {...props} />
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
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr ref={ref} className={className} {...props} />
))
TableRow.displayName = 'TableRow'

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th ref={ref} scope="col" className={className} {...props} />
))
TableHead.displayName = 'TableHead'

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={className} {...props} />
))
TableCell.displayName = 'TableCell'

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
