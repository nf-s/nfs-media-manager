'use client'

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { z } from 'zod'
import { Columns3, Eye } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import {
  TableHead,
  TableScroll,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  sortTableRows,
  type TableSort,
  type TableValue,
} from '@/utils/secondary-table'

export type DataColumn<T> = TableColumn & {
  value: (row: T) => TableValue
  render?: (row: T) => ReactNode
  className?: string
}

/** A compact value with a full-text reveal when it is clipped. */
export function SecondaryCell({
  children,
  text,
  details,
  label = 'Show cell details',
  lines = 1,
}: {
  children: ReactNode
  text?: string
  details?: ReactNode
  label?: string
  lines?: 1 | 2
}) {
  const content = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  const fullText =
    text ??
    (typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : undefined)
  useEffect(() => {
    const element = content.current
    if (!element) return
    function measure() {
      if (!element) return
      setClipped(
        element.scrollWidth > element.clientWidth ||
          element.scrollHeight > element.clientHeight,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [children, fullText, lines])
  return (
    <div className="secondary-cell" data-lines={lines}>
      <div className="secondary-cell-text" ref={content} title={fullText}>
        {children}
      </div>
      {(details != null || (clipped && fullText)) && (
        <SecondaryCellDetails label={label}>
          {details ?? fullText}
        </SecondaryCellDetails>
      )}
    </div>
  )
}

/** Native top-layer detail surface, usable by mouse, keyboard and touch. */
export function SecondaryCellDetails({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  function cancelClose() {
    if (closing.current !== null) clearTimeout(closing.current)
    closing.current = null
  }
  function show() {
    cancelClose()
    panel.current?.showPopover()
  }
  function scheduleClose() {
    cancelClose()
    closing.current = setTimeout(() => {
      if (!pinned.current && !anchor.current?.contains(document.activeElement))
        panel.current?.hidePopover()
    }, 150)
  }
  useEffect(() => () => cancelClose(), [])
  useEffect(() => {
    if (!open) return
    function onEscape(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      pinned.current = false
      trigger.current?.focus()
      panel.current?.hidePopover()
    }
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    if (panel.current) observer.observe(panel.current)
    document.addEventListener('keydown', onEscape, true)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', onEscape, true)
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
    }
  }, [open])
  return (
    <div
      className="secondary-cell-details"
      ref={anchor}
      onMouseEnter={show}
      onMouseLeave={scheduleClose}
      onBlur={scheduleClose}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="secondary-cell-action"
        ref={trigger}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onFocus={show}
        onClick={() => {
          if (pinned.current) {
            pinned.current = false
            panel.current?.hidePopover()
          } else {
            pinned.current = true
            show()
          }
        }}
      >
        <Eye size={14} aria-hidden="true" />
      </button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="dialog"
        aria-label={label}
        className="secondary-cell-popover"
        onToggle={(event) => {
          const visible = event.newState === 'open'
          setOpen(visible)
          if (!visible) pinned.current = false
        }}
      >
        {children}
      </div>
    </div>
  )
}

export function SecondaryTableToolbar({
  search,
  filters,
  count,
  columns,
}: {
  search?: ReactNode
  filters?: ReactNode
  count?: ReactNode
  columns?: ReactNode
}) {
  const toolbar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function openPopovers() {
      return [
        ...(toolbar.current?.querySelectorAll<HTMLDetailsElement>(
          'details.toolbar-popover[open]',
        ) ?? []),
      ]
    }
    function onPointerDown(event: PointerEvent) {
      for (const popover of openPopovers())
        if (!(event.target instanceof Node && popover.contains(event.target)))
          popover.open = false
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.key !== 'Escape') return
      const popovers = openPopovers()
      if (!popovers.length) return
      const focused =
        popovers.find((popover) => popover.contains(document.activeElement)) ??
        popovers[0]
      for (const popover of popovers) popover.open = false
      event.preventDefault()
      focused?.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  if (!search && !filters && count == null && !columns) return null
  return (
    <div className="secondary-table-toolbar" ref={toolbar}>
      <div className="secondary-table-toolbar-main">
        {search && (
          <div className="secondary-table-toolbar-search">{search}</div>
        )}
        {filters && (
          <div className="secondary-table-toolbar-filters">{filters}</div>
        )}
        {count != null && (
          <span className="secondary-table-toolbar-count" role="status">
            {count}
          </span>
        )}
      </div>
      {columns && (
        <div className="secondary-table-toolbar-columns">{columns}</div>
      )}
    </div>
  )
}

/** For complete in-memory datasets. Paged tables must order in their API. */
export function SecondaryDataTable<T>({
  id,
  label,
  rows,
  columns,
  rowKey,
  defaultSort,
  empty = 'No results.',
  error = false,
  busy = false,
  className,
  search,
  filters,
  countLabel,
  totalCount,
}: {
  id: string
  label: string
  rows: readonly T[]
  columns: readonly DataColumn<T>[]
  rowKey: (row: T) => string | number
  defaultSort: TableSort
  empty?: ReactNode
  error?: boolean
  busy?: boolean
  className?: string
  search?: { label: string; placeholder?: string; value: (row: T) => string }
  filters?: ReactNode
  countLabel?: string
  totalCount?: number
}) {
  const visibility = useTableColumns(id, columns)
  const [sort, setSort] = useState(defaultSort)
  const [query, setQuery] = useState('')
  const term = query.trim().toLocaleLowerCase()
  const matching =
    search && term
      ? rows.filter((row) =>
          search.value(row).toLocaleLowerCase().includes(term),
        )
      : rows
  const shown = columns.filter((column) => visibility.visible(column.key))
  const ordered = sortTableRows(matching, sort, (row, key) =>
    columns.find((column) => column.key === key)?.value(row),
  )
  return (
    <>
      <SecondaryTableToolbar
        search={
          search && (
            <Input
              type="search"
              aria-label={search.label}
              placeholder={search.placeholder ?? search.label}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )
        }
        filters={filters}
        count={
          countLabel
            ? `${matching.length.toLocaleString()}${matching.length !== (totalCount ?? rows.length) ? ` of ${(totalCount ?? rows.length).toLocaleString()}` : ''} ${countLabel}`
            : undefined
        }
        columns={visibility.controls}
      />
      <SecondaryTableScroll
        className={className}
        role="region"
        aria-label={label}
        aria-busy={busy}
      >
        <table className="compact-table" aria-label={label}>
          <thead>
            <tr>
              {shown.map((column) => (
                <SecondaryTableHead
                  key={column.key}
                  sortKey={column.key}
                  label={column.label}
                  sortBy={sort.key}
                  direction={sort.direction}
                  className={column.className}
                  onSort={(key) =>
                    setSort({
                      key,
                      direction:
                        key === sort.key && sort.direction === 'asc'
                          ? 'desc'
                          : 'asc',
                    })
                  }
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {!ordered.length && (
              <TableState colSpan={visibility.count} error={error}>
                {term && rows.length > 0 ? 'No matching results.' : empty}
              </TableState>
            )}
            {ordered.map((row) => (
              <tr key={rowKey(row)}>
                {shown.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render ? (
                      column.render(row)
                    ) : (
                      <SecondaryCell>
                        {String(column.value(row) ?? '-')}
                      </SecondaryCell>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </SecondaryTableScroll>
    </>
  )
}

export const SecondaryTableScroll = forwardRef<
  HTMLDivElement,
  ComponentProps<typeof TableScroll>
>(({ className = '', ...props }, ref) => (
  <TableScroll
    ref={ref}
    className={`${className} secondary-table-scroll`.trim()}
    {...props}
  />
))
SecondaryTableScroll.displayName = 'SecondaryTableScroll'

export function SecondaryTableHead<Key extends string>({
  sortKey,
  label,
  sortBy,
  direction,
  onSort,
  className,
  disabled,
  children,
}: {
  sortKey: Key
  label: string
  sortBy: Key
  direction: 'asc' | 'desc'
  onSort: (key: Key) => void
  className?: string
  disabled?: boolean
  children?: ReactNode
}) {
  const active = sortKey === sortBy
  return (
    <TableHead
      className={className}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        className="max-w-full truncate"
        disabled={disabled}
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
      >
        {label}
        <span aria-hidden="true">
          {active ? (direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
        </span>
      </button>
      {children}
    </TableHead>
  )
}

export type TableColumn = {
  key: string
  label: string
  defaultVisible?: boolean
  required?: boolean
}

const HiddenColumnsSchema = z.array(z.string())

export function useTableColumns(
  storageKey: string,
  columns: readonly TableColumn[],
) {
  const configurable = columns.length > 3
  const key = `secondary-table:${storageKey}:hidden`
  const [saved, setSaved] = useState<{ key: string; hidden: string[] } | null>(
    null,
  )
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key)
      const parsed = HiddenColumnsSchema.safeParse(raw ? JSON.parse(raw) : null)
      setSaved(parsed.success ? { key, hidden: parsed.data } : null)
    } catch {
      setSaved(null)
    }
  }, [key])
  const defaults = columns
    .filter((column) => column.defaultVisible === false && !column.required)
    .map((column) => column.key)
  const candidate = saved?.key === key ? saved.hidden : defaults
  const hidden = columns.every(
    (column) => !column.required && candidate.includes(column.key),
  )
    ? defaults
    : candidate
  const visible = (columnKey: string) =>
    columns.some(
      (column) =>
        column.key === columnKey &&
        (!configurable || column.required || !hidden.includes(columnKey)),
    )
  const count = columns.filter((column) => visible(column.key)).length
  function save(next: string[]) {
    setSaved({ key, hidden: next })
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      // Column controls remain usable when browser storage is unavailable.
    }
  }
  return {
    visible,
    count,
    controls: configurable ? (
      <TableColumns
        columns={columns}
        visible={visible}
        count={count}
        onToggle={(columnKey) =>
          save(
            visible(columnKey)
              ? [...hidden, columnKey]
              : hidden.filter((item) => item !== columnKey),
          )
        }
        onReset={() => save(defaults)}
      />
    ) : null,
  }
}

function TableColumns({
  columns,
  visible,
  count,
  onToggle,
  onReset,
}: {
  columns: readonly TableColumn[]
  visible: (key: string) => boolean
  count: number
  onToggle: (key: string) => void
  onReset: () => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.right - box.width, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  return (
    <div className="table-column-controls">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="table-columns-trigger"
        ref={trigger}
        popoverTarget={id}
        aria-expanded={open}
        aria-controls={id}
      >
        <Columns3 size={14} aria-hidden="true" /> Columns
      </Button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="group"
        aria-label="Visible columns"
        className="table-columns-panel"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            panel.current?.hidePopover()
            trigger.current?.focus()
          }
        }}
      >
        {columns.map((column) => (
          <label key={column.key}>
            <input
              type="checkbox"
              checked={visible(column.key)}
              disabled={column.required || (count === 1 && visible(column.key))}
              onChange={() => onToggle(column.key)}
            />
            {column.label}
          </label>
        ))}
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          Reset columns
        </Button>
      </div>
    </div>
  )
}
