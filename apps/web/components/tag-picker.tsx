'use client'

import { ReadButton } from '@/components/read-button'
import { useDeferredValue, useState } from 'react'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import {
  formatTagName,
  normalizeTagName,
  TagPageSchema,
  type Tag,
} from '@repo/schemas/tags'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button, type ButtonFeedback } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { TableBody, TableCell, TableRow } from '@repo/ui/components/ui/table'
import { useConfig } from './providers'
import { fetchApiData } from '@/utils/api'
import { SecondaryTableScroll, SecondaryVirtualRows } from './secondary-table'

/**
 * Finds one tag of a library by name: a search field and the matching tags
 * as a scrolling list. Choosing a tag clears the search. `unavailable` names
 * why a tag cannot be chosen, such as "current tag"; that tag is listed but
 * disabled. With `onCreate`, a search that names no tag offers to create it.
 */
export function TagPicker({
  mediaType,
  label,
  inputLabel,
  listLabel,
  disabled = false,
  unavailable,
  onPick,
  onCreate,
  pickFeedback,
  createFeedback,
}: {
  mediaType: 'album' | 'film'
  label: string
  inputLabel: string
  listLabel: string
  disabled?: boolean
  unavailable?: (tag: Tag) => string | null
  onPick: (tag: Tag) => void
  onCreate?: (name: string) => void
  pickFeedback?: (tag: Tag) => ButtonFeedback | undefined
  createFeedback?: (name: string) => ButtonFeedback | undefined
}) {
  const { apiBaseUrl } = useConfig()
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const matches = useVirtualTable({
    queryKey: ['tags', 'search', mediaType, query],
    enabled:
      query.length > 0 &&
      (!disabled || Boolean(pickFeedback || createFeedback)),
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
      {query && (!disabled || pickFeedback || createFeedback) && (
        <>
          {matches.isError && (
            <Notice
              tone="danger"
              action={
                <ReadButton type="button" size="xs" read={matches.retry}>
                  Retry
                </ReadButton>
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
                            disabled={disabled || reason !== null}
                            feedback={pickFeedback?.(item)}
                            onClick={() => {
                              if (!pickFeedback) setSearch('')
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
          {onCreate &&
            matches.hasTotal &&
            !matches.firstPage?.items.some(
              (tag) => normalizeTagName(tag.name) === normalizeTagName(query),
            ) && (
              <span>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  disabled={disabled}
                  feedback={createFeedback?.(query)}
                  onClick={() => {
                    if (!createFeedback) setSearch('')
                    onCreate(query)
                  }}
                >
                  Create tag “{query}”
                </Button>
              </span>
            )}
        </>
      )}
    </div>
  )
}
