'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  LastfmSpotifySearchInputSchema,
  type LastfmLinkGroup,
} from '@repo/schemas/lastfm'
import { Button } from '@repo/ui/components/ui/button'
import { fetchApiData } from '@/utils/api'
import { dispatchFilmSelection } from '@/utils/film-selection'
import { canSearchLastfmGroup, lastfmLinkKey } from '@/utils/lastfm-sync'
import { scopedHref } from '@/utils/media-scope'
import { useConfig } from './providers'

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
  const [confirmedKey, setConfirmedKey] = useState('')
  const [batchId, setBatchId] = useState('')
  const [progress, setProgress] = useState(0)
  const targets = groups.filter(
    (group) =>
      selectedIds.includes(lastfmLinkKey(group)) && canSearchLastfmGroup(group),
  )
  const ids = targets.map(lastfmLinkKey)
  const confirmationKey = JSON.stringify(ids)
  const confirmed = confirmedKey === confirmationKey
  useEffect(() => setConfirmedKey(''), [confirmationKey])
  const queue = useMutation({
    mutationFn: () => {
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
      setConfirmedKey('')
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
  return (
    <div className="job-selection-toolbar">
      {selectedIds.length ? (
        <>
          <span>{selectedIds.length} selected</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || queue.isPending}
            onClick={() => {
              onSelect([])
              setConfirmedKey('')
            }}
          >
            Clear
          </Button>
          {ids.length > 5 && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={disabled || queue.isPending}
                onChange={(event) =>
                  setConfirmedKey(event.target.checked ? confirmationKey : '')
                }
              />
              Confirm {ids.length} Spotify album searches
            </label>
          )}
          <Button
            size="sm"
            disabled={
              disabled ||
              queue.isPending ||
              !ids.length ||
              (ids.length > 5 && !confirmed)
            }
            onClick={() => queue.mutate()}
          >
            Search Spotify albums
          </Button>
          {selectedIds.length > ids.length && (
            <span className="muted">
              {selectedIds.length - ids.length} no longer eligible
            </span>
          )}
        </>
      ) : (
        <span className="muted">Shift-click to select a range.</span>
      )}
      {queue.isPending && (
        <span role="status">Queueing searches: {progress} confirmed...</span>
      )}
      {queue.isError && <p role="alert">{queue.error.message}</p>}
      {queue.data && (
        <div role="status" className="w-full">
          {queue.data.queued} queued · {queue.data.skipped} skipped.{' '}
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
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  )
}
