'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  SecondaryTableScroll,
  SecondaryTableHead,
  useTableColumns,
} from './secondary-table'
import {
  sortTableRows,
  type TableSort,
  type TableValue,
} from '@/utils/secondary-table'
import { Button } from '@repo/ui/components/ui/button'
import { useInfiniteTableScroll } from '@/hooks/useInfiniteTableScroll'
import { updateJobSelection } from '@/utils/job-selection'

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
}: {
  items: Item[]
  selected: number[]
  onChange: (rows: number[]) => void
  disabled: boolean
  actionable: (item: Item) => boolean
  storageKey: string
  columns: {
    key: string
    label: string
    value: (item: Item) => TableValue
    render?: (item: Item) => ReactNode
    defaultVisible?: boolean
  }[]
}) {
  const visibility = useTableColumns(storageKey, columns)
  const [sort, setSort] = useState<TableSort>({ key: 'row', direction: 'asc' })
  const ordered = sortTableRows(items, sort, (item, key) =>
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
    enabled: count < items.length,
    fetchNextPage: async () => {
      setCount((value) => Math.min(value + 50, items.length))
    },
    resetKey: `${sort.key}:${sort.direction}`,
  })
  useEffect(() => {
    if (all.current)
      all.current.indeterminate =
        !checked && ids.some((id) => selection.includes(id))
  }, [checked, ids, selection])
  return (
    <>
      {visibility.controls}
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
                      {column.render
                        ? column.render(item)
                        : String(column.value(item) ?? '-')}
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
          {Math.min(count, items.length)} of {items.length} items
        </div>
        {count < items.length && (
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
