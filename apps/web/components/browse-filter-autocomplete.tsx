'use client'

import { useEffect, useId, useState } from 'react'
import { Input } from '@repo/ui/components/ui/input'
import { FilterIndicator } from './filter-affordance'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  browseSuggestions,
  enterSuggestion,
  suggestionKey,
  type BrowseSuggestion,
  type FilterSuggestion,
  type TitleSuggestion,
} from '@/utils/browse-suggestions'

export default function BrowseFilterAutocomplete({
  options,
  items,
  titlesLoading,
  titlesError,
  placeholder,
  value,
  onValueChange,
  onAddFilter,
  onApplyText,
  onOpenItem,
}: {
  options: FilterSuggestion[]
  items: TitleSuggestion[]
  titlesLoading: boolean
  titlesError: boolean
  placeholder: string
  emptyMessage?: string
  value: string
  onValueChange: (value: string) => void
  onAddFilter: (filter: BrowseFilter) => void
  onApplyText: (value: string) => void
  onOpenItem: (id: string, trigger: HTMLElement | undefined) => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [pendingEnter, setPendingEnter] = useState<string | null>(null)
  const suggestions = browseSuggestions(options, items, value)
  const active = suggestions.findIndex(
    (option) => suggestionKey(option) === activeKey,
  )
  function select(option: BrowseSuggestion) {
    if (option.kind === 'item') {
      setOpen(false)
      const trigger = document.getElementById(`${id}-input`)
      onOpenItem(option.item.id, trigger ?? undefined)
    } else
      onAddFilter({ field: option.filter.field, value: option.filter.value })
    setActiveKey(null)
    setPendingEnter(null)
  }
  useEffect(() => {
    if (pendingEnter !== value || titlesLoading) return
    setPendingEnter(null)
    const option = enterSuggestion(suggestions, -1)
    if (option && !titlesError) select(option)
    else if (!titlesError) {
      onApplyText(value.trim())
      setOpen(false)
    }
  })
  function highlight(index: number) {
    const option = suggestions[index]
    setActiveKey(option ? suggestionKey(option) : null)
    document
      .getElementById(`${id}-${index}`)
      ?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div
      className="browse-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
          setPendingEnter(null)
        }
      }}
    >
      <Input
        id={`${id}-input`}
        aria-label="Search and filter library"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={
          open && active >= 0 ? `${id}-${active}` : undefined
        }
        placeholder={placeholder}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onValueChange(event.target.value)
          setOpen(true)
          setActiveKey(null)
          setPendingEnter(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setOpen(false)
            setPendingEnter(null)
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            highlight(Math.min(active + 1, suggestions.length - 1))
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            highlight(Math.max(-1, active - 1))
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            const option = enterSuggestion(suggestions, active)
            if (open && option) select(option)
            else if (value.trim() && titlesLoading) setPendingEnter(value)
            else if (titlesError) setOpen(true)
            else {
              onApplyText(value.trim())
              setOpen(false)
            }
          }
        }}
      />
      {open && (
        <div className="search-menu">
          <div id={`${id}-list`} role="listbox" aria-label="Filter suggestions">
            {titlesLoading && (
              <p role="status" className="quiet">
                Finding titles...
              </p>
            )}
            {titlesError && (
              <p role="alert" className="quiet">
                Could not load titles. Try searching again.
              </p>
            )}
            {suggestions.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                id={`${id}-${index}`}
                key={suggestionKey(option)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(option)}
              >
                <span>
                  {option.kind === 'filter' && <FilterIndicator />}
                  {option.kind === 'item'
                    ? option.item.label
                    : option.filter.label}
                </span>
                <small>
                  {option.kind === 'item'
                    ? 'Open'
                    : option.filter.count.toLocaleString()}
                </small>
              </button>
            ))}
            {!suggestions.length && !titlesLoading && (
              <p className="quiet">No matching suggestions.</p>
            )}
          </div>
          {value.trim() && (
            <button
              type="button"
              className="search-text-action"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setPendingEnter(null)
                onApplyText(value.trim())
                setOpen(false)
              }}
            >
              Filter by text: "{value.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  )
}
