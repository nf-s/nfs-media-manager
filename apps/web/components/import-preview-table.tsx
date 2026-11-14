'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  SecondaryCell,
  SecondaryTableScroll,
  SecondaryTableHead,
  SecondaryTableToolbar,
  useTableColumns,
} from './secondary-table'
import {
  sortTableRows,
  type TableSort,
  type TableValue,
} from '@/utils/secondary-table'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TableState } from '@repo/ui/components/ui/table'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { updateJobSelection } from '@/utils/job-selection'

export type ImportPreviewFilter<Item> = {
  key: string
  label: string
  matches: (item: Item) => boolean
}

export function filterImportPreviewItems<Item>(
  items: readonly Item[],
  search: string,
  filter: string,
  filters: readonly ImportPreviewFilter<Item>[],
  searchValue: (item: Item) => string,
): Item[] {
  const term = search.trim().toLocaleLowerCase()
  const selectedFilter = filters.find((option) => option.key === filter)
  return items.filter(
    (item) =>
      (!term || searchValue(item).toLocaleLowerCase().includes(term)) &&
      (!selectedFilter || selectedFilter.matches(item)),
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
  searchValue,
}: {
  items: Item[]
  selected: number[]
  onChange: (rows: number[]) => void
  disabled: boolean
  actionable: (item: Item) => boolean
  storageKey: string
  filters?: readonly ImportPreviewFilter<Item>[]
  searchValue?: (item: Item) => string
  columns: {
    key: string
    label: string
    value: (item: Item) => TableValue
    render?: (item: Item) => ReactNode
    defaultVisible?: boolean
  }[]
}) {
  const visibility = useTableColumns(storageKey, columns)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
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
  const [count, setCount] = useState(50)
  const [anchor, setAnchor] = useState<string | null>(null)
  const all = useRef<HTMLInputElement>(null)
  const ids = ordered.filter(actionable).map((item) => String(item.row))
  const selection = selected.map(String)
  const checked = ids.length > 0 && ids.every((id) => selection.includes(id))
  const { scroller, sentinel } = useInfiniteTableScroll({
    enabled: count < ordered.length,
    fetchNextPage: async () => {
      setCount((value) => Math.min(value + 50, ordered.length))
    },
    resetKey: JSON.stringify([sort.key, sort.direction, search, filter]),
  })
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        !checked && ids.some((id) => selection.includes(id))
  }, [checked, ids, selection])
  function clearSelection() {
    onChange([])
    setAnchor(null)
    setCount(50)
  }
  return (
    <>
      <SecondaryTableToolbar
        search={
          <Input
            type="search"
            aria-label="Search preview"
            placeholder="Search preview"
            value={search}
            disabled={disabled}
            onChange={(event) => {
              setSearch(event.target.value)
              clearSelection()
            }}
          />
        }
        filters={
          filters.length ? (
            <select
              aria-label="Import status"
              value={filter}
              disabled={disabled}
              onChange={(event) => {
                setFilter(event.target.value)
                clearSelection()
              }}
            >
              <option value="">All rows</option>
              {filters.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : undefined
        }
        count={`${filtered.length.toLocaleString()} of ${items.length.toLocaleString()} items`}
        columns={visibility.controls}
      />
      <SecondaryTableScroll
        ref={scroller}
        className="import-preview-scroll"
        role="region"
        aria-label="Import preview"
      >
        <table className="compact-table" aria-label="Import preview">
          <thead>
            <tr>
              <th scope="col" className="table-selection-cell">
                <input
                  ref={all}
                  type="checkbox"
                  aria-label="Select all preview items"
                  checked={checked}
                  disabled={disabled || !ids.length}
                  onChange={(event) => {
                    onChange(event.target.checked ? ids.map(Number) : [])
                    setAnchor(null)
                  }}
                />
              </th>
              {columns
                .filter((column) => visibility.visible(column.key))
                .map((column) => (
                  <SecondaryTableHead
                    key={column.key}
                    sortKey={column.key}
                    label={column.label}
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
                      setCount(50)
                    }}
                  />
                ))}
            </tr>
          </thead>
          <tbody>
            {!ordered.length && (
              <TableState colSpan={visibility.count + 1}>
                {items.length ? 'No matching items.' : 'No items to import.'}
              </TableState>
            )}
            {ordered.slice(0, count).map((item) => (
              <tr
                key={item.row}
                data-selected={selected.includes(item.row) || undefined}
              >
                <td className="table-selection-cell">
                  <input
                    type="checkbox"
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
                </td>
                {columns
                  .filter((column) => visibility.visible(column.key))
                  .map((column) => (
                    <td key={column.key}>
                      {column.render ? (
                        column.render(item)
                      ) : (
                        <SecondaryCell text={String(column.value(item) ?? '-')}>
                          {String(column.value(item) ?? '-')}
                        </SecondaryCell>
                      )}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div
          ref={sentinel}
          className="py-2 text-center text-sm text-muted-foreground"
          role="status"
        >
          {Math.min(count, ordered.length)} of {ordered.length} items loaded
        </div>
        {count < ordered.length && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setCount((value) => value + 50)}
          >
            Load more
          </Button>
        )}
      </SecondaryTableScroll>
    </>
  )
}
