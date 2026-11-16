'use client'

import Link from 'next/link'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListMusic } from 'lucide-react'
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
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Facts, Section, Stats } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { PlayHeaderButtons, PlayPair } from '@repo/ui/components/ds/play'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import { formatCount, formatDate, formatDateTime } from '@repo/ui/lib/format'
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
  playlistJobProgress,
  playlistNextSync,
  playlistSourceLabel,
  spotifyPlaylistId,
} from '@/utils/playlist-sync'
import { createPlaylistPlaybackSource } from '@/utils/playback-source'
import { runStatusLabel, runStatusStates } from '@/utils/run-status'
import type { PlayableItem } from '@/utils/playback'
import { youtubeScheduleLabels } from '@/utils/youtube'
import { errorMessage } from './lastfm-sync'
import { usePlayback, usePlaybackControls } from './playback-provider'
import { useDetailInspector, useDetailView } from './detail-inspector-context'
import { DetailLink } from './detail-link'
import { CreatorDetailState } from './creator-detail-state'
import { DetailArt, DetailTabs, OpenAtProvider } from './detail-frame'
import { ListeningTrend } from './listening-trend'
import { MetadataCoverage } from './metadata-coverage'
import {
  TrackEntriesTable,
  trackEntryKey,
  type IndexedTrackEntry,
  type TrackEntryColumn,
} from './track-entries-table'
import { useConfig } from './providers'
import { ProviderSources } from './provider-sources'
import { useNestedMediaView } from './nested-media-view'

