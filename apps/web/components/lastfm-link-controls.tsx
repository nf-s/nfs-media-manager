'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PaginatedDataSchema } from '@repo/schemas/common'
import {
  LastfmLinkReportSchema,
  LastfmSyncStatusSchema,
  type LastfmLinkUpdate,
} from '@repo/schemas/lastfm'
import { AlbumListItemSchema } from '@repo/schemas/media'
import { formatCount } from '@repo/ui/lib/format'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { fetchApiData } from '@/utils/api'
import {
  albumPickerPath,
  lastfmLinkReasonLabels,
  lastfmLinksPath,
} from '@/utils/lastfm-sync'
import { invalidateScrobbleLinks } from './lastfm-sync'
import { useConfig } from './providers'

const AlbumPageSchema = PaginatedDataSchema(AlbumListItemSchema)
const SEARCH_RESULTS = 8

/** Links, unlinks or resets one scrobbled artist and album name. */
export function useLastfmLinkUpdate() {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: LastfmLinkUpdate) =>
      fetchApiData(apiBaseUrl, '/api/v1/lastfm/links', LastfmSyncStatusSchema, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: async (next) => {
      client.setQueryData(['lastfm-sync'], next)
      await invalidateScrobbleLinks(client)
    },
  })
}

function useDebounced(value: string) {
  const [settled, setSettled] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [value])
  return settled
}

/** Searches library albums and reports the chosen one. */
export function AlbumPicker({
  label,
  disabled,
  onPick,
  initialQuery = '',
  enabled = true,
}: {
  label: string
  disabled: boolean
  onPick: (albumId: string) => void
  initialQuery?: string
  enabled?: boolean
}) {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState(initialQuery.slice(0, 200))
  const query = useDebounced(draft)
  const albums = useQuery({
    queryKey: ['album-picker', query],
    enabled: enabled && query.length > 1,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        albumPickerPath(query, SEARCH_RESULTS),
        AlbumPageSchema,
        { signal },
      ),
  })
  return (
    <div className="data-stack">
      <Input
        type="search"
        aria-label={label}
        placeholder="Search library albums"
        maxLength={200}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {albums.isError && (
        <Notice tone="danger">Could not search albums.</Notice>
      )}
      {albums.data && !albums.data.items.length && (
        <p className="ds-muted">No albums found.</p>
      )}
      {albums.data && albums.data.items.length > 0 && (
        <ul className="data-picker">
          {albums.data.items.map((album) => (
            <li key={album.id}>
              <Button
                size="xs"
                disabled={disabled}
                onClick={() => onPick(album.id)}
              >
                Link
              </Button>
              <span className="ds-truncate">
                {album.title}
                {' — '}
                {album.credits
                  .filter((credit) => credit.role === 'artist')
                  .map((credit) => credit.name)
                  .join(', ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Searches every scrobbled artist and album name and reports the chosen one. */
export function ScrobbledNamePicker({
  disabled,
  onPick,
}: {
  disabled: boolean
  onPick: (name: { artistName: string; albumName: string }) => void
}) {
  const { apiBaseUrl } = useConfig()
  const [draft, setDraft] = useState('')
  const query = useDebounced(draft)
  const names = useQuery({
    queryKey: ['lastfm-links', 'picker', query],
    enabled: query.length > 1,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        lastfmLinksPath({
          reason: '',
          q: query,
          page: 1,
          size: SEARCH_RESULTS,
        }),
        LastfmLinkReportSchema,
        { signal },
      ),
  })
  return (
    <div className="data-stack">
      <Input
        type="search"
        aria-label="Search scrobbled names"
        placeholder="Search scrobbled artists or albums"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      {names.isError && (
        <Notice tone="danger">Could not search scrobbled names.</Notice>
      )}
      {names.data && !names.data.items.length && (
        <p className="ds-muted">No scrobbled names found.</p>
      )}
      {names.data && names.data.items.length > 0 && (
        <ul className="data-picker">
          {names.data.items.map((group) => {
            const albumName = group.albumName
            return (
              <li key={`${group.artistName}\u0000${albumName ?? ''}`}>
                <Button
                  size="xs"
                  disabled={disabled || albumName === null}
                  onClick={() => {
                    if (albumName !== null)
                      onPick({ artistName: group.artistName, albumName })
                  }}
                >
                  Add
                </Button>
                <span className="ds-truncate">
                  {group.artistName} — {albumName ?? '–'} ·{' '}
                  <span className="ds-num">{formatCount(group.scrobbles)}</span>{' '}
                  · {lastfmLinkReasonLabels[group.reason]}
                  {group.album ? `: ${group.album.title}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
