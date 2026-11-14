'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { Input } from '@repo/ui/components/ui/input'
import { FilterIndicator } from './filter-affordance'
import type { BrowseFilter } from '@repo/schemas/browse'
import {
  browseSuggestions,
  suggestionKey,
  type BrowseSuggestion,
  type FilterSuggestion,
  type TitleSuggestion,
} from '@/utils/browse-suggestions'

export type BrowseFilterAutocompleteProps = {
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
  inputActions?: ReactNode
  children?: ReactNode
  onAiSearch?: (value: string) => void
  aiSearchDisabled?: boolean
  disabled?: boolean
  hideSuggestions?: boolean
  /** No filter or title suggestions: the menu lists only the text and AI actions, while there is text. */
  textActionsOnly?: boolean
  onFocus?: () => void
}

type SearchMenuOption =
  | { key: string; kind: 'suggestion'; suggestion: BrowseSuggestion }
  | { key: string; kind: 'text' }
  | { key: string; kind: 'ai'; disabled: boolean }

export function autocompleteOptions(
  suggestions: BrowseSuggestion[],
  value: string,
  includeAi: boolean,
  aiDisabled = false,
): SearchMenuOption[] {
  const options: SearchMenuOption[] = suggestions.map((suggestion) => ({
    key: suggestionKey(suggestion),
    kind: 'suggestion',
    suggestion,
  }))
  if (value.trim()) {
    options.push({ key: 'action:text', kind: 'text' })
    if (includeAi)
      options.push({ key: 'action:ai', kind: 'ai', disabled: aiDisabled })
  }
  return options
}

/** Enter selects only an option highlighted with the arrow keys; otherwise it searches the text. */
export function autocompleteEnterOption(
  options: SearchMenuOption[],
  activeKey: string | null,
) {
  return options.find((option) => option.key === activeKey)
}

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
  inputActions,
  children,
  onAiSearch,
  aiSearchDisabled = false,
  disabled = false,
  hideSuggestions = false,
  textActionsOnly = false,
  onFocus,
}: BrowseFilterAutocompleteProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const suggestions = browseSuggestions(options, items, value)
  const menuOptions = autocompleteOptions(
    suggestions,
    value,
    Boolean(onAiSearch),
    aiSearchDisabled,
  )
  const active = menuOptions.findIndex((option) => option.key === activeKey)
  const menuVisible =
    open &&
    !hideSuggestions &&
    !disabled &&
    (!textActionsOnly || menuOptions.length > 0)
  function select(option: BrowseSuggestion) {
    if (option.kind === 'item') {
      setOpen(false)
      const trigger = document.getElementById(`${id}-input`)
      onOpenItem(option.item.id, trigger ?? undefined)
    } else
      onAddFilter({ field: option.filter.field, value: option.filter.value })
    setActiveKey(null)
  }
  function selectMenuOption(option: SearchMenuOption) {
    if (option.kind === 'suggestion') {
      select(option.suggestion)
      return
    }
    if (option.kind === 'ai' && option.disabled) return
    setActiveKey(null)
    setOpen(false)
    if (option.kind === 'ai') onAiSearch?.(value.trim())
    else onApplyText(value.trim())
  }
  useEffect(() => {
    if ((hideSuggestions || disabled) && activeKey !== null) setActiveKey(null)
  })
  function highlight(index: number) {
    const option = menuOptions[index]
    setActiveKey(option?.key ?? null)
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
          setActiveKey(null)
        }
      }}
    >
      <div className={`search-input-wrap${inputActions ? ' has-actions' : ''}`}>
        <Input
          id={`${id}-input`}
          aria-label="Search and filter library"
          role="combobox"
          aria-expanded={menuVisible}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            menuVisible && active >= 0 ? `${id}-${active}` : undefined
          }
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onFocus={() => {
            setOpen(true)
            onFocus?.()
          }}
          onChange={(event) => {
            onValueChange(event.target.value)
            setOpen(true)
            setActiveKey(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              setOpen(false)
              setActiveKey(null)
            }
            if (hideSuggestions || disabled) {
              if (['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key))
                event.preventDefault()
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              highlight(Math.min(active + 1, menuOptions.length - 1))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
              highlight(Math.max(-1, active - 1))
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const option = autocompleteEnterOption(menuOptions, activeKey)
              if (menuVisible && option) selectMenuOption(option)
              else {
                onApplyText(value.trim())
                setOpen(false)
                setActiveKey(null)
              }
            }
          }}
        />
        {inputActions && (
          <div className="search-input-actions">{inputActions}</div>
        )}
      </div>
      {menuVisible && (
        <div className="search-menu">
          <div id={`${id}-list`} role="listbox" aria-label="Filter suggestions">
            {titlesLoading && (
              <p role="status" className="quiet search-status">
                Loading suggestions...
              </p>
            )}
            {titlesError && (
              <p role="alert" className="quiet search-status">
                Could not load suggestions. Try searching again.
              </p>
            )}
            {!textActionsOnly &&
              !suggestions.length &&
              !titlesLoading &&
              !titlesError && (
                <p className="quiet search-status">No matching suggestions.</p>
              )}
            {menuOptions.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                id={`${id}-${index}`}
                key={option.key}
                className={
                  option.kind === 'text'
                    ? 'search-text-action'
                    : option.kind === 'ai'
                      ? 'search-ai-action'
                      : undefined
                }
                aria-disabled={
                  option.kind === 'ai' && option.disabled ? true : undefined
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMenuOption(option)}
              >
                <span>
                  {option.kind === 'suggestion' ? (
                    <>
                      {option.suggestion.kind === 'filter' && (
                        <FilterIndicator />
                      )}
                      {option.suggestion.kind === 'item'
                        ? option.suggestion.item.label
                        : option.suggestion.filter.label}
                    </>
                  ) : option.kind === 'text' ? (
                    <>Filter by text: "{value.trim()}"</>
                  ) : (
                    <>
                      <Sparkles size={14} aria-hidden="true" /> AI search
                    </>
                  )}
                </span>
                {option.kind === 'suggestion' && (
                  <small>
                    {option.suggestion.kind === 'item'
                      ? 'Open'
                      : option.suggestion.filter.count.toLocaleString()}
                  </small>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {children}
    </div>
  )
}
