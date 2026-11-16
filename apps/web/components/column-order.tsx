'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { Button } from '@repo/ui/components/ui/button'

type OrderedColumn = { key: string; label: string }

/** `keys` with `key` moved to `index`. */
export function moveColumnKey(
  keys: readonly string[],
  key: string,
  index: number,
): string[] {
  const rest = keys.filter((item) => item !== key)
  const at = Math.max(0, Math.min(rest.length, index))
  return [...rest.slice(0, at), key, ...rest.slice(at)]
}

/**
 * Column picker entries in column order. Each entry's handle moves it: drag
 * the handle, or focus it and press the up and down arrow keys. `pinned`, the
 * identity column, stays first and its handle is disabled.
 */
export function ColumnOrderList<Column extends OrderedColumn>({
  columns,
  pinned,
  onMove,
  children,
}: {
  columns: readonly Column[]
  pinned?: string
  onMove: (keys: string[]) => void
  children: (column: Column) => ReactNode
}) {
  const hint = useId()
  const list = useRef<HTMLOListElement>(null)
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const [drag, setDrag] = useState<{
    key: string
    keys: string[]
    pointerId: number
  } | null>(null)
  // A moved entry's handle keeps focus once the new order is shown.
  const [refocus, setRefocus] = useState<{ key: string; order: string } | null>(
    null,
  )
  const [announcement, setAnnouncement] = useState('')
  const keys = columns.map(({ key }) => key)
  const order = keys.join(',')
  const first = pinned !== undefined && keys[0] === pinned ? 1 : 0
  const byKey = new Map(columns.map((column) => [column.key, column]))

  const dragKey = drag?.key
  const dragPointer = drag?.pointerId
  useEffect(() => {
    if (dragKey === undefined || dragPointer === undefined) return
    const key = dragKey
    const pointerId = dragPointer
    // Escape abandons the drag. Heard on the window in the capture phase, before
    // the dialog's and popover's own Escape handling, so that key press does not
    // also close them.
    function onEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setDrag(null)
      const handle = handles.current.get(key)
      if (handle?.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId)
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [dragKey, dragPointer])

  useEffect(() => {
    if (!refocus || refocus.order !== order) return
    handles.current.get(refocus.key)?.focus()
    setRefocus(null)
  }, [refocus, order])

  function announce(key: string, next: readonly string[]) {
    const label = byKey.get(key)?.label ?? key
    setAnnouncement(
      `${label}, position ${next.indexOf(key) + 1} of ${next.length}`,
    )
  }
  function commit(key: string, next: string[]) {
    if (next.join(',') === order) return
    setRefocus({ key, order: next.join(',') })
    onMove(next)
    announce(key, next)
  }
  /** Where the dragged entry lands: after every other entry above the pointer. */
  function dropIndex(key: string, y: number) {
    const entries = [...(list.current?.children ?? [])].filter(
      (entry) =>
        entry instanceof HTMLElement && entry.dataset.columnKey !== key,
    )
    const above = entries.filter((entry) => {
      const box = entry.getBoundingClientRect()
      return box.top + box.height / 2 < y
    }).length
    return Math.max(first, above)
  }

  return (
    <>
      <ol className="column-order" ref={list}>
        {columns.map((column) => {
          const { key } = column
          const locked = key === pinned
          return (
            <li
              key={key}
              className="ds-menu-item column-order-item"
              data-column-key={key}
              data-state={drag?.key === key ? 'hover' : undefined}
              // While dragging, the entries show the new order in place; the
              // document order changes when the entry is dropped.
              style={drag ? { order: drag.keys.indexOf(key) } : undefined}
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon
                className="column-order-handle"
                ref={(element) => {
                  if (element) handles.current.set(key, element)
                  else handles.current.delete(key)
                }}
                disabled={locked}
                aria-label={
                  locked
                    ? `${column.label} stays first`
                    : `Move ${column.label}`
                }
                aria-describedby={locked ? undefined : hint}
                title={locked ? undefined : 'Drag or use arrow keys to move'}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
                    return
                  event.preventDefault()
                  const index = keys.indexOf(key)
                  const next = event.key === 'ArrowUp' ? index - 1 : index + 1
                  if (next < first || next >= keys.length) return
                  commit(key, moveColumnKey(keys, key, next))
                }}
                onPointerDown={(event) => {
                  if (locked || event.button !== 0) return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setDrag({ key, keys, pointerId: event.pointerId })
                }}
                onPointerMove={(event) => {
                  if (drag?.key !== key) return
                  const next = moveColumnKey(
                    drag.keys,
                    key,
                    dropIndex(key, event.clientY),
                  )
                  if (next.join(',') !== drag.keys.join(','))
                    setDrag({ ...drag, keys: next })
                }}
                onPointerUp={() => {
                  if (drag?.key !== key) return
                  setDrag(null)
                  commit(key, drag.keys)
                }}
                onPointerCancel={() => setDrag(null)}
                // Pointer up has already committed by now; a capture lost any
                // other way abandons the drag.
                onLostPointerCapture={() => setDrag(null)}
              >
                <GripVertical className="ds-i" data-size="sm" aria-hidden />
              </Button>
              {children(column)}
            </li>
          )
        })}
      </ol>
      <span id={hint} className="sr-only">
        Press the up and down arrow keys to move the column.
      </span>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </>
  )
}
