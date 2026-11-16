'use client'

import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { BrowseFieldSchema } from '@repo/schemas/browse'
import { FilmSelectionPageSchema } from '@repo/schemas/film-selection'
import { AlbumSelectionPageSchema } from '@repo/schemas/album-selection'
import { PaginatedDataSchema } from '@repo/schemas/common'
import { AlbumListItemSchema, FilmListItemSchema } from '@repo/schemas/media'
import type { MediaScope } from '@/utils/media-scope'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import {
  matchingTitleFilters,
  titleSuggestions,
} from '@/utils/browse-suggestions'
import { useBrowseFacets } from './useBrowseFacets'
import { useVirtualTable } from './useVirtualTable'

const TitlePageSchema = PaginatedDataSchema(
  z.union([AlbumListItemSchema, FilmListItemSchema]),
)

export function useFilmSelection(
  params: string,
  mediaType: MediaScope = 'film',
  draft = '',
  paused = false,
) {
  const resource = mediaType === 'album' ? 'albums' : 'films'
  const { apiBaseUrl } = useConfig()
  const fields = useQuery({
    queryKey: [`${mediaType}-fields`],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${resource}/fields`,
        z.array(BrowseFieldSchema),
      ),
  })
  const facets = useBrowseFacets(apiBaseUrl, resource, draft, !paused)
  const titleFilters = matchingTitleFilters(facets.data ?? [], facets.search)
  const matches = useQuery({
    queryKey: [resource, 'title-suggestions', titleFilters, false],
    enabled: !paused && titleFilters.length > 0,
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({
        page: '1',
        size: '100',
        filters: JSON.stringify(titleFilters),
        sortBy: 'title',
        direction: 'asc',
        includeArchived: 'false',
      })
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/${resource}?${query}`,
        TitlePageSchema,
        { signal },
      )
    },
  })
  const titlesLoading =
    facets.isDebouncing ||
    facets.isPending ||
    (titleFilters.length > 0 && matches.isPending)
  const films = useVirtualTable({
    queryKey: [`${mediaType}-selection`, params],
    pageSize: 50,
    headerHeight: 28,
    enabled: !paused,
    refetchInterval: 10_000,
    loadPage: (page, size, signal) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${resource}/selection?${params}&page=${page}&size=${size}`,
        mediaType === 'album'
          ? AlbumSelectionPageSchema
          : FilmSelectionPageSchema,
        { signal },
      ),
  })
  return {
    fields,
    facets,
    films,
    titleItems:
      titleFilters.length > 0
        ? titleSuggestions(matches.data?.items ?? [])
        : [],
    titlesLoading,
    titlesError: facets.isError || (titleFilters.length > 0 && matches.isError),
  }
}
