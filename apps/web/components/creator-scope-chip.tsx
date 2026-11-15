'use client'

import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import {
  ArtistDetailSchema,
  PersonDetailSchema,
  type ArtistDetail,
  type PersonDetail,
} from '@repo/schemas/creators'
import { fetchApiData } from '@/utils/api'
import {
  personRoleLabels,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import { FilterButton } from './filter-affordance'
import { useConfig } from './providers'

export function CreatorScopeChip({
  scope,
  film = false,
  onRemove,
}: {
  scope: CreatorBrowseScope
  film?: boolean
  onRemove: () => void
}) {
  const { apiBaseUrl } = useConfig()
  const { creatorId, creatorRole } = scope
  const query = useQuery<ArtistDetail | PersonDetail>({
    queryKey: [film ? 'person' : 'artist', creatorId],
    queryFn: ({ signal }) => {
      const id = encodeURIComponent(creatorId)
      return film
        ? fetchApiData(apiBaseUrl, `/api/v1/people/${id}`, PersonDetailSchema, {
            signal,
          })
        : fetchApiData(
            apiBaseUrl,
            `/api/v1/artists/${id}`,
            ArtistDetailSchema,
            { signal },
          )
    },
  })
  const label = creatorRole
    ? personRoleLabels[creatorRole]
    : film
      ? 'Person'
      : 'Artist'
  return (
    <FilterButton
      className="filter-pill filter-required"
      aria-label={`Remove ${label.toLowerCase()} filter`}
      onClick={onRemove}
    >
      {query.data ? `${label}: ${query.data.name}` : label}{' '}
      <X size={12} aria-hidden="true" />
    </FilterButton>
  )
}
