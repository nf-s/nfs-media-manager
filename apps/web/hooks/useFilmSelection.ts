'use client'

import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { BrowseFieldSchema } from '@repo/schemas/browse'
import { FilmSelectionPageSchema } from '@repo/schemas/film-selection'
import { AlbumSelectionPageSchema } from '@repo/schemas/album-selection'
import type { MediaScope } from '@/utils/media-scope'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'
import { useBrowseFacets } from './useBrowseFacets'
import { useVirtualTable } from './useVirtualTable'

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
  const facets = useBrowseFacets(apiBaseUrl, resource, draft)
  const films = useVirtualTable({
    queryKey: [`${mediaType}-selection`, params],
    pageSize: 50,
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
  return { fields, facets, films }
}
