'use client'

import { DetailLink } from './detail-link'
import Link from 'next/link'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListPlus, Play } from 'lucide-react'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  PlaylistDetailSchema,
  PlaylistEntrySortSchema,
  PlaylistSummarySchema,
  PlaylistSyncScheduleSchema,
  type PlaylistDetail,
  type PlaylistDetailQuery,
  type PlaylistEntrySort,
  type PlaylistSummary,
  type PlaylistSyncSchedule,
  type SpotifyPlaylistImportInput,
} from '@repo/schemas/tracks'
import { Button } from '@repo/ui/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@repo/ui/components/ui/tabs'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import { parseBrowseView, type BrowseView } from '@/utils/media-grid'
import {
  PlaylistTabSchema,
  playlistTracksHref,
  playlistAlbumsHref,
  playlistHref,
  playlistEntryView,
  playlistEntryViewParam,
  type PlaylistTab,
} from '@/utils/playlist-links'
import {
  PLAYLIST_SYNC_POLL_MS,
  formatPlaylistDuration,
  invalidatePlaylists,
  playlistImportRequest,
  playlistJobActive,
  playlistJobLabels,
  playlistJobProgress,
  playlistNextSync,
  playlistSourceLabel,
  spotifyPlaylistId,
} from '@/utils/playlist-sync'
import { createPlaylistPlaybackSource } from '@/utils/playback-source'
import type { PlayableItem } from '@/utils/playback'
import { youtubeScheduleLabels } from '@/utils/youtube'
import { errorMessage } from './lastfm-sync'
import MediaArtwork from './media-artwork'
import { UnavailablePlayButton } from './play-controls'
import { usePlayback, usePlaybackControls } from './playback-provider'
import { useDetailInspector, useDetailView } from './detail-inspector-context'
import {
  TrackEntriesTable,
  trackEntryKey,
  type IndexedTrackEntry,
  type TrackEntryColumn,
} from './track-entries-table'
import { useConfig } from './providers'
import ServiceIconLinks from './service-icon-links'
import { ProviderSources } from './provider-sources'
import { useNestedMediaView } from './nested-media-view'

const ENTRY_PAGE_SIZE = 100

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '-'
}

function playlistPath(
  id: string,
  page: number,
  size: number,
  sortBy: PlaylistEntrySort = 'position',
  direction: 'asc' | 'desc' = 'asc',
  q = '',
  kinds: NonNullable<PlaylistDetailQuery['kinds']> = [],
) {
  return `/api/v1/playlists/${encodeURIComponent(id)}?${new URLSearchParams({
    page: String(page),
    size: String(size),
    sortBy,
    direction,
    ...(q ? { q } : {}),
    ...(kinds.length ? { kinds: JSON.stringify(kinds) } : {}),
  })}`
}

/** The playlist with its sync state, re-read while its import is queued or running. */
export function usePlaylistSummary(id: string) {
  const { apiBaseUrl } = useConfig()
  return useQuery({
    queryKey: ['playlist', id],
    refetchInterval: (query) =>
      playlistJobActive(query.state.data?.sync.job)
        ? PLAYLIST_SYNC_POLL_MS
        : false,
    queryFn: () =>
      fetchApiData(apiBaseUrl, playlistPath(id, 1, 1), PlaylistDetailSchema),
  })
}

