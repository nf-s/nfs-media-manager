'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  LastfmSpotifySearchInputSchema,
  type LastfmLinkGroup,
} from '@repo/schemas/lastfm'
import { formatCount, formatItemCount } from '@repo/ui/lib/format'
import { fetchApiData } from '@/utils/api'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { canSearchLastfmGroup, lastfmLinkKey } from '@/utils/lastfm-sync'
import { scopedHref } from '@/utils/media-scope'
import { useConfig } from './providers'
import { ConfirmAction } from './confirm-action'

const ALBUMS = { one: 'album', other: 'albums' }

export default function LastfmSearchActions({
  groups,
  selectedIds,
  onSelect,
  onPending,
  disabled,
}: {
  groups: LastfmLinkGroup[]
  selectedIds: string[]
  onSelect: (ids: string[]) => void
  onPending: (pending: boolean) => void
  disabled: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const [batchId, setBatchId] = useState('')
  const [progress, setProgress] = useState(0)
  const targets = groups.filter(
    (group) =>
      selectedIds.includes(lastfmLinkKey(group)) && canSearchLastfmGroup(group),
  )
  const ids = targets.map(lastfmLinkKey)
  const queue = useMutation({
    mutationFn: (confirmed: boolean) => {
      if (ids.length > 5 && !confirmed)
        throw new Error('Confirm the selected searches before continuing.')
      const batch = crypto.randomUUID()
      setBatchId(batch)
      return dispatchFilmSelection(
        ids,
        (chunk) =>
          fetchApiData(
            apiBaseUrl,
            '/api/v1/lastfm/links/spotify-search',
            EnrichmentResultSchema,
            {
              method: 'POST',
              body: JSON.stringify(
                LastfmSpotifySearchInputSchema.parse({
                  groups: targets
                    .filter((group) => chunk.includes(lastfmLinkKey(group)))
                    .map(({ artistName, albumName }) => ({
                      artistName,
                      albumName,
                    })),
                  batchId: batch,
                  confirmBroadRun: ids.length > 5 && confirmed,
                }),
              ),
            },
          ),
        setProgress,
      )
    },
    onMutate: () => {
      setProgress(0)
      onPending(true)
    },
    onSuccess: (result) => {
      onSelect(selectedIds.filter((id) => !result.completed.includes(id)))
    },
    onSettled: async () => {
      try {
        await Promise.all([
          client.invalidateQueries({ queryKey: ['jobs'] }),
          client.invalidateQueries({ queryKey: ['job-activity'] }),
          client.invalidateQueries({ queryKey: ['lastfm-links'] }),
        ])
      } finally {
        onPending(false)
      }
    },
  })
  if (
    !selectedIds.length &&
    !queue.isPending &&
    !queue.isError &&
    !queue.data
  )
    return null
  return (
    <div className="sec-selectbar-actions">
      {selectedIds.length > ids.length && (
        <span className="ds-muted">
          {formatCount(selectedIds.length - ids.length)} no longer eligible
        </span>
      )}
      {queue.isPending && (
        <span role="status">
          Queueing searches: {formatCount(progress)} confirmed...
        </span>
      )}
      {queue.isError && <span role="alert">{queue.error.message}</span>}
      {queue.data && (
        <span role="status">
          {formatCount(queue.data.queued)} queued ·{' '}
          {formatCount(queue.data.skipped)} skipped.{' '}
          {batchId && (
            <Link
              href={scopedHref(
                `/jobs?batchId=${encodeURIComponent(batchId)}`,
                'album',
              )}
            >
              View search jobs
            </Link>
          )}
          {queue.data.warnings.map((warning) => (
            <span key={warning} className="block">
              {warning}
            </span>
          ))}
        </span>
      )}
      {selectedIds.length > 0 && (
        <span className="ds-actions">
          <ConfirmAction
            variant="primary"
            confirm={ids.length > 5}
            question={`Search Spotify for ${formatItemCount(ids.length, ALBUMS)}?`}
            details="Each search is a Spotify request; provider pacing applies."
            confirmLabel="Search"
            disabled={disabled || queue.isPending || !ids.length}
            onConfirm={() => queue.mutate(ids.length > 5)}
          >
            Search Spotify albums
          </ConfirmAction>
        </span>
      )}
    </div>
  )
}
