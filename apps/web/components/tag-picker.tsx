'use client'

import { useDeferredValue, useState } from 'react'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { formatTagName, TagPageSchema, type Tag } from '@repo/schemas/tags'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TableBody, TableCell, TableRow } from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { SecondaryTableScroll, SecondaryVirtualRows } from './secondary-table'

/**
 * Finds one tag of a library by name: a search field and the matching tags
 * as a scrolling list. Choosing a tag clears the search. `unavailable` names
 * why a tag cannot be chosen, such as "current tag"; that tag is listed but
 * disabled.
 */
export function TagPicker({
  mediaType,
  label,
  inputLabel,
  listLabel,
  disabled = false,
  unavailable,
  onPick,
}: {
  mediaType: 'album' | 'film'
  label: string
  inputLabel: string
  listLabel: string
  disabled?: boolean
  unavailable?: (tag: Tag) => string | null
  onPick: (tag: Tag) => void
}) {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const matches = useVirtualTable({
    queryKey: ['tags', 'search', mediaType, query],
    enabled: query.length > 0 && !disabled,
    pageSize: 25,
    headerHeight: 0,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tags?${new URLSearchParams({ mediaType, q: query, visibility: 'all', page: String(page), size: String(size) })}`,
        TagPageSchema,
        { signal },
      ),
  })
  return (
    <div className="dtl-stack">
      <label className="ds-field">
        <span className="ds-label">{label}</span>
        <Input
          aria-label={inputLabel}
          placeholder="Search tags..."
          value={search}
          maxLength={200}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {query && !disabled && (
        <>
          {matches.isError && (
            <Notice
              tone="danger"
              action={
                <Button type="button" size="xs" onClick={matches.retry}>
                  Retry
                </Button>
              }
            >
              Could not find tags.
            </Notice>
          )}
          <SecondaryTableScroll
            ref={matches.scroller}
            onScroll={matches.onScroll}
            className="dtl-matches"
            role="region"
            aria-label={listLabel}
            aria-busy={matches.isFetching}
          >
            <table
              className="ds-table"
              aria-label={listLabel}
              aria-rowcount={matches.hasTotal ? matches.total : undefined}
            >
              <TableBody>
                {matches.hasTotal && !matches.total && (
                  <TableRow>
                    <TableCell className="ds-muted">
                      No matching tags.
                    </TableCell>
                  </TableRow>
                )}
                <SecondaryVirtualRows
                  window={matches}
                  colSpan={1}
                  renderRow={(item, index) => {
                    const reason = unavailable?.(item) ?? null
                    return (
                      <TableRow key={item.id} aria-rowindex={index + 1}>
                        <TableCell>
                          <Button
                            type="button"
                            variant="link"
                            size="xs"
                            disabled={reason !== null}
                            onClick={() => {
                              setSearch('')
                              onPick(item)
                            }}
                          >
                            {formatTagName(item.name)}
                            {item.hidden ? ' (hidden)' : ''}
                            {reason ? ` (${reason})` : ''}
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  }}
                />
              </TableBody>
            </table>
          </SecondaryTableScroll>
        </>
      )}
    </div>
  )
}