export function PlaylistPlayButton({
  playlist,
  total,
  compact = true,
  presentation,
}: {
  playlist: Pick<PlaylistSummary, 'id' | 'name'> &
    Partial<Pick<PlaylistSummary, 'trackCount' | 'albumCount'>>
  total?: number
  compact?: boolean
  presentation?: BrowseView
}) {
  const { apiBaseUrl } = useConfig()
  const view = usePlayback()
  const controls = usePlaybackControls()
  const detail = useDetailView()
  const inspector = useDetailInspector()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const knownCount =
    total ??
    (playlist.trackCount !== undefined && playlist.albumCount !== undefined
      ? playlist.trackCount + playlist.albumCount
      : undefined)
  const hasEntries = knownCount === undefined || knownCount > 0
  async function play(action: 'play' | 'queue') {
    setLoading(true)
    setError('')
    try {
      const count =
        total ??
        (
          await fetchApiData(
            apiBaseUrl,
            playlistPath(playlist.id, 1, 1),
            PlaylistDetailSchema,
          )
        ).items.totalCount
      const returnParams = new URLSearchParams(detail.params)
      returnParams.delete('tab')
      if (presentation) returnParams.set('view', presentation)
      const href =
        total !== undefined
          ? detail.href(returnParams)
          : (inspector?.href({ kind: 'playlist', id: playlist.id }) ??
            playlistHref(playlist.id))
      const source = createPlaylistPlaybackSource({
        apiBaseUrl,
        id: playlist.id,
        params: new URLSearchParams(),
        href,
        label: playlist.name,
        total: count,
        startIndex: 0,
      })
      const queued: PlayableItem[] = []
      for (let index = 0; index < count; index += 1) {
        const items = await source.load(index)
        if (action === 'queue') {
          queued.push(...items)
          continue
        }
        const [first] = items
        if (!first) continue
        controls.play(first, { ...source, startIndex: index })
        return
      }
      if (queued.length) queued.forEach((item) => controls.enqueue(item))
      else setError('No playable tracks.')
    } catch (error) {
      setError(errorMessage(error, 'Could not load tracks.'))
    } finally {
      setLoading(false)
    }
  }
  if (!hasEntries || !view.enabled)
    return (
      <UnavailablePlayButton
        title={playlist.name}
        available={hasEntries}
        compact={compact}
      />
    )
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--chip)]"
        aria-label={`Play ${playlist.name}`}
        title={`Play ${playlist.name}`}
        disabled={loading}
        onClick={() => play('play')}
      >
        <Play size={compact ? 12 : 14} aria-hidden="true" />
        {!compact && (loading ? 'Loading tracks...' : 'Play')}
      </button>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-[var(--chip)]"
        aria-label={`Add ${playlist.name} to queue`}
        title={`Add ${playlist.name} to queue`}
        disabled={loading}
        onClick={() => play('queue')}
      >
        <ListPlus size={compact ? 12 : 14} aria-hidden="true" />
        {!compact && 'Add to queue'}
      </button>
      {error && (
        <span role="alert" className="text-xs">
          {error}
        </span>
      )}
    </span>
  )
}

/** Preserve the scroll and playback offsets when adjacent pages overlap after a sync. */
export function playlistWindowSlots(
  slots: readonly { index: number; item: IndexedTrackEntry | undefined }[],
) {
  const seen = new Set<string>()
  return slots.map((slot) => {
    if (slot.item === undefined) return slot
    if (seen.has(slot.item.key)) return { index: slot.index, item: null }
    seen.add(slot.item.key)
    return slot
  })
}

function PlaylistEntries({
  id,
  presentation,
  onPresentationChange,
}: {
  id: string
  presentation: BrowseView
  onPresentationChange: (view: BrowseView) => void
}) {
  const { apiBaseUrl } = useConfig()
  const detail = useDetailView()
  const view = playlistEntryView(detail.params.get('playlistView'), id)
  const { sortBy, direction } = view
  const search = view.q ?? ''
  const q = useDeferredValue(search.trim())
  const kinds = view.kinds ?? []
  function viewParams(
    patch: Partial<PlaylistDetailQuery>,
    nextPresentation = presentation,
  ) {
    const params = new URLSearchParams(detail.params)
    params.set(
      'playlistView',
      playlistEntryViewParam(id, { ...view, ...patch }),
    )
    params.delete('tab')
    params.set('view', nextPresentation)
    return params
  }
  function onSort(key: TrackEntryColumn, direction: 'asc' | 'desc') {
    const parsed = PlaylistEntrySortSchema.safeParse(key)
    if (parsed.success)
      detail.replace(
        viewParams({
          sortBy: parsed.data,
          direction,
        }),
      )
  }
  const entries = useVirtualTable({
    queryKey: ['playlist', id, 'entries', sortBy, direction, q, kinds],
    pageSize: ENTRY_PAGE_SIZE,
    presentation: { view: presentation, mediaType: 'album' },
    loadPage: async (page, size, signal) => {
      const result = await fetchApiData(
        apiBaseUrl,
        playlistPath(id, page, size, sortBy, direction, q, kinds),
        PlaylistDetailSchema,
        { signal },
      )
      return {
        ...result.items,
        name: result.name,
        items: result.items.items.map((entry, offset) => ({
          entry,
          key: trackEntryKey(entry),
          index: (page - 1) * size + offset,
        })),
      }
    },
  })
  const total = entries.total
  return (
    <TrackEntriesTable
      scope="playlist"
      window={{
        slots: playlistWindowSlots(entries.slots),
        total,
        hasTotal: entries.hasTotal,
        rowHeight: entries.rowHeight,
        height: entries.height,
        columns: entries.columns,
        gap: entries.gap,
        padTop: entries.padTop,
        padBottom: entries.padBottom,
        scroller: entries.scroller,
        onScroll: entries.onScroll,
      }}
      view={presentation}
      onViewChange={(next) => {
        onPresentationChange(next)
        detail.replace(viewParams({}, next))
      }}
      search={search}
      onSearch={(search) => detail.replace(viewParams({ q: search }))}
      sortBy={sortBy}
      direction={direction}
      onSort={onSort}
      count={
        entries.hasTotal
          ? `${total.toLocaleString()} ${q || kinds.length ? 'matching ' : ''}entries`
          : undefined
      }
      pending={!entries.hasTotal}
      empty={q || kinds.length ? 'No matching entries.' : 'No tracks.'}
      error={
        entries.isError ? (
          <>
            Could not load tracks.{' '}
            <button type="button" className="underline" onClick={entries.retry}>
              Retry
            </button>
          </>
        ) : undefined
      }
      kindFilter={{
        value: kinds,
        onChange: (kinds) => detail.replace(viewParams({ kinds })),
      }}
      source={({ entry, index }) =>
        createPlaylistPlaybackSource({
          apiBaseUrl,
          id,
          params: new URLSearchParams({
            sortBy,
            direction,
            q,
            kinds: JSON.stringify(kinds),
          }),
          href: detail.href(viewParams({ q })),
          label: entries.firstPage?.name ?? 'Playlist',
          total,
          startIndex: index,
          initialEntry: entry,
        })
      }
    />
  )
}

