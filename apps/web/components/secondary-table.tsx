'use client'

import {
  Fragment,
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { z } from 'zod'
import {
  Columns3,
  Eye,
  Filter,
  Info,
  Search,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'
import {
  TableCell,
  TableColumns,
  TableHead,
  TableRow,
  TableScroll,
  TableSelectionBar,
  TableSortButton,
  TableState,
  columnsWidth,
} from '@repo/ui/components/ui/table'
import {
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import { EMPTY_VALUE, formatCount } from '@repo/ui/lib/format'
import {
  sortTableRows,
  type TableSort,
  type TableValue,
} from '@/utils/secondary-table'
import { orderColumns } from '@/utils/browse-items'
import {
  defaultColumnWidth,
  tableColumnLayout,
  tableWidthLimits,
} from '@/utils/column-widths'
import { useColumnWidths } from '@/hooks/useColumnWidths'
import { ColumnOrderList } from './column-order'

/** Column placement in the one table: right-aligned numbers and pinned identity. */
export type ColumnLayout = {
  align?: 'end'
  sticky?: number
  stickyEdge?: boolean
}

type DataColumn<T> = TableColumn &
  ColumnLayout & {
    value: (row: T) => TableValue
    sortable?: boolean
    render?: (row: T, orderedRows: readonly T[]) => ReactNode
    className?: string
    filter?: ReactNode
  }

/** The plain value of a cell: counts with separators, an en dash when empty. */
export function formatTableValue(value: TableValue): string {
  if (value == null || value === '') return EMPTY_VALUE
  if (typeof value === 'number')
    return Number.isFinite(value) ? formatCount(value) : EMPTY_VALUE
  return String(value)
}

/** The design-system search field for table toolbars. */
export function SecondaryTableSearch({
  label,
  placeholder,
  value,
  onChange,
  disabled,
  maxLength,
}: {
  label: string
  placeholder?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  maxLength?: number
}) {
  return (
    <label className="ds-search">
      <Search className="ds-i" data-size="sm" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/** A compact value with a full-text reveal when it is clipped. */
export function SecondaryCell({
  children,
  text,
  details,
  label = 'Show cell details',
  lines = 1,
  tone = 'info',
}: {
  children: ReactNode
  text?: string
  details?: ReactNode
  label?: string
  lines?: 1 | 2
  tone?: 'info' | 'warning'
}) {
  const content = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  const fullText =
    text ??
    (typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : undefined)
  const additionalDetails =
    details != null &&
    (typeof details !== 'string' || details.trim() !== fullText?.trim())
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
      {(additionalDetails || (clipped && fullText)) && (
        <SecondaryCellDetails label={label} tone={tone}>
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
  buttonText,
  tone = 'info',
  icon = 'info',
}: {
  children: ReactNode | (() => ReactNode)
  label: string
  buttonText?: string
  tone?: 'info' | 'warning'
  icon?: 'info' | 'eye'
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
      onMouseEnter={buttonText ? undefined : show}
      onMouseLeave={buttonText ? undefined : scheduleClose}
      onBlur={buttonText ? undefined : scheduleClose}
      onClick={(event) => event.stopPropagation()}
    >
      {buttonText ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          ref={trigger}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={id}
          popoverTarget={id}
        >
          {buttonText}
        </Button>
      ) : (
        <button
          type="button"
          className="secondary-cell-action"
          data-tone={tone}
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
          {tone === 'warning' ? (
            <TriangleAlert size={14} aria-hidden="true" />
          ) : icon === 'eye' ? (
            <Eye size={14} aria-hidden="true" />
          ) : (
            <Info size={14} aria-hidden="true" />
          )}
        </button>
      )}
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
        {typeof children === 'function' ? (open ? children() : null) : children}
      </div>
    </div>
  )
}

/** An attached footer stays visible outside the table's scrolling rows. */
export function SecondaryTableFrame({ children }: { children: ReactNode }) {
  return <div className="secondary-table-frame">{children}</div>
}

/**
 * The design-system selection bar under a table: the count on the left and
 * the actions after it. Children use the shared buttons, which the bar
 * restyles for the inverse surface.
 */
export function SecondaryTableSelectionBar({
  children,
  selectedCount,
  total,
  hideWhenEmpty = false,
}: {
  children?: ReactNode
  selectedCount: number
  total?: number
  /** Leave out the count at zero, so a bar with nothing else in it is hidden. */
  hideWhenEmpty?: boolean
}) {
  return (
    <TableSelectionBar className="sec-selectbar">
      {(selectedCount > 0 || !hideWhenEmpty) && (
        <span role="status">
          <b>{formatCount(selectedCount)} selected</b>
          {total !== undefined && (
            <span className="ds-muted"> of {formatCount(total)}</span>
          )}
        </span>
      )}
      {children}
    </TableSelectionBar>
  )
}

/** Top-layer filters stay usable inside scrolling tables and sticky headers. */
export function SecondaryHeaderFilter({
  label,
  active = false,
  disabled = false,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  children: ReactNode
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
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      panel.current?.hidePopover()
      trigger.current?.focus()
    }
    position()
    panel.current
      ?.querySelector<HTMLElement>(
        'input:not(:disabled), button:not(:disabled), select:not(:disabled)',
      )
      ?.focus()
    const observer = new ResizeObserver(position)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    document.addEventListener('keydown', onEscape, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      document.removeEventListener('keydown', onEscape, true)
    }
  }, [open])
  return (
    <span className="secondary-header-filter">
      <button
        ref={trigger}
        type="button"
        className="secondary-cell-action"
        data-active={active || undefined}
        disabled={disabled}
        aria-label={`Filter ${label}`}
        title={`Filter ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => panel.current?.togglePopover()}
      >
        <Filter size={13} aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={`Filter ${label}`}
        className="secondary-header-filter-popover"
        onToggle={(event) => setOpen(event.newState === 'open')}
      >
        {children}
      </div>
    </span>
  )
}

export type ColumnFilterProps<Value extends string> = {
  label: string
  options: readonly { value: Value; label: string }[]
  value: readonly Value[]
  onChange: (next: Value[]) => void
  disabled?: boolean
}

export function ColumnFilterOptions<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  showLegend = true,
}: ColumnFilterProps<Value> & { showLegend?: boolean }) {
  return (
    <fieldset
      className="secondary-filter-options"
      aria-label={showLegend ? undefined : label}
      disabled={disabled}
    >
      {showLegend && <legend>{label}</legend>}
      <button
        type="button"
        disabled={!value.length}
        onClick={() => onChange([])}
      >
        All values
      </button>
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="checkbox"
            checked={value.includes(option.value)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, option.value]
                  : value.filter((item) => item !== option.value),
              )
            }
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

export function SecondaryColumnFilter<Value extends string>(
  props: ColumnFilterProps<Value>,
) {
  return (
    <SecondaryHeaderFilter
      label={props.label}
      active={props.value.length > 0}
      disabled={props.disabled}
    >
      <ColumnFilterOptions {...props} />
    </SecondaryHeaderFilter>
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
          'details.browse-popover[open]',
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
    <Toolbar ref={toolbar}>
      {search}
      {filters}
      {count != null && <ToolbarCount>{count}</ToolbarCount>}
      {columns && <ToolbarEnd>{columns}</ToolbarEnd>}
    </Toolbar>
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
  view,
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
  search?: {
    label: string
    placeholder?: string
    maxLength?: number
    value: (row: T) => string
  }
  filters?: ReactNode
  countLabel?: string
  totalCount?: number
  /** Optional URL-owned search and sort state. Other tables keep their local state. */
  view?: {
    sort: TableSort
    query: string
    onChange: (next: { sort: TableSort; query: string }) => void
  }
}) {
  const visibility = useTableColumns(id, columns, { reorder: true })
  const [localSort, setLocalSort] = useState(defaultSort)
  const [localQuery, setLocalQuery] = useState('')
  const sort = view?.sort ?? localSort
  const query = view?.query ?? localQuery
  function setSort(next: TableSort) {
    if (view) view.onChange({ sort: next, query })
    else setLocalSort(next)
  }
  function setQuery(next: string) {
    if (view) view.onChange({ sort, query: next })
    else setLocalQuery(next)
  }
  const term = query.trim().toLocaleLowerCase()
  const matching =
    search && term
      ? rows.filter((row) =>
          search.value(row).toLocaleLowerCase().includes(term),
        )
      : rows
  const shown = visibility
    .order(columns)
    .filter((column) => visibility.visible(column.key))
  const ordered = sortTableRows(matching, sort, (row, key) =>
    columns.find((column) => column.key === key)?.value(row),
  )
  const total = totalCount ?? rows.length
  const layout = visibility.layout(shown.map((column) => column.key))
  const hasToolbar =
    Boolean(search) ||
    Boolean(filters) ||
    Boolean(countLabel) ||
    Boolean(visibility.controls)
  return (
    <>
      {hasToolbar && (
        <Toolbar>
          {search && (
            <SecondaryTableSearch
              label={search.label}
              placeholder={search.placeholder}
              maxLength={search.maxLength}
              value={query}
              onChange={setQuery}
            />
          )}
          {filters}
          {countLabel && (
            <ToolbarCount>
              {formatCount(matching.length)}
              {matching.length !== total
                ? ` of ${formatCount(total)}`
                : ''}{' '}
              {countLabel}
            </ToolbarCount>
          )}
          {visibility.controls && (
            <ToolbarEnd>{visibility.controls}</ToolbarEnd>
          )}
        </Toolbar>
      )}
      <SecondaryTableScroll
        className={className}
        role="region"
        aria-label={label}
        aria-busy={busy}
      >
        <table className="ds-table" aria-label={label} {...layout.table}>
          {layout.colgroup}
          <thead>
            <tr>
              {shown.map((column) =>
                column.sortable === false ? (
                  <TableHead
                    key={column.key}
                    className={column.className}
                    align={column.align}
                    sticky={column.sticky}
                    stickyEdge={column.stickyEdge}
                    resizer={visibility.resizer(column.key)}
                  >
                    {column.label}
                  </TableHead>
                ) : (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    sortBy={sort.key}
                    direction={sort.direction}
                    className={column.className}
                    align={column.align}
                    sticky={column.sticky}
                    stickyEdge={column.stickyEdge}
                    filter={column.filter}
                    resizer={visibility.resizer(column.key)}
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
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {!ordered.length && (
              <TableState colSpan={visibility.count} error={error}>
                {term && rows.length > 0 ? 'No matching results.' : empty}
              </TableState>
            )}
            {ordered.map((row) => (
              <TableRow key={rowKey(row)}>
                {shown.map((column) => (
                  <TableCell
                    key={column.key}
                    className={column.className}
                    align={column.align}
                    sticky={column.sticky}
                    stickyEdge={column.stickyEdge}
                  >
                    {column.render ? (
                      column.render(row, ordered)
                    ) : (
                      <SecondaryCell>
                        {formatTableValue(column.value(row))}
                      </SecondaryCell>
                    )}
                  </TableCell>
                ))}
              </TableRow>
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

/** Keep a table's complete height while rendering only its current window. */
export type SecondaryVirtualWindow<Item> = {
  slots: readonly { index: number; item: Item | undefined }[]
  padTop: number
  padBottom: number
  rowHeight: number
}

export function SecondaryVirtualRows<Item>({
  window,
  colSpan,
  renderRow,
}: {
  window: SecondaryVirtualWindow<Item>
  colSpan: number
  renderRow: (item: Item, index: number) => ReactNode
}) {
  const { slots, padTop, padBottom, rowHeight } = window
  return (
    <>
      {padTop > 0 && (
        <tr aria-hidden="true">
          <td
            colSpan={colSpan}
            style={{ height: padTop, padding: 0, border: 0 }}
          />
        </tr>
      )}
      {slots.map(({ item, index }) =>
        item === undefined ? (
          <tr
            key={`slot-${index}`}
            className="virtual-browse-placeholder"
            aria-hidden="true"
          >
            {Array.from({ length: colSpan }, (_, column) => (
              <td key={column} style={{ height: rowHeight }}>
                <div className="virtual-browse-line virtual-browse-shimmer" />
              </td>
            ))}
          </tr>
        ) : (
          <Fragment key={index}>{renderRow(item, index)}</Fragment>
        ),
      )}
      {padBottom > 0 && (
        <tr aria-hidden="true">
          <td
            colSpan={colSpan}
            style={{ height: padBottom, padding: 0, border: 0 }}
          />
        </tr>
      )}
    </>
  )
}

export function SecondaryTableHead<Key extends string>({
  sortKey,
  label,
  sortBy,
  direction,
  onSort,
  className,
  disabled,
  children,
  filter,
  resizer,
  align,
  sticky,
  stickyEdge,
}: {
  sortKey: Key
  label: string
  sortBy: Key
  direction: 'asc' | 'desc'
  onSort: (key: Key) => void
  className?: string
  disabled?: boolean
  children?: ReactNode
  filter?: ReactNode
  /** The column's width handle, from `useTableColumns().resizer`. */
  resizer?: HTMLAttributes<HTMLSpanElement>
} & ColumnLayout) {
  const active = sortKey === sortBy
  return (
    <TableHead
      className={className}
      align={align}
      sticky={sticky}
      stickyEdge={stickyEdge}
      aria-sort={
        active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
      resizer={resizer}
    >
      <div className="secondary-table-heading">
        <TableSortButton
          direction={active ? direction : undefined}
          disabled={disabled}
          onClick={() => onSort(sortKey)}
          title={`Sort by ${label}`}
        >
          {label}
        </TableSortButton>
        {filter}
      </div>
      {children}
    </TableHead>
  )
}

export type TableColumn = {
  key: string
  label: string
  defaultVisible?: boolean
  required?: boolean
  /** The default width in pixels. The reader can change it; it is saved per table. */
  width?: number
  /** `false` for a column of row actions: it keeps its width and has no handle. */
  resizable?: false
  /**
   * This column takes the room left in the table, in place of the last one.
   * Set it on the identity column when the last column is a number, a date or
   * a status.
   */
  fill?: boolean
}

/**
 * The props and colgroup of a fixed-layout table. `entries` are the displayed
 * columns in order: a key, or a pixel width for a column that cannot be
 * resized. Every column keeps its width except the one that takes the room
 * that is left: `fill` when it is displayed, otherwise the last keyed one.
 */
export function fixedTableLayout(
  entries: readonly (string | number)[],
  widthFor: (key: string) => number,
  fill?: string,
) {
  const { widths, sizes } = tableColumnLayout(entries, widthFor, fill)
  const table: { 'data-layout': 'fixed'; style: { minWidth: string } } = {
    'data-layout': 'fixed',
    style: { minWidth: columnsWidth(sizes) },
  }
  return { table, colgroup: <TableColumns widths={widths} /> }
}

/**
 * A table's column widths, kept in browser storage and changed with the handle
 * on each header. `layout` takes the displayed columns in order, a key for each
 * of `columns` and a pixel width for each column that is not one of them
 * (selection, artwork), and returns the table's `fixedTableLayout`. `resizer`
 * gives a column's header its width handle.
 */
export function useTableWidths(
  storageKey: string,
  columns: readonly TableColumn[],
) {
  const widths = useColumnWidths(
    `table:${storageKey}`,
    (column: TableColumn) => column.width ?? defaultColumnWidth,
    undefined,
    tableWidthLimits,
  )
  function column(columnKey: string): TableColumn {
    return (
      columns.find((item) => item.key === columnKey) ?? {
        key: columnKey,
        label: columnKey,
      }
    )
  }
  const widthFor = (columnKey: string) => widths.widthFor(column(columnKey))
  function layout(entries: readonly (string | number)[]) {
    return fixedTableLayout(
      entries.map((entry) =>
        typeof entry === 'string' && column(entry).resizable === false
          ? widthFor(entry)
          : entry,
      ),
      widthFor,
      columns.find((item) => item.fill)?.key,
    )
  }
  function resizer(columnKey: string) {
    const item = column(columnKey)
    return item.resizable === false ? undefined : widths.resizer(item)
  }
  return { layout, resizer, reset: widths.reset }
}

const HiddenColumnsSchema = z.array(z.string())

function readSavedKeys(key: string) {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = HiddenColumnsSchema.safeParse(raw ? JSON.parse(raw) : null)
    return parsed.success ? { key, keys: parsed.data } : null
  } catch {
    return null
  }
}

/**
 * Which columns a table shows and how wide they are, kept in browser storage.
 * With `reorder`, the picker also moves columns and `order` puts a table's
 * columns in the chosen order; the first column is the identity column and
 * stays first. A table that renders its cells one by one leaves `reorder` off.
 * `layout` and `resizer` are the table's `useTableWidths`; Reset columns also
 * returns every column to its default width.
 */
export function useTableColumns(
  storageKey: string,
  columns: readonly TableColumn[],
  { reorder = false }: { reorder?: boolean } = {},
) {
  const configurable = columns.length > 3
  const key = `secondary-table:${storageKey}:hidden`
  const orderKey = `secondary-table:${storageKey}:order`
  const [saved, setSaved] = useState<{ key: string; hidden: string[] } | null>(
    null,
  )
  const [savedOrder, setSavedOrder] = useState<{
    key: string
    keys: string[]
  } | null>(null)
  useEffect(() => {
    const read = readSavedKeys(key)
    setSaved(read ? { key, hidden: read.keys } : null)
  }, [key])
  useEffect(() => {
    setSavedOrder(readSavedKeys(orderKey))
  }, [orderKey])
  const widths = useTableWidths(storageKey, columns)
  const pinned = columns[0]?.key
  const customOrder =
    configurable && reorder && savedOrder?.key === orderKey
      ? savedOrder.keys
      : null
  function order<Column extends { key: string }>(
    items: readonly Column[],
  ): Column[] {
    return orderColumns(items, customOrder, pinned)
  }
  function saveOrder(next: string[] | null) {
    setSavedOrder(next ? { key: orderKey, keys: next } : null)
    try {
      if (next) window.localStorage.setItem(orderKey, JSON.stringify(next))
      else window.localStorage.removeItem(orderKey)
    } catch {
      // Column order remains usable when browser storage is unavailable.
    }
  }
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
  const choice = (column: TableColumn) => (
    <label key={column.key}>
      <input
        type="checkbox"
        checked={visible(column.key)}
        disabled={column.required || (count === 1 && visible(column.key))}
        onChange={() =>
          save(
            visible(column.key)
              ? [...hidden, column.key]
              : hidden.filter((item) => item !== column.key),
          )
        }
      />
      {column.label}
    </label>
  )
  const options = configurable ? (
    <>
      {reorder ? (
        <ColumnOrderList
          columns={order(columns)}
          pinned={pinned}
          onMove={(keys) =>
            saveOrder(
              keys.join(',') === columns.map((column) => column.key).join(',')
                ? null
                : keys,
            )
          }
        >
          {choice}
        </ColumnOrderList>
      ) : (
        columns.map(choice)
      )}
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          save(defaults)
          saveOrder(null)
          widths.reset()
        }}
      >
        Reset columns
      </Button>
    </>
  ) : null
  return {
    visible,
    count,
    order,
    layout: widths.layout,
    resizer: widths.resizer,
    options,
    controls: options ? <ColumnsMenu>{options}</ColumnsMenu> : null,
  }
}

function ColumnsMenu({ children }: { children: ReactNode }) {
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
        {children}
      </div>
    </div>
  )
}
