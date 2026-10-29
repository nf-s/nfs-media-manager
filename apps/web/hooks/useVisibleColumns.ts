'use client'

import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'

const StoredVisibleColumnsSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string' || value.length === 0) {
      return []
    }

    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  },
  z.array(z.string()).max(32),
)

function isColumnKey<TColumnKey extends string>(
  allColumns: readonly TColumnKey[],
  value: string,
): value is TColumnKey {
  return allColumns.some((columnKey) => columnKey === value)
}

export function useVisibleColumns<TColumnKey extends string>({
  allColumns,
  defaultColumns,
  storageKey,
}: {
  allColumns: readonly TColumnKey[]
  defaultColumns: readonly TColumnKey[]
  storageKey: string
}) {
  const [visibleColumns, setVisibleColumns] = useState<TColumnKey[]>([
    ...defaultColumns,
  ])

  useEffect(() => {
    const storedValue = window.localStorage.getItem(storageKey)
    const parsedValue = StoredVisibleColumnsSchema.safeParse(storedValue)

    if (!parsedValue.success) {
      return
    }

    const nextColumns = Array.from(
      new Set(
        parsedValue.data.filter((columnKey) => isColumnKey(allColumns, columnKey)),
      ),
    )

    if (nextColumns.length > 0) {
      setVisibleColumns(nextColumns)
    }
  }, [allColumns, storageKey])

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(visibleColumns))
  }, [storageKey, visibleColumns])

  const visibleColumnSet = useMemo(
    () => new Set(visibleColumns),
    [visibleColumns],
  )

  function toggleColumn(columnKey: TColumnKey) {
    setVisibleColumns((current) => {
      if (current.includes(columnKey)) {
        if (current.length === 1) {
          return current
        }

        return current.filter((visibleColumn) => visibleColumn !== columnKey)
      }

      return allColumns.filter(
        (availableColumn) =>
          availableColumn === columnKey || current.includes(availableColumn),
      )
    })
  }

  return {
    visibleColumns,
    visibleColumnSet,
    toggleColumn,
  }
}
