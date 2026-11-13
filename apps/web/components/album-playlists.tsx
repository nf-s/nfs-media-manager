'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  AlbumPlaylistsSchema,
  PlaylistAlbumAdditionInputSchema,
  PlaylistAlbumAdditionSchema,
  PlaylistAlbumAdditionsSchema,
  PlaylistSummarySchema,
  type PlaylistAlbumAddition,
  type PlaylistSummary,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { errorMessage } from './lastfm-sync'
import AllowPlaylistChanges from './spotify-playlist-changes'
import { fetchApiData } from '@/utils/api'
import { scopedHref } from '@/utils/media-scope'
import {
  invalidatePlaylists,
  playlistJobActive,
  playlistJobProgress,
} from '@/utils/playlist-sync'
import { playlistAlbumsHref, trackHref } from '@/utils/playlist-links'

const importHref = scopedHref('/imports/spotify-playlists', 'album')

/** Playlists with more entries than this get a filter in the picker. */
const FILTER_THRESHOLD = 8

const additionLabels: Record<SpotifyPlaylistJob['status'], string> = {
  queued: 'Queued',
  running: 'Adding',
  succeeded: 'Added',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** Playlists re-imported after an album was added to them, while that import runs. */
function followOnImports(
  additions: PlaylistAlbumAddition[],
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

export default function AlbumPlaylists({ albumId }: { albumId: string }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const additions = useQuery({
    queryKey: ['playlist-additions', albumId],
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.additions.some((addition) =>
        playlistJobActive(addition.job),
      )
        ? 2000
        : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/additions?${new URLSearchParams({ albumId })}`,
        PlaylistAlbumAdditionsSchema,
      ),
  })
  const additionList = additions.data?.additions ?? []
  const adding = additionList.some((addition) =>
    playlistJobActive(addition.job),
  )
  const playlists = useQuery({
    queryKey: ['playlists'],
    refetchInterval: (query) =>
      followOnImports(additionList, query.state.data) ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/playlists',
        z.array(PlaylistSummarySchema),
      ),
  })
  const importing = followOnImports(additionList, playlists.data)
  const query = useQuery({
    queryKey: ['album-playlists', albumId],
    refetchInterval: adding || importing ? 2000 : false,
    queryFn: () =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/albums/${encodeURIComponent(albumId)}/playlists`,
        AlbumPlaylistsSchema,
      ),
  })

  // An addition and the import it queues both change what the album is in.
  const following = adding || importing
  const wasFollowing = useRef(following)
  useEffect(() => {
    if (wasFollowing.current && !following)
      void Promise.all([
        invalidatePlaylists(client),
        client.invalidateQueries({ queryKey: ['spotify-playlists'] }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    wasFollowing.current = following
  }, [following, client])

  const names = new Map(
    (playlists.data ?? []).map((playlist) => [playlist.id, playlist.name]),
  )
  const memberships = query.data?.playlists ?? []
  const tracks = query.data?.tracks ?? []
  return (
    <div className="detail-metadata mt-6">
      <section>
        <h2>Playlists</h2>
        {query.isError && (
          <p role="alert">
            Playlists unavailable.{' '}
            <button className="underline" onClick={() => query.refetch()}>
              Retry
            </button>
          </p>
        )}
        {memberships.length > 0 && (
          <div className="detail-tags">
            {memberships.map((playlist) => (
              <Link
                key={playlist.id}
                className="metadata-tag"
                href={playlistAlbumsHref(playlist.name)}
              >
                {playlist.name}
                {playlist.trackCount > 0 && (
                  <span className="quiet">
                    {' '}
                    · {playlist.trackCount}{' '}
                    {playlist.trackCount === 1 ? 'track' : 'tracks'}
                  </span>
                )}
              </Link>
            ))}
          </div>
        )}
        <AddToPlaylist
          albumId={albumId}
          playlists={playlists}
          additions={additionList}
        />
        {additionList.length > 0 && (
          <ul className="mt-2 grid gap-1 text-sm" aria-label="Additions">
            {additionList.map((addition) => (
              <AdditionState
                key={addition.job.jobId}
                addition={addition}
                name={names.get(addition.playlistId) ?? 'Playlist'}
              />
            ))}
          </ul>
        )}
      </section>
      {tracks.length > 0 && (
        <section>
          <h2>Tracks in the track library</h2>
          <ul className="grid gap-1 text-sm">
            {tracks.map((track) => (
              <li key={track.id}>
                <Link
                  className="underline underline-offset-2"
                  href={trackHref(track.id)}
                >
                  {track.title}
                </Link>
                {track.playlists.length > 0 && (
                  <span className="quiet"> · {track.playlists.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function AdditionState({
  addition,
  name,
}: {
  addition: PlaylistAlbumAddition
  name: string
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

function AddToPlaylist({
  albumId,
  playlists,
  additions,
}: {
  albumId: string
  playlists: { data: PlaylistSummary[] | undefined; isError: boolean }
  additions: PlaylistAlbumAddition[]
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
    mutationFn: (playlistId: string) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/${encodeURIComponent(playlistId)}/additions`,
        PlaylistAlbumAdditionSchema,
        {
          method: 'POST',
          body: JSON.stringify(
            PlaylistAlbumAdditionInputSchema.parse({ albumId }),
          ),
        },
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['playlist-additions', albumId],
        }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
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
        <AllowPlaylistChanges />
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
        options={(playlists.data ?? []).filter(
          (playlist) => playlist.acceptsAdditions,
        )}
        loading={!playlists.data && !playlists.isError}
        failed={playlists.isError}
        busy={(playlistId) => add.isPending || active.has(playlistId)}
        onChoose={(playlistId) => add.mutate(playlistId)}
      />
      {add.isError && (
        <p role="alert">
          {errorMessage(add.error, 'Could not add the album to the playlist.')}
        </p>
      )}
    </div>
  )
}

function PlaylistPicker({
  options,
  loading,
  failed,
  busy,
  onChoose,
}: {
  options: PlaylistSummary[]
  loading: boolean
  failed: boolean
  busy: (playlistId: string) => boolean
  onChoose: (playlistId: string) => void
}) {
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
          <p role="alert">Could not load playlists.</p>
        ) : !options.length ? (
          <p className="quiet">
            No imported playlist accepts albums. Albums can be added to imported
            Spotify playlists the account owns or collaborates on.{' '}
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
