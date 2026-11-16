'use client'

import { DetailLink } from './detail-link'
import Link from 'next/link'
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowseCountSchema } from '@repo/schemas/browse'
import { SpotifyAccountStatusSchema } from '@repo/schemas/spotify'
import {
  PlaylistAlbumAdditionInputSchema,
  PlaylistAlbumAdditionSchema,
  PlaylistAlbumAdditionsSchema,
  PlaylistBrowsePageSchema,
  type PlaylistSummary,
  type SpotifyPlaylistJob,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import { Input } from '@repo/ui/components/ui/input'
import { useConfig } from './providers'
import { errorMessage, invalidateScrobbleLinks } from './lastfm-sync'
import AllowPlaylistChanges from './spotify-playlist-changes'
import { fetchApiData } from '@/utils/api'
import { useVirtualTable } from '@/hooks/useVirtualTable'
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
const PICKER_PAGE_SIZE = 25
const RELATED_PLAYLIST_BATCH_SIZE = 100

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

function relatedPlaylistIds(additions: Addition[]) {
  return [...new Set(additions.map((addition) => addition.playlistId))].sort()
}

function relatedPlaylistsKey(ids: string[]) {
  return ['playlists', 'related', ids]
}

async function loadRelatedPlaylists(
  apiBaseUrl: string,
  ids: string[],
  signal: AbortSignal,
) {
  const playlists: PlaylistSummary[] = []
  for (
    let offset = 0;
    offset < ids.length;
    offset += RELATED_PLAYLIST_BATCH_SIZE
  ) {
    const batch = ids.slice(offset, offset + RELATED_PLAYLIST_BATCH_SIZE)
    const params = new URLSearchParams({
      ids: JSON.stringify(batch),
      size: String(batch.length),
    })
    const page = await fetchApiData(
      apiBaseUrl,
      `/api/v1/playlists/browse-page?${params}`,
      PlaylistBrowsePageSchema,
      { signal },
    )
    playlists.push(...page.items)
  }
  return playlists
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
    refetchInterval: (query) =>
      query.state.data?.additions.some((addition) =>
        playlistJobActive(addition.job),
      ) ||
      followOnImports(
        query.state.data?.additions ?? [],
        client.getQueryData<PlaylistSummary[]>(
          relatedPlaylistsKey(
            relatedPlaylistIds(query.state.data?.additions ?? []),
          ),
        ),
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
  const ids = relatedPlaylistIds(additionList)
  const playlists = useQuery<PlaylistSummary[]>({
    queryKey: relatedPlaylistsKey(ids),
    enabled: ids.length > 0,
    refetchInterval: (query) =>
      adding || followOnImports(additionList, query.state.data) ? 2000 : false,
    queryFn: ({ signal }) => loadRelatedPlaylists(apiBaseUrl, ids, signal),
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
}: {
  addition: Addition
  name: string
}) {
  const { job } = addition
  const progress = playlistJobActive(job)
    ? playlistJobProgress(job.progress)
    : null
  return (
    <li>
      {name}{' '}
      <DetailLink
        className="job-status underline underline-offset-2"
        data-status={job.status}
        kind="job"
        id={job.jobId}
      >
        {additionLabels[job.status]}
      </DetailLink>
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
  additions,
}: {
  mediaType: PlaylistMediaType
  id: string
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
  busy,
  onChoose,
}: {
  mediaType: PlaylistMediaType
  busy: (playlistId: string) => boolean
  onChoose: (playlistId: string) => void
}) {
  const { apiBaseUrl } = useConfig()
  const importHref = scopedHref('/imports/spotify-playlists', mediaType)
  const id = useId()
  const titleId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const name = useDeferredValue(search.trim())
  const scope = { acceptsAdditions: 'true', ...(name ? { name } : {}) }
  const count = useQuery({
    queryKey: ['playlists', 'picker-count', name],
    enabled: open,
    retry: false,
    queryFn: ({ signal }) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-count?${new URLSearchParams(scope)}`,
        BrowseCountSchema,
        { signal },
      ),
  })
  const choices = useVirtualTable({
    queryKey: ['playlists', 'picker', name],
    enabled: open,
    pageSize: PICKER_PAGE_SIZE,
    rowHeight: 32,
    headerHeight: 0,
    totalCount: count.data?.totalCount,
    loadPage: async (page, size, signal) => {
      const params = new URLSearchParams({
        ...scope,
        page: String(page),
        size: String(size),
      })
      const result = await fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/browse-page?${params}`,
        PlaylistBrowsePageSchema,
        { signal },
      )
      return {
        ...result,
        totalCount:
          page === 1 && !result.hasMore ? result.items.length : undefined,
      }
    },
  })
  const conflict = choices.conflictingPage
  const refetchCount = count.refetch
  useEffect(() => {
    if (open && conflict !== undefined)
      void refetchCount({ cancelRefetch: false })
  }, [open, conflict, refetchCount])
  const countError =
    count.isError && (!choices.hasTotal || conflict !== undefined)
  const failed = choices.isError || countError
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
        {(search || choices.total > FILTER_THRESHOLD || !choices.hasTotal) && (
          <Input
            aria-label="Filter playlists"
            placeholder="Filter playlists..."
            className="mb-2 h-7 text-xs"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        {failed && (
          <p role="alert">
            Could not load playlists.{' '}
            <button
              type="button"
              className="underline"
              onClick={() => {
                choices.retry()
                if (countError) void count.refetch()
              }}
            >
              Retry
            </button>
          </p>
        )}
        {choices.hasTotal && choices.total === 0 && !failed ? (
          name ? (
            <p className="quiet">No playlists match this filter.</p>
          ) : (
            <p className="quiet">
              No imported playlist accepts{' '}
              {mediaType === 'album' ? 'albums' : 'tracks'}.{' '}
              {mediaType === 'album' ? 'Albums' : 'Tracks'} can be added to
              imported Spotify playlists the account owns or collaborates on.{' '}
              <Link className="underline" href={importHref}>
                Import playlists
              </Link>
            </p>
          )
        ) : (
          <div
            className="max-h-[min(288px,45dvh)] overflow-auto overscroll-contain [overflow-anchor:none]"
            ref={choices.scroller}
            onScroll={choices.onScroll}
            role="region"
            aria-label="Available playlists"
            aria-busy={!choices.hasTotal || choices.isFetching}
            tabIndex={0}
            data-inspector-scroll=""
          >
            <ul role="list" className="grid">
              {choices.padTop > 0 && (
                <li aria-hidden="true" style={{ height: choices.padTop }} />
              )}
              {choices.slots.map(({ index, item: playlist }) =>
                playlist ? (
                  <li
                    key={index}
                    style={{ height: choices.rowHeight }}
                    aria-posinset={index + 1}
                    aria-setsize={choices.hasTotal ? choices.total : undefined}
                  >
                    <button
                      type="button"
                      className="h-full w-full truncate rounded-md px-2 text-left hover:bg-slate-100 disabled:opacity-50"
                      disabled={busy(playlist.id)}
                      title={playlist.name}
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
                ) : (
                  <li
                    key={index}
                    className="virtual-browse-placeholder"
                    aria-hidden="true"
                    style={{ height: choices.rowHeight }}
                  >
                    <div className="virtual-browse-line virtual-browse-shimmer" />
                  </li>
                ),
              )}
              {choices.padBottom > 0 && (
                <li aria-hidden="true" style={{ height: choices.padBottom }} />
              )}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}
