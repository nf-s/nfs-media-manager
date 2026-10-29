'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { BrowseFieldSchema } from '@repo/schemas/browse'
import { FilmFilterOptionSchema } from '@repo/schemas/media'
import { FilmSelectionPageSchema } from '@repo/schemas/film-selection'
import { AlbumSelectionPageSchema } from '@repo/schemas/album-selection'
import type { MediaScope } from '@/utils/media-scope'
import { useConfig } from '@/components/providers'
import { fetchApiData } from '@/utils/api'

export function useFilmSelection(
  params: string,
  mediaType: MediaScope = 'film',
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
    staleTime: 60000,
  })
  const facets = useQuery({
    queryKey: [`${mediaType}-facets`],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${resource}/facets`,
        z.array(FilmFilterOptionSchema),
      ),
    staleTime: 60000,
  })
  const films = useInfiniteQuery({
    queryKey: [`${mediaType}-selection`, params],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/${resource}/selection?${params}&page=${pageParam}&size=50`,
        mediaType === 'album'
          ? AlbumSelectionPageSchema
          : FilmSelectionPageSchema,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.pageCount ? last.page + 1 : undefined,
    staleTime: 10000,
  })
  return { fields, facets, films }
}