export function PlaylistSyncPanel({ playlist }: { playlist: PlaylistSummary }) {
  const { apiBaseUrl } = useConfig()
  const client = useQueryClient()
  const { sync } = playlist
  const request = playlistImportRequest(playlist)
  const schedule = useMutation({
    mutationFn: (value: PlaylistSyncSchedule) =>
      fetchApiData(
        apiBaseUrl,
        `/api/v1/playlists/${encodeURIComponent(playlist.id)}/sync-schedule`,
        PlaylistSummarySchema,
        { method: 'PUT', body: JSON.stringify({ schedule: value }) },
      ),
    onSuccess: async (summary) => {
      client.setQueryData<PlaylistDetail>(['playlist', playlist.id], (old) =>
        old ? { ...old, ...summary } : old,
      )
      await client.invalidateQueries({ queryKey: ['playlists'] })
    },
  })
  const queue = useMutation({
    mutationFn: (input: SpotifyPlaylistImportInput) =>
      fetchApiData(
        apiBaseUrl,
        '/api/v1/spotify/playlists/import',
        EnrichmentResultSchema,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ['playlist', playlist.id],
          exact: true,
        }),
        client.invalidateQueries({ queryKey: ['playlists'] }),
        client.invalidateQueries({ queryKey: ['jobs'] }),
        client.invalidateQueries({ queryKey: ['job-activity'] }),
      ])
    },
  })
  if (!sync.syncable)
    return <p className="quiet">This playlist is not synced from Spotify.</p>
  const { job } = sync
  const active = playlistJobActive(job)
  const progress = job ? playlistJobProgress(job.progress) : null
  const refused = queue.data?.queued === 0
  return (
    <section className="film-import-workflow" aria-label="Sync">
      <div className="form-actions">
        <label className="flex items-center gap-2">
          Schedule
          <select
            value={sync.schedule}
            disabled={schedule.isPending}
            onChange={(event) => {
              const parsed = PlaylistSyncScheduleSchema.safeParse(
                event.target.value,
              )
              if (parsed.success) schedule.mutate(parsed.data)
            }}
          >
            {PlaylistSyncScheduleSchema.options.map((value) => (
              <option key={value} value={value}>
                {youtubeScheduleLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          disabled={!request || active || queue.isPending}
          onClick={() => request && queue.mutate(request)}
        >
          {queue.isPending ? 'Queueing...' : 'Sync now'}
        </Button>
      </div>
      {schedule.isError && (
        <p role="alert">
          {errorMessage(schedule.error, 'Could not save the schedule.')}
        </p>
      )}
      {queue.isError && (
        <p role="alert">
          {errorMessage(queue.error, 'Could not queue the import.')}
        </p>
      )}
      {refused && (
        <p role="alert">
          {queue.data?.warnings.join(' ') || 'The import was not queued.'}
        </p>
      )}
      <dl className="detail-metrics">
        <div>
          <dt>Last checked</dt>
          <dd>{formatDateTime(sync.lastCheckedAt)}</dd>
        </div>
        <div>
          <dt>Contents stored</dt>
          <dd>{formatDateTime(playlist.importedAt)}</dd>
        </div>
        <div>
          <dt>Next sync</dt>
          <dd>{playlistNextSync(sync)}</dd>
        </div>
      </dl>
      <h2 className="text-xs font-semibold">Latest import</h2>
      {job ? (
        <>
          <div className="form-actions">
            <span className="job-status" data-status={job.status}>
              {playlistJobLabels[job.status]}
            </span>
            {progress && <span>{progress}</span>}
            {job.finishedAt && (
              <span>Finished {formatDateTime(job.finishedAt)}</span>
            )}
            <DetailLink
              className="underline underline-offset-2"
              kind="job"
              id={job.jobId}
            >
              View job
            </DetailLink>
          </div>
          {active && (
            <progress
              className="w-full"
              value={
                job.progress?.totalPages ? job.progress.pagesRead : undefined
              }
              max={job.progress?.totalPages || undefined}
              aria-label="Import progress"
            />
          )}
          {job.status === 'failed' && job.errorMessage && (
            <p role="alert">{job.errorMessage}</p>
          )}
        </>
      ) : (
        <p className="muted">No import job.</p>
      )}
    </section>
  )
}

export default function PlaylistDetailView({
  id,
  tab,
  onTabChange,
  filterTracks,
}: {
  id: string
  tab: PlaylistTab
  onTabChange: (tab: PlaylistTab) => void
  /** Filters the surrounding Tracks browser; without it the button links to Tracks. */
  filterTracks?: (playlist: PlaylistSummary) => void
}) {
  const client = useQueryClient()
  const detail = useDetailView()
  const [savedPresentation, setPresentation] =
    useNestedMediaView('playlist-entries')
  const presentation = parseBrowseView(
    detail.params.get('view'),
    savedPresentation,
  )
  const summary = usePlaylistSummary(id)
  const active = playlistJobActive(summary.data?.sync.job)
  const wasActive = useRef(active)
  useEffect(() => {
    if (wasActive.current && !active) void invalidatePlaylists(client)
    wasActive.current = active
  }, [active, client])

  if (summary.isPending) return <p className="browse-empty">Loading...</p>
  if (!summary.data)
    return (
      <p role="alert">
        {errorMessage(summary.error, 'Could not load this playlist.')}{' '}
        <Button size="md" variant="primary" onClick={() => summary.refetch()}>
          Retry
        </Button>
      </p>
    )
  const playlist = summary.data
  const facts = [
    playlistSourceLabel(playlist.source),
    playlist.ownerName,
    `${playlist.trackCount.toLocaleString()} ${playlist.trackCount === 1 ? 'track' : 'tracks'}`,
    formatPlaylistDuration(playlist.durationSec),
  ].filter((fact): fact is string => Boolean(fact))
  return (
    <>
      <header className="flex shrink-0 items-start gap-3">
        {playlist.artworkUrl && (
          <MediaArtwork
            src={playlist.artworkUrl}
            alt=""
            fallbackLabel=""
            containerClassName="size-16 shrink-0 rounded"
            imageClassName="size-16 object-cover"
            fallbackClassName="size-16"
          />
        )}
        <div className="grid min-w-0 gap-1.5">
          <h1 className="text-lg font-semibold leading-tight">
            {playlist.name}{' '}
            {playlist.spotifyUrl && (
              <ServiceIconLinks
                links={[
                  {
                    provider: 'spotify',
                    label: 'Spotify',
                    url: playlist.spotifyUrl,
                  },
                ]}
              />
            )}
          </h1>
          <div className="detail-facts">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </div>
          <div className="form-actions">
            <PlaylistPlayButton
              playlist={playlist}
              total={playlist.items.totalCount}
              compact={false}
              presentation={presentation}
            />
            {filterTracks ? (
              <Button onClick={() => filterTracks(playlist)}>
                Filter tracks
              </Button>
            ) : (
              <Button asChild>
                <Link href={playlistTracksHref(playlist.name)}>
                  Filter tracks
                </Link>
              </Button>
            )}
            {playlist.albumCount > 0 && (
              <Button asChild>
                <Link href={playlistAlbumsHref(playlist.name)}>
                  Filter albums
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const parsed = PlaylistTabSchema.safeParse(value)
          if (parsed.success) onTabChange(parsed.data)
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="self-start">
          <TabsTrigger value="tracks">Tracks</TabsTrigger>
          <TabsTrigger value="sync">Sources</TabsTrigger>
        </TabsList>
        <TabsContent
          value="tracks"
          className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <PlaylistEntries
            id={id}
            presentation={presentation}
            onPresentationChange={setPresentation}
          />
        </TabsContent>
        <TabsContent
          value="sync"
          className="mt-3 min-h-0 flex-1 space-y-4 overflow-auto"
        >
          <ProviderSources
            rows={[
              {
                id: playlist.source ?? 'legacy',
                label:
                  playlist.source === 'spotify'
                    ? 'Spotify'
                    : playlistSourceLabel(playlist.source),
                identifier: spotifyPlaylistId(playlist.spotifyUrl) ?? undefined,
                updatedAt: playlist.importedAt ?? undefined,
                links: playlist.spotifyUrl
                  ? [
                      {
                        provider: 'spotify',
                        label: 'Spotify',
                        url: playlist.spotifyUrl,
                      },
                    ]
                  : undefined,
              },
            ]}
          />
          <PlaylistSyncPanel playlist={playlist} />
        </TabsContent>
      </Tabs>
    </>
  )
}
