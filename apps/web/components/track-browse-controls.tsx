'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  BrowseFieldSchema,
  trackBrowseFields,
  type BrowseField,
  type BrowseFilter,
  type BrowseRange,
} from '@repo/schemas/browse'
import { trackMatchDiagnosticFields } from '@repo/schemas/match-diagnostics'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { TrackListItemSchema } from '@repo/schemas/tracks'
import { useBrowseFacets } from '@/hooks/useBrowseFacets'
import { aiSearchParams, mediaAiSearchTarget } from '@/utils/ai-search'
import { fetchApiData } from '@/utils/api'
import { formatFieldValue, orderFields } from '@/utils/browse-items'
import { matchingTitleFilters } from '@/utils/browse-suggestions'
import {
  clearCreatorScope,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import { loadTrackMatchDiagnosticsPage } from '@/utils/match-diagnostics'
import { trackFieldOrder, trackTitleSuggestions } from '@/utils/track-browse'
import AiSearch from './ai-search'
import { BrowseFilterChips, BrowseFilterPill } from './browse-controls'
import { CreatorScopeChip } from './creator-scope-chip'
import { useConfig } from './providers'

const PageSchema = PaginatedDataSchema(TrackListItemSchema)

export function useTrackBrowseFields(matches = false, enabled = true) {
  const { apiBaseUrl } = useConfig()
  const fields = useQuery({
    queryKey: matches ? ['tracks', 'match-fields'] : ['tracks', 'fields'],
    enabled,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks${matches ? '/match-diagnostics' : ''}/fields`,
        z.array(BrowseFieldSchema),
        { signal },
      ),
  })
  return orderFields(
    fields.data ?? (matches ? trackMatchDiagnosticFields : trackBrowseFields),
    trackFieldOrder,
  )
}

export function TrackBrowseSearch({
  fields,
  filters,
  creator,
  queryIdentity,
  onOpenItem,
  onAddFilter,
  setParams,
  ready = true,
  disabled = false,
  matches = false,
}: {
  fields: BrowseField[]
  filters: BrowseFilter[]
  creator?: CreatorBrowseScope
  queryIdentity: string
  onOpenItem: (id: string, trigger?: HTMLElement) => void
  onAddFilter: (filter: BrowseFilter, keepOpen?: boolean) => void
  setParams: (updates: Record<string, string | null>) => void
  ready?: boolean
  disabled?: boolean
  matches?: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState('')
  const facets = useBrowseFacets(
    apiBaseUrl,
    'tracks',
    draft,
    ready && !disabled,
    matches,
  )
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const titleMatches = useQuery({
    queryKey: [
      'tracks',
      matches ? 'match-title-suggestions' : 'title-suggestions',
      titleFilters,
      ...(creator ? [creator] : []),
    ],
    enabled: ready && !disabled && titleFilters.length > 0,
    queryFn: async ({ signal }) => {
      const direction: 'asc' = 'asc'
      const query = {
        page: 1,
        size: 100,
        filters: titleFilters,
        sortBy: 'title',
        direction,
        ...creator,
      }
      if (matches) {
        const result = await loadTrackMatchDiagnosticsPage(
          apiBaseUrl,
          { ...query, ranges: [] },
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
      const params = new URLSearchParams({
        page: String(query.page),
        size: String(query.size),
        filters: JSON.stringify(query.filters),
        sortBy: query.sortBy,
        direction: query.direction,
        ...creator,
      })
      return fetchApiData(apiBaseUrl, `/api/v1/tracks?${params}`, PageSchema, {
        signal,
      })
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
}: {
  q: string
  creator?: CreatorBrowseScope
  filters: BrowseFilter[]
  ranges: BrowseRange[]
  fields: BrowseField[]
  limitResults?: number
  setParams: (updates: Record<string, string | null>) => void
}) {
  return (
    <>
      {creator && (
        <CreatorScopeChip
          scope={creator}
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