const ENTRY_PAGE_SIZE = 100

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
function usePlaylistSummary(id: string) {
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
  /** The row pair; without it, the labelled buttons of a detail header. */
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
  const disabled = !hasEntries || !view.enabled || loading
  const reason = !hasEntries
    ? 'No tracks.'
    : !view.enabled
      ? 'Connect Spotify playback in the player.'
      : 'Loading tracks...'
  const pair = {
    title: playlist.name,
    disabled,
    disabledReason: reason,
    onPlay: () => void play('play'),
    onQueue: () => void play('queue'),
  }
  return (
    <>
      {compact ? (
        <PlayPair place="row" {...pair} />
      ) : (
        <PlayHeaderButtons {...pair} />
      )}
      {error && (
        <span role="alert" className="ds-muted">
          {error}
        </span>
      )}
    </>
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
          ? `${formatCount(total)} ${q || kinds.length ? 'matching ' : ''}entries`
          : undefined
      }
      pending={!entries.hasTotal}
      empty={q || kinds.length ? 'No matching entries.' : 'No tracks.'}
      error={
        entries.isError ? (
          <>
            Could not load tracks.{' '}
            <Button size="xs" onClick={entries.retry}>
              Retry
            </Button>
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

function PlaylistSyncPanel({ playlist }: { playlist: PlaylistSummary }) {
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
    return (
      <Section title="Sync">
        <p className="ds-help">This playlist is not synced from Spotify.</p>
      </Section>
    )
  const { job } = sync
  const active = playlistJobActive(job)
  const progress = job ? playlistJobProgress(job.progress) : null
  const refused = queue.data?.queued === 0
  return (
    <Section
      title="Sync"
      aside={
        <span className="ds-actions">
          <Select
            aria-label="Schedule"
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
          </Select>
          <Button
            disabled={!request || active || queue.isPending}
            onClick={() => request && queue.mutate(request)}
          >
            {queue.isPending ? 'Queueing...' : 'Sync now'}
          </Button>
        </span>
      }
    >
      {schedule.isError && (
        <Notice tone="danger">
          {errorMessage(schedule.error, 'Could not save the schedule.')}
        </Notice>
      )}
      {queue.isError && (
        <Notice tone="danger">
          {errorMessage(queue.error, 'Could not queue the import.')}
        </Notice>
      )}
      {refused && (
        <Notice tone="danger">
          {queue.data?.warnings.join(' ') || 'The import was not queued.'}
        </Notice>
      )}
      <Facts
        items={[
          { label: 'Last checked', value: formatDateTime(sync.lastCheckedAt) },
          {
            label: 'Contents stored',
            value: formatDateTime(playlist.importedAt),
          },
          { label: 'Next sync', value: playlistNextSync(sync) },
          {
            label: 'Latest import',
            value: job ? (
              <DetailLink kind="job" id={job.jobId} title="View job">
                <Status state={runStatusStates[job.status]}>
                  {runStatusLabel(job.status)}
                </Status>
              </DetailLink>
            ) : (
              'No import job.'
            ),
          },
          ...(job?.finishedAt
            ? [{ label: 'Finished', value: formatDateTime(job.finishedAt) }]
            : []),
        ]}
      />
      {job && active && job.progress?.totalPages ? (
        <div aria-label="Import progress">
          <Progress
            done={job.progress.pagesRead}
            total={job.progress.totalPages}
          />
        </div>
      ) : (
        progress && <span className="ds-muted">{progress}</span>
      )}
      {job?.status === 'failed' && job.errorMessage && (
        <Notice tone="danger">{job.errorMessage}</Notice>
      )}
    </Section>
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

  if (!summary.data)
    return (
      <CreatorDetailState
        pending={summary.isPending}
        retry={() => summary.refetch()}
        subject="playlist"
      />
    )
  const playlist = summary.data
  const sourceLabel = playlistSourceLabel(playlist.source)
  return (
    <article className="dtl-detail">
      {summary.isRefetchError && (
        <CreatorDetailState
          stale
          retry={() => summary.refetch()}
          subject="playlist"
        />
      )}
      <DetailHeader
        art={
          <DetailArt
            src={playlist.artworkUrl}
            fallback={<ListMusic className="ds-i" aria-hidden="true" />}
          />
        }
        kind="Playlist"
        title={playlist.name}
        by={
          [
            sourceLabel ? `from ${sourceLabel}` : null,
            playlist.ownerName ? `by ${playlist.ownerName}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        facts={[
          `${formatCount(playlist.trackCount)} ${playlist.trackCount === 1 ? 'track' : 'tracks'}`,
          formatPlaylistDuration(playlist.durationSec),
          playlist.importedAt
            ? `Updated ${formatDate(playlist.importedAt)}`
            : null,
        ]}
        actions={
          <>
            <PlaylistPlayButton
              playlist={playlist}
              total={playlist.items.totalCount}
              compact={false}
              presentation={presentation}
            />
            {filterTracks ? (
              <Button size="md" onClick={() => filterTracks(playlist)}>
                Filter tracks
              </Button>
            ) : (
              <Button asChild size="md">
                <Link href={playlistTracksHref(playlist.name)}>
                  Filter tracks
                </Link>
              </Button>
            )}
            {playlist.albumCount > 0 && (
              <Button asChild size="md">
                <Link href={playlistAlbumsHref(playlist.name)}>
                  Filter albums
                </Link>
              </Button>
            )}
            <DetailActionsSpacer />
            {playlist.spotifyUrl && (
              <OpenAtProvider label="Spotify" url={playlist.spotifyUrl} />
            )}
          </>
        }
      />
      <DetailTabs
        label="Playlist details"
        value={tab}
        onChange={(value) => {
          const parsed = PlaylistTabSchema.safeParse(value)
          if (parsed.success) onTabChange(parsed.data)
        }}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'listening', label: 'Listening' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <Section flush>
            <Stats
              items={[
                { label: 'tracks', value: formatCount(playlist.trackCount) },
                {
                  label: 'library albums',
                  value: formatCount(playlist.albumCount),
                },
                {
                  label: 'linked tracks',
                  value: formatCount(playlist.linkedTrackCount),
                },
                {
                  label: 'last checked',
                  value: formatDate(playlist.sync.lastCheckedAt),
                },
              ]}
            />
          </Section>
          {playlist.description && (
            <Section title="About">
              <p className="dtl-text">{playlist.description}</p>
            </Section>
          )}
          <MetadataCoverage kind="playlist" id={playlist.id} />
          <Section title="Tracks">
            <PlaylistEntries
              id={id}
              presentation={presentation}
              onPresentationChange={setPresentation}
            />
          </Section>
        </TabsContent>
        <TabsContent value="listening">
          <ListeningTrend kind="playlist" id={playlist.id} />
        </TabsContent>
        <TabsContent value="sources">
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
      </DetailTabs>
    </article>
  )
}
