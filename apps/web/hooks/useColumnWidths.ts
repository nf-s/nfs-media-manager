'use client'

import { useEffect, useRef, useState, type HTMLAttributes } from 'react'
import {
  SavedWidthsSchema,
  browseWidthLimits,
  resizedWidth,
  type WidthLimits,
} from '@/utils/column-widths'

type WidthColumn = { key: string; label: string }

/**
 * The on-screen width of the handle's column when it is the one that takes the
 * room left over in its table: the column whose `<col>` states no width. Every
 * other column is as wide as its set width, or is scaled with the whole table.
 */
function renderedWidth(handle: HTMLElement) {
  const cell = handle.parentElement
  if (!(cell instanceof HTMLTableCellElement)) return undefined
  const column = cell.closest('table')?.querySelectorAll('col')[cell.cellIndex]
  return column && !column.style.width
    ? cell.getBoundingClientRect().width
    : undefined
}

/**
 * Table column widths, kept in browser storage. `resizer` gives a header's
 * handle: drag it or use the Left and Right keys to change the width, and
 * double-click it to return the column to its default width.
 */
export function useColumnWidths<Column extends WidthColumn>(
  collection: string,
  defaultWidth: (column: Column) => number,
  minimumWidths: Partial<Record<string, number>> = {},
  limits: WidthLimits = browseWidthLimits,
) {
  const [widths, setWidths] = useState<Record<string, number>>({})
  const resize = useRef<{
    key: string
    x: number
    width: number
    rendered: number | undefined
    next?: number
  } | null>(null)
  const storageKey = `widths:${collection}`
  useEffect(() => {
    try {
      const parsed = SavedWidthsSchema.safeParse(
        JSON.parse(window.localStorage.getItem(storageKey) ?? '{}'),
      )
      setWidths(parsed.success ? parsed.data : {})
    } catch {
      /* Ignore unavailable storage or malformed saved widths. */
    }
  }, [storageKey])
  const limitsFor = (key: string): WidthLimits => ({
    min: minimumWidths[key] ?? limits.min,
    max: limits.max,
  })
  const widthFor = (column: Column) => {
    const { min, max } = limitsFor(column.key)
    return Math.max(
      min,
      Math.min(max, widths[column.key] ?? defaultWidth(column)),
    )
  }
  function save(next: Record<string, number>) {
    setWidths(next)
    try {
      if (Object.keys(next).length)
        window.localStorage.setItem(storageKey, JSON.stringify(next))
      else window.localStorage.removeItem(storageKey)
    } catch {
      /* Width changes remain usable for this session. */
    }
  }
  function finish(key: string) {
    const drag = resize.current
    if (drag?.key !== key) return
    resize.current = null
    if (drag.next !== undefined) save({ ...widths, [key]: drag.next })
  }
  function resizer(column: Column): HTMLAttributes<HTMLSpanElement> {
    const { key } = column
    const columnLimits = limitsFor(key)
    return {
      role: 'separator',
      title: `Drag to resize ${column.label}. Double-click to reset.`,
      'aria-label': `Resize ${column.label}`,
      'aria-orientation': 'vertical',
      'aria-valuenow': widthFor(column),
      'aria-valuemin': columnLimits.min,
      'aria-valuemax': columnLimits.max,
      tabIndex: 0,
      onKeyDown: (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        save({
          ...widths,
          [key]: resizedWidth({
            width: widthFor(column),
            rendered: renderedWidth(event.currentTarget),
            delta: event.key === 'ArrowRight' ? 10 : -10,
            limits: columnLimits,
          }),
        })
      },
      onPointerDown: (event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        resize.current = {
          key,
          x: event.clientX,
          width: widthFor(column),
          rendered: renderedWidth(event.currentTarget),
        }
      },
      onPointerMove: (event) => {
        const drag = resize.current
        if (drag?.key !== key) return
        drag.next = resizedWidth({
          width: drag.width,
          rendered: drag.rendered,
          delta: event.clientX - drag.x,
          limits: columnLimits,
        })
        setWidths({ ...widths, [key]: drag.next })
      },
      onPointerUp: () => finish(key),
      onPointerCancel: () => finish(key),
      onDoubleClick: () => {
        save(
          Object.fromEntries(
            Object.entries(widths).filter(([saved]) => saved !== key),
          ),
        )
      },
    }
  }
  return { widthFor, resizer, reset: () => save({}) }
}
