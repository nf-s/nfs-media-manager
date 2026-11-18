'use client'

import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { BrowsePageSliceSchema } from '@repo/schemas/browse'
import { TrackListItemSchema, type TrackListItem } from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { clientQueryDefaults } from '@/utils/query-cache'

const pageSize = 10
const VersionsPage = BrowsePageSliceSchema(TrackListItemSchema)

type Expansion = {
  identity: string
  id: string
  index: number
  page: number
}

export function useTrackRecordingVersions(
  apiBaseUrl: string,
  identity: string,
  params: URLSearchParams,
) {
  const [selection, setSelection] = useState<Expansion | null>(null)
  const collapse = useCallback(() => setSelection(null), [])
  const expanded = selection?.identity === identity ? selection : null
  const page = expanded?.page ?? 1
  const query = useQuery({
    queryKey: ['tracks', 'recording-versions', identity, expanded?.id, page],
    enabled: expanded !== null,
    queryFn: ({ signal }) => {
      if (!expanded) throw new Error('No recording is selected.')
      const query = new URLSearchParams(params)
      query.set('page', String(page))
      query.set('size', String(pageSize))
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/tracks/${encodeURIComponent(expanded.id)}/recordings?${query}`,
        VersionsPage,
        { signal },
      )
    },
    ...clientQueryDefaults,
    retry: false,
  })
  const items = query.data?.items ?? []
  const needsPager = page > 1 || query.data?.hasMore === true

  return {
    expanded,
    items,
    needsPager,
    loading: query.isPending,
    error: query.isError,
    nextPage: query.data?.hasMore === true,
    page,
    rowCount: Math.max(1, items.length) + Number(needsPager),
    collapse,
    retry: () => void query.refetch(),
    goToPage: (page: number) => {
      if (expanded) setSelection({ ...expanded, page })
    },
    toggle: (id: string, index: number) => {
      setSelection(
        expanded?.id === id ? null : { identity, id, index, page: 1 },
      )
    },
  }
}

export function RecordingVersionsToggle({
  track,
  index,
  versions,
}: {
  track: TrackListItem
  index: number
  versions: ReturnType<typeof useTrackRecordingVersions>
}) {
  const group = track.recordingGroup
  if (!group) return null
  const open = versions.expanded?.id === track.id
  const label = `${open ? 'Hide' : 'Show'} ${group.versionCount} release versions for ${track.title}`
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      icon
      aria-expanded={open}
      aria-label={label}
      title={label}
      onClick={() => versions.toggle(track.id, index)}
    >
      <Chevron className="ds-i" data-size="sm" aria-hidden />
    </Button>
  )
}

export function RecordingVersionsStatus({
  versions,
}: {
  versions: ReturnType<typeof useTrackRecordingVersions>
}) {
  if (versions.loading) return <span role="status">Loading versions…</span>
  if (versions.error)
    return (
      <span role="alert">
        Could not load versions.{' '}
        <Button type="button" variant="link" size="xs" onClick={versions.retry}>
          Retry
        </Button>
      </span>
    )
  return <span role="status">No matching versions.</span>
}

export function RecordingVersionsPager({
  versions,
}: {
  versions: ReturnType<typeof useTrackRecordingVersions>
}) {
  return (
    <span className="ds-cell-id">
      <Button
        type="button"
        size="xs"
        aria-label="Previous release versions"
        disabled={versions.page === 1}
        onClick={() => versions.goToPage(versions.page - 1)}
      >
        Previous
      </Button>
      <span className="ds-muted">Page {versions.page}</span>
      <Button
        type="button"
        size="xs"
        aria-label="Next release versions"
        disabled={!versions.nextPage}
        onClick={() => versions.goToPage(versions.page + 1)}
      >
        Next
      </Button>
    </span>
  )
}
