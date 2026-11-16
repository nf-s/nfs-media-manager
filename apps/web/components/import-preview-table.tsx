'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  formatTableValue,
  SecondaryCell,
  SecondaryColumnFilter,
  SecondaryTableFrame,
  SecondaryTableHead,
  SecondaryTableScroll,
  SecondaryTableSearch,
  SecondaryTableSelectionBar,
  SecondaryVirtualRows,
  useTableColumns,
} from './secondary-table'
import {
  sortTableRows,
  type TableSort,
  type TableValue,
} from '@/utils/secondary-table'
import {
  TableCell,
  TableHead,
  TableRow,
  TableState,
} from '@repo/ui/components/ui/table'
import {
  Toolbar,
  ToolbarCount,
  ToolbarEnd,
} from '@repo/ui/components/ds/toolbar'
import { formatItemCount } from '@repo/ui/lib/format'
import { useVirtualRows } from '@/hooks/useVirtualTable'
import { updateJobSelection } from '@/utils/job-selection'

const ITEMS = { one: 'item', other: 'items' }
/** Width of the selection column; the first data column is pinned after it. */
const CHECK_WIDTH = 36

export type ImportPreviewFilter<Item> = {
  key: string
  label: string
  matches: (item: Item) => boolean
}

export function filterImportPreviewItems<Item>(
  items: readonly Item[],
  search: string,
  filter: readonly string[],
  filters: readonly ImportPreviewFilter<Item>[],
  searchValue: (item: Item) => string,
): Item[] {
  const term = search.trim().toLocaleLowerCase()
  const selectedFilters = filters.filter((option) =>
    filter.includes(option.key),
  )
  return items.filter(
    (item) =>
      (!term || searchValue(item).toLocaleLowerCase().includes(term)) &&
      (!selectedFilters.length ||
        selectedFilters.some((option) => option.matches(item))),
  )
}

export default function ImportPreviewTable<
  Item extends { row: number; title: string },
>({
  items,
  selected,
  onChange,
  disabled,
  actionable,
  columns,
  storageKey,
  filters = [],
  filterColumn,
  footer,
  searchValue,
}: {
  items: Item[]
  selected: number[]
  onChange: (rows: number[]) => void
  disabled: boolean
  actionable: (item: Item) => boolean
  storageKey: string
  filters?: readonly ImportPreviewFilter<Item>[]
  filterColumn?: string
  footer?: ReactNode
  searchValue?: (item: Item) => string
  columns: {
    key: string
    label: string
    value: (item: Item) => TableValue
    render?: (item: Item) => ReactNode
    defaultVisible?: boolean
    align?: 'end'
  }[]
}) {
  const visibility = useTableColumns(storageKey, columns)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string[]>([])
  const [sort, setSort] = useState<TableSort>({ key: 'row', direction: 'asc' })
  const filtered = filterImportPreviewItems(
    items,
    search,
    filter,
    filters,
    searchValue ??
      ((item) => columns.map((column) => column.value(item)).join(' ')),
  )
  const ordered = sortTableRows(filtered, sort, (item, key) =>
    key === 'row'
      ? item.row
      : columns.find((column) => column.key === key)?.value(item),
  )
  const [anchor, setAnchor] = useState<string | null>(null)
  const all = useRef<HTMLInputElement>(null)
  const ids = ordered.filter(actionable).map((item) => String(item.row))
  const selection = selected.map(String)
  const checked = ids.length > 0 && ids.every((id) => selection.includes(id))
  const preview = useVirtualRows({
    rows: ordered,
    identity: JSON.stringify([sort.key, sort.direction, search, filter]),
  })
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        !checked && ids.some((id) => selection.includes(id))
  }, [checked, ids, selection])
  function clearSelection() {
    onChange([])
    setAnchor(null)
  }
  const shown = columns.filter((column) => visibility.visible(column.key))
  return (
    <>
      <Toolbar>
        <SecondaryTableSearch
          label="Search preview"
          value={search}
          disabled={disabled}
          onChange={(value) => {
            setSearch(value)
            clearSelection()
          }}
        />
        <ToolbarCount>
          {formatItemCount(filtered.length, ITEMS, items.length)}
        </ToolbarCount>
        {visibility.controls && <ToolbarEnd>{visibility.controls}</ToolbarEnd>}
      </Toolbar>
      <SecondaryTableFrame>
        <SecondaryTableScroll
          ref={preview.scroller}
          onScroll={preview.onScroll}
          role="region"
          aria-label="Import preview"
        >
          <table className="ds-table" aria-label="Import preview">
            <thead>
              <tr>
                <TableHead className="sec-check-cell" sticky={0}>
                  <input
                    ref={all}
                    type="checkbox"
                    className="ds-check"
                    aria-label="Select all preview items"
                    checked={checked}
                    disabled={disabled || !ids.length}
                    onChange={(event) => {
                      onChange(event.target.checked ? ids.map(Number) : [])
                      setAnchor(null)
                    }}
                  />
                </TableHead>
                {shown.map((column, index) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
                    align={column.align}
                    sticky={index === 0 ? CHECK_WIDTH : undefined}
                    stickyEdge={index === 0}
                    filter={
                      column.key === filterColumn && filters.length ? (
                        <SecondaryColumnFilter
                          label="Import status"
                          options={filters.map((option) => ({
                            value: option.key,
                            label: option.label,
                          }))}
                          value={filter}
                          disabled={disabled}
                          onChange={(value) => {
                            setFilter(value)
                            clearSelection()
                          }}
                        />
                      ) : undefined
                    }
                    sortBy={sort.key}
                    direction={sort.direction}
                    onSort={(key) => {
                      setSort({
                        key,
                        direction:
                          key === sort.key && sort.direction === 'asc'
                            ? 'desc'
                            : 'asc',
                      })
                      setAnchor(null)
                    }}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {!ordered.length && (
                <TableState colSpan={visibility.count + 1}>
                  {items.length ? 'No items match.' : 'No items to import.'}
                </TableState>
              )}
              <SecondaryVirtualRows
                window={preview}
                colSpan={visibility.count + 1}
                renderRow={(item) => (
                  <TableRow
                    key={item.row}
                    selected={selected.includes(item.row)}
                  >
                    <TableCell className="sec-check-cell" sticky={0}>
                      <input
                        type="checkbox"
                        className="ds-check"
                        aria-label={`Import ${item.title}`}
                        checked={selected.includes(item.row)}
                        disabled={disabled || !actionable(item)}
                        onChange={(event) => {
                          onChange(
                            updateJobSelection(
                              selection,
                              ids,
                              String(item.row),
                              anchor,
                              'shiftKey' in event.nativeEvent &&
                                event.nativeEvent.shiftKey === true,
                              event.target.checked,
                            ).map(Number),
                          )
                          setAnchor(String(item.row))
                        }}
                      />
                    </TableCell>
                    {shown.map((column, index) => (
                      <TableCell
                        key={column.key}
                        align={column.align}
                        sticky={index === 0 ? CHECK_WIDTH : undefined}
                        stickyEdge={index === 0}
                      >
                        {column.render ? (
                          column.render(item)
                        ) : (
                          <SecondaryCell>
                            {formatTableValue(column.value(item))}
                          </SecondaryCell>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              />
            </tbody>
          </table>
        </SecondaryTableScroll>
        <SecondaryTableSelectionBar
          selectedCount={selected.length}
          total={ids.length}
        >
          {footer}
        </SecondaryTableSelectionBar>
      </SecondaryTableFrame>
    </>
  )
}
