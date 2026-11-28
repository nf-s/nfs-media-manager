'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Search, Sparkles } from 'lucide-react'
import { FilterIndicator } from './filter-affordance'
import type { BrowseFilter } from '@repo/schemas/browse'
import { detailPageHref, type DetailTarget } from '@/utils/detail-inspector'
import type { BrowseFilterHref } from '@/utils/browse-items'
import {
  isWorkspaceTabGesture,
  workspaceTabLinkProps,
} from '@/utils/workspace-tab-destination'
import {
  browseSuggestions,
  filterSuggestionNote,
  suggestionKey,
  type BrowseSuggestion,
  type FilterSuggestion,
  type SmartPlaylistSuggestion,
  type TitleSuggestion,
} from '@/utils/browse-suggestions'

export type BrowseFilterAutocompleteProps = {
  options: FilterSuggestion[]
  items: TitleSuggestion[]
  /** The library's smart playlists, offered when they can be opened (PL-44). */
  smartPlaylists?: SmartPlaylistSuggestion[]
  onOpenSmartPlaylist?: (playlist: SmartPlaylistSuggestion) => void
  itemKind?: DetailTarget['kind']
  titlesLoading: boolean
  titlesError: boolean
  placeholder: string
  emptyMessage?: string
  value: string
  onValueChange: (value: string) => void
  onAddFilter: (filter: BrowseFilter) => void
  filterHref?: BrowseFilterHref
  searchHref?: (value: string) => string
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

function suggestionLabel(suggestion: BrowseSuggestion) {
  switch (suggestion.kind) {
    case 'item':
      return suggestion.item.label
    case 'filter':
      return suggestion.filter.label
    case 'smart':
      return suggestion.playlist.label
  }
}

/**
 * Choosing a suggestion: a title opens its item and a smart playlist its
 * view, and both close the menu; a filter, a playlist's included, is added
 * and the menu stays open.
 */
export function chooseSuggestion(
  suggestion: BrowseSuggestion,
  actions: {
    openItem: (id: string) => void
    openSmartPlaylist: (playlist: SmartPlaylistSuggestion) => void
    addFilter: (filter: BrowseFilter) => void
  },
): 'close' | 'keep' {
  switch (suggestion.kind) {
    case 'item':
      actions.openItem(suggestion.item.id)
      return 'close'
    case 'smart':
      actions.openSmartPlaylist(suggestion.playlist)
      return 'close'
    case 'filter':
      actions.addFilter({
        field: suggestion.filter.field,
        value: suggestion.filter.value,
      })
      return 'keep'
  }
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
  smartPlaylists = [],
  onOpenSmartPlaylist,
  itemKind,
  titlesLoading,
  titlesError,
  placeholder,
  value,
  onValueChange,
  onAddFilter,
  filterHref,
  searchHref,
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
  const suggestions = browseSuggestions(
    options,
    items,
    value,
    onOpenSmartPlaylist ? smartPlaylists : [],
  )
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
  function workspaceProps(option: SearchMenuOption | undefined) {
    if (option?.kind === 'text' && searchHref) {
      const text = value.trim()
      return workspaceTabLinkProps(searchHref(text), text)
    }
    if (option?.kind !== 'suggestion') return undefined
    const suggestion = option.suggestion
    if (suggestion.kind === 'filter')
      return filterHref
        ? workspaceTabLinkProps(
            filterHref({
              field: suggestion.filter.field,
              value: suggestion.filter.value,
            }),
            suggestion.filter.label,
          )
        : undefined
    if (suggestion.kind === 'smart')
      return workspaceTabLinkProps(
        suggestion.playlist.href,
        suggestion.playlist.name,
      )
    if (!itemKind) return undefined
    return workspaceTabLinkProps(
      detailPageHref({ kind: itemKind, id: suggestion.item.id }),
      suggestion.item.title,
    )
  }
  function select(option: BrowseSuggestion) {
    const trigger = document.getElementById(`${id}-input`) ?? undefined
    const result = chooseSuggestion(option, {
      openItem: (itemId) => onOpenItem(itemId, trigger),
      openSmartPlaylist: (playlist) => onOpenSmartPlaylist?.(playlist),
      addFilter: onAddFilter,
    })
    if (result === 'close') setOpen(false)
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
      className="browse-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false)
          setActiveKey(null)
        }
      }}
    >
      <div className="ds-search" data-actions={inputActions ? '' : undefined}>
        <Search className="ds-i" data-size="sm" aria-hidden />
        <input
          {...(menuVisible
            ? workspaceProps(
                menuOptions[active] ??
                  menuOptions.find((option) => option.kind === 'text'),
              )
            : undefined)}
          id={`${id}-input`}
          type="search"
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
              if (isWorkspaceTabGesture(event.nativeEvent)) {
                event.preventDefault()
                return
              }
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
          <span className="browse-search-actions">{inputActions}</span>
        )}
      </div>
      {menuVisible && (
        <div className="ds-pop browse-menu">
          <div id={`${id}-list`} role="listbox" aria-label="Filter suggestions">
            {titlesLoading && (
              <p role="status" className="ds-pop-head">
                Loading suggestions...
              </p>
            )}
            {titlesError && (
              <p role="alert" className="ds-pop-head">
                Could not load suggestions. Try searching again.
              </p>
            )}
            {!textActionsOnly &&
              !suggestions.length &&
              !titlesLoading &&
              !titlesError && (
                <p className="ds-pop-head">No matching suggestions.</p>
              )}
            {menuOptions.map((option, index) => (
              <button
                {...workspaceProps(option)}
                type="button"
                role="option"
                aria-selected={index === active}
                id={`${id}-${index}`}
                key={option.key}
                className={
                  option.kind === 'text'
                    ? 'ds-menu-item search-text-action'
                    : option.kind === 'ai'
                      ? 'ds-menu-item search-ai-action'
                      : 'ds-menu-item'
                }
                data-state={index === active ? 'hover' : undefined}
                aria-disabled={
                  option.kind === 'ai' && option.disabled ? true : undefined
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMenuOption(option)}
              >
                {option.kind === 'suggestion' ? (
                  <>
                    {option.suggestion.kind === 'filter' && <FilterIndicator />}
                    <span className="ds-truncate">
                      {suggestionLabel(option.suggestion)}
                    </span>
                    <span className="ds-muted">
                      {option.suggestion.kind === 'filter'
                        ? filterSuggestionNote(option.suggestion.filter)
                        : 'Open'}
                    </span>
                  </>
                ) : option.kind === 'text' ? (
                  <span className="ds-truncate">
                    Filter by text: "{value.trim()}"
                  </span>
                ) : (
                  <>
                    <Sparkles className="ds-i" data-size="sm" aria-hidden />
                    AI search
                  </>
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
