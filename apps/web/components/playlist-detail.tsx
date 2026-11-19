'use client'

import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListMusic } from 'lucide-react'
import { CoverageEntriesSchema } from '@repo/schemas/coverage'
import { EnrichmentResultSchema } from '@repo/schemas/job'
import {
  PlaylistDetailSchema,
  PlaylistEntrySortSchema,
  PlaylistSummarySchema,
  PlaylistSyncScheduleSchema,
  type PlaylistDetail,
  type PlaylistDetailQuery,
  type PlaylistPresentation,
  type PlaylistSummary,
  type PlaylistSyncSchedule,
  type SpotifyPlaylistImportInput,
} from '@repo/schemas/tracks'
import {
  DetailActionsSpacer,
  DetailHeader,
} from '@repo/ui/components/ds/detail-header'
import { Facts, Section } from '@repo/ui/components/ds/facts'
import { Notice } from '@repo/ui/components/ds/feedback'
import { Progress } from '@repo/ui/components/ds/meter'
import { Segmented } from '@repo/ui/components/ds/segmented'
import { PlayHeaderButtons, PlayPair } from '@repo/ui/components/ds/play'
import { Status } from '@repo/ui/components/ds/status'
import { Select } from '@repo/ui/components/ds/toolbar'
import { Button } from '@repo/ui/components/ui/button'
import { TabsContent } from '@repo/ui/components/ui/tabs'
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatItemCount,
} from '@repo/ui/lib/format'
import { useVirtualTable } from '@/hooks/useVirtualTable'
import { fetchApiData } from '@/utils/api'
import {
  COVERAGE_SUBJECT_PARAM,
  GAP_FILTER_PARAM,
  coverageEntriesKey,
  coverageEntriesPath,
  coverageSubject,
  coverageSubjectParams,
  gapFilter,
  gapFilterParam,
  gapFilterParams,
  gapFilterValue,
  gapLabels,
  type GapFilter,
} from '@/utils/coverage-entries'
import { parseBrowseView, type BrowseView } from '@/utils/media-grid'
import { providerLabel } from '@/utils/field-provenance'
import {
  PlaylistTabSchema,
  playlistTracksHref,
  playlistAlbumsHref,
  playlistAlbumSorts,
  playlistPresentationLabels,
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
import { DetailMore } from './detail-more'
import { ScrobbleStats } from './listening-stats'
import { ListeningTrend } from './listening-trend'
import { PlaylistCoverage } from './metadata-coverage'
import { GapFilterControls, GapSelection } from './playlist-gaps'
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
  {
    sortBy = 'position',
    direction = 'asc',
    q,
    kinds,
    groupBy,
  }: Partial<PlaylistDetailQuery> = {},
) {
  return `/api/v1/playlists/${encodeURIComponent(id)}?${new URLSearchParams({
    page: String(page),
    size: String(size),
    sortBy,
    direction,
    ...(q ? { q } : {}),
    ...(kinds?.length ? { kinds: JSON.stringify(kinds) } : {}),
    ...(groupBy ? { groupBy } : {}),
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
  playlist,
  presentation,
  onPresentationChange,
}: {
  playlist: PlaylistSummary
  presentation: BrowseView
  onPresentationChange: (view: BrowseView) => void
}) {
  const { apiBaseUrl } = useConfig()
  const detail = useDetailView()
  const { id } = playlist
  const view = playlistEntryView(detail.params.get('playlistView'), id)
  const canSwitch = playlist.albumCount > 0 && playlist.trackCount > 0
  const preferredContents =
    view.contents ?? (view.kinds?.length ? 'tracks' : playlist.presentation)
  const contents = canSwitch ? preferredContents : playlist.presentation
  const albums = contents === 'albums'
  const groupBy: PlaylistDetailQuery['groupBy'] = albums ? 'album' : undefined
  const sortBy =
    albums && !playlistAlbumSorts.includes(view.sortBy)
      ? 'position'
      : view.sortBy
  const direction = sortBy === view.sortBy ? view.direction : 'asc'
  const search = view.q ?? ''
  const q = useDeferredValue(search.trim())
  const kinds = albums ? [] : (view.kinds ?? [])
  function viewParams(
    patch: Partial<PlaylistDetailQuery> & { contents?: PlaylistPresentation },
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
  const filter = gapFilter(detail.params.get(GAP_FILTER_PARAM), id)
  function setFilter(next: GapFilter | null) {
    const params = viewParams({})
    if (next) params.set(GAP_FILTER_PARAM, gapFilterParam(id, next))
    else params.delete(GAP_FILTER_PARAM)
    detail.replace(params)
  }
  // Only the table can select rows, so Metadata gaps shows it without the
  // view switch; the owner's view returns when the filter is turned off.
  const shownView: BrowseView = filter ? 'table' : presentation
  const selectionKey = JSON.stringify([id, contents, filter, q, kinds])
  const [selection, setSelection] = useState({
    key: '',
    rows: new Map<string, IndexedTrackEntry>(),
  })
  const selected =
    selection.key === selectionKey
      ? selection.rows
      : new Map<string, IndexedTrackEntry>()
  const query = { sortBy, direction, q, kinds, groupBy }
  const entries = useVirtualTable({
    queryKey: filter
      ? coverageEntriesKey(id, query, filter)
      : [
          'playlist',
          id,
          albums ? 'albums' : 'entries',
          sortBy,
          direction,
          q,
          kinds,
        ],
    pageSize: ENTRY_PAGE_SIZE,
    presentation: { view: shownView, mediaType: 'album' },
    loadPage: async (page, size, signal) => {
      if (filter) {
        const result = await fetchApiData(
          apiBaseUrl,
          coverageEntriesPath(id, page, size, query, filter),
          CoverageEntriesSchema,
          { signal },
        )
        return {
          ...result,
          items: result.items.map(({ entry, gaps }, offset) => ({
            entry,
            gaps,
            key: trackEntryKey(entry),
            index: (page - 1) * size + offset,
          })),
        }
      }
      const result = await fetchApiData(
        apiBaseUrl,
        playlistPath(id, page, size, query),
        PlaylistDetailSchema,
        { signal },
      )
      return {
        ...result.items,
        name: result.name,
        albumCount: null,
        items: result.items.items.map((entry, offset) => ({
          entry,
          key: trackEntryKey(entry),
          index: (page - 1) * size + offset,
        })),
      }
    },
  })
  const total = entries.total
  const albumCount = entries.firstPage?.albumCount
  const matching = q || kinds.length
  const gapProvider = filter?.provider
    ? `${providerLabel(filter.provider)} `
    : ''
  const anyProvider = filter?.provider ? '' : ' from at least one provider'
  const gapDescription =
    filter?.gap === 'missing'
      ? `without a successful ${gapProvider}scrape${anyProvider}`
      : `with stale ${gapProvider}metadata${anyProvider}`
  const noun = albums
    ? { one: 'album', other: 'albums' }
    : { one: 'entry', other: 'entries' }
  const count = formatItemCount(
    total,
    matching
      ? { one: `matching ${noun.one}`, other: `matching ${noun.other}` }
      : noun,
  )
  const gapCount =
    filter && typeof albumCount === 'number'
      ? `${formatItemCount(albumCount, { one: 'library album', other: 'library albums' })} ${gapDescription}`
      : null
  return (
    <Section
      title={canSwitch ? 'Contents' : albums ? 'Albums' : 'Tracks'}
      className="dtl-playlist-contents"
      aside={
        <>
          {canSwitch && (
            <Segmented<PlaylistPresentation>
              label="Playlist contents"
              value={contents}
              options={[
                { value: 'albums', label: 'Albums' },
                { value: 'tracks', label: 'Tracks' },
              ]}
              onChange={(next) =>
                detail.replace(viewParams({ contents: next }))
              }
            />
          )}
          <GapFilterControls
            playlistId={id}
            filter={filter}
            onChange={setFilter}
          />
        </>
      }
    >
      <TrackEntriesTable
        scope={albums ? 'playlist-albums' : 'playlist'}
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
        view={shownView}
        onViewChange={
          filter
            ? undefined
            : (next) => {
                onPresentationChange(next)
                detail.replace(viewParams({}, next))
              }
        }
        search={search}
        onSearch={(search) => detail.replace(viewParams({ q: search }))}
        sortBy={sortBy}
        direction={direction}
        onSort={onSort}
        count={
          entries.hasTotal
            ? gapCount && albums && !matching
              ? gapCount
              : [count, gapCount].filter(Boolean).join(' · ')
            : undefined
        }
        pending={!entries.hasTotal}
        empty={
          matching
            ? `No matching ${noun.other}.`
            : filter
              ? 'No entries match this metadata gap.'
              : albums
                ? 'No library albums.'
                : 'No tracks.'
        }
        error={
          entries.isError ? (
            <>
              {albums ? 'Could not load albums.' : 'Could not load tracks.'}{' '}
              <Button size="xs" onClick={entries.retry}>
                Retry
              </Button>
            </>
          ) : undefined
        }
        kindFilter={
          albums
            ? undefined
            : {
                value: kinds,
                onChange: (kinds) => detail.replace(viewParams({ kinds })),
              }
        }
        gaps={
          filter
            ? {
                label: gapLabels[filter.gap],
                selected: new Set(selected.keys()),
                onSelect: (row, checked) => {
                  const rows = new Map(selected)
                  if (checked) rows.set(row.key, row)
                  else rows.delete(row.key)
                  setSelection({ key: selectionKey, rows })
                },
              }
            : undefined
        }
        source={
          filter || albums
            ? undefined
            : ({ entry, index }) =>
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
      {filter && (
        <GapSelection
          key={gapFilterValue(filter)}
          playlistId={id}
          filter={filter}
          rows={[...selected.values()]}
          onClear={() => setSelection({ key: selectionKey, rows: new Map() })}
        />
      )}
    </Section>
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
        kind={playlistPresentationLabels[playlist.presentation]}
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
          ...(playlist.presentation === 'albums'
            ? [
                formatItemCount(playlist.albumCount, {
                  one: 'album',
                  other: 'albums',
                }),
              ]
            : []),
          playlist.presentation === 'tracks' || playlist.trackCount > 0
            ? formatItemCount(playlist.trackCount, {
                one: 'track',
                other: 'tracks',
              })
            : null,
          playlist.durationSec > 0
            ? formatPlaylistDuration(playlist.durationSec)
            : null,
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
            <DetailActionsSpacer />
            {playlist.spotifyUrl && (
              <OpenAtProvider label="Spotify" url={playlist.spotifyUrl} />
            )}
            <DetailMore
              crumb={{ title: playlist.name }}
              items={[
                filterTracks
                  ? {
                      label: 'Filter tracks',
                      onSelect: () => filterTracks(playlist),
                    }
                  : {
                      label: 'Filter tracks',
                      href: playlistTracksHref(playlist.name),
                    },
                ...(playlist.albumCount > 0
                  ? [
                      {
                        label: 'Filter albums',
                        href: playlistAlbumsHref(playlist.name),
                      },
                    ]
                  : []),
              ]}
            />
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
          { value: 'coverage', label: 'Coverage' },
          { value: 'sources', label: 'Sources' },
        ]}
      >
        <TabsContent value="overview">
          <Section flush>
            <ScrobbleStats
              kind="playlist"
              id={playlist.id}
              items={[
                {
                  label: 'library albums',
                  value: formatCount(playlist.albumCount),
                },
                {
                  label: 'linked tracks',
                  value: formatCount(playlist.linkedTrackCount),
                },
              ]}
            />
          </Section>
          {playlist.description && (
            <Section title="About">
              <p className="dtl-text">{playlist.description}</p>
            </Section>
          )}
          <PlaylistEntries
            playlist={playlist}
            presentation={presentation}
            onPresentationChange={setPresentation}
          />
        </TabsContent>
        <TabsContent value="listening">
          <ListeningTrend kind="playlist" id={playlist.id} />
        </TabsContent>
        <TabsContent value="coverage">
          <PlaylistCoverage
            id={playlist.id}
            subject={coverageSubject(detail.params.get(COVERAGE_SUBJECT_PARAM))}
            onSubjectChange={(subject) =>
              detail.replace(coverageSubjectParams(detail.params, subject))
            }
            onShowGap={(provider, gap) =>
              detail.replace(
                gapFilterParams(detail.params, id, {
                  gap,
                  provider: provider.provider,
                }),
              )
            }
          />
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
