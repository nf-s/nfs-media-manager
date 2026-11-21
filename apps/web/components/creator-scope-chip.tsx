'use client'

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArtistDetailSchema,
  PersonDetailSchema,
  type ArtistDetail,
  type PersonDetail,
} from '@repo/schemas/creators'
import { fetchApiData } from '@/utils/api'
import { detailPageHref } from '@/utils/detail-inspector'
import {
  personRoleLabels,
  type CreatorBrowseScope,
} from '@/utils/creator-browse'
import { BrowseFilterPill } from './browse-controls'
import { useConfig } from './providers'

export function CreatorScopeChip({
  scope,
  film = false,
  onMoved,
  onRemove,
}: {
  scope: CreatorBrowseScope
  film?: boolean
  /** The scope names an artist that was merged into another: the kept artist's ID. */
  onMoved: (creatorId: string) => void
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
  const currentId = query.data?.id
  useEffect(() => {
    if (currentId !== undefined && currentId !== creatorId) onMoved(currentId)
  }, [creatorId, currentId, onMoved])
  const label = creatorRole
    ? personRoleLabels[creatorRole]
    : film
      ? 'Person'
      : 'Artist'
  return (
    <BrowseFilterPill
      mode="required"
      destination={{
        href: detailPageHref({
          kind: film ? 'person' : 'artist',
          id: creatorId,
        }),
        label: query.data?.name ?? label,
      }}
      removeLabel={`Remove ${label.toLowerCase()} filter`}
      onRemove={onRemove}
    >
      {query.data ? `${label}: ${query.data.name}` : label}
    </BrowseFilterPill>
  )
}
