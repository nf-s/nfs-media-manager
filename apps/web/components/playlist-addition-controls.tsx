'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  PlaylistAlbumAdditionInputSchema,
  PlaylistAlbumAdditionSchema,
  PlaylistAlbumAdditionsSchema,
  PlaylistSummarySchema,
  type PlaylistSummary,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import AllowPlaylistChanges from './spotify-playlist-changes'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import {
  invalidatePlaylists,
  playlistJobActive,
  playlistJobProgress,
} from '@/utils/playlist-sync'
import {
  TrackPlaylistAdditionInputSchema,
  TrackPlaylistAdditionSchema,
  TrackPlaylistAdditionsSchema,
} from '@repo/schemas/track-playlist-additions'

type Addition = { playlistId: string; job: SpotifyPlaylistJob }
type PlaylistMediaType = 'album' | 'track'

/** Playlists with more entries than this get a filter in the picker. */
const FILTER_THRESHOLD = 8

const additionLabels: Record<SpotifyPlaylistJob['status'], string> = {
  queued: 'Queued',
  running: 'Adding',
  succeeded: 'Added',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Playlists re-imported after an item was added to them, while that import runs. */
function followOnImports(
  additions: Addition[],
  playlists: PlaylistSummary[] | undefined,
) {
  const added = new Set(
    additions
      .filter((addition) => addition.job.status === 'succeeded')
      .map((addition) => addition.playlistId),
  )
  return (playlists ?? []).some(
    (playlist) =>
      added.has(playlist.id) && playlistJobActive(playlist.sync.job),
  )
}

export function resolvedTrackReplacement(
  id: string,
  additions: Array<Addition & { resolvedTrackId?: string | null }>,
) {
  return (
    additions.find(
      (addition) =>
        addition.job.status === 'succeeded' &&
        addition.resolvedTrackId &&
        addition.resolvedTrackId !== id,
    )?.resolvedTrackId ?? null
  )
}

export function usePlaylistAdditions(
  mediaType: PlaylistMediaType,
  id: string,
  onTrackResolved?: (trackId: string) => void,
) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const resolvedCallback = useRef(onTrackResolved)
  resolvedCallback.current = onTrackResolved
  const additions = useQuery({
    queryKey: [
      mediaType === 'album' ? 'playlist-additions' : 'track-playlist-additions',
      id,
    ],
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.additions.some((addition) =>
        playlistJobActive(addition.job),
      ) ||
      followOnImports(
        query.state.data?.additions ?? [],
        client.getQueryData<PlaylistSummary[]>(['playlists']),
      )
        ? 2000
        : false,
    queryFn: async () => {
      if (mediaType === 'track')
        return fetchApiData(
          apiBaseUrl,
          `/api/v1/tracks/${encodeURIComponent(id)}/playlist-additions`,
          TrackPlaylistAdditionsSchema,
        )
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/additions?${new URLSearchParams({ albumId: id })}`,
        PlaylistAlbumAdditionsSchema,
      )
    },
  })
  const additionList = additions.data?.additions ?? []
  const adding = additionList.some((addition) =>
    playlistJobActive(addition.job),
  )
  const playlists = useQuery({
    queryKey: ['playlists'],
    staleTime: 0,
    refetchInterval: (query) =>
      adding || followOnImports(additionList, query.state.data) ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/playlists',
        z.array(PlaylistSummarySchema),
      ),
  })
  const importing = followOnImports(additionList, playlists.data)
  // The playlist import can replace an album-derived Last.fm identity.
  // Resolve that identity before refreshing an open detail request.
  const following = adding || importing
  const wasFollowing = useRef(following)
  const completed = additionList
    .filter((addition) => addition.job.status === 'succeeded')
    .map((addition) => addition.job.jobId)
    .sort()
    .join(',')
  const observedCompleted = useRef('')
  const resolvedOnce = useRef<string | null>(null)
  const replacement = resolvedTrackReplacement(id, additionList)
  useEffect(() => {
    if (!replacement || resolvedOnce.current === replacement) return
    resolvedOnce.current = replacement
    resolvedCallback.current?.(replacement)
    void invalidateScrobbleLinks(client, id)
  }, [replacement, id, client])
  const refetchAdditions = additions.refetch
  const refetchPlaylists = playlists.refetch
  useEffect(() => {
    if (
      (wasFollowing.current && !following) ||
      (completed && completed !== observedCompleted.current)
    ) {
      void (async () => {
        const latestPlaylists = await refetchPlaylists()
        const latest = await refetchAdditions()
        if (latestPlaylists.isError || latest.isError) return
        if (followOnImports(latest.data?.additions ?? [], latestPlaylists.data))
          return
        const next = resolvedTrackReplacement(id, latest.data?.additions ?? [])
        if (next && mounted.current && resolvedOnce.current !== next) {
          resolvedOnce.current = next
          resolvedCallback.current?.(next)
        }
        await Promise.all([
          next
            ? invalidateScrobbleLinks(client, id)
            : invalidatePlaylists(client),
          client.invalidateQueries({ queryKey: ['spotify-playlists'] }),
          client.invalidateQueries({ queryKey: ['jobs'] }),
          client.invalidateQueries({ queryKey: ['job-activity'] }),
        ])
      })()
    }
    wasFollowing.current = following
    observedCompleted.current = completed
  }, [following, completed, client, id, refetchAdditions, refetchPlaylists])

  return { additions, additionList, playlists, following }
}

export function AdditionState({
  addition,
  name,
  mediaType = 'album',
}: {
  addition: Addition
  name: string
  mediaType?: PlaylistMediaType
}) {
  const { job } = addition
  const progress = playlistJobActive(job)
    ? playlistJobProgress(job.progress)
    : null
  return (
    <li>
      {name}{' '}
      <Link
        className="job-status underline underline-offset-2"
        data-status={job.status}
        title={mediaType === 'track' ? 'View job in Albums' : undefined}
        aria-label={
          mediaType === 'track'
            ? `${additionLabels[job.status]} · View job in Albums`
            : undefined
        }
        href={scopedHref(
          `/jobs?jobId=${encodeURIComponent(job.jobId)}`,
          'album',
        )}
      >
        {additionLabels[job.status]}
      </Link>
      {progress && <span className="quiet"> {progress}</span>}
      {job.status === 'succeeded' && job.finishedAt && (
        <span className="quiet">
          {' '}
          <time dateTime={job.finishedAt}>
            {new Date(job.finishedAt).toLocaleString()}
          </time>
        </span>
      )}
      {job.status === 'failed' && job.errorMessage && (
        <span className="block" role="alert">
          {job.errorMessage}
        </span>
      )}
    </li>
  )
}

export function AddToPlaylist({
  mediaType,
  id,
  playlists,
  additions,
}: {
  mediaType: PlaylistMediaType
  id: string
  playlists: {
    data: PlaylistSummary[] | undefined
    isError: boolean
    refetch: () => unknown
  }
  additions: Addition[]
}) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const account = useQuery({
    queryKey: ['spotify-account'],
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/status',
        SpotifyAccountStatusSchema,
      ),
  })
  const add = useMutation({
    mutationFn: async (playlistId: string) => {
      if (mediaType === 'track')
        return fetchApiData(
          apiBaseUrl,
          `/api/v1/tracks/${encodeURIComponent(id)}/playlist-additions`,
          TrackPlaylistAdditionSchema,
          {
            method: 'POST',
            body: JSON.stringify(
              TrackPlaylistAdditionInputSchema.parse({ playlistId }),
            ),
          },
        )
      return fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/${encodeURIComponent(playlistId)}/additions`,
        PlaylistAlbumAdditionSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            PlaylistAlbumAdditionInputSchema.parse({ albumId: id }),
          ),
        },
      )
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: [
            mediaType === 'album'
              ? 'playlist-additions'
              : 'track-playlist-additions',
            id,
          ],
        }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  const importHref = scopedHref('/imports/spotify-playlists', mediaType)
  const status = account.data
  if (account.isError)
    return (
      <p role="alert" className="quiet mt-2">
        Could not load the Spotify connection.{' '}
        <button className="underline" onClick={() => account.refetch()}>
          Retry
        </button>
      </p>
    )
  if (!status) return null
  if (!status.connected || !status.playlists)
    return (
      <p className="quiet mt-2">
        Adding to a playlist needs a connected Spotify account.{' '}
        <Link className="underline" href={importHref}>
          Connect Spotify
        </Link>
      </p>
    )
  if (!status.playlistChanges)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="quiet">
          The Spotify connection does not allow playlist changes.
        </span>
        <AllowPlaylistChanges playlistLibrary={mediaType} />
      </div>
    )
  const active = new Set(
    additions
      .filter((addition) => playlistJobActive(addition.job))
      .map((addition) => addition.playlistId),
  )
  return (
    <div className="mt-2 grid gap-1">
      <PlaylistPicker
        mediaType={mediaType}
        options={(playlists.data ?? []).filter(
          (playlist) => playlist.acceptsAdditions,
        )}
        loading={!playlists.data && !playlists.isError}
        failed={playlists.isError}
        onRetry={() => playlists.refetch()}
        busy={(playlistId) => add.isPending || active.has(playlistId)}
        onChoose={(playlistId) => add.mutate(playlistId)}
      />
      {add.isError && (
        <p role="alert">
          {errorMessage(
            add.error,
            `Could not add the ${mediaType} to the playlist.`,
          )}
        </p>
      )}
    </div>
  )
}

