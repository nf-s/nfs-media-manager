'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
  type TagLevels,
} from '@repo/schemas/browse'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { formatFieldValue, type BrowseFilterHref } from '@/utils/browse-items'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import {
  clearCreatorScope,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import { loadTrackMatchDiagnosticsPage } from '@/utils/match-diagnostics'
import {
  loadTrackTitleMatches,
  trackTitleSuggestions,
} from '@/utils/track-browse'
import AiSearch from './ai-search'
import { BrowseFilterChips, BrowseFilterPill } from './browse-controls'
import { CreatorScopeChip } from './creator-scope-chip'
import { useConfig } from './providers'

export function TrackBrowseSearch({
  fields,
  filters,
  creator,
  queryIdentity,
  onOpenItem,
  onAddFilter,
  filterHref,
  searchHref,
  setParams,
  ready = true,
  disabled = false,
  matches = false,
  tagLevels,
  catalogParams,
}: {
  fields: BrowseField[]
  filters: BrowseFilter[]
  creator?: CreatorBrowseScope
  queryIdentity: string
  onOpenItem: (id: string, trigger?: HTMLElement) => void
  onAddFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
  filterHref?: BrowseFilterHref
  searchHref?: (value: string) => string
  setParams: (updates: Record<string, string | null>) => void
  ready?: boolean
  disabled?: boolean
  matches?: boolean
  /** Where the Tags suggestions are counted; left out for Auto. */
  tagLevels?: TagLevels
  catalogParams?: Readonly<Record<string, string>>
}) {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState('')
  const facets = useBrowseFacets(
    apiBaseUrl,
    'tracks',
    draft,
    ready && !disabled,
    matches,
    tagLevels,
    false,
    catalogParams,
  )
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [
      'tracks',
      matches ? 'match-title-suggestions' : 'title-suggestions',
      titleFilters,
      ...(creator ? [creator] : []),
      ...(catalogParams ? [catalogParams] : []),
    ],
    enabled: ready && !disabled && titleFilters.length > 0,
    queryFn: async ({ signal }) => {
      if (matches) {
        const result = await loadTrackMatchDiagnosticsPage(
          apiBaseUrl,
          {
            page: 1,
            size: 100,
            filters: titleFilters,
            ranges: [],
            sortBy: 'title',
            direction: 'asc',
            ...creator,
          },
          signal,
        )
        return {
          items: result.items.map(({ id, name, creator, track }) => ({
            id,
            title: name,
            artists: track?.artists ?? (creator ? [creator] : []),
          })),
        }
      }
      return loadTrackTitleMatches(
        apiBaseUrl,
        titleFilters,
        creator,
        signal,
        catalogParams,
      )
    },
  })
  const titlesLoading =
    facets.isDebouncing ||
    facets.isPending ||
    (titleFilters.length > 0 && titleMatches.isPending)
  const items =
    !titlesLoading && draft.trim() && titleFilters.length > 0
      ? trackTitleSuggestions(titleMatches.data?.items ?? [])
      : []
  const options = (facets.data ?? []).filter(
    (option) =>
      !filters.some(
        (filter) =>
          filter.field === option.field && filter.value === option.value,
      ),
  )
  return (
    <AiSearch
      target={mediaAiSearchTarget(
        'track',
        fields,
        matches ? 'matches' : undefined,
      )}
      queryIdentity={queryIdentity}
      autocomplete={{
        items,
        itemKind: 'track',
        titlesLoading,
        titlesError:
          facets.isError || (titleFilters.length > 0 && titleMatches.isError),
        onOpenItem,
        options,
        placeholder: 'Search titles, artists, albums, playlists...',
        value: draft,
        disabled,
        onFocus: facets.activate,
        onValueChange: setDraft,
        onAddFilter,
        filterHref,
        searchHref,
        onApplyText: (value) => {
          setParams({ q: value || null })
          setDraft('')
        },
      }}
      onApply={(plan) => {
        setParams(aiSearchParams(plan, matches ? 'matches' : undefined))
        setDraft('')
      }}
    />
  )
}

export function TrackBrowseFilterChips({
  q,
  creator,
  filters,
  ranges,
  fields,
  limitResults,
  setParams,
  filterHref,
}: {
  q: string
  creator?: CreatorBrowseScope
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  fields: BrowseField[]
  limitResults?: number
  setParams: (updates: Record<string, string | null>) => void
  filterHref?: BrowseFilterHref
}) {
  return (
    <>
      {creator && (
        <CreatorScopeChip
          scope={creator}
          onMoved={(creatorId) => setParams({ creatorId })}
          onRemove={() => setParams(clearCreatorScope)}
        />
      )}
      {q && (
        <BrowseFilterPill
          removeLabel="Remove search"
          onRemove={() => setParams({ q: null })}
        >
          Search: {q}
        </BrowseFilterPill>
      )}
      <BrowseFilterChips
        filters={filters}
        fields={fields}
        filterHref={filterHref}
        onChange={(next) =>
          setParams({ filters: next.length ? JSON.stringify(next) : null })
        }
      />
      {ranges.map((range) => {
        const field = fields.find((field) => field.key === range.field)
        const bound = (value: number | undefined) =>
          value === undefined
            ? '*'
            : field
              ? formatFieldValue(field, value)
              : String(value)
        const label = `${field?.label ?? range.field}: ${bound(range.min)} to ${bound(range.max)}${range.includeMissing ? ' + missing' : ''}`
        return (
          <BrowseFilterPill
            key={range.field}
            removeLabel={`Remove ${label}`}
            onRemove={() =>
              setParams({
                ranges: JSON.stringify(
                  ranges.filter((item) => item.field !== range.field),
                ),
              })
            }
          >
            {label}
          </BrowseFilterPill>
        )
      })}
      {limitResults !== undefined && (
        <BrowseFilterPill
          removeLabel="Remove result limit"
          onRemove={() => setParams({ limitResults: null })}
        >
          Limit: {limitResults}
        </BrowseFilterPill>
      )}
    </>
  )
}