function PlaylistPicker({
  mediaType,
  options,
  loading,
  failed,
  onRetry,
  busy,
  onChoose,
}: {
  mediaType: PlaylistMediaType
  options: PlaylistSummary[]
  loading: boolean
  failed: boolean
  onRetry: () => void
  busy: (playlistId: string) => boolean
  onChoose: (playlistId: string) => void
}) {
  const importHref = scopedHref('/imports/spotify-playlists', mediaType)
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (!open) return
    panel.current?.focus({ preventScroll: true })
    function position() {
      if (!trigger.current || !panel.current) return
      const rect = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      panel.current.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))}px`
      panel.current.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - box.height - 8))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  function close() {
    panel.current?.hidePopover()
    trigger.current?.focus()
  }
  const term = search.trim().toLocaleLowerCase()
  const visible = term
    ? options.filter((playlist) =>
        playlist.name.toLocaleLowerCase().includes(term),
      )
    : options
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        size="sm"
        variant="outline"
        className="w-max"
        popoverTarget={id}
        aria-expanded={open}
        aria-controls={id}
      >
        Add to playlist
      </Button>
      <div
        id={id}
        ref={panel}
        popover="auto"
        role="region"
        tabIndex={-1}
        aria-labelledby={titleId}
        className="player-popover"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          close()
        }}
      >
        <div className="player-popover-heading">
          <h2 id={titleId}>Add to playlist</h2>
          <button type="button" className="quiet" onClick={close}>
            Close
          </button>
        </div>
        {options.length > FILTER_THRESHOLD && (
          <Input
            aria-label="Filter playlists"
            placeholder="Filter playlists..."
            className="mb-2 h-7 text-xs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        {loading ? (
          <p className="quiet">Loading playlists...</p>
        ) : failed ? (
          <p role="alert">
            Could not load playlists.{' '}
            <button type="button" className="underline" onClick={onRetry}>
              Retry
            </button>
          </p>
        ) : !options.length ? (
          <p className="quiet">
            No imported playlist accepts{' '}
            {mediaType === 'album' ? 'albums' : 'tracks'}.{' '}
            {mediaType === 'album' ? 'Albums' : 'Tracks'} can be added to
            imported Spotify playlists the account owns or collaborates on.{' '}
            <Link className="underline" href={importHref}>
              Import playlists
            </Link>
          </p>
        ) : !visible.length ? (
          <p className="quiet">No playlists match this filter.</p>
        ) : (
          <ul className="grid">
            {visible.map((playlist) => (
              <li key={playlist.id}>
                <button
                  type="button"
                  className="w-full rounded-md px-2 py-1 text-left hover:bg-slate-100 disabled:opacity-50"
                  disabled={busy(playlist.id)}
                  onClick={() => {
                    close()
                    onChoose(playlist.id)
                  }}
                >
                  {playlist.name}
                  <span className="quiet">
                    {' '}
                    · {playlist.trackCount.toLocaleString()}{' '}
                    {playlist.trackCount === 1 ? 'track' : 'tracks'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
